import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { sql } from './db.js';

const provider = 'google_calendar';
const calendarScope = 'https://www.googleapis.com/auth/calendar.events';
const authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const revokeEndpoint = 'https://oauth2.googleapis.com/revoke';
const calendarApi = 'https://www.googleapis.com/calendar/v3';
const encryptionKey = createHash('sha256').update(config.JWT_SECRET).digest();

type AuthUser = { sub: string; role: 'admin' | 'trainer' | 'client'; email: string };
type GoogleRecord = Record<string, any>;
type CalendarConnection = {
  owner_id: string;
  encrypted_refresh_token: string;
  organization_id: string;
  organization_name: string;
  status: string;
  sync_enabled: boolean;
};

type GoogleSyncResult = {
  synced: number;
  failed: number;
  total: number;
  errors: string[];
  updatedFromGoogle: number;
  checkedFromGoogle: number;
  conflictsResolved: number;
  alreadyRunning?: boolean;
};

const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();
const synchronizationLocks = new Set<string>();

class GoogleCalendarError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function requireStaff(request: FastifyRequest) {
  await request.jwtVerify();
  const user = request.user as AuthUser;
  if (!['admin', 'trainer'].includes(user.role)) {
    const error = new Error('Acceso restringido');
    (error as Error & { statusCode: number }).statusCode = 403;
    throw error;
  }
  return user;
}

function configured() {
  return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
}

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

function decrypt(value: string) {
  const [ivValue, tagValue, encryptedValue] = value.split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('La conexión con Google Calendar no es válida');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

async function tokenRequest(parameters: Record<string, string>) {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(parameters)
  });
  const payload = await response.json() as GoogleRecord;
  if (!response.ok || payload.error) throw new Error(payload.error_description || payload.error || 'Google rechazó la autorización');
  return payload;
}

async function exchangeAuthorizationCode(code: string) {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) throw new Error('Faltan las credenciales OAuth de Google en Railway');
  return tokenRequest({
    code,
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code'
  });
}

async function accessToken(connection: CalendarConnection) {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) throw new Error('Faltan las credenciales OAuth de Google en Railway');
  const cached = accessTokenCache.get(connection.owner_id);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const payload = await tokenRequest({
    refresh_token: decrypt(connection.encrypted_refresh_token),
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });
  if (!payload.access_token) throw new Error('Google no entregó un token de acceso');
  const token = String(payload.access_token);
  const expiresIn = Math.max(60, Number(payload.expires_in || 3600) - 300);
  accessTokenCache.set(connection.owner_id, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

async function googleRequest(token: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${calendarApi}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({})) as GoogleRecord;
  if (!response.ok) {
    const reason = String(payload.error?.errors?.[0]?.reason || payload.error?.status || payload.error?.details?.[0]?.reason || '').toLowerCase();
    const originalMessage = String(payload.error?.message || `Google Calendar respondió ${response.status}`);
    const normalizedMessage = originalMessage.toLowerCase();
    let message = originalMessage;
    if (response.status === 403 && (reason.includes('accessnotconfigured') || reason.includes('service_disabled') || normalizedMessage.includes('has not been used') || normalizedMessage.includes('is disabled'))) {
      message = 'La API de Google Calendar no está habilitada en el proyecto de Google Cloud. Actívala en “APIs y servicios” y vuelve a sincronizar.';
    } else if (response.status === 403 && (reason.includes('insufficient') || normalizedMessage.includes('insufficient authentication scopes'))) {
      message = 'Google no concedió el permiso de calendario. Desconecta la integración y vuelve a autorizarla aceptando el acceso solicitado.';
    } else if (response.status === 403 && (reason.includes('ratelimit') || reason.includes('quota') || normalizedMessage.includes('quota'))) {
      message = 'Google Calendar alcanzó temporalmente su límite de solicitudes. Eileen volverá a intentarlo automáticamente.';
    }
    throw new GoogleCalendarError(message, response.status);
  }
  return payload;
}

