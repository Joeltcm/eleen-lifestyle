// Horarios fijos con VARIOS horarios por cliente (Francolini: lun y mar 17:30 + vie 10:00): mover una clase de hora no debe duplicar el día al "Actualizar el calendario".
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let cid;
const aPanama = iso => new Date(new Date(iso).getTime() - 5 * 3600_000).toISOString();
const diaDe = iso => aPanama(iso).slice(0, 10);
const horaDe = iso => aPanama(iso).slice(11, 16);
const vivas = async () => (await api.get('/api/sessions')).datos.filter(x => x.client_id === cid && x.status !== 'cancelled' && new Date(x.starts_at) > new Date());
const porDia = lista => { const r = {}; for (const x of lista) r[diaDe(x.starts_at)] = [...(r[diaDe(x.starts_at)] || []), horaDe(x.starts_at)]; return r; };

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  cid = (await api.post('/api/clients', { fullName: 'Francolini', cutoffDay: 15 })).datos.id;
  // Dos horarios del mismo cliente: lun+mar 17:30 y vie 10:00.
  assert.equal((await api.post('/api/session-recurrences', { clientId: cid, weekdays: [1, 2], timeOfDay: '17:30', durationMinutes: 60, mode: 'Presencial' })).estado, 201);
  assert.equal((await api.post('/api/session-recurrences', { clientId: cid, weekdays: [5], timeOfDay: '10:00', durationMinutes: 60, mode: 'Presencial' })).estado, 201);
}, { timeout: 90_000 });
after(async () => { await servidor?.parar(); });

test('dos horarios del mismo cliente generan cada día a su hora: lun/mar 17:30 y vie 10:00, una clase por día', async () => {
  const dias = porDia(await vivas());
  for (const [dia, horas] of Object.entries(dias)) {
    assert.equal(horas.length, 1, `${dia} tiene una sola clase`);
    const dow = new Date(`${dia}T12:00:00Z`).getUTCDay();
    assert.equal(horas[0], dow === 5 ? '10:00' : '17:30');
    assert.ok([1, 2, 5].includes(dow));
  }
  assert.ok(Object.keys(dias).length >= 20);
});

test('mover de hora una clase (un lunes y un viernes) y actualizar el calendario NO duplica ninguno de esos días', async () => {
  const lista = (await vivas()).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  const lunes = lista.find(x => new Date(`${diaDe(x.starts_at)}T12:00:00Z`).getUTCDay() === 1 && horaDe(x.starts_at) === '17:30');
  const viernes = lista.find(x => new Date(`${diaDe(x.starts_at)}T12:00:00Z`).getUTCDay() === 5);
  // lunes: 17:30 -> 18:45 ; viernes: 10:00 -> 08:00
  await api.patch(`/api/sessions/${lunes.id}`, { startsAt: new Date(new Date(lunes.starts_at).getTime() + 75 * 60_000).toISOString(), durationMinutes: 60, mode: 'Presencial' });
  await api.patch(`/api/sessions/${viernes.id}`, { startsAt: new Date(new Date(viernes.starts_at).getTime() - 120 * 60_000).toISOString(), durationMinutes: 60, mode: 'Presencial' });
  const antes = (await vivas()).length;
  const r = await api.post('/api/session-recurrences/extend', {});
  assert.equal(r.estado, 200);
  const despues = porDia(await vivas());
  assert.deepEqual(despues[diaDe(lunes.starts_at)], ['18:45'], 'el lunes movido sigue con UNA clase, a su nueva hora');
  assert.deepEqual(despues[diaDe(viernes.starts_at)], ['08:00'], 'el viernes movido sigue con UNA clase, a su nueva hora');
  assert.ok(Object.values(despues).every(horas => horas.length === 1), 'ningún día tiene dos clases');
  assert.ok((await vivas()).length - antes <= 0, 'no se agregó ninguna clase de más');
  const segunda = await api.post('/api/session-recurrences/extend', {});
  assert.equal(segunda.datos.creadas, 0, 'y volver a pulsarlo no crea nada');
});

test('la agenda recurrente permanece indefinida aunque llegue una fecha Hasta', async () => {
  const creada = await api.post('/api/session-recurrences', {
    clientId: cid, weekdays: [4], timeOfDay: '06:15', durationMinutes: 60, mode: 'Presencial', endsOn: '2099-12-31'
  });
  assert.equal(creada.estado, 201);
  assert.equal(creada.datos.recurrence.ends_on, null, 'una agenda nueva no tiene fecha de fin');

  const editada = await api.patch(`/api/session-recurrences/${creada.datos.recurrence.id}`, {
    weekdays: [4], timeOfDay: '06:15', durationMinutes: 60, mode: 'Presencial', endsOn: '2099-12-31'
  });
  assert.equal(editada.estado, 200);
  assert.equal(editada.datos.recurrence.ends_on, null, 'editar una agenda tampoco puede ponerle fecha de fin');
});
