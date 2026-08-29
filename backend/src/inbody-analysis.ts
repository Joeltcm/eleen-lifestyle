import { z } from 'zod';
import sharp from 'sharp';
import { config } from './config.js';

const cloudflareReady = Boolean(config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_API_TOKEN);
const deepseekReady = Boolean(config.DEEPSEEK_API_KEY);

export const inbodyAnalysisProvider = config.INBODY_ANALYSIS_PROVIDER;
export const inbodyAnalysisReady = inbodyAnalysisProvider === 'deepseek' ? deepseekReady : cloudflareReady;
export const inbodyAnalysisSetup = inbodyAnalysisProvider === 'deepseek'
  ? 'Agrega DEEPSEEK_API_KEY a Railway. El análisis visual usa DeepSeek Vision.'
  : 'Agrega a Railway un token de Cloudflare con permisos Workers AI Read y Edit.';

const metricKeys = [
  'heightCm', 'weightKg', 'skeletalMuscleMassKg', 'bodyFatMassKg', 'percentBodyFat', 'bmi',
  'inBodyScore', 'visceralFatLevel', 'ecwRatio'
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
  if (values.weightKg && values.heightCm && values.bmi) {
    const calculated = values.weightKg / ((values.heightCm / 100) ** 2);
    if (Math.abs(calculated - values.bmi) > 1) warnings.push('El IMC no coincide con la estatura y el peso');
  }
  return warnings;
}

const ranges: Partial<Record<InBodyMetricKey, [number, number]>> = {
  heightCm: [100, 230], weightKg: [20, 400], skeletalMuscleMassKg: [5, 120], bodyFatMassKg: [0, 250],
  percentBodyFat: [1, 75], bmi: [10, 80], inBodyScore: [0, 120], visceralFatLevel: [1, 30],
  ecwRatio: [0.3, 0.5]
};

const canonicalKeys = metricKeys.join(', ');
const prompt = `Read this InBody body-composition report and return ONLY valid JSON with these top-level keys:
- deviceModel: the machine model as a string, or null.
- measurements: an array of objects. Each object must contain testedAt, values, and confidence.
- warnings: an array of short data-quality messages.

The values object may only use these canonical keys: ${canonicalKeys}.

Report-type rules:
- MAIN RESULT SHEET: return exactly ONE measurement. Read testedAt only from the top header labeled "Test Date / Time". Ignore the miniature "Body Composition History" graph at the bottom because separate history pages are processed independently.
- BODY COMPOSITION HISTORY PAGE: return one measurement for every dated column in the charts. Combine all metric rows that share a date. Do not interpret a header date range as a measurement.

General rules:
- Convert DD.MM.YY and DD.MM.YYYY dates to ISO 8601. Panama is UTC-05:00; use noon when no exact time is readable.
- Omit any metric that is not clearly visible. Never infer or guess a number.
- Use decimal points and preserve negative signs.
- confidence is an object of 0-to-1 scores by metric; use an empty object when uncertain.
- Never return patient name, ID, birth date, diagnosis, recommendations, or medical interpretation.`;

function apiError(payload: unknown, status: number, provider = 'Cloudflare') {
  const body = payload as { errors?: Array<{ message?: string }>; error?: string | { message?: string } };
  const errorMessage = typeof body?.error === 'string' ? body.error : body?.error?.message;
  const detail = body?.errors?.map(error => error.message).filter(Boolean).join('; ') || errorMessage;
  if (status === 401 || status === 403) return new Error(provider === 'DeepSeek'
    ? 'La clave de DeepSeek no es válida o no tiene acceso al modelo de visión'
    : 'El token de Cloudflare no tiene permiso para Workers AI');
  return new Error(detail || `${provider} respondió con estado ${status}`);
}

function jsonFromModel(value: unknown) {
  if (typeof value === 'object' && value !== null) return value;
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('El lector no devolvió resultados estructurados');
  return JSON.parse(text.slice(start, end + 1));
}

async function cloudflareRequest(path: string, init: RequestInit) {
  if (!cloudflareReady) throw new Error('El análisis de documentos PDF requiere configurar Cloudflare como proveedor alternativo');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(90000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !(payload as { success?: boolean }).success) throw apiError(payload, response.status);
  return payload as { result?: unknown };
}