export function buildGoogleCalendarEvent(session: GoogleRecord) {
  const start = new Date(session.starts_at);
  const end = new Date(start.getTime() + Number(session.duration_minutes || 60) * 60_000);
  const details = [
    'Sesión gestionada desde Eileen Lifestyle.',
    `Rutina: ${session.routine_title || 'Evaluación / seguimiento'}`,
    `Modalidad: ${session.mode || 'Presencial'}`,
    session.notes ? `Notas: ${session.notes}` : ''
  ].filter(Boolean).join('\n');
  return {
    summary: `Entrenamiento · ${session.full_name}`,
    description: details,
    start: { dateTime: start.toISOString(), timeZone: 'America/Panama' },
    end: { dateTime: end.toISOString(), timeZone: 'America/Panama' },
    extendedProperties: { private: { eileenSessionId: String(session.id), source: 'eileen-lifestyle' } }
  };
}

async function saveEvent(token: string, connection: CalendarConnection, session: GoogleRecord) {
  const calendarId = encodeURIComponent(connection.organization_id || 'primary');
  const body = JSON.stringify(buildGoogleCalendarEvent(session));
  let event: GoogleRecord;
  if (session.google_event_id) {
    try {
      event = await googleRequest(token, `/calendars/${calendarId}/events/${encodeURIComponent(session.google_event_id)}?sendUpdates=none`, { method: 'PATCH', body });
    } catch (error) {
      if (!(error instanceof GoogleCalendarError) || ![404, 410].includes(error.status)) throw error;
      event = await googleRequest(token, `/calendars/${calendarId}/events?sendUpdates=none`, { method: 'POST', body });
    }
  } else {
    event = await googleRequest(token, `/calendars/${calendarId}/events?sendUpdates=none`, { method: 'POST', body });
  }
  await sql`
    UPDATE sessions SET google_event_id = ${String(event.id)}, google_event_link = ${event.htmlLink ? String(event.htmlLink) : null},
      google_event_updated_at = ${event.updated ? String(event.updated) : new Date().toISOString()},
      google_event_etag = ${event.etag ? String(event.etag) : null}, google_synced_at = now(), google_sync_error = NULL,
      updated_at = now()
    WHERE id = ${session.id}
  `;
  return event;
}

async function eileenEventsFromGoogle(token: string, connection: CalendarConnection) {
  const calendarId = encodeURIComponent(connection.organization_id || 'primary');
  const events: GoogleRecord[] = [];
  let pageToken: string | undefined;
  do {
    const parameters = new URLSearchParams({
      singleEvents: 'true',
      showDeleted: 'true',
      maxResults: '2500',
      privateExtendedProperty: 'source=eileen-lifestyle'
    });
    if (pageToken) parameters.set('pageToken', pageToken);
    const payload = await googleRequest(token, `/calendars/${calendarId}/events?${parameters.toString()}`);
    if (Array.isArray(payload.items)) events.push(...payload.items);
    pageToken = payload.nextPageToken ? String(payload.nextPageToken) : undefined;
  } while (pageToken);
  return events;
}

