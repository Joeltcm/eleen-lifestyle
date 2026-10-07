import { createHash } from 'node:crypto';

export type RoutineExerciseForSummary = {
  catalogId?: string;
  name?: string;
  sets?: number;
  reps?: string;
  weight?: string;
  notes?: string;
  block?: number;
  rounds?: number;
};

export type RoutineForSummary = {
  title: string;
  version?: number | null;
  description?: string | null;
  sessionsPerWeek?: number | null;
  dueOn?: string | null;
  exercises?: RoutineExerciseForSummary[] | null;
};

/**
 * Identidad de ejercicio para comparar rutinas sin confundir parámetros de
 * trabajo con el ejercicio elegido. Devuelve una por ejercicio, en el orden de la rutina
 * (para comparar conjuntos usa exerciseSetKey / sameExerciseSet, que ignoran el orden).
 */
export function exerciseIdentities(exercises: RoutineExerciseForSummary[] = []): string[] {
  return exercises.map(exercise => {
    const catalogId = String(exercise?.catalogId ?? '').trim();
    if (catalogId) return `catalog:${catalogId}`;
    return `name:${String(exercise?.name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`;
  });
}

/**
 * Clave del CONJUNTO de ejercicios: las identidades ordenadas (un repetido cuenta tantas veces como aparece). Reordenar no la cambia;
 * agregar, quitar o cambiar un ejercicio sí. Es el criterio de Joel para "modificar" una rutina y para el aviso de envíos repetidos.
 */
export function exerciseSetKey(exercises: RoutineExerciseForSummary[] = []): string[] {
  return [...exerciseIdentities(exercises)].sort();
}

export function sameExerciseSet(a: RoutineExerciseForSummary[] = [], b: RoutineExerciseForSummary[] = []): boolean {
  const left = exerciseSetKey(a); const right = exerciseSetKey(b);
  return left.length === right.length && left.every((identity, index) => identity === right[index]);
}

export function exercisesHash(exercises: RoutineExerciseForSummary[] = []): string {
  return createHash('sha256').update(JSON.stringify(exerciseSetKey(exercises))).digest('hex');
}

function fechaPanama(value: string): string {
  const [year, month, day] = String(value).slice(0, 10).split('-');
  return year && month && day ? `${day}-${month}-${year}` : String(value);
}

function textoNumero(value: unknown): string {
  return String(value ?? '').trim();
}

function detalleEjercicio(exercise: RoutineExerciseForSummary, enBloque = false): string {
  // Dentro de un bloque `sets` es el número de rondas del bloque (ya va en su encabezado): repetirlo como "3 series" se leería como 9.
  const sets = !enBloque && Number.isFinite(Number(exercise.sets)) && Number(exercise.sets) > 0 ? `${Number(exercise.sets)} series` : '';
  const reps = textoNumero(exercise.reps);
  const cantidad = sets && reps ? `${sets} × ${reps}` : sets || reps;
  const peso = textoNumero(exercise.weight);
  return `${cantidad}${peso ? ` · peso ${peso}` : ''}`;
}

function tituloEjercicio(exercise: RoutineExerciseForSummary): string {
  return textoNumero(exercise.name) || 'Ejercicio sin nombre';
}

/** Genera una foto textual, legible y copiable de la rutina en el momento del envío. */
export function routineSummaryText(routine: RoutineForSummary): string {
  const exercises = Array.isArray(routine.exercises) ? routine.exercises : [];
  const version = Number(routine.version || 1);
  const sesiones = Number(routine.sessionsPerWeek || 0);
  const sesionesTexto = sesiones === 1 ? '1 sesión por semana' : `${sesiones} sesiones por semana`;
  const encabezado = `${textoNumero(routine.title) || 'Rutina'} (v${version}) · ${exercises.length} ejercicio${exercises.length === 1 ? '' : 's'} · ${sesionesTexto}`;
  const lineas: string[] = [encabezado, ''];
  if (routine.dueOn) lineas.push(`Fecha límite: ${fechaPanama(routine.dueOn)}`, '');

  const bloques = [...new Set(exercises.map(exercise => Number(exercise.block)).filter(block => Number.isInteger(block) && block > 0))] as number[];
  if (!bloques.length) {
    exercises.forEach((exercise, index) => {
      lineas.push(`  ${index + 1}. ${tituloEjercicio(exercise)}${detalleEjercicio(exercise) ? ` — ${detalleEjercicio(exercise)}` : ''}`);
      if (textoNumero(exercise.notes)) lineas.push(`     Nota: ${textoNumero(exercise.notes)}`);
    });
  } else {
    const usados = new Set<number>();
    let numero = 0;
    for (const bloque of bloques) {
      const delBloque = exercises.filter(exercise => Number(exercise.block) === bloque);
      delBloque.forEach(exercise => usados.add(exercises.indexOf(exercise)));
      const rondas = delBloque.map(exercise => Number(exercise.rounds)).find(value => Number.isInteger(value) && value > 0);
      lineas.push(`Bloque ${bloque}${rondas ? ` · ${rondas} rondas` : ''}`);
      delBloque.forEach(exercise => {
        numero += 1;
        lineas.push(`  ${numero}. ${tituloEjercicio(exercise)}${detalleEjercicio(exercise, true) ? ` — ${detalleEjercicio(exercise, true)}` : ''}`);
        if (textoNumero(exercise.notes)) lineas.push(`     Nota: ${textoNumero(exercise.notes)}`);
      });
    }
    exercises.forEach((exercise, index) => {
      if (usados.has(index)) return;
      numero += 1;
      lineas.push(`  ${numero}. ${tituloEjercicio(exercise)}${detalleEjercicio(exercise) ? ` — ${detalleEjercicio(exercise)}` : ''}`);
      if (textoNumero(exercise.notes)) lineas.push(`     Nota: ${textoNumero(exercise.notes)}`);
    });
  }
  return lineas.filter((line, index) => !(index === lineas.length - 1 && line === '')).join('\n');
}
