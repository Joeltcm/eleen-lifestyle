import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { cliente, levantar, CREDENCIALES, SETUP_TOKEN } from './harness.mjs';

let servidor;
let api;
let db;
let googlePull;
const originalFetch = globalThis.fetch;

const isoDay = value => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Panama', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(value);

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  const setup = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  assert.equal(setup.estado, 201, JSON.stringify(setup.datos));
  api.usarToken(setup.datos.token);

  // pullGoogleChanges is exercised against the same temporary database as the
  // real HTTP server, while Google itself is replaced by the event response
  // below. This keeps the test focused on the real reconciliation transaction.
  process.env.DATABASE_URL = servidor.databaseUrl;
  process.env.JWT_SECRET = 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres';
  process.env.SETUP_TOKEN = SETUP_TOKEN;
  process.env.NODE_ENV = 'test';
  ({ pullGoogleChanges: googlePull } = await import('../dist/google-calendar.js'));
  db = postgres(servidor.databaseUrl, { connection: { TimeZone: 'America/Panama' } });
}, { timeout: 90_000 });

after(async () => {
  globalThis.fetch = originalFetch;
  await db?.end({ timeout: 1 }).catch(() => {});
  await servidor?.parar();
});

test('Google: mover de día y luego solo de hora deja reprogramación y permite resolverla', async () => {
  const client = await api.post('/api/clients', { fullName: 'Google movimiento simulado', billingModel: 'single', standardPrice: 25, cutoffDay: 15 });
  assert.equal(client.estado, 201, JSON.stringify(client.datos));
  const original = new Date(Date.now() - 72 * 3600_000);
  const movedDay = new Date(Date.now() - 48 * 3600_000);
  const created = await api.post('/api/sessions', {
    clientId: client.datos.id, startsAt: original.toISOString(), durationMinutes: 60, mode: 'Presencial'
  });
  assert.equal(created.estado, 201, JSON.stringify(created.datos));
  const sessionId = created.datos.id;
  const eventId = `google-test-${sessionId}`;
  const owner = (await db`SELECT id FROM users WHERE email = ${CREDENCIALES.email}`)[0];
  await db`
    UPDATE sessions SET google_event_id = ${eventId}, google_event_updated_at = NULL, google_synced_at = now()
    WHERE id = ${sessionId}
  `;

  const connection = {
    owner_id: owner.id,
    encrypted_refresh_token: 'irrelevante-en-la-prueba',
    organization_id: 'primary', organization_name: 'Prueba', status: 'connected', sync_enabled: true
  };
  let eventUpdatedAt = new Date(Date.now() + 5_000);
  globalThis.fetch = async () => new Response(JSON.stringify({
    items: [{
      id: eventId, status: 'confirmed', updated: eventUpdatedAt.toISOString(),
      htmlLink: 'https://calendar.google.test/event', etag: 'etag-1',
      extendedProperties: { private: { eileenSessionId: sessionId, source: 'eileen-lifestyle' } },
      start: { dateTime: movedDay.toISOString() },
      end: { dateTime: new Date(movedDay.getTime() + 60 * 60_000).toISOString() }
    }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const moved = await googlePull(owner.id, 'fake-access-token', connection);
  assert.equal(moved.updatedFromGoogle, 1, 'Google mueve la sesión de día');
  let history = await db`SELECT * FROM session_reschedules WHERE session_id = ${sessionId}`;
  assert.equal(history.length, 1);

  const movedHour = new Date(movedDay.getTime() + 45 * 60_000);
  eventUpdatedAt = new Date(eventUpdatedAt.getTime() + 2_000);
  globalThis.fetch = async () => new Response(JSON.stringify({
    items: [{
      id: eventId, status: 'confirmed', updated: eventUpdatedAt.toISOString(),
      htmlLink: 'https://calendar.google.test/event', etag: 'etag-2',
      extendedProperties: { private: { eileenSessionId: sessionId, source: 'eileen-lifestyle' } },
      start: { dateTime: movedHour.toISOString() },
      end: { dateTime: new Date(movedHour.getTime() + 60 * 60_000).toISOString() }
    }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const movedOnlyHour = await googlePull(owner.id, 'fake-access-token', connection);
  assert.equal(movedOnlyHour.updatedFromGoogle, 1, 'Google también registra un cambio solo de hora');
  history = await db`SELECT * FROM session_reschedules WHERE session_id = ${sessionId} ORDER BY created_at`;
  assert.equal(history.length, 2, 'cada movimiento se registra una sola vez');
  assert.notEqual(String(history[0].from_starts_at), String(history[0].to_starts_at));
  assert.notEqual(String(history[1].from_starts_at), String(history[1].to_starts_at));
  globalThis.fetch = originalFetch;

  const marked = await api.patch(`/api/sessions/${sessionId}/compliance`, { outcome: 'completed', completionPercent: 100 });
  assert.equal(marked.estado, 200, 'la sesión movida sigue pudiendo marcarse cumplida');
  const cancelled = await api.delete(`/api/sessions/${sessionId}?rescheduled=true&by=client`);
  assert.equal(cancelled.estado, 200, JSON.stringify(cancelled.datos));
  assert.ok(cancelled.datos.session, JSON.stringify(cancelled.datos));
  assert.equal(cancelled.datos.session.cancellation_kind, 'rescheduled');
  assert.equal(isoDay(new Date(cancelled.datos.session.starts_at)), isoDay(movedHour));
});

test('Google: mover una clase cumplida y cobrada devuelve el saldo una sola vez', async () => {
  const client = await api.post('/api/clients', { fullName: 'Google clase cobrada', billingModel: 'package', standardPrice: 25, cutoffDay: 15 });
  assert.equal(client.estado, 201, JSON.stringify(client.datos));
  const paquete = await api.post('/api/packages', { clientId: client.datos.id, totalSessions: 2, amount: 50, kind: 'package' });
  assert.equal(paquete.estado, 201, JSON.stringify(paquete.datos));
  await api.post(`/api/invoices/${paquete.datos.invoice_id}/confirm`, { method: 'Efectivo', paidOn: isoDay(new Date()) });
  const original = new Date(Date.now() - 72 * 3600_000);
  const movedDay = new Date(Date.now() - 48 * 3600_000);
  const created = await api.post('/api/sessions', {
    clientId: client.datos.id, startsAt: original.toISOString(), durationMinutes: 60, mode: 'Presencial'
  });
  const sessionId = created.datos.id;
  const marked = await api.patch(`/api/sessions/${sessionId}/compliance`, { outcome: 'completed', completionPercent: 100 });
  assert.equal(marked.estado, 200, JSON.stringify(marked.datos));
  let saldo = (await api.get('/api/packages')).datos.find(item => item.id === paquete.datos.id);
  assert.equal(Number(saldo.used_sessions), 1, 'la clase inicialmente cumplida consume una sesión');

  const eventId = `google-paid-${sessionId}`;
  const owner = (await db`SELECT id FROM users WHERE email = ${CREDENCIALES.email}`)[0];
  await db`UPDATE sessions SET google_event_id = ${eventId}, google_event_updated_at = NULL, google_synced_at = now() WHERE id = ${sessionId}`;
  const connection = {
    owner_id: owner.id,
    encrypted_refresh_token: 'irrelevante-en-la-prueba',
    organization_id: 'primary', organization_name: 'Prueba', status: 'connected', sync_enabled: true
  };
  let eventUpdatedAt = new Date(Date.now() + 5_000);
  const event = start => ({
    id: eventId, status: 'confirmed', updated: eventUpdatedAt.toISOString(),
    htmlLink: 'https://calendar.google.test/paid-event', etag: `etag-paid-${eventUpdatedAt.getTime()}`,
    extendedProperties: { private: { eileenSessionId: sessionId, source: 'eileen-lifestyle' } },
    start: { dateTime: start.toISOString() },
    end: { dateTime: new Date(start.getTime() + 60 * 60_000).toISOString() }
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ items: [event(movedDay)] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const moved = await googlePull(owner.id, 'fake-access-token', connection);
  assert.equal(moved.updatedFromGoogle, 1);
  globalThis.fetch = originalFetch;
  const paquetesTrasMover = await api.get('/api/packages');
  assert.equal(paquetesTrasMover.estado, 200, JSON.stringify(paquetesTrasMover.datos));
  assert.equal(Array.isArray(paquetesTrasMover.datos), true, JSON.stringify(paquetesTrasMover.datos));
  saldo = paquetesTrasMover.datos.find(item => item.id === paquete.datos.id);
  assert.equal(Number(saldo.used_sessions), 0, 'mover desde Google revierte el débito');
  let history = await db`SELECT * FROM session_reschedules WHERE session_id = ${sessionId}`;
  assert.equal(history.length, 1, 'registra el movimiento una vez');
  const current = (await api.get('/api/sessions')).datos.find(item => item.id === sessionId);
  assert.equal(current.package_debited, false);
  assert.equal(current.package_id, null);

  const movedHour = new Date(movedDay.getTime() + 45 * 60_000);
  eventUpdatedAt = new Date(eventUpdatedAt.getTime() + 2_000);
  globalThis.fetch = async () => new Response(JSON.stringify({ items: [event(movedHour)] }), { status: 200, headers: { 'content-type': 'application/json' } });
  await googlePull(owner.id, 'fake-access-token', connection);
  globalThis.fetch = originalFetch;
  saldo = (await api.get('/api/packages')).datos.find(item => item.id === paquete.datos.id);
  assert.equal(Number(saldo.used_sessions), 0, 'mover sólo la hora no devuelve otra sesión');
  history = await db`SELECT * FROM session_reschedules WHERE session_id = ${sessionId}`;
  assert.equal(history.length, 2, 'el segundo movimiento también queda trazado');

  const remarcar = await api.patch(`/api/sessions/${sessionId}/compliance`, { outcome: 'completed', completionPercent: 100 });
  assert.equal(remarcar.estado, 200, JSON.stringify(remarcar.datos));
  saldo = (await api.get('/api/packages')).datos.find(item => item.id === paquete.datos.id);
  assert.equal(Number(saldo.used_sessions), 1, 'al volver a marcar cobra una sola vez');
  const repetir = await api.patch(`/api/sessions/${sessionId}/compliance`, { outcome: 'completed', completionPercent: 100 });
  assert.equal(repetir.estado, 200);
  saldo = (await api.get('/api/packages')).datos.find(item => item.id === paquete.datos.id);
  assert.equal(Number(saldo.used_sessions), 1, 'volver a marcar no duplica el débito');
  globalThis.fetch = originalFetch;
});