async function pullGoogleChanges(ownerId: string, token: string, connection: CalendarConnection) {
  const events = await eileenEventsFromGoogle(token, connection);
  const sessions = await sql`
    SELECT s.*
    FROM sessions s JOIN clients c ON c.id = s.client_id
    WHERE c.owner_id = ${ownerId} AND s.google_event_id IS NOT NULL
  `;
  const byId = new Map(sessions.map(session => [String(session.id), session]));
  let updatedFromGoogle = 0;
  let conflictsResolved = 0;

  // Eventos nuestros que ya no corresponden a ninguna sesión: quedaron
  // huérfanos porque la sesión se borró en la aplicación sin avisar al
  // calendario. Se retiran aquí para que la sincronización se cure sola, en
  // vez de dejar entrenamientos fantasma en la agenda de la entrenadora.
  const vivas = await sql`
    SELECT s.id FROM sessions s JOIN clients c ON c.id = s.client_id WHERE c.owner_id = ${ownerId}
  `;
  const idsVivas = new Set(vivas.map(fila => String(fila.id)));
  let huerfanosRetirados = 0;
  const calendarId = encodeURIComponent(connection.organization_id || 'primary');
  for (const event of events) {
    if (event.status === 'cancelled') continue;
    const marcada = event.extendedProperties?.private?.eileenSessionId;
    if (!marcada || idsVivas.has(String(marcada))) continue;
    try {
      await googleRequest(token, `/calendars/${calendarId}/events/${encodeURIComponent(String(event.id))}?sendUpdates=none`, { method: 'DELETE' });
      huerfanosRetirados += 1;
    } catch { /* si ya no está, mejor */ }
  }

  for (const event of events) {
    const sessionId = event.extendedProperties?.private?.eileenSessionId;
    const session = sessionId ? byId.get(String(sessionId)) : undefined;
    if (!session || String(session.google_event_id) !== String(event.id)) continue;
    const eventUpdatedAt = event.updated ? new Date(String(event.updated)) : null;
    if (!eventUpdatedAt || Number.isNaN(eventUpdatedAt.getTime())) continue;
    const storedUpdatedAt = session.google_event_updated_at ? new Date(session.google_event_updated_at) : null;
    if (storedUpdatedAt && eventUpdatedAt.getTime() <= storedUpdatedAt.getTime() + 500) continue;

    if (event.status === 'cancelled') {
      await sql`
        UPDATE sessions SET google_event_updated_at = ${eventUpdatedAt.toISOString()}, google_event_etag = ${event.etag ? String(event.etag) : null},
          google_sync_error = 'El evento fue eliminado en Google; Eileen lo recreará en la próxima sincronización.'
        WHERE id = ${session.id}
      `;
      continue;
    }

    const startValue = event.start?.dateTime;
    const endValue = event.end?.dateTime;
    if (!startValue || !endValue) {
      await sql`
        UPDATE sessions SET google_event_updated_at = ${eventUpdatedAt.toISOString()}, google_event_etag = ${event.etag ? String(event.etag) : null},
          google_sync_error = 'El evento de Google debe conservar una hora de inicio y fin.'
        WHERE id = ${session.id}
      `;
      continue;
    }
    const startsAt = new Date(String(startValue));
    const endsAt = new Date(String(endValue));
    const durationMinutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || durationMinutes <= 0) continue;

    const localUpdatedAt = new Date(session.updated_at);
    const lastSyncedAt = session.google_synced_at ? new Date(session.google_synced_at) : null;
    const localDirty = Boolean(lastSyncedAt && localUpdatedAt.getTime() > lastSyncedAt.getTime() + 1000);
    if (localDirty && localUpdatedAt.getTime() > eventUpdatedAt.getTime()) {
      conflictsResolved += 1;
      continue;
    }

    const scheduleChanged = startsAt.getTime() !== new Date(session.starts_at).getTime()
      || durationMinutes !== Number(session.duration_minutes);
    await sql`
      UPDATE sessions SET starts_at = ${startsAt.toISOString()}, duration_minutes = ${durationMinutes},
        google_event_link = ${event.htmlLink ? String(event.htmlLink) : session.google_event_link},
        google_event_updated_at = ${eventUpdatedAt.toISOString()}, google_event_etag = ${event.etag ? String(event.etag) : null},
        google_synced_at = now(), google_sync_error = NULL, updated_at = now()
      WHERE id = ${session.id}
    `;
    if (scheduleChanged) updatedFromGoogle += 1;
    if (localDirty) conflictsResolved += 1;
  }
  return { updatedFromGoogle, checkedFromGoogle: events.length, conflictsResolved, huerfanosRetirados };
}

async function connectionFor(ownerId: string) {
  const [connection] = await sql`
    SELECT owner_id, encrypted_refresh_token, organization_id, organization_name, status, sync_enabled
    FROM integration_connections
    WHERE owner_id = ${ownerId} AND provider = ${provider} AND sync_enabled = true AND encrypted_refresh_token IS NOT NULL
  `;
  return connection as CalendarConnection | undefined;
}

