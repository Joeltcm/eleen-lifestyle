// Criterio de Joel para "modificar" una rutina: solo cuenta agregar, quitar o cambiar un ejercicio; reordenar o cambiar series/repeticiones/peso/notas/bloques NO.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exerciseIdentities, exerciseSetKey, exercisesHash, sameExerciseSet, routineSummaryText } from '../dist/routine-utils.js';

const A = { catalogId: 'a', name: 'Sentadilla', sets: 3, reps: '10', weight: '10 lb' };
const B = { catalogId: 'b', name: 'Zancada', sets: 3, reps: '12', weight: '5 lb' };
const C = { name: 'Puente  de Glúteos', sets: 3, reps: '20' };
const D = { catalogId: 'd', name: 'Plancha' };

test('el conjunto de ejercicios ignora el orden y los parámetros, pero no agregar/quitar/cambiar', () => {
  assert.equal(exercisesHash([A, B, C]), exercisesHash([C, A, B]), 'reordenar no es modificar');
  assert.equal(exercisesHash([A, B, C]), exercisesHash([{ ...A, weight: '40 lb', reps: '5', sets: 5, notes: 'x', block: 2, rounds: 4 }, B, C]), 'series/repeticiones/peso/notas/bloque no son modificar');
  assert.notEqual(exercisesHash([A, B, C]), exercisesHash([A, B, D]), 'cambiar un ejercicio por otro SÍ');
  assert.notEqual(exercisesHash([A, B, C]), exercisesHash([A, B]), 'quitar SÍ');
  assert.notEqual(exercisesHash([A, B]), exercisesHash([A, B, C]), 'agregar SÍ');
  assert.notEqual(exercisesHash([A, B, B]), exercisesHash([A, B]), 'quitar uno de dos repetidos SÍ');
  assert.equal(sameExerciseSet([A, B, C], [B, C, A]), true); assert.equal(sameExerciseSet([A, B], [A, B, B]), false);
  assert.deepEqual(exerciseSetKey([C, A]), ['catalog:a', 'name:puente de gluteos'], 'sin catálogo: nombre normalizado (sin acentos ni espacios dobles)');
  assert.deepEqual(exerciseIdentities([C, A]), ['name:puente de gluteos', 'catalog:a'], 'exerciseIdentities conserva el orden de la rutina');
});

test('resumen en texto: dentro de un bloque no se repiten las series, sin bloques sí, y sin líneas en blanco de más', () => {
  const conBloques = routineSummaryText({ title: 'Piernas', version: 1, sessionsPerWeek: 2, dueOn: '2026-10-11', exercises: [{ ...A, block: 1, rounds: 3 }, { ...B, block: 1, rounds: 3 }, { ...C, block: 2, rounds: 4, sets: 4 }] });
  assert.match(conBloques, /Bloque 1 · 3 rondas/); assert.match(conBloques, /1\. Sentadilla — 10 · peso 10 lb/);
  assert.doesNotMatch(conBloques, /series/, 'en bloques las series son las rondas');
  assert.match(conBloques, /Fecha límite: 11-10-2026\n\nBloque 1/);
  const simple = routineSummaryText({ title: 'Simple', version: 2, sessionsPerWeek: 1, exercises: [A, C] });
  assert.match(simple, /^Simple \(v2\) · 2 ejercicios · 1 sesión por semana\n\n  1\. Sentadilla — 3 series × 10 · peso 10 lb\n  2\. Puente  de Glúteos — 3 series × 20$/);
  assert.doesNotMatch(simple, /\n\n\n/, 'sin tres saltos seguidos');
});
