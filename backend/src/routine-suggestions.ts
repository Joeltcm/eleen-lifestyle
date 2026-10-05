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

export type CatalogEntry = { name: string; section: string; level?: string | null; machine?: string | null; freeWeight?: string | null };
export type HistoryEntry = { title: string; assignedOn: string | null; sections: string[] };

export type SuggestedRoutine = {
  title: string;
  description: string;
  sessionsPerWeek: number;
  exercises: Array<{ name: string; sets?: number; reps?: string; notes?: string; block?: number; rounds?: number }>;
  rationale: string;
  avoided: string[];
};

const textoSeguro = (value: unknown, fallback: string, max = 500) => {
  const texto = String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
  return texto || fallback;
};

export function formatRoutineDescription(partes: { objective?: unknown; warmup?: unknown; cooldown?: unknown; stretching?: unknown }) {
  return [
    `OBJETIVO\n${textoSeguro(partes.objective, 'Entrenamiento personalizado según la indicación de la entrenadora.')}`,
    `CALENTAMIENTO · 5–10 MINUTOS\n${textoSeguro(partes.warmup, 'Realiza movilidad suave y aumenta gradualmente la intensidad antes de comenzar.')}`,
    'EJERCICIOS PRINCIPALES\nRealiza los ejercicios que aparecen abajo en el orden indicado. Respeta las series, repeticiones y notas de cada ejercicio.',
    `VUELTA A LA CALMA · 3–5 MINUTOS\n${textoSeguro(partes.cooldown, 'Baja poco a poco la intensidad, camina suavemente y controla la respiración.')}`,
    `ESTIRAMIENTOS · 5–8 MINUTOS\n${textoSeguro(partes.stretching, 'Termina con estiramientos suaves, sin rebotes y sin llegar al dolor.')}`
  ].join('\n\n');
}

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
  // Rutina para que el cliente la haga por su cuenta (clase cancelada): se dimensiona a la duración de la clase y la descripción son las instrucciones que él leerá.
  paraCliente?: boolean;
  duracionMinutos?: number;
  // Rutina para un cliente que viaja (J-107): sin máquinas ni equipo, que se pueda hacer en un cuarto de hotel o con peso corporal.
  paraViaje?: boolean;
}) {
  if (!routineSuggestionsReady) throw new Error('Falta configurar la clave de DeepSeek');

  const gruposRecientes = [...new Set(entrada.historial.flatMap(item => item.sections))];
  const evitar = entrada.repetirGrupos ? [] : gruposRecientes;

  const instrucciones = [
    'Eres asistente de una entrenadora personal en Panamá. Propones rutinas, no las apruebas.',
    'Elige ejercicios ÚNICAMENTE de la lista del catálogo, copiando el nombre exacto. No inventes ejercicios.',
    // La entrenadora escribe una línea breve (J-111), p. ej. "45 minutos, espalda, tríceps y pierna; tiene mancuernas y bandas". Es la autoridad: ella sabe con qué cuenta el cliente.
    'Lo que escribe la entrenadora MANDA: si indica la duración, los grupos musculares a trabajar o el equipo o lugar con que cuenta el cliente, respétalo. '
      + 'Si dice qué equipo tiene disponible, elige ÚNICAMENTE ejercicios del catálogo que se puedan hacer con ese equipo y no incluyas ejercicios que requieran otro. '
      + 'En el catálogo, la máquina y el peso libre de cada ejercicio aparecen entre paréntesis; "peso corporal" significa que no requiere equipo.',
    'Responde sólo JSON válido con esta forma: {"title":string,"description":string,"warmup":string,"cooldown":string,"stretching":string,"sessionsPerWeek":number,'
      + '"exercises":[{"name":string,"sets":number,"reps":string,"notes":string,"block":number,"rounds":number}],"rationale":string}',
    // Bloques (J-113): Eileen arma sus rutinas en circuitos, p. ej. "3 rondas de los primeros 3 ejercicios y otras 3 rondas del segundo bloque de tres".
    'ESTRUCTURA EN BLOQUES: organiza la rutina en bloques (circuitos). Cada ejercicio lleva "block" (1, 2, 3…, en el orden en que se hacen) y "rounds" (cuántas rondas se repite ese bloque; es el MISMO número para todos los ejercicios del bloque). '
      + 'En un bloque se hacen sus ejercicios seguidos, en orden, y se repite el bloque "rounds" veces; por eso "sets" debe ser igual a "rounds" y "reps" es lo que se hace en cada ronda. '
      + 'Por omisión usa bloques de 3 ejercicios (2 a 4 si hace falta) y 3 rondas por bloque. Si la entrenadora indica otra estructura (por ejemplo "2 bloques de 4 ejercicios, 4 rondas cada uno"), respétala. '
      + 'Solo si la entrenadora pide expresamente ejercicios sueltos por series, omite "block" y "rounds".',
    'Entre 4 y 10 ejercicios. "reps" es texto libre ("12", "30 seg", "10 por lado").',
    'El campo description resume el objetivo. Los campos warmup, cooldown y stretching son obligatorios: escribe instrucciones concretas, en español, con duración aproximada y sin dejarlos vacíos.',
    'warmup debe explicar cómo preparar el cuerpo; cooldown debe indicar cómo bajar la intensidad y respirar; stretching debe nombrar los estiramientos recomendados y cómo hacerlos sin dolor.',
    'La sección de ejercicios principales se mostrará con la lista de ejercicios, por lo que no la repitas dentro de description.',
    'El campo rationale explica en una o dos frases por qué elegiste ese enfoque, en español.'
  ];

  if (entrada.paraCliente) {
    instrucciones.push(
      'Esta rutina la hará el cliente POR SU CUENTA, sin entrenadora al lado, en lugar de su clase cancelada. '
      + `Dimensiónala para unos ${entrada.duracionMinutos || 45} minutos en total, calentamiento incluido (salvo que la entrenadora indique otra duración), con ejercicios simples de ejecutar solo y con buena técnica. `
      + 'El campo "description" son las INSTRUCCIONES para el cliente, escritas en segunda persona (tú) y en español: cómo calentar unos 5 minutos, cuánto descansar entre series, '
      + 'a qué esfuerzo trabajar, que mire la demostración en video de cada ejercicio antes de hacerlo y que pare si siente dolor. Máximo 450 caracteres, sin listas largas. '
      + 'En "notes" de cada ejercicio escribe una pista corta de técnica para esa persona.'
    );
  }
  if (entrada.paraViaje) {
    instrucciones.push(
      'El cliente está DE VIAJE y la hará por su cuenta, fuera de su gimnasio habitual. Si la entrenadora NO dice con qué equipo cuenta, supón peso corporal o bandas y evita lo que necesite máquina, barra o aparatos grandes; '
      + 'si lo dice, lo que ella indique manda. En "description" incluye una indicación de que puede hacerla en cualquier día del viaje y que descanse bien entre series.'
    );
  }
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
    .map(e => {
      const libre = e.freeWeight && !/^no aplica/i.test(e.freeWeight) ? `peso libre: ${e.freeWeight}` : '';
      const maquina = e.machine && !/^no aplica/i.test(e.machine) ? `máquina: ${e.machine}` : '';
      return `- ${e.name} [${SECCIONES[e.section] || e.section}] (${[maquina, libre].filter(Boolean).join('; ') || 'peso corporal'})`;
    })
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
    const bloque = Number(item?.block); const rondas = Number(item?.rounds);
    return [{
      name: encontrado.name,
      sets: Number.isFinite(series) && series >= 1 && series <= 20 ? Math.round(series) : 3,
      reps: String(item?.reps ?? '').slice(0, 40) || '12',
      notes: String(item?.notes ?? '').slice(0, 300) || undefined,
      block: Number.isFinite(bloque) && bloque >= 1 && bloque <= 20 ? Math.round(bloque) : undefined,
      rounds: Number.isFinite(rondas) && rondas >= 1 && rondas <= 10 ? Math.round(rondas) : undefined
    }];
  });

  if (!ejercicios.length) throw new Error('La propuesta no incluyó ningún ejercicio del catálogo. Prueba a describirla de otra forma.');
  normalizarBloques(ejercicios);

  const semanales = Number(cruda.sessionsPerWeek);
  return {
    title: String(cruda.title ?? '').trim().slice(0, 120) || 'Rutina propuesta',
    description: formatRoutineDescription({ objective: cruda.description, warmup: cruda.warmup, cooldown: cruda.cooldown, stretching: cruda.stretching }),
    sessionsPerWeek: Number.isFinite(semanales) && semanales >= 1 && semanales <= 7 ? Math.round(semanales) : 3,
    exercises: ejercicios,
    rationale: String(cruda.rationale ?? '').trim().slice(0, 500),
    avoided: evitar.map(s => SECCIONES[s] || s),
    descartados
  };
}

