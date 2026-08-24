import { z } from 'zod';
import { config } from './config.js';

export const inbodyAnalysisReady = Boolean(config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_API_TOKEN);

const metricKeys = [
  'heightCm', 'weightKg', 'skeletalMuscleMassKg', 'bodyFatMassKg', 'percentBodyFat', 'bmi',
  'totalBodyWaterL', 'proteinKg', 'mineralsKg', 'softLeanMassKg', 'fatFreeMassKg', 'inBodyScore',
  'visceralFatLevel', 'ecwRatio', 'basalMetabolicRateKcal', 'waistHipRatio', 'waistCircumferenceCm',
  'targetWeightKg', 'weightControlKg', 'fatControlKg', 'muscleControlKg', 'recommendedCalorieIntakeKcal'
] as const;

export type InBodyMetricKey = typeof metricKeys[number];
export type InBodyValues = Partial<Record<InBodyMetricKey, number>>;

const measurementSchema = z.object({
  testedAt: z.string().min(8),
  values: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).default({}),
  confidence: z.record(z.string(), z.coerce.number().min(0).max(1)).default({})
});

const extractionSchema = z.object({
  deviceModel: z.string().nullable().optional(),
  measurements: z.array(measurementSchema).default([]),
  warnings: z.array(z.string()).default([])
});

export type ValidatedMeasurement = {
  testedAt: string;
  values: InBodyValues;
  confidence: Record<string, number>;
  warnings: string[];
};

export function validateInBodyValues(values: InBodyValues, requireCore = true) {
  const warnings: string[] = [];
  if (requireCore) {
    if (!values.weightKg) warnings.push('No se encontró el peso');
    if (!values.skeletalMuscleMassKg) warnings.push('No se encontró la masa muscular esquelética');
    if (!values.percentBodyFat && !values.bodyFatMassKg) warnings.push('No se encontró la grasa corporal');
  }
  if (values.weightKg && values.bodyFatMassKg && values.percentBodyFat) {
    const calculated = values.bodyFatMassKg / values.weightKg * 100;
    if (Math.abs(calculated - values.percentBodyFat) > 1.5) warnings.push('El porcentaje de grasa no coincide con peso y masa grasa');
  }
  if (values.weightKg && values.fatFreeMassKg && values.bodyFatMassKg && Math.abs(values.fatFreeMassKg + values.bodyFatMassKg - values.weightKg) > 2) {
    warnings.push('La suma de masa libre de grasa y masa grasa no coincide con el peso');
  }
  if (values.weightKg && values.heightCm && values.bmi) {
    const calculated = values.weightKg / ((values.heightCm / 100) ** 2);
    if (Math.abs(calculated - values.bmi) > 1) warnings.push('El IMC no coincide con la estatura y el peso');
  }
  return warnings;
}

const ranges: Partial<Record<InBodyMetricKey, [number, number]>> = {
  heightCm: [100, 230], weightKg: [20, 400], skeletalMuscleMassKg: [5, 120], bodyFatMassKg: [0, 250],
  percentBodyFat: [1, 75], bmi: [10, 80], totalBodyWaterL: [10, 120], proteinKg: [2, 35], mineralsKg: [1, 15],
  softLeanMassKg: [15, 250], fatFreeMassKg: [15, 250], inBodyScore: [0, 120], visceralFatLevel: [1, 30],
  ecwRatio: [0.3, 0.5], basalMetabolicRateKcal: [500, 5000], waistHipRatio: [0.5, 1.5],
  waistCircumferenceCm: [40, 250], targetWeightKg: [20, 400], weightControlKg: [-150, 150],
  fatControlKg: [-150, 150], muscleControlKg: [-50, 50], recommendedCalorieIntakeKcal: [500, 8000]
};

const prompt = `Read this InBody body-composition report. It may be the main result sheet or a Body Composition History page.
Return ONLY valid JSON, with no markdown and no explanation, in this exact shape:
{"deviceModel":"InBody580 or null","measurements":[{"testedAt":"YYYY-MM-DDT12:00:00-05:00","values":{"heightCm":173,"weightKg":71.1,"skeletalMuscleMassKg":31.2,"bodyFatMassKg":15.6,"percentBodyFat":21.9,"bmi":23.8,"totalBodyWaterL":40.9,"proteinKg":11,"mineralsKg":3.57,"softLeanMassKg":52.5,"fatFreeMassKg":55.5,"inBodyScore":74,"visceralFatLevel":6,"ecwRatio":0.377,"basalMetabolicRateKcal":1570,"waistHipRatio":0.92,"waistCircumferenceCm":87.9,"targetWeightKg":65.8,"weightControlKg":-5.3,"fatControlKg":-5.7,"muscleControlKg":0.4,"recommendedCalorieIntakeKcal":2620},"confidence":{"weightKg":0.99}}],"warnings":[]}
Rules:
- Extract every dated measurement visible in history charts, not just the latest.
- Use the canonical metric keys shown above and omit fields that are not visible. Never guess a value.
- Convert dates printed as DD.MM.YY or DD.MM.YYYY to ISO. Panama time is UTC-05:00; use noon when no time is printed.
- Use decimal points in JSON. Keep negative signs in control values.
- Do not return patient name, ID, birth date, diagnosis, recommendations or medical interpretation.
- confidence is 0 to 1 for each extracted value.`;

