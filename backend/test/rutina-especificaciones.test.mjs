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