async function sessionFor(ownerId: string, sessionId: string) {
  const [session] = await sql`
    SELECT s.*, c.full_name, r.title AS routine_title
    FROM sessions s JOIN clients c ON c.id = s.client_id LEFT JOIN routines r ON r.id = s.routine_id
    WHERE s.id = ${sessionId} AND c.owner_id = ${ownerId} AND s.status <> 'cancelled'
  `;
  return session;
}

export async function syncSessionToGoogle(ownerId: string, sessionId: string) {
  if (!configured()) return null;
  const connection = await connectionFor(ownerId);
  if (!connection) return null;
  const session = await sessionFor(ownerId, sessionId);
  if (!session) return null;
  try {
    return await saveEvent(await accessToken(connection), connection, session);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No fue posible sincronizar la sesión';
    await Promise.all([
      sql`UPDATE sessions SET google_sync_error = ${message}, updated_at = now() WHERE id = ${sessionId}`,
      sql`UPDATE integration_connections SET status = 'error', last_error = ${message}, updated_at = now() WHERE owner_id = ${ownerId} AND provider = ${provider}`
    ]);
    throw error;
  }
}

// Cancelar no borra el evento: lo deja en rojo y marcado como CANCELADA.
// Antes desaparecía del calendario, y desaparecer no es lo mismo que cancelar:
// si Eileen mira su agenda del martes y el hueco está vacío, no sabe si nunca
// hubo clase o si se canceló. Queda en 'transparent' para que no siga
// bloqueando su disponibilidad.
//
// syncFutureSessions ignora las canceladas, así que el rojo no se revierte solo.
export async function cancelSessionInGoogle(ownerId: string, sessionId: string) {
  if (!configured()) return null;
  const connection = await connectionFor(ownerId);
  if (!connection) return null;
  const [session] = await sql`
    SELECT s.google_event_id, c.full_name FROM sessions s JOIN clients c ON c.id = s.client_id
    WHERE s.id = ${sessionId} AND c.owner_id = ${ownerId}
  `;
  if (!session?.google_event_id) return null;
  const calendarId = encodeURIComponent(connection.organization_id || 'primary');
  const cuerpo = JSON.stringify({
    summary: `CANCELADA · Entrenamiento · ${session.full_name}`,
    // 11 es el rojo de Google Calendar (Tomate).
    colorId: '11',
    transparency: 'transparent'
  });
  try {
    await googleRequest(await accessToken(connection), `/calendars/${calendarId}/events/${encodeURIComponent(session.google_event_id)}?sendUpdates=none`, { method: 'PATCH', body: cuerpo });
    await sql`UPDATE sessions SET google_synced_at = now(), google_sync_error = NULL WHERE id = ${sessionId}`;
  } catch (error) {
    // Si ya no está en Google no hay nada que marcar.
    if (error instanceof GoogleCalendarError && [404, 410].includes(error.status)) return null;
    throw error;
  }
  return { cancelled: true };
}

// Quitar el evento del calendario de verdad. Para cuando la sesión se borra en
// la aplicación y no debe quedar rastro: si no se llama, el evento se queda
// huérfano en Google para siempre, apuntando a una sesión que ya no existe.
export async function removeSessionFromGoogle(ownerId: string, sessionId: string) {
  if (!configured()) return null;
  const connection = await connectionFor(ownerId);
  if (!connection) return null;
  const [session] = await sql`
    SELECT s.google_event_id FROM sessions s JOIN clients c ON c.id = s.client_id
    WHERE s.id = ${sessionId} AND c.owner_id = ${ownerId}
  `;
  if (!session?.google_event_id) return null;
  const calendarId = encodeURIComponent(connection.organization_id || 'primary');
  try {
    await googleRequest(await accessToken(connection), `/calendars/${calendarId}/events/${encodeURIComponent(session.google_event_id)}?sendUpdates=none`, { method: 'DELETE' });
  } catch (error) {
    if (error instanceof GoogleCalendarError && [404, 410].includes(error.status)) return null;
    throw error;
  }
  return { removed: true };
}

