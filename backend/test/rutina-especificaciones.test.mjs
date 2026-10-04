// La entrenadora da una especificación breve (J-111): "45 minutos, espalda, tríceps y pierna; tiene mancuernas y bandas". La IA debe tratarla como autoridad y ver con qué se hace cada ejercicio.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://prueba'; process.env.JWT_SECRET = 'j'.repeat(40); process.env.SETUP_TOKEN = 's'.repeat(20); process.env.DEEPSEEK_API_KEY = 'clave-de-prueba';
const { suggestRoutine } = await import('../dist/routine-suggestions.js');

const catalogo = [
  { name: 'Sentadilla', section: 'tren_inferior', machine: 'Smith machine', freeWeight: 'Barra / Mancuernas / Peso corporal' },
  { name: 'Plancha', section: 'core', machine: 'No aplica', freeWeight: 'No aplica' },
  { name: 'Remo con banda', section: 'tren_superior', machine: null, freeWeight: 'Banda elástica' }
];
const base = { catalogo, historial: [], condiciones: [], repetirGrupos: false, clienteNombre: 'Sara' };

async function pedir(extra) {
  let enviado = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, opciones) => {
    enviado = JSON.parse(opciones.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: 'T', description: 'D', sessionsPerWeek: 3, exercises: [{ name: 'Plancha', sets: 3, reps: '30 seg' }, { name: 'Ejercicio inventado', sets: 3, reps: '10' }], rationale: 'r' }) } }] }) };
  };
  try { const propuesta = await suggestRoutine({ ...base, ...extra }); return { propuesta, sistema: enviado.messages[0].content, usuario: enviado.messages[1].content }; }
  finally { globalThis.fetch = original; }
}

test('la línea de la entrenadora llega al modelo como autoridad (duración, grupos y equipo) y el catálogo dice con qué se hace cada ejercicio', async () => {
  const linea = 'Rutina de 45 minutos: espalda, tríceps y pierna. El cliente tiene disponible: mancuernas y bandas.';
  const { sistema, usuario, propuesta } = await pedir({ descripcion: linea });
  assert.match(sistema, /Lo que escribe la entrenadora MANDA/);
  assert.match(sistema, /duración, los grupos musculares a trabajar o el equipo o lugar/);
  assert.match(sistema, /ÚNICAMENTE ejercicios del catálogo que se puedan hacer con ese equipo/);
  assert.ok(usuario.includes(linea), 'la línea llega tal cual');
  assert.match(usuario, /- Sentadilla \[tren inferior\] \(máquina: Smith machine; peso libre: Barra \/ Mancuernas \/ Peso corporal\)/);
  assert.match(usuario, /- Plancha \[core\] \(peso corporal\)/);
  assert.match(usuario, /- Remo con banda \[tren superior\] \(peso libre: Banda elástica\)/);
  assert.deepEqual(propuesta.exercises.map(e => e.name), ['Plancha'], 'lo que no está en el catálogo se sigue descartando');
});

test('en una rutina para el cliente la duración de la clase es solo el valor por omisión; en un viaje se supone peso corporal salvo que ella indique otra cosa', async () => {
  const clase = await pedir({ descripcion: 'Rutina de 30 minutos de tren superior', paraCliente: true, duracionMinutos: 60 });
  assert.match(clase.sistema, /unos 60 minutos en total, calentamiento incluido \(salvo que la entrenadora indique otra duración\)/);
  const viaje = await pedir({ descripcion: 'Rutina de viaje. Tiene gimnasio completo en el hotel.', paraCliente: true, paraViaje: true });
  assert.match(viaje.sistema, /DE VIAJE/);
  assert.match(viaje.sistema, /Si la entrenadora NO dice con qué equipo cuenta, supón peso corporal o bandas/);
  assert.match(viaje.sistema, /si lo dice, lo que ella indique manda/);
});

// ── Bloques (J-113) ─────────────────────────────────────────────────────────────────────────────
const catalogoGrande = ['A', 'B', 'C', 'D', 'E', 'F'].map(letra => ({ name: `Ejercicio ${letra}`, section: 'core', machine: 'No aplica', freeWeight: 'No aplica' }));
async function conRespuesta(ejercicios, extra = {}) {
  const original = globalThis.fetch; let enviado = null;
  globalThis.fetch = async (_u, o) => { enviado = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: 'T', description: 'D', sessionsPerWeek: 3, exercises: ejercicios, rationale: 'r' }) } }] }) }; };
  try { return { propuesta: await suggestRoutine({ ...base, catalogo: catalogoGrande, descripcion: 'x', ...extra }), sistema: enviado.messages[0].content }; }
  finally { globalThis.fetch = original; }
}

test('el modelo recibe la estructura en bloques y la salida respeta "3 rondas de 3 ejercicios y otras 3 rondas del segundo bloque"', async () => {
  const { propuesta, sistema } = await conRespuesta(['A', 'B', 'C', 'D', 'E', 'F'].map((l, i) => ({ name: `Ejercicio ${l}`, sets: 3, reps: '12', block: i < 3 ? 1 : 2, rounds: 3 })));
  assert.match(sistema, /ESTRUCTURA EN BLOQUES/); assert.match(sistema, /bloques de 3 ejercicios/);
  assert.deepEqual(propuesta.exercises.map(e => [e.block, e.rounds, e.sets]), [[1, 3, 3], [1, 3, 3], [1, 3, 3], [2, 3, 3], [2, 3, 3], [2, 3, 3]]);
});

test('si el modelo se equivoca con los bloques, la salida queda coherente: orden, rondas del primero, sets = rondas, sin huecos', async () => {
  const { propuesta } = await conRespuesta([
    { name: 'Ejercicio A', sets: 4, reps: '10', block: 5, rounds: 4 },
    { name: 'Ejercicio B', sets: 2, reps: '10' },                      // sin bloque: se queda en el del anterior
    { name: 'Ejercicio C', sets: 3, reps: '10', block: 2, rounds: 2 }, // bloque anterior en el orden: pasa primero
    { name: 'Ejercicio D', sets: 3, reps: '10', block: 5, rounds: 9 }  // rondas distintas dentro del bloque: manda la del primero
  ]);
  assert.deepEqual(propuesta.exercises.map(e => [e.name, e.block, e.rounds, e.sets]),
    [['Ejercicio C', 1, 2, 2], ['Ejercicio A', 2, 4, 4], ['Ejercicio B', 2, 4, 4], ['Ejercicio D', 2, 4, 4]]);
});

test('sin ningún bloque la rutina queda como lista de ejercicios sueltos (sin campos de bloque)', async () => {
  const { propuesta } = await conRespuesta([{ name: 'Ejercicio A', sets: 3, reps: '10' }, { name: 'Ejercicio B', sets: 3, reps: '10', rounds: 3 }]);
  assert.ok(propuesta.exercises.every(e => e.block === undefined && e.rounds === undefined));
});