// Deja los bloques coherentes aunque el modelo se equivoque: sin números repetidos fuera de orden, todos los ejercicios de un bloque con las mismas rondas (las del primero) y "sets" igual a
// "rounds". Un ejercicio sin bloque entre otros con bloque se queda en el bloque del anterior; si ninguno trae bloque, la rutina queda como lista de ejercicios sueltos.
export function normalizarBloques(ejercicios: Array<{ sets?: number; block?: number; rounds?: number }>) {
  if (!ejercicios.some(item => item.block)) { ejercicios.forEach(item => { delete item.block; delete item.rounds; }); return; }
  let anterior: number | undefined;
  for (const item of ejercicios) { if (!item.block) item.block = anterior ?? 1; anterior = item.block; }
  const orden = ejercicios.map((item, posicion) => ({ item, posicion })).sort((a, b) => (a.item.block! - b.item.block!) || (a.posicion - b.posicion)).map(entrada => entrada.item);
  ejercicios.splice(0, ejercicios.length, ...orden);
  const numeros = new Map<number, number>(); const rondas = new Map<number, number>();
  for (const item of ejercicios) {
    if (!numeros.has(item.block!)) numeros.set(item.block!, numeros.size + 1);
    const nuevo = numeros.get(item.block!)!;
    if (!rondas.has(nuevo)) rondas.set(nuevo, item.rounds ?? 3);
    item.block = nuevo; item.rounds = rondas.get(nuevo); item.sets = item.rounds;
  }
}