async function syncFutureSessions(ownerId: string): Promise<GoogleSyncResult> {
  if (synchronizationLocks.has(ownerId)) {
    return { synced: 0, failed: 0, total: 0, errors: [], updatedFromGoogle: 0, checkedFromGoogle: 0, conflictsResolved: 0, alreadyRunning: true };
  }
  synchronizationLocks.add(ownerId);
  const connection = await connectionFor(ownerId);
  if (!connection) {
    synchronizationLocks.delete(ownerId);
    throw new Error('Google Calendar no está conectado');
  }
  await sql`UPDATE integration_connections SET status = 'syncing', last_error = NULL, updated_at = now() WHERE owner_id = ${ownerId} AND provider = ${provider}`;
  try {
    const token = await accessToken(connection);
    const pulled = await pullGoogleChanges(ownerId, token, connection);
    const sessions = await sql`
      SELECT s.*, c.full_name, r.title AS routine_title
      FROM sessions s JOIN clients c ON c.id = s.client_id LEFT JOIN routines r ON r.id = s.routine_id
      WHERE c.owner_id = ${ownerId} AND s.status <> 'cancelled' AND s.starts_at >= now() - interval '1 day'
        AND (s.google_event_id IS NULL OR s.google_sync_error IS NOT NULL OR s.google_synced_at IS NULL
          OR s.updated_at > s.google_synced_at + interval '1 second')
      ORDER BY s.starts_at
    `;
    let synced = 0;
    const errors: string[] = [];
    for (const session of sessions) {
      try {
        await saveEvent(token, connection, session);
        synced += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Error desconocido';
        errors.push(`${session.full_name}: ${message}`);
        await sql`UPDATE sessions SET google_sync_error = ${message}, updated_at = now() WHERE id = ${session.id}`;
      }
    }
    await sql`
      UPDATE integration_connections SET status = ${errors.length ? 'error' : 'ready'}, last_sync_at = now(),
        last_error = ${errors.length ? errors.slice(0, 3).join(' · ') : null}, updated_at = now()
      WHERE owner_id = ${ownerId} AND provider = ${provider}
    `;
    return { synced, failed: errors.length, total: sessions.length, errors: errors.slice(0, 3), ...pulled };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No fue posible sincronizar Google Calendar';
    await sql`UPDATE integration_connections SET status = 'error', last_error = ${message}, updated_at = now() WHERE owner_id = ${ownerId} AND provider = ${provider}`;
    throw error;
  } finally {
    synchronizationLocks.delete(ownerId);
  }
}