function apiError(payload: unknown, status: number) {
  const body = payload as { errors?: Array<{ message?: string }>; error?: string };
  const detail = body?.errors?.map(error => error.message).filter(Boolean).join('; ') || body?.error;
  if (status === 401 || status === 403) return new Error('El token de Cloudflare no tiene permiso para Workers AI');
  return new Error(detail || `Cloudflare AI respondió con estado ${status}`);
}

function jsonFromModel(value: unknown) {
  if (typeof value === 'object' && value !== null) return value;
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('El lector no devolvió resultados estructurados');
  return JSON.parse(text.slice(start, end + 1));
}

async function cloudflareRequest(path: string, init: RequestInit) {
  if (!inbodyAnalysisReady) throw new Error('El análisis automático aún no está configurado');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(90000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !(payload as { success?: boolean }).success) throw apiError(payload, response.status);
  return payload as { result?: unknown };
}

export async function extractInBodyImage(imageUrl: string) {
  const model = config.CLOUDFLARE_VISION_MODEL.split('/').map(encodeURIComponent).join('/');
  const payload = await cloudflareRequest(`/ai/run/${model}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'query', image: imageUrl, question: prompt, reasoning: false, temperature: 0, max_tokens: 4096, stream: false })
  });
  const result = payload.result as { answer?: unknown; response?: unknown } | undefined;
  return extractionSchema.parse(jsonFromModel(result?.answer ?? result?.response ?? result));
}

export async function extractInBodyDocument(body: Buffer, fileName: string, contentType: string) {
  const form = new FormData();
  form.append('files', new Blob([Uint8Array.from(body)], { type: contentType }), fileName);
  form.append('conversionOptions', JSON.stringify({ output: { format: 'text' }, pdf: { metadata: false } }));
  const converted = await cloudflareRequest('/ai/tomarkdown', { method: 'POST', body: form });
  const pages = converted.result as Array<{ data?: string; error?: string }>;
  const text = pages?.map(page => page.data || '').join('\n').trim();
  if (!text) throw new Error(pages?.[0]?.error || 'No fue posible leer el contenido del PDF');
  const model = config.CLOUDFLARE_TEXT_MODEL.split('/').map(encodeURIComponent).join('/');
  const payload = await cloudflareRequest(`/ai/run/${model}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'system', content: prompt }, { role: 'user', content: `Texto extraído del reporte:\n${text.slice(0, 30000)}` }], temperature: 0, max_tokens: 4096 })
  });
  const result = payload.result as { response?: unknown; answer?: unknown } | undefined;
  return extractionSchema.parse(jsonFromModel(result?.response ?? result?.answer ?? result));
}

function numberValue(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s/g, '').replace(',', '.').replace(/[^0-9.+-]/g, '');
  const parsed = Number(normalized); return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(value: string) {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const parsed = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T12:00:00-05:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const match = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    const parsed = new Date(`${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}T12:00:00-05:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const direct = new Date(value);
  return Number.isNaN(direct.getTime()) ? null : direct.toISOString();
}

export function validateExtraction(raw: z.infer<typeof extractionSchema>) {
  const validated: ValidatedMeasurement[] = [];
  for (const measurement of raw.measurements) {
    const warnings = [...raw.warnings]; const testedAt = isoDate(measurement.testedAt);
    if (!testedAt) { warnings.push(`Fecha no reconocida: ${measurement.testedAt}`); continue; }
    const values: InBodyValues = {}; const confidence: Record<string, number> = {};
    for (const key of metricKeys) {
      const value = numberValue(measurement.values[key]); if (value === null) continue;
      const range = ranges[key];
      if (range && (value < range[0] || value > range[1])) { warnings.push(`${key} fuera de rango plausible (${value})`); continue; }
      values[key] = value; confidence[key] = measurement.confidence[key] ?? 0.7;
    }
    warnings.push(...validateInBodyValues(values, false));
    if (Object.keys(values).length) validated.push({ testedAt, values, confidence, warnings: [...new Set(warnings)] });
  }
  return { deviceModel: raw.deviceModel || null, measurements: validated };
}