async function extractWithCloudflare(imageUrl: string, fileName = '') {
  const model = config.CLOUDFLARE_VISION_MODEL.split('/').map(encodeURIComponent).join('/');
  const payload = await cloudflareRequest(`/ai/run/${model}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'You extract body-composition report data. Return only valid JSON and never include patient identity.' },
        { role: 'user', content: [{ type: 'text', text: `${prompt}\nSource filename: ${fileName || 'not provided'}.` }, { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } }] }
      ],
      response_format: { type: 'json_object' }, temperature: 0, max_completion_tokens: 1500,
      chat_template_kwargs: { enable_thinking: false }, stream: false
    })
  });
  const outer = payload.result as { result?: unknown } | undefined;
  const result = (outer?.result ?? outer) as { answer?: unknown; response?: unknown; choices?: Array<{ message?: { content?: unknown } }> } | undefined;
  return extractionSchema.parse(jsonFromModel(result?.choices?.[0]?.message?.content ?? result?.answer ?? result?.response ?? result));
}

async function deepseekRequest(body: unknown) {
  if (!deepseekReady) throw new Error('Falta configurar la clave de DeepSeek');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw apiError(payload, response.status, 'DeepSeek');
  return payload as { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }> };
}

async function extractWithDeepSeek(imageUrl: string, fileName = '') {
  const payload = await deepseekRequest({
    model: config.DEEPSEEK_VISION_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    // Leer cifras de un reporte es transcripción, no razonamiento. Con el modo
    // de pensamiento activo (el de fábrica) el modelo gastaba el presupuesto
    // completo razonando y devolvía el contenido vacío.
    thinking: { type: 'disabled' },
    max_tokens: 4000,
    messages: [
      { role: 'system', content: 'You extract body-composition report data. Return only valid JSON and never include patient identity.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: `${prompt}\nSource filename: ${fileName || 'not provided'}.` },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }
    ]
  });
  const choice = payload.choices?.[0];
  if (!choice?.message?.content && choice?.finish_reason === 'length') {
    throw new Error('El modelo agotó el presupuesto de tokens antes de escribir la respuesta');
  }
  return extractionSchema.parse(jsonFromModel(choice?.message?.content));
}

export async function extractInBodyImage(imageUrl: string, fileName = '') {
  return inbodyAnalysisProvider === 'deepseek'
    ? extractWithDeepSeek(imageUrl, fileName)
    : extractWithCloudflare(imageUrl, fileName);
}

export function isInBodyHistoryImage(fileName: string) {
  return /body[\s_-]*history/i.test(fileName);
}

export async function prepareInBodyImage(body: Buffer, fileName: string) {
  const metadata = await sharp(body).metadata();
  const source = sharp(body);
  const oriented = isInBodyHistoryImage(fileName) && metadata.width && metadata.height && metadata.height > metadata.width
    ? source.rotate(270)
    : source.rotate();
  const rotated = await oriented
    .resize({ width: 1800, withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();
  return `data:image/jpeg;base64,${rotated.toString('base64')}`;
}

export async function extractInBodyDocument(body: Buffer, fileName: string, contentType: string) {
  if (inbodyAnalysisProvider === 'deepseek') {
    throw new Error('DeepSeek Vision procesa páginas de InBody en JPG, PNG o WebP. Exporta el PDF en imágenes para analizarlo.');
  }
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
    body: JSON.stringify({ messages: [{ role: 'system', content: prompt }, { role: 'user', content: `Texto extraído del reporte:\n${text.slice(0, 30000)}` }], response_format: { type: 'json_object' }, temperature: 0, max_completion_tokens: 1500, chat_template_kwargs: { enable_thinking: false }, stream: false })
  });
  const outer = payload.result as { result?: unknown } | undefined;
  const result = (outer?.result ?? outer) as { response?: unknown; answer?: unknown; choices?: Array<{ message?: { content?: unknown } }> } | undefined;
  return extractionSchema.parse(jsonFromModel(result?.choices?.[0]?.message?.content ?? result?.response ?? result?.answer ?? result));
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
  const match = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:\D.*)?$/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    const parsed = new Date(`${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}T12:00:00-05:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const direct = new Date(value);
  return Number.isNaN(direct.getTime()) ? null : direct.toISOString();
}

function allowedMetricsForFile(fileName: string) {
  const historyPage = fileName.match(/body[\s_-]*history[\s_-]*(\d+)/i);
  if (!historyPage) return new Set<InBodyMetricKey>(metricKeys);
  if (historyPage[1] === '0') return new Set<InBodyMetricKey>(['weightKg', 'skeletalMuscleMassKg', 'bodyFatMassKg', 'percentBodyFat', 'ecwRatio']);
  if (historyPage[1] === '1') return new Set<InBodyMetricKey>(['bmi', 'visceralFatLevel']);
  return new Set<InBodyMetricKey>();
}

export function validateExtraction(raw: z.infer<typeof extractionSchema>, fileName = '') {
  const validated: ValidatedMeasurement[] = [];
  const allowedMetrics = allowedMetricsForFile(fileName);
  for (const measurement of raw.measurements) {
    const warnings = [...raw.warnings]; const testedAt = isoDate(measurement.testedAt);
    if (!testedAt) { warnings.push(`Fecha no reconocida: ${measurement.testedAt}`); continue; }
    const values: InBodyValues = {}; const confidence: Record<string, number> = {};
    for (const key of metricKeys) {
      if (!allowedMetrics.has(key)) continue;
      const value = numberValue(measurement.values[key]); if (value === null) continue;
      const range = ranges[key];
      if (range && (value < range[0] || value > range[1])) { warnings.push(`${key} fuera de rango plausible (${value})`); continue; }
      values[key] = value; confidence[key] = Math.min(measurement.confidence[key] ?? 0.7, 0.95);
    }
    warnings.push(...validateInBodyValues(values, false));
    if (Object.keys(values).length) validated.push({ testedAt, values, confidence, warnings: [...new Set(warnings)] });
  }
  return { deviceModel: raw.deviceModel || null, measurements: validated };
}