export async function registerGoogleCalendarRoutes(app: FastifyInstance) {
  app.get('/api/integrations/google-calendar/status', { preHandler: requireStaff }, async request => {
    const auth = request.user as AuthUser;
    const [connection] = await sql`
      SELECT organization_name, status, last_sync_at, last_error
      FROM integration_connections WHERE owner_id = ${auth.sub} AND provider = ${provider}
    `;
    const [counts] = await sql`
      SELECT count(*) FILTER (WHERE s.google_event_id IS NOT NULL)::integer AS synced,
        count(*) FILTER (WHERE s.google_event_id IS NULL)::integer AS pending,
        count(*) FILTER (WHERE s.google_sync_error IS NOT NULL)::integer AS failed
      FROM sessions s JOIN clients c ON c.id = s.client_id
      WHERE c.owner_id = ${auth.sub} AND s.status <> 'cancelled' AND s.starts_at >= now() - interval '1 day'
    `;
    return {
      configured: configured(), connected: Boolean(connection),
      connection: connection || null,
      sessions: { synced: Number(counts?.synced || 0), pending: Number(counts?.pending || 0), failed: Number(counts?.failed || 0) }
    };
  });

  app.get('/api/integrations/google-calendar/authorize', { preHandler: requireStaff }, async (request, reply) => {
    if (!configured()) return reply.code(503).send({ error: 'Primero agrega GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Railway' });
    const auth = request.user as AuthUser;
    const state = app.jwt.sign({ sub: auth.sub, purpose: 'google_calendar_oauth' }, { expiresIn: '10m' });
    const url = new URL(authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID!, redirect_uri: config.GOOGLE_REDIRECT_URI, response_type: 'code',
      scope: calendarScope, access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent', state
    }).toString();
    return { authorizationUrl: url.toString() };
  });

  app.get('/api/integrations/google-calendar/callback', async (request, reply) => {
    const query = z.object({ code: z.string().min(1).optional(), state: z.string().min(1).optional(), error: z.string().optional() }).parse(request.query);
    if (!query.state) return reply.redirect(`${config.APP_URL.replace(/\/$/, '')}/?google=start#calendar`);
    const state = app.jwt.verify<{ sub: string; purpose: string }>(query.state);
    if (state.purpose !== 'google_calendar_oauth') return reply.code(400).send({ error: 'Estado OAuth inválido' });
    if (query.error || !query.code) return reply.redirect(`${config.APP_URL.replace(/\/$/, '')}/?google=denied#calendar`);
    try {
      const token = await exchangeAuthorizationCode(query.code);
      const [existing] = await sql`SELECT encrypted_refresh_token FROM integration_connections WHERE owner_id = ${state.sub} AND provider = ${provider}`;
      const encryptedRefreshToken = token.refresh_token ? encrypt(String(token.refresh_token)) : existing?.encrypted_refresh_token;
      if (!encryptedRefreshToken) throw new Error('Google no entregó un refresh token. Vuelve a conectar y acepta el consentimiento.');
      await sql`
        INSERT INTO integration_connections (owner_id, provider, encrypted_refresh_token, organization_id, organization_name, accounts_url, api_base_url, status, sync_enabled)
        VALUES (${state.sub}, ${provider}, ${encryptedRefreshToken}, ${config.GOOGLE_CALENDAR_ID}, 'Calendario principal',
          'https://accounts.google.com', ${calendarApi}, 'connected', true)
        ON CONFLICT (owner_id, provider) DO UPDATE SET encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
          organization_id = EXCLUDED.organization_id, organization_name = EXCLUDED.organization_name,
          accounts_url = EXCLUDED.accounts_url, api_base_url = EXCLUDED.api_base_url, status = 'connected',
          sync_enabled = true, last_error = NULL, updated_at = now()
      `;
      const result = await syncFutureSessions(state.sub);
      const outcome = result.failed ? 'partial' : 'connected';
      return reply.redirect(`${config.APP_URL.replace(/\/$/, '')}/?google=${outcome}#calendar`);
    } catch (error) {
      app.log.error(error);
      return reply.redirect(`${config.APP_URL.replace(/\/$/, '')}/?google=error#calendar`);
    }
  });

  app.post('/api/integrations/google-calendar/sync', { preHandler: requireStaff }, async request => {
    const auth = request.user as AuthUser;
    return syncFutureSessions(auth.sub);
  });

  app.post('/api/integrations/google-calendar/disconnect', { preHandler: requireStaff }, async request => {
    const auth = request.user as AuthUser;
    const connection = await connectionFor(auth.sub);
    if (connection) {
      const refreshToken = decrypt(connection.encrypted_refresh_token);
      await fetch(revokeEndpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken })
      }).catch(error => app.log.warn(error));
    }
    await sql`DELETE FROM integration_connections WHERE owner_id = ${auth.sub} AND provider = ${provider}`;
    accessTokenCache.delete(auth.sub);
    return { disconnected: true };
  });

  const synchronizeConnectedCalendars = async () => {
    if (!configured()) return;
    const connections = await sql`
      SELECT owner_id FROM integration_connections
      WHERE provider = ${provider} AND sync_enabled = true AND encrypted_refresh_token IS NOT NULL
    `;
    for (const connection of connections) {
      syncFutureSessions(String(connection.owner_id)).catch(error => app.log.warn({ err: error, ownerId: connection.owner_id }, 'Background Google Calendar sync failed'));
    }
  };
  const backgroundSync = setInterval(() => void synchronizeConnectedCalendars(), 120_000);
  backgroundSync.unref();
  app.addHook('onClose', async () => clearInterval(backgroundSync));
}
