import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let db; let demoId;
// Fechas de fin de demo siempre en el futuro (una fecha fija se vuelve pasado y rompe la prueba sola): hoy de Panamá + n días.
const dia = n => new Date(Date.now() - 5 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {} });
  const setup = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  assert.equal(setup.estado, 201, JSON.stringify(setup.datos));
  api.usarToken(setup.datos.token);
}, { timeout: 90_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('alta demo, duplicado confirmado y tope de rutinas', async () => {
  const primera = await api.post('/api/clients', { fullName: 'Prospecto Demo', email: 'demo@prueba.test', phone: '+507 6000-0001', demo: true, demoEndsOn: dia(14), demoRoutineLimit: 2, demoNote: 'Instagram' });
  assert.equal(primera.estado, 201, JSON.stringify(primera.datos));
  demoId = primera.datos.id;
  assert.equal(primera.datos.service_mode, 'demo');
  assert.equal(String(primera.datos.demo_ends_on).slice(0, 10), dia(14));
  assert.equal(Number(primera.datos.demo_routine_limit), 2);
  assert.equal((await db`SELECT count(*)::int AS n FROM memberships WHERE client_id = ${demoId}`)[0].n, 0);

  const duplicado = await api.post('/api/clients', { fullName: 'Otro Demo', email: 'DEMO@PRUEBA.TEST', phone: '50760000001', demo: true });
  assert.equal(duplicado.estado, 409);
  assert.equal(duplicado.datos.code, 'client_duplicate');
  assert.equal(duplicado.datos.matches[0].id, demoId);
  assert.equal((await db`SELECT count(*)::int AS n FROM clients WHERE lower(email) = 'demo@prueba.test'`)[0].n, 1);
  const confirmado = await api.post('/api/clients', { fullName: 'Otro Demo', email: 'DEMO@PRUEBA.TEST', phone: '50760000001', demo: true, confirmDuplicate: true });
  assert.equal(confirmado.estado, 201, JSON.stringify(confirmado.datos));

  const rutina = async (title, clientId = demoId) => api.post('/api/routines', { title, description: 'Rutina promocional', sessionsPerWeek: 1, clientId, dueOn: '2026-10-20', exercises: [{ name: title, reps: '10' }] });
  const primeraRutina = await rutina('Demo uno'); assert.equal(primeraRutina.estado, 201);
  assert.equal((await rutina('Demo dos')).estado, 201);
  const tercera = await rutina('Demo tres');
  assert.equal(tercera.estado, 409, JSON.stringify(tercera.datos));
  assert.match(String(tercera.datos.error || tercera.datos.message), /rutinas gratis/i);
  const sameRoutine = await api.patch(`/api/routines/${primeraRutina.datos.id}`, { title: 'Demo uno', description: 'Rutina promocional', sessionsPerWeek: 1, clientId: demoId, dueOn: '2026-10-20', exercises: [{ name: 'Demo uno', reps: '10' }], confirmRepeat: true });
  assert.notEqual(sameRoutine.estado, 409, JSON.stringify(sameRoutine.datos));
  const tooLow = await api.patch(`/api/clients/${demoId}/demo`, { demoRoutineLimit: 1 });
  assert.equal(tooLow.estado, 409, JSON.stringify(tooLow.datos));
  const raised = await api.patch(`/api/clients/${demoId}/demo`, { demoRoutineLimit: 3 });
  assert.equal(raised.estado, 200, JSON.stringify(raised.datos));

  const clients = (await api.get('/api/clients')).datos;
  const visible = clients.find(item => item.id === demoId);
  assert.equal(visible.service_mode, 'demo');
  assert.equal(Number(visible.demo_routines_used), 2);
  assert.equal((await db`SELECT count(*)::int AS n FROM client_mode_events WHERE client_id = ${demoId}`)[0].n, 2);
});

test('una demo vencida bloquea nuevos envíos y conserva un portal consultable con WhatsApp', async () => {
  const demo = (await api.post('/api/clients', { fullName: 'Demo vencida', email: 'demo.vencida@prueba.test', demo: true, demoEndsOn: dia(14) })).datos;
  const rutina = (await api.post('/api/routines', {
    title: 'Rutina histórica demo', clientId: demo.id, sessionsPerWeek: 1, dueOn: '2026-10-07', exercises: [{ name: 'Plancha', reps: '10' }]
  })).datos;
  await db`UPDATE clients SET demo_ends_on = '2026-10-07', demo_note = 'Vencida' WHERE id = ${demo.id}`;
  const bloqueado = await api.post('/api/routines', { title: 'No debe salir', clientId: demo.id, sessionsPerWeek: 1, exercises: [{ name: 'Sentadilla', reps: '10' }] });
  assert.equal(bloqueado.estado, 409, JSON.stringify(bloqueado.datos));
  assert.match(String(bloqueado.datos.error || bloqueado.datos.message), /terminó|prorroga/i);
  const enlace = await api.post(`/api/clients/${demo.id}/access-link`, {});
  const portal = await api.post(`/api/auth/access-link/${String(enlace.datos.url).split('acceso=')[1]}`, { password: 'clave-demo-vencida-larga' });
  const portalApi = cliente(servidor.base); portalApi.usarToken(portal.datos.token);
  const resumen = await portalApi.get('/api/portal/summary');
  assert.equal(resumen.estado, 200, JSON.stringify(resumen.datos));
  assert.equal(resumen.datos.client.demo_ended, true);
  assert.match(resumen.datos.client.whatsapp_url, /^https:\/\/wa\.me\/50762128180\?text=/);
  assert.ok(resumen.datos.routines.some(item => item.id === rutina.id));
  assert.equal(resumen.datos.invoices.length, 0); assert.equal(resumen.datos.sessions.length, 0);
});

test('demo no admite facturas, pagos, paquetes ni sesiones y puede convertirse sin cargo retroactivo', async () => {
  const invoice = await api.post('/api/billing/invoices', { payerClientId: demoId, kind: 'manual', issuedOn: '2026-10-08', lines: [{ beneficiaryClientId: demoId, unitAmount: 25 }] });
  assert.equal(invoice.estado, 409);
  const payment = await api.post('/api/billing/payments', { payerClientId: demoId, amount: 25, method: 'Yappy', paidOn: '2026-10-08' });
  assert.equal(payment.estado, 409);
  const packageResult = await api.post('/api/packages', { clientId: demoId, totalSessions: 1, amount: 25, kind: 'package' });
  assert.equal(packageResult.estado, 409);
  const session = await api.post('/api/sessions', { clientId: demoId, startsAt: '2026-10-12T14:00:00.000Z', durationMinutes: 45, mode: 'Virtual' });
  assert.equal(session.estado, 409);

  const adjust = await api.patch(`/api/clients/${demoId}/demo`, { demoEndsOn: dia(20) });
  assert.equal(adjust.estado, 200, JSON.stringify(adjust.datos));
  const converted = await api.post(`/api/clients/${demoId}/demo/convert`, {});
  assert.equal(converted.estado, 200, JSON.stringify(converted.datos));
  assert.equal(converted.datos.service_mode, 'standard');
  assert.equal((await db`SELECT count(*)::int AS n FROM invoices WHERE client_id = ${demoId}`)[0].n, 0);
  assert.equal((await db`SELECT count(*)::int AS n FROM billing_invoices WHERE payer_client_id = ${demoId}`)[0].n, 0);
  assert.equal((await db`SELECT count(*)::int AS n FROM client_mode_events WHERE client_id = ${demoId} AND to_mode = 'standard'`)[0].n, 1);
});

test('la reversa 069 queda protegida si hay datos demo', async () => {
  const archivo = new URL('../migrations-down/069_demo_client_mode.down.sql', import.meta.url).pathname;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await assert.rejects(promisify(execFile)('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, '-f', archivo]), /billing\.allow_destructive_down|orden expresa/i);
  assert.equal((await db`SELECT count(*)::int AS n FROM client_mode_events WHERE client_id = ${demoId}`)[0].n > 0, true);
});
