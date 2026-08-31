// Proponer una rutina con IA a partir de lo que escribe la entrenadora.
//
// La propuesta se ata al catálogo de ejercicios: el modelo sólo puede elegir
// nombres que ya existen. Si inventara ejercicios, la rutina saldría sin video
// —el cliente entrena solo mirando el video— y sin las indicaciones que Eileen
// escribió para cada uno. Lo que no esté en el catálogo se descarta.
//
// Nunca se guarda sola: devuelve un borrador que la entrenadora revisa, edita y
// aprueba. Es su criterio el que asigna una rutina a una persona, no el modelo.
import { config } from './config.js';

export const routineSuggestionsReady = Boolean(config.DEEPSEEK_API_KEY);

export type CatalogEntry = { name: string; section: string; level?: string | null; machine?: string | null };
export type HistoryEntry = { title: string; assignedOn: string | null; sections: string[] };

export type SuggestedRoutine = {
  title: string;
  description: string;
  sessionsPerWeek: number;
  exercises: Array<{ name: string; sets?: number; reps?: string; notes?: string }>;
  rationale: string;
  avoided: string[];
};

const SECCIONES: Record<string, string> = {
  tren_inferior: 'tren inferior',
  tren_superior: 'tren superior',
  core: 'core',
  cardio: 'cardio',
  hit: 'HIT'
};

function apiError(payload: unknown, status: number) {
  const cuerpo = payload as { error?: { message?: string } };
  return new Error(cuerpo?.error?.message || `DeepSeek respondió ${status}`);
}

export async function suggestRoutine(entrada: {
  descripcion: string;
  catalogo: CatalogEntry[];
  historial: HistoryEntry[];
  condiciones: string[];
  repetirGrupos: boolean;
  clienteNombre?: string;
}) {
  if (!routineSuggestionsReady) throw new Error('Falta configurar la clave de DeepSeek');

  const gruposRecientes = [...new Set(entrada.historial.flatMap(item => item.sections))];
  const evitar = entrada.repetirGrupos ? [] : gruposRecientes;

  const instrucciones = [
    'Eres asistente de una entrenadora personal en Panamá. Propones rutinas, no las apruebas.',
    'Elige ejercicios ÚNICAMENTE de la lista del catálogo, copiando el nombre exacto. No inventes ejercicios.',
    'Responde sólo JSON válido con esta forma: {"title":string,"description":string,"sessionsPerWeek":number,'
      + '"exercises":[{"name":string,"sets":number,"reps":string,"notes":string}],"rationale":string}',
    'Entre 4 y 10 ejercicios. "reps" es texto libre ("12", "30 seg", "10 por lado").',
    'El campo rationale explica en una o dos frases por qué elegiste ese enfoque, en español.'
  ];

  if (entrada.condiciones.length) {
    instrucciones.push(
      `El cliente tiene estas lesiones o condiciones: ${entrada.condiciones.join('; ')}. `
      + 'Evita los ejercicios que las agraven y dilo en las notas del ejercicio cuando sea relevante.'
    );
  }
  if (evitar.length) {
    instrucciones.push(
      `En sus rutinas recientes ya se trabajó: ${evitar.map(s => SECCIONES[s] || s).join(', ')}. `
      + 'Prioriza los grupos musculares que NO aparecen ahí, para no repetir. Si la descripción de la '
      + 'entrenadora pide expresamente uno de esos grupos, respétala: su instrucción manda.'
    );
  } else if (entrada.repetirGrupos) {
    instrucciones.push('La entrenadora pidió repetir los mismos grupos musculares aunque se hayan trabajado hace poco.');
  }

  const catalogoTexto = entrada.catalogo
    .map(e => `- ${e.name} [${SECCIONES[e.section] || e.section}]${e.machine ? ` (${e.machine})` : ''}`)
    .join('\n');
  const historialTexto = entrada.historial.length
    ? entrada.historial.map(h => `- ${h.assignedOn || 'sin fecha'}: ${h.title} → ${h.sections.map(s => SECCIONES[s] || s).join(', ') || 'sin clasificar'}`).join('\n')
    : 'Sin rutinas previas registradas.';

  const respuesta = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      temperature: 0.4,
      response_format: { type: 'json_object' },
      max_tokens: 2000,
      messages: [
        { role: 'system', content: instrucciones.join('\n') },
        {
          role: 'user',
          content: [
            entrada.clienteNombre ? `Cliente: ${entrada.clienteNombre}` : 'Rutina sin cliente asignado todavía.',
            `Lo que pide la entrenadora: ${entrada.descripcion}`,
            '',
            'Rutinas recientes de este cliente:',
            historialTexto,
            '',
            'Catálogo disponible (usa estos nombres exactos):',
            catalogoTexto
          ].join('\n')
        }
      ]
    }),
    signal: AbortSignal.timeout(90000)
  });

  const payload = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) throw apiError(payload, respuesta.status);

  const eleccion = (payload as { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }> }).choices?.[0];
  if (!eleccion?.message?.content && eleccion?.finish_reason === 'length') {
    throw new Error('El modelo agotó el presupuesto de tokens antes de escribir la respuesta');
  }
  let cruda: Record<string, unknown>;
  try { cruda = JSON.parse(String(eleccion?.message?.content ?? '')); }
  catch { throw new Error('El modelo no devolvió una rutina legible'); }

  // Se filtra contra el catálogo: lo que el modelo se haya inventado no entra.
  const porNombre = new Map(entrada.catalogo.map(e => [e.name.toLowerCase(), e]));
  const propuestos = Array.isArray(cruda.exercises) ? cruda.exercises : [];
  const descartados: string[] = [];
  const ejercicios = propuestos.flatMap((item: Record<string, unknown>) => {
    const nombre = String(item?.name ?? '').trim();
    const encontrado = porNombre.get(nombre.toLowerCase());
    if (!encontrado) { if (nombre) descartados.push(nombre); return []; }
    const series = Number(item?.sets);
    return [{
      name: encontrado.name,
      sets: Number.isFinite(series) && series >= 1 && series <= 20 ? Math.round(series) : 3,
      reps: String(item?.reps ?? '').slice(0, 40) || '12',
      notes: String(item?.notes ?? '').slice(0, 300) || undefined
    }];
  });

  if (!ejercicios.length) throw new Error('La propuesta no incluyó ningún ejercicio del catálogo. Prueba a describirla de otra forma.');

  const semanales = Number(cruda.sessionsPerWeek);
  return {
    title: String(cruda.title ?? '').trim().slice(0, 120) || 'Rutina propuesta',
    description: String(cruda.description ?? '').trim().slice(0, 400),
    sessionsPerWeek: Number.isFinite(semanales) && semanales >= 1 && semanales <= 7 ? Math.round(semanales) : 3,
    exercises: ejercicios,
    rationale: String(cruda.rationale ?? '').trim().slice(0, 500),
    avoided: evitar.map(s => SECCIONES[s] || s),
    descartados
  };
}
