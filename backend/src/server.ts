import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import webpush from 'web-push';
import { createHash, randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import type { TransactionSql } from 'postgres';
import { sql } from './db.js';
import { createDownloadUrl, createUploadUrl, deleteObject, downloadObject, storageReady, uploadObject, verifyUpload } from './storage.js';
import { extractInBodyDocument, extractInBodyImage, inbodyAnalysisReady, inbodyAnalysisSetup, prepareInBodyImage, validateExtraction, validateInBodyValues } from './inbody-analysis.js';
import { registerZohoRoutes } from './zoho-routes.js';
import { cancelSessionInGoogle, registerGoogleCalendarRoutes, removeSessionFromGoogle, syncSessionToGoogle } from './google-calendar.js';
import { routineSuggestionsReady, suggestRoutine } from './routine-suggestions.js';
import { accountStatementPdf, accountsReceivablePdf, compliancePdf, invoicePdf } from './billing-reports.js';

type AuthUser = { sub: string; role: 'admin' | 'trainer' | 'client'; email: string };
const app = Fastify({ logger: true, trustProxy: true });
const maxDocumentSize = 20 * 1024 * 1024;
const documentContentTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
const webPushReady = Boolean(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY);

if (webPushReady) {
  webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY!, config.VAPID_PRIVATE_KEY!);
}

app.addContentTypeParser([...documentContentTypes], { parseAs: 'buffer', bodyLimit: maxDocumentSize }, (_request, body, done) => {
  done(null, body);
});

await app.register(cors, {
  origin: config.CORS_ORIGIN.split(',').map(origin => origin.trim()),
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
  // Sin esto el navegador manda un OPTIONS de comprobación antes de CADA
  // llamada, porque todas llevan cabecera de autorización: el doble de viajes
  // para el mismo dato. Dos horas es el máximo que respeta Chrome.
  maxAge: 7200
});
await app.register(jwt, { secret: config.JWT_SECRET });
await registerZohoRoutes(app);
await registerGoogleCalendarRoutes(app);

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: 'Datos inválidos', details: error.issues });
  if ((error as { code?: string }).code === '23505') return reply.code(409).send({ error: 'El registro ya existe' });
  if ((error as { statusCode?: number }).statusCode) return reply.code((error as { statusCode: number }).statusCode).send({ error: (error as Error).message });
  app.log.error(error);
  return reply.code(500).send({ error: 'Error interno' });
});

async function requireAuth(request: FastifyRequest) {
  await request.jwtVerify();
  return request.user as AuthUser;
}

// La sesión duraba 12 horas, así que a la entrenadora la sacaba a media
// jornada y al cliente entre una visita y otra. 30 días, y además se renueva
// en cada arranque de la aplicación: mientras se use, no vence.
const sessionLifetime = '30d';

async function requireStaff(request: FastifyRequest) {
  const user = await requireAuth(request);
  if (!['admin', 'trainer'].includes(user.role)) {
    const error = new Error('Acceso restringido');
    (error as Error & { statusCode: number }).statusCode = 403;
    throw error;
  }
  return user;
}

async function recurringBillingStatus(ownerId: string) {
  const [zohoConnection] = await sql`
    SELECT status, sync_enabled, last_sync_at
    FROM integration_connections
    WHERE owner_id = ${ownerId} AND provider = 'zoho_invoice'
      AND sync_enabled = true AND status <> 'completed'
  `;
  const [summary] = await sql`
    WITH eligible AS (
      SELECT c.id, c.billing_cutoff_day, c.standard_price
      FROM clients c
      WHERE c.owner_id = ${ownerId} AND c.status = 'active' AND c.billing_model = 'monthly'
        AND c.standard_price > 0
        AND EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.client_id = c.id AND m.status = 'active' AND m.starts_on <= current_date
            AND (m.ends_on IS NULL OR m.ends_on >= current_date)
        )
    ), periods AS (
      SELECT generate_series(
        date_trunc('month', current_date),
        date_trunc('month', current_date) + interval '1 month',
        interval '1 month'
      )::date AS billing_period
    ), schedule AS (
      SELECT e.id AS client_id, p.billing_period,
        make_date(
          extract(year FROM p.billing_period)::integer,
          extract(month FROM p.billing_period)::integer,
          least(e.billing_cutoff_day, extract(day FROM (p.billing_period + interval '1 month - 1 day'))::integer)
        ) AS due_on,
        e.standard_price
      FROM eligible e CROSS JOIN periods p
    ), covered AS (
      SELECT s.*,
        EXISTS (
          SELECT 1 FROM invoices i
          -- El cobro puede estar a nombre de quien paga por esta persona.
          WHERE COALESCE(i.billed_for_client_id, i.client_id) = s.client_id AND i.status <> 'void'
            AND date_trunc('month', COALESCE(i.billing_period, i.issued_on, i.due_on))::date = s.billing_period
            AND (
              i.auto_generated = true OR i.source_system = 'zoho_invoice'
              OR (i.package_id IS NULL AND i.amount = s.standard_price)
              OR lower(i.concept) LIKE '%mensual%'
            )
        ) AS has_invoice
      FROM schedule s
    )
    SELECT
      (SELECT count(*)::integer FROM eligible) AS active_clients,
      count(*) FILTER (WHERE billing_period = date_trunc('month', current_date)::date AND has_invoice)::integer AS current_period_invoices,
      count(*) FILTER (WHERE due_on <= current_date + (${config.BILLING_GENERATION_DAYS_AHEAD})::integer AND NOT has_invoice)::integer AS ready_to_generate,
      min(due_on) FILTER (WHERE due_on >= current_date) AS next_due_on
    FROM covered
  `;
  return {
    automatic: !zohoConnection,
    blockedByZoho: Boolean(zohoConnection),
    zohoStatus: zohoConnection?.status || null,
    daysAhead: config.BILLING_GENERATION_DAYS_AHEAD,
    activeClients: Number(summary?.active_clients || 0),
    currentPeriodInvoices: Number(summary?.current_period_invoices || 0),
    readyToGenerate: Number(summary?.ready_to_generate || 0),
    nextDueOn: summary?.next_due_on || null
  };
}

// Las columnas date vuelven de postgres.js como Date, no como texto. Pegarles
// 'T12:00:00-05:00' producía "Invalid Date" y tumbaba toda la generación con un
// 500 sin pista: el error salía al formatear el nombre del saldo, no al leerlo.
// Mediodía porque a medianoche el cambio de huso mueve el día un mes atrás.
// El día natural en Panamá. Comparar instantes en UTC diría que una clase de
// las 19:00 y otra de las 21:00 del mismo día son días distintos en invierno.
function diaEnPanama(fecha: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Panama', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(fecha));
}

function mediodiaEnPanama(fecha: Date | string): Date {
  const dia = fecha instanceof Date ? fecha.toISOString().slice(0, 10) : String(fecha).slice(0, 10);
  return new Date(`${dia}T12:00:00-05:00`);
}

// Un saldo que se abre tarde tiene que hacerse cargo de las clases que ya se
// dieron dentro de su ciclo.
//
// El orden real de los hechos es ése: la clase se marca dada por la mañana y
// el saldo se abre después, al aplicar el pago o al renovar. Al marcarla no
// había de dónde descontar, así que la sesión quedó completada y sin cobrar a
// ningún saldo, y nada volvía a mirarla: el saldo nacía entero y esa clase no
// se le descontaba a nadie nunca.
//
// Esto no es tocar el pasado, que es lo que no se debe hacer con el dinero.
// Es al revés: la clase se dio, y el saldo tiene que decir la verdad sobre lo
// que queda. Sólo alcanza a las de su propio ciclo, nunca a las de un mes ya
// cerrado, y nunca gasta más sesiones de las que el saldo tiene.
async function cobrarClasesYaDadas(
  transaction: TransactionSql | typeof sql,
  packageId: string,
  clientId: string,
  expiresOn: string,
  totalSessions: number
) {
  const pendientes = await transaction`
    SELECT id FROM sessions
    WHERE client_id = ${clientId} AND status = 'completed' AND package_debited = false
      AND starts_at > (${expiresOn}::date - interval '1 month')
      AND starts_at < (${expiresOn}::date + interval '1 day')
    ORDER BY starts_at
    LIMIT ${totalSessions}
  `;
  if (!pendientes.length) return 0;
  const ids = pendientes.map(fila => fila.id as string);
  await transaction`
    UPDATE sessions SET package_id = ${packageId}, package_debited = true,
      debited_group_id = ${clientId}, updated_at = now()
    WHERE id IN ${transaction(ids)}
  `;
  await transaction`
    UPDATE session_packages
    SET used_sessions = ${ids.length},
      status = ${ids.length >= totalSessions ? 'exhausted' : 'active'}
    WHERE id = ${packageId}
  `;
  return ids.length;
}

async function generateRecurringInvoices(ownerId?: string) {
  const selectedOwner = ownerId || null;
  const invoices = await sql`
    WITH periods AS (
      SELECT generate_series(
        date_trunc('month', current_date),
        date_trunc('month', current_date) + interval '1 month',
        interval '1 month'
      )::date AS billing_period
    ), schedule AS (
      -- El cobro va a nombre de quien paga; se recuerda de quién es la
      -- mensualidad para desglosarla y para poder dar de baja a uno solo.
      SELECT COALESCE(c.billing_responsible_client_id, c.id) AS client_id,
        c.id AS billed_for_client_id, c.full_name AS billed_for_name,
        (c.billing_responsible_client_id IS NOT NULL) AS la_paga_otro,
        c.owner_id, c.standard_price AS amount,
        COALESCE(p.name, 'Mensualidad') AS plan_name, periods.billing_period,
        make_date(
          extract(year FROM periods.billing_period)::integer,
          extract(month FROM periods.billing_period)::integer,
          least(c.billing_cutoff_day, extract(day FROM (periods.billing_period + interval '1 month - 1 day'))::integer)
        ) AS due_on
      FROM clients c
      LEFT JOIN service_plans p ON p.id = c.plan_id
      CROSS JOIN periods
      WHERE c.status = 'active' AND c.billing_model = 'monthly' AND c.standard_price > 0
        AND (${selectedOwner}::uuid IS NULL OR c.owner_id = ${selectedOwner}::uuid)
        AND NOT EXISTS (
          SELECT 1 FROM integration_connections ic
          WHERE ic.owner_id = c.owner_id AND ic.provider = 'zoho_invoice'
            AND ic.sync_enabled = true AND ic.status <> 'completed'
        )
    ), candidates AS (
      SELECT s.*
      FROM schedule s
      -- Ni antes de tiempo ni hacia atrás. Un cobro de un mes que ya terminó
      -- no es un cobro: es un registro de algo que pasó, y emitirlo hoy le
      -- llegaría al cliente como una deuda nueva de agosto el 31 de agosto.
      -- Los pagos viejos se quedan como historial y no dirigen lo que viene.
      WHERE s.due_on >= current_date
        AND s.due_on <= current_date + (${config.BILLING_GENERATION_DAYS_AHEAD})::integer
        AND EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.client_id = s.billed_for_client_id AND m.status = 'active' AND m.starts_on <= s.due_on
            AND (m.ends_on IS NULL OR m.ends_on >= s.billing_period)
        )
        AND NOT EXISTS (
          SELECT 1 FROM invoices i
          WHERE COALESCE(i.billed_for_client_id, i.client_id) = s.billed_for_client_id AND i.status <> 'void'
            AND date_trunc('month', COALESCE(i.billing_period, i.issued_on, i.due_on))::date = s.billing_period
            AND (
              i.auto_generated = true OR i.source_system = 'zoho_invoice'
              OR (i.package_id IS NULL AND i.amount = s.amount)
              OR lower(i.concept) LIKE '%mensual%'
            )
        )
        -- Ni a quien ya está cubierto por un cobro ajeno. Los $350 de un
        -- pagador son una sola línea en Zoho: sin esto, a la persona que no
        -- aparece en la factura se le emitiría su mensualidad otra vez, como
        -- si no hubiera pagado.
        AND NOT EXISTS (
          SELECT 1 FROM invoice_coverage cov
          JOIN invoices ci ON ci.id = cov.invoice_id AND ci.status <> 'void'
          WHERE cov.client_id = s.billed_for_client_id AND cov.billing_period = s.billing_period
        )
    )
    INSERT INTO invoices (
      client_id, billed_for_client_id, concept, amount, due_on, issued_on, subtotal,
      billing_period, auto_generated
    )
    -- Cuando la paga otro, el concepto lleva el nombre de quien entrena: en el
    -- estado de cuenta del pagador, tres cobros iguales serían indistinguibles.
    SELECT client_id, billed_for_client_id,
      plan_name || ' · ' || CASE WHEN la_paga_otro THEN billed_for_name || ' · ' ELSE '' END
        || to_char(billing_period, 'MM/YYYY'),
      amount, due_on, current_date, amount, billing_period, true
    FROM candidates
    ON CONFLICT (client_id, billing_period, billed_for_client_id) WHERE auto_generated = true DO NOTHING
    RETURNING id, client_id, billed_for_client_id, billing_period, due_on, amount
  `;
  // Renovar el saldo de sesiones junto con el cobro. Sin esto, la mensualidad
  // con tope de sesiones se cobraba cada mes pero el saldo vencía y no volvía:
  // el cliente quedaba pagando sin sesiones disponibles.
  //
  // Se mira el cobro vigente de cada quien, no sólo los que acaban de nacer en
  // este mismo INSERT. Un cobro emitido ayer —o traído de Zoho— ya no vuelve a
  // pasar por aquí, y su cliente se quedaba sin saldo para siempre sin que
  // nada lo dijera. El saldo es de quien entrena, no de quien paga: si la
  // mensualidad de la esposa la cubre el marido, las sesiones son de ella.
  const pendientes = await sql`
    SELECT DISTINCT ON (entrena) * FROM (
      SELECT COALESCE(i.billed_for_client_id, i.client_id) AS entrena,
        i.due_on, i.amount,
        COALESCE(i.billing_period, date_trunc('month', i.due_on)::date) AS billing_period,
        -- Las sesiones salen del último saldo del cliente y, si aún no tiene
        -- ninguno, del plan que se le asignó. Antes sólo miraba el saldo
        -- previo, así que quien nunca tuvo uno no lo tenía nunca: había que
        -- crearle el primero a mano, y las sesiones declaradas en el plan no
        -- servían para nada hasta entonces.
        COALESCE(
          (SELECT sp.total_sessions FROM session_packages sp
            WHERE sp.client_id = COALESCE(i.billed_for_client_id, i.client_id) AND sp.kind = 'monthly'
            ORDER BY sp.purchased_on DESC, sp.created_at DESC LIMIT 1),
          pl.sessions_included
        ) AS total_sessions
      FROM invoices i
      JOIN clients c ON c.id = COALESCE(i.billed_for_client_id, i.client_id)
      LEFT JOIN service_plans pl ON pl.id = c.plan_id
      WHERE c.status = 'active' AND c.billing_model = 'monthly' AND i.status <> 'void'
        AND i.package_id IS NULL
        -- Sólo el ciclo que viene. Un cobro de un mes cerrado es historial: no
        -- debe repartir sesiones hoy ni corregir nada hacia atrás.
        --
        -- Aquí no rige la ventana de días de la generación: ésa existe para no
        -- emitir un cobro antes de tiempo, y un saldo no es un cobro. Son las
        -- sesiones de un cobro que ya está emitido, y hacerlas esperar a una
        -- semana antes del corte deja al cliente entrenando sin de dónde
        -- descontar. Se toma el corte más cercano y sólo uno por persona.
        AND i.due_on >= current_date
        AND (${selectedOwner}::uuid IS NULL OR c.owner_id = ${selectedOwner}::uuid)
        AND NOT EXISTS (
          SELECT 1 FROM session_packages sp
          WHERE sp.client_id = COALESCE(i.billed_for_client_id, i.client_id) AND sp.kind = 'monthly'
            AND sp.expires_on IS NOT NULL AND sp.expires_on >= i.due_on
        )
    ) q
    WHERE q.total_sessions > 0
    ORDER BY entrena, due_on
  `;
  for (const cobro of pendientes) {
    const [abierto] = await sql`
      INSERT INTO session_packages (client_id, label, total_sessions, amount, expires_on, kind, purchased_on, status)
      VALUES (${cobro.entrena},
        ${'Mensualidad ' + new Intl.DateTimeFormat('es-PA', { month: 'long', year: 'numeric', timeZone: 'America/Panama' }).format(mediodiaEnPanama(cobro.billing_period))},
        ${cobro.total_sessions}, ${cobro.amount}, ${cobro.due_on}::date, 'monthly', current_date,
        -- Nace activo, y es la diferencia entre servir y no servir. Un saldo
        -- 'pending' no suma en las sesiones disponibles ni se descuenta al
        -- marcar la clase: el cliente entrenaba y su saldo no se movía. Se
        -- activaba al confirmar el cobro asociado, pero éste no lo tiene —y
        -- los cobros que vienen de Zoho no pasan por esa confirmación—, así
        -- que se habría quedado dormido para siempre.
        --
        -- La mensualidad se paga por adelantado y el cobro ya está emitido:
        -- las clases del ciclo son suyas. Si no lo fueran, el cumplimiento
        -- mediría mal a quien sí entrenó, que es peor que cobrar tarde.
        'active')
      RETURNING id
    `;
    await cobrarClasesYaDadas(sql, abierto.id as string, cobro.entrena as string,
      String(cobro.due_on).slice(0, 10), Number(cobro.total_sessions));
  }
  return { generated: invoices.length, balances: pendientes.length, invoices };
}

app.get('/api/billing/recurring/status', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return recurringBillingStatus(auth.sub);
});

app.post('/api/billing/recurring/generate', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const status = await recurringBillingStatus(auth.sub);
  if (status.blockedByZoho) {
    return { ...status, generated: 0, message: 'La facturación automática se activará después del corte final de Zoho.' };
  }
  const result = await generateRecurringInvoices(auth.sub);
  return { ...(await recurringBillingStatus(auth.sub)), generated: result.generated, balances: result.balances };
});

app.get('/health', async () => {
  const [database] = await sql`SELECT now() AS time`;
  return {
    status: 'ok', service: 'eileen-lifestyle-api', databaseTime: database.time,
    documentStorage: storageReady ? 'ready' : 'configuration_required',
    inbodyAnalysis: inbodyAnalysisReady ? 'configured' : 'configuration_required',
    webPush: webPushReady ? 'configured' : 'configuration_required',
    googleCalendar: config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET ? 'configured' : 'configuration_required'
  };
});

app.get('/api/auth/setup-status', async () => {
  const [{ count }] = await sql`SELECT count(*)::integer AS count FROM users`;
  return { required: count === 0 };
});

const setupSchema = z.object({ email: z.string().email(), password: z.string().min(10), fullName: z.string().min(2) });
// ── Bitácora de borrados ──────────────────────────────────────────────────
// Un hook y no quince llamadas repartidas por los endpoints: así quedan
// cubiertas también las rutas de borrado que se añadan mañana, que es
// justamente lo que se olvidaría instrumentar a mano.
//
// Va en onSend porque aquí ya se conoce la respuesta: varios endpoints
// devuelven lo que borraron ("plan", "categoria", "concept"), y eso convierte
// un identificador suelto en algo legible dentro de un año.
app.addHook('onSend', async (request, reply, payload) => {
  try {
    const url = request.url || '';
    const esBorrado = request.method === 'DELETE' || (request.method === 'POST' && url.includes('/permanent'));
    if (!esBorrado || reply.statusCode >= 400) return payload;
    const auth = request.user as AuthUser | undefined;
    if (!auth?.sub) return payload;

    // Se guarda el texto tal cual y se convierte en la propia consulta: pasar
    // un objeto suelto al driver obliga a pelearse con sus tipos sin ganar
    // nada, porque el cuerpo ya venía siendo JSON.
    let detalle: string | null = null;
    if (typeof payload === 'string' && payload.length <= 4000) {
      try { JSON.parse(payload); detalle = payload; } catch { detalle = null; }
    }
    const parametros = (request.params || {}) as Record<string, string>;
    await sql`
      INSERT INTO audit_log (user_id, user_email, action, route, target_id, detail, ip)
      VALUES (${auth.sub}, ${auth.email || null}, ${request.method},
        ${request.routeOptions?.url || url}, ${parametros.id || null},
        -- El ::text antes del ::jsonb no sobra: sin él, postgres.js deduce que
        -- el parámetro ya es jsonb y vuelve a codificarlo, y en la columna
        -- acaba una cadena JSON escapada en vez de un objeto.
        ${detalle}::text::jsonb, ${request.ip || null})
    `;
  } catch (error) {
    // La bitácora nunca puede tumbar la operación que registra: si falla, se
    // deja constancia en el log del servidor y la respuesta sigue su camino.
    app.log.warn({ err: error, url: request.url }, 'No se pudo escribir en la bitácora');
  }
  return payload;
});

app.get('/api/audit-log', { preHandler: requireStaff }, async request => {
  const consulta = z.object({ limit: z.coerce.number().int().min(1).max(200).default(60) }).parse(request.query);
  return sql`
    SELECT id, user_email, action, route, target_id, detail, created_at
    FROM audit_log ORDER BY created_at DESC LIMIT ${consulta.limit}
  `;
});

// ── Freno a la fuerza bruta ───────────────────────────────────────────────
// Se cuenta por correo y por IP. Por correo, para que nadie martillee una
// cuenta concreta; por IP, para que no se libre probando muchos correos
// distintos. Los topes son holgados: quien se equivoca de contraseña de verdad
// no llega a ocho fallos en un cuarto de hora, y quien prueba a ciegas sí.
const LIMITE_CORREO = 8;
const LIMITE_IP = 25;
const VENTANA_MINUTOS = 15;

async function registrarIntento(endpoint: string, email: string | null, ip: string | null, succeeded: boolean) {
  await sql`
    INSERT INTO auth_attempts (endpoint, email, ip, succeeded)
    VALUES (${endpoint}, ${email ? email.toLowerCase() : null}, ${ip || null}, ${succeeded})
  `;
}

// Devuelve los segundos que faltan para poder reintentar, o 0 si puede pasar.
async function esperaPorAbuso(email: string | null, ip: string | null) {
  const desde = `${VENTANA_MINUTOS} minutes`;
  const [fila] = await sql`
    SELECT
      count(*) FILTER (WHERE email = ${email ? email.toLowerCase() : null})::int AS por_correo,
      count(*) FILTER (WHERE ip = ${ip || null})::int AS por_ip,
      max(created_at) AS ultimo
    FROM auth_attempts
    WHERE NOT succeeded AND created_at > now() - ${desde}::interval
      AND (email = ${email ? email.toLowerCase() : null} OR ip = ${ip || null})
  `;
  const excedido = Number(fila?.por_correo || 0) >= LIMITE_CORREO || Number(fila?.por_ip || 0) >= LIMITE_IP;
  if (!excedido || !fila?.ultimo) return 0;
  // La ventana corre desde el último fallo: insistir alarga la espera.
  const listoEn = new Date(fila.ultimo as string).getTime() + VENTANA_MINUTOS * 60_000;
  return Math.max(0, Math.ceil((listoEn - Date.now()) / 1000));
}

function respuestaDeEspera(reply: FastifyReply, segundos: number) {
  const minutos = Math.max(1, Math.ceil(segundos / 60));
  reply.header('Retry-After', String(segundos));
  return reply.code(429).send({
    error: `Demasiados intentos fallidos. Vuelve a probar en ${minutos} minuto${minutos === 1 ? '' : 's'}.`
  });
}

// Purga los intentos viejos. No hacen falta para nada una vez pasada la
// ventana, y sin esto la tabla crecería para siempre.
async function purgarIntentos() {
  await sql`DELETE FROM auth_attempts WHERE created_at < now() - interval '30 days'`;
}

app.post('/api/auth/setup', async (request, reply) => {
  const esperaSetup = await esperaPorAbuso(null, request.ip);
  if (esperaSetup) return respuestaDeEspera(reply, esperaSetup);
  if (request.headers['x-setup-token'] !== config.SETUP_TOKEN) {
    await registrarIntento('setup', null, request.ip, false);
    return reply.code(403).send({ error: 'Token de configuración inválido' });
  }
  const [{ count }] = await sql`SELECT count(*)::integer AS count FROM users`;
  if (count > 0) return reply.code(409).send({ error: 'La cuenta administradora ya fue creada' });
  const input = setupSchema.parse(request.body);
  const passwordHash = await bcrypt.hash(input.password, 12);
  const [user] = await sql`
    INSERT INTO users (email, password_hash, full_name, role)
    VALUES (${input.email.toLowerCase()}, ${passwordHash}, ${input.fullName}, 'admin')
    RETURNING id, email, full_name, role
  `;
  const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role }, { expiresIn: sessionLifetime });
  return reply.code(201).send({ user, token });
});

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
app.post('/api/auth/login', async (request, reply) => {
  const input = loginSchema.parse(request.body);
  const espera = await esperaPorAbuso(input.email, request.ip);
  // Se frena antes de comprobar la contraseña: si no, el propio tiempo de
  // respuesta seguiría diciendo si el correo existe.
  if (espera) return respuestaDeEspera(reply, espera);

  const [user] = await sql`SELECT id, email, full_name, role, password_hash, active FROM users WHERE email = ${input.email.toLowerCase()}`;
  if (!user || !user.active || !(await bcrypt.compare(input.password, user.password_hash))) {
    await registrarIntento('login', input.email, request.ip, false);
    return reply.code(401).send({ error: 'Correo o contraseña incorrectos' });
  }
  // Entrar borra los fallos de ese correo: quien se equivocó tres veces y
  // acertó a la cuarta no debe arrastrar el contador el resto de la tarde.
  await sql`DELETE FROM auth_attempts WHERE email = ${input.email.toLowerCase()} AND NOT succeeded`;
  await registrarIntento('login', input.email, request.ip, true);
  const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role }, { expiresIn: sessionLifetime });
  return { user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role }, token };
});

const resetPasswordSchema = z.object({ email: z.string().email(), password: z.string().min(10) });
app.post('/api/auth/reset-password', async (request, reply) => {
  // Esta ruta cambia la contraseña de la primera cuenta administradora con
  // sólo acertar el token, así que es la más golosa de las tres.
  const esperaReset = await esperaPorAbuso(null, request.ip);
  if (esperaReset) return respuestaDeEspera(reply, esperaReset);
  if (request.headers['x-setup-token'] !== config.SETUP_TOKEN) {
    await registrarIntento('reset-password', null, request.ip, false);
    return reply.code(403).send({ error: 'Token de recuperación inválido' });
  }
  const input = resetPasswordSchema.parse(request.body);
  const passwordHash = await bcrypt.hash(input.password, 12);
  const [user] = await sql`
    UPDATE users SET email = ${input.email.toLowerCase()}, password_hash = ${passwordHash}, updated_at = now()
    WHERE id = (SELECT id FROM users WHERE role = 'admin' AND active = true ORDER BY created_at LIMIT 1)
    RETURNING id, email, full_name, role
  `;
  if (!user) return reply.code(404).send({ error: 'No existe una cuenta administradora activa' });
  const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role }, { expiresIn: sessionLifetime });
  return { user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role }, token };
});

app.get('/api/me', { preHandler: requireAuth }, async request => {
  // Se devuelve un token nuevo en cada arranque: usar la aplicación renueva la
  // sesión, y sólo caduca tras 30 días sin abrirla.
  const renovado = app.jwt.sign({ sub: (request.user as AuthUser).sub, email: (request.user as AuthUser).email, role: (request.user as AuthUser).role }, { expiresIn: sessionLifetime });
  const auth = request.user as AuthUser;
  const [user] = await sql`SELECT id, email, full_name, role FROM users WHERE id = ${auth.sub}`;
  return { user, token: renovado };
});

const planSchema = z.object({
  name: z.string().trim().min(2).max(80), description: z.string().trim().max(240).optional(),
  billingModel: z.enum(['monthly', 'package', 'single']), price: z.coerce.number().min(0),
  sessionsIncluded: z.coerce.number().int().positive().optional(), validityDays: z.coerce.number().int().positive().optional(),
  active: z.boolean().default(true)
}).superRefine((plan, context) => {
  // La mensualidad también tiene un número de sesiones: es el que la
  // entrenadora acordó por mes y contra el que se mide el cumplimiento. Antes
  // sólo el paquete lo pedía, así que un cliente de mensualidad no tenía meta
  // salvo que alguien la escribiera a mano en su ficha.
  // Las sesiones individuales no llevan número: se cobra una cada vez que
  // ocurre, no hay bolsa ni meta mensual que declarar por adelantado.
  if (plan.billingModel !== 'single' && !plan.sessionsIncluded) context.addIssue({
    code: 'custom', path: ['sessionsIncluded'],
    message: plan.billingModel === 'package' ? 'Indica la cantidad de sesiones' : 'Indica las sesiones por mes'
  });
});

app.get('/api/plans', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`SELECT * FROM service_plans WHERE owner_id = ${auth.sub} ORDER BY active DESC, name`;
});

app.post('/api/plans', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const input = planSchema.parse(request.body);
  const [plan] = await sql`
    INSERT INTO service_plans (owner_id, name, description, billing_model, price, sessions_included, validity_days, active)
    VALUES (${auth.sub}, ${input.name}, ${input.description || null}, ${input.billingModel}, ${input.price}, ${input.billingModel === 'single' ? null : input.sessionsIncluded!}, ${input.billingModel === 'package' ? input.validityDays || 30 : null}, ${input.active})
    RETURNING *
  `;
  return reply.code(201).send(plan);
});

app.patch('/api/plans/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id); const input = planSchema.parse(request.body);
  const [plan] = await sql`
    UPDATE service_plans SET name = ${input.name}, description = ${input.description || null}, billing_model = ${input.billingModel},
      price = ${input.price}, sessions_included = ${input.billingModel === 'single' ? null : input.sessionsIncluded!},
      validity_days = ${input.billingModel === 'package' ? input.validityDays || 30 : null}, active = ${input.active}, updated_at = now()
    WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING *
  `;
  if (!plan) return reply.code(404).send({ error: 'Plan no encontrado' });
  return plan;
});

// Borrar un plan de verdad, sólo si nadie lo usa. Desactivarlo lo esconde de
// los clientes nuevos pero lo deja en la lista para siempre, y un plan creado
// por error —o de prueba— no tiene por qué quedarse ahí.
//
// Si algún cliente lo tiene asignado no se borra: la clave foránea es ON DELETE
// SET NULL, así que borrarlo dejaría a esas personas sin plan y sin manera de
// saber cuál tenían.
app.delete('/api/plans/:id/permanent', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [enUso] = await sql`
    SELECT count(*)::int AS total FROM clients WHERE plan_id = ${id} AND owner_id = ${auth.sub}
  `;
  if (Number(enUso?.total)) {
    return reply.code(409).send({
      error: `Este plan está asignado a ${enUso.total} cliente${Number(enUso.total) === 1 ? '' : 's'}. Cámbiales el plan antes de borrarlo, o desactívalo.`
    });
  }
  const [plan] = await sql`DELETE FROM service_plans WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING id, name`;
  if (!plan) return reply.code(404).send({ error: 'Plan no encontrado' });
  return { deleted: true, plan };
});

app.delete('/api/plans/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [plan] = await sql`UPDATE service_plans SET active = false, updated_at = now() WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING id, name`;
  if (!plan) return reply.code(404).send({ error: 'Plan no encontrado' });
  return { deleted: true, archived: true, plan };
});

const clientSchema = z.object({
  fullName: z.string().min(2), email: z.string().email().optional().or(z.literal('')), phone: z.string().optional(),
  goal: z.string().optional(), notes: z.string().optional(), billingModel: z.enum(['monthly', 'package', 'single']).default('monthly'),
  standardPrice: z.coerce.number().min(0).default(0), packageSessions: z.coerce.number().int().positive().optional(),
  planId: z.string().uuid().optional(), cutoffDay: z.coerce.number().int().min(1).max(31).default(1),
  // Vacío llega como '' desde el formulario y significa "sin meta pactada".
  monthlySessionTarget: z.union([z.literal(''), z.null(), z.coerce.number().int().min(1).max(31)]).optional()
    .transform(value => (value === '' || value === undefined ? null : value)),
  // Quién paga por este cliente. Vacío = paga él mismo.
  billingResponsibleClientId: z.union([z.literal(''), z.null(), z.string().uuid()]).optional()
    .transform(value => (value === '' || value === undefined ? null : value)),
  // Desactivar en vez de borrar: quien deja de entrenar conserva su expediente,
  // su historial de InBody y sus cobros, pero sale de las listas del día a día.
  status: z.enum(['active', 'paused', 'inactive']).optional()
});
app.get('/api/clients', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`
    SELECT c.*, p.name AS plan_name, p.sessions_included, p.validity_days,
      COALESCE((SELECT sum(total_sessions - used_sessions) FROM session_packages sp WHERE sp.client_id = c.id AND sp.status = 'active'), 0)::integer AS available_sessions,
      -- Movimientos del ciclo en curso, separados. Cancelar y perder la clase
      -- no es lo mismo que pedir otro día: lo primero mide el cumplimiento del
      -- cliente, lo segundo el desgaste de la agenda. Juntos no dicen nada.
      (SELECT count(*)::int FROM session_reschedules sr
        WHERE sr.client_id = c.id AND sr.created_at >= inicio_ciclo(c.billing_cutoff_day)) AS reprogramaciones_ciclo,
      (SELECT count(*)::int FROM sessions s
        WHERE s.client_id = c.id AND s.status = 'cancelled' AND s.cancellation_kind = 'not_rescheduled'
          AND s.starts_at >= inicio_ciclo(c.billing_cutoff_day)) AS canceladas_ciclo
    FROM clients c LEFT JOIN service_plans p ON p.id = c.plan_id
    WHERE c.owner_id = ${auth.sub} ORDER BY c.full_name
  `;
});
app.post('/api/clients', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const input = clientSchema.parse(request.body);
  const result = await sql.begin(async transaction => {
    const [selectedPlan] = input.planId ? await transaction`SELECT * FROM service_plans WHERE id = ${input.planId} AND owner_id = ${auth.sub} AND active = true` : [];
    if (input.planId && !selectedPlan) return null;
    const billingModel = selectedPlan?.billing_model || input.billingModel;
    const standardPrice = selectedPlan ? Number(selectedPlan.price) : input.standardPrice;
    const packageSessions = selectedPlan?.sessions_included || input.packageSessions;
    const [client] = await transaction`
      INSERT INTO clients (owner_id, full_name, email, phone, goal, notes, billing_model, standard_price, plan_id, billing_cutoff_day)
      VALUES (${auth.sub}, ${input.fullName}, ${input.email || null}, ${input.phone || null}, ${input.goal || null}, ${input.notes || null}, ${billingModel}, ${standardPrice}, ${selectedPlan?.id || null}, ${input.cutoffDay}) RETURNING *
    `;
    if (billingModel === 'monthly') {
      // Las sesiones del plan mensual son la meta contra la que se mide el
      // cumplimiento. Sin esto el número del plan y el del cumplimiento serían
      // dos cifras distintas que nadie mantiene sincronizadas.
      if (selectedPlan?.sessions_included) {
        await transaction`UPDATE clients SET monthly_session_target = ${selectedPlan.sessions_included} WHERE id = ${client.id}`;
      }
      await transaction`INSERT INTO memberships (client_id, amount, renewal_day) VALUES (${client.id}, ${standardPrice}, ${input.cutoffDay})`;
    } else if (packageSessions) {
      const expiresOn = selectedPlan?.validity_days ? new Date(Date.now() + Number(selectedPlan.validity_days) * 86400000).toISOString().slice(0, 10) : null;
      const [pack] = await transaction`INSERT INTO session_packages (client_id, label, total_sessions, amount, expires_on) VALUES (${client.id}, ${selectedPlan?.name || `Paquete ${packageSessions} sesiones`}, ${packageSessions}, ${standardPrice}, ${expiresOn}) RETURNING id`;
      await transaction`INSERT INTO invoices (client_id, package_id, concept, amount, due_on) VALUES (${client.id}, ${pack.id}, 'Paquete de sesiones', ${standardPrice}, current_date)`;
    }
    return client;
  });
  if (!result) return reply.code(404).send({ error: 'Plan no encontrado o inactivo' });
  return reply.code(201).send(result);
});

app.patch('/api/clients/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = clientSchema.pick({ fullName: true, email: true, phone: true, goal: true, notes: true, monthlySessionTarget: true, billingResponsibleClientId: true, status: true, cutoffDay: true }).parse(request.body);
  // cutoffDay lleva .default(1) en el esquema, así que si no viene en el cuerpo
  // llega valiendo 1: editar sólo el nombre habría movido el día de cobro al
  // primero de mes sin avisar. Se mira si venía de verdad.
  const tocaCorte = 'cutoffDay' in (request.body as Record<string, unknown>);
  // El pagador debe ser otro cliente de la misma entrenadora, y no puede
  // apuntarse a sí mismo ni encadenar: quien paga por alguien no puede a su vez
  // tener pagador, o el saldo quedaría en un tercero imposible de rastrear.
  if (input.billingResponsibleClientId) {
    if (input.billingResponsibleClientId === id) return reply.code(400).send({ error: 'Un cliente no puede pagarse a sí mismo' });
    const [pagador] = await sql`SELECT id, billing_responsible_client_id FROM clients WHERE id = ${input.billingResponsibleClientId} AND owner_id = ${auth.sub}`;
    if (!pagador) return reply.code(404).send({ error: 'El cliente responsable del pago no existe' });
    if (pagador.billing_responsible_client_id) return reply.code(409).send({ error: 'Ese cliente ya tiene a otra persona como responsable de su pago' });
    const [dependientes] = await sql`SELECT id FROM clients WHERE billing_responsible_client_id = ${id} LIMIT 1`;
    if (dependientes) return reply.code(409).send({ error: 'Este cliente ya paga por alguien más, no puede depender de otro' });
  }
  const [client] = await sql`UPDATE clients SET full_name = ${input.fullName}, email = ${input.email || null}, phone = ${input.phone || null}, goal = ${input.goal || null}, notes = ${input.notes || null}, monthly_session_target = ${input.monthlySessionTarget ?? null}, billing_responsible_client_id = ${input.billingResponsibleClientId ?? null}, status = COALESCE(${input.status ?? null}, status),
    billing_cutoff_day = CASE WHEN ${tocaCorte} THEN ${input.cutoffDay}::int ELSE billing_cutoff_day END, updated_at = now() WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING *`;
  if (!client) return reply.code(404).send({ error: 'Cliente no encontrado' });
  // La membresía guarda su propio día de renovación. Si sólo se moviera el del
  // cliente, quedarían dos fechas distintas para lo mismo y cuál manda
  // dependería de por dónde se mire.
  if (tocaCorte) {
    // memberships no tiene updated_at; añadirlo aquí rompía el guardado entero.
    await sql`UPDATE memberships SET renewal_day = ${input.cutoffDay} WHERE client_id = ${id} AND status = 'active'`;
  }
  return client;
});

app.delete('/api/clients/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const documents = await sql`
    SELECT d.object_key FROM documents d JOIN clients c ON c.id = d.client_id
    WHERE d.client_id = ${id} AND c.owner_id = ${auth.sub}
  `;
  if (storageReady) {
    for (const document of documents) await deleteObject(document.object_key);
  }
  const [client] = await sql`DELETE FROM clients WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING id, full_name`;
  if (!client) return reply.code(404).send({ error: 'Cliente no encontrado' });
  return { deleted: true, client };
});

const clientPlanSchema = z.object({ planId: z.string().uuid(), cutoffDay: z.coerce.number().int().min(1).max(31) });
app.patch('/api/clients/:id/plan', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id); const input = clientPlanSchema.parse(request.body);
  const result = await sql.begin(async transaction => {
    const [plan] = await transaction`SELECT * FROM service_plans WHERE id = ${input.planId} AND owner_id = ${auth.sub} AND active = true`;
    if (!plan) return null;
    const [client] = await transaction`
      UPDATE clients SET plan_id = ${plan.id}, billing_model = ${plan.billing_model}, standard_price = ${plan.price}, billing_cutoff_day = ${input.cutoffDay}, updated_at = now()
      WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING *
    `;
    if (!client) return null;
    if (plan.billing_model === 'monthly') {
      if (plan.sessions_included) {
        await transaction`UPDATE clients SET monthly_session_target = ${plan.sessions_included} WHERE id = ${id}`;
      }
      await transaction`
        INSERT INTO memberships (client_id, amount, renewal_day)
        SELECT ${id}, ${plan.price}, ${input.cutoffDay}
        WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE client_id = ${id} AND status = 'active')
      `;
      await transaction`UPDATE memberships SET amount = ${plan.price}, renewal_day = ${input.cutoffDay}, status = 'active' WHERE client_id = ${id} AND status = 'active'`;
    } else {
      await transaction`UPDATE memberships SET status = 'paused' WHERE client_id = ${id} AND status = 'active'`;
      // Las sesiones individuales no abren saldo ni cobro por adelantado: no
      // hay bolsa que crear. Sin este corte se insertaría un paquete con
      // total_sessions nulo y una factura por una sesión que aún no ocurrió.
      // También se limpia la meta mensual: la que hubiera quedado del plan
      // anterior seguiría midiendo el cumplimiento contra algo ya no pactado.
      if (plan.billing_model === 'single') {
        await transaction`UPDATE clients SET monthly_session_target = NULL WHERE id = ${id}`;
        return client;
      }
      const [existingPackage] = await transaction`SELECT id FROM session_packages WHERE client_id = ${id} AND status IN ('pending', 'active') AND label = ${plan.name} ORDER BY created_at DESC LIMIT 1`;
      if (!existingPackage) {
        const expiresOn = plan.validity_days ? new Date(Date.now() + Number(plan.validity_days) * 86400000).toISOString().slice(0, 10) : null;
        const [createdPackage] = await transaction`INSERT INTO session_packages (client_id, label, total_sessions, amount, expires_on) VALUES (${id}, ${plan.name}, ${plan.sessions_included}, ${plan.price}, ${expiresOn}) RETURNING id`;
        await transaction`INSERT INTO invoices (client_id, package_id, concept, amount, due_on) VALUES (${id}, ${createdPackage.id}, ${plan.name}, ${plan.price}, current_date)`;
      }
    }
    return client;
  });
  if (!result) return reply.code(404).send({ error: 'Cliente o plan no encontrado' });
  return result;
});

const portalAccessSchema = z.object({ email: z.string().email(), password: z.string().min(10) });
app.post('/api/clients/:id/portal-access', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id); const input = portalAccessSchema.parse(request.body);
  const passwordHash = await bcrypt.hash(input.password, 12);
  const portalUser = await sql.begin(async transaction => {
    const [client] = await transaction`SELECT * FROM clients WHERE id = ${id} AND owner_id = ${auth.sub} FOR UPDATE`;
    if (!client) return null;
    if (client.portal_user_id) {
      const [updated] = await transaction`UPDATE users SET email = ${input.email.toLowerCase()}, password_hash = ${passwordHash}, active = true, updated_at = now() WHERE id = ${client.portal_user_id} RETURNING id, email, full_name, role`;
      await transaction`UPDATE clients SET email = ${input.email.toLowerCase()}, updated_at = now() WHERE id = ${id}`;
      return updated;
    }
    const [created] = await transaction`INSERT INTO users (email, password_hash, full_name, role) VALUES (${input.email.toLowerCase()}, ${passwordHash}, ${client.full_name}, 'client') RETURNING id, email, full_name, role`;
    await transaction`UPDATE clients SET portal_user_id = ${created.id}, email = ${input.email.toLowerCase()}, updated_at = now() WHERE id = ${id}`;
    return created;
  });
  if (!portalUser) return reply.code(404).send({ error: 'Cliente no encontrado' });
  return reply.code(201).send({ user: portalUser });
});

// ── Enlace de acceso de un solo uso ───────────────────────────────────────
// La entrenadora genera el enlace y se lo pasa al cliente; el cliente define
// su propia contraseña. Sirve para el alta inicial y para cada olvido, y en
// ningún momento ella llega a conocer la contraseña.
const accessLinkHours = 48;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

app.post('/api/clients/:id/access-link', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);

  const emitido = await sql.begin(async transaction => {
    const [client] = await transaction`SELECT * FROM clients WHERE id = ${id} AND owner_id = ${auth.sub} FOR UPDATE`;
    if (!client) return null;
    if (!client.email) return { error: 'Registra primero el correo del cliente en su expediente' };

    let userId = client.portal_user_id as string | null;
    if (!userId) {
      // Alta inicial por enlace: el usuario nace con una contraseña aleatoria
      // que nadie conoce ni puede usar. La real la define el cliente al abrir
      // el enlace, así que la entrenadora nunca inventa ni comunica una clave.
      const inutilizable = await bcrypt.hash(randomUUID() + randomUUID(), 12);
      const [creado] = await transaction`
        INSERT INTO users (email, password_hash, full_name, role)
        VALUES (${String(client.email).toLowerCase()}, ${inutilizable}, ${client.full_name}, 'client')
        ON CONFLICT (email) DO NOTHING
        RETURNING id
      `;
      if (!creado) return { error: 'Ese correo ya pertenece a otra cuenta' };
      userId = creado.id as string;
      await transaction`UPDATE clients SET portal_user_id = ${userId}, updated_at = now() WHERE id = ${id}`;
    }

    // Emitir uno nuevo invalida los anteriores: si se generaron dos por error,
    // sólo el último debe abrir.
    await transaction`UPDATE portal_access_tokens SET used_at = now() WHERE client_id = ${id} AND used_at IS NULL`;
    const token = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
    await transaction`
      INSERT INTO portal_access_tokens (client_id, user_id, token_hash, expires_at, created_by_user_id)
      VALUES (${id}, ${userId}, ${hashToken(token)}, now() + ${`${accessLinkHours} hours`}::interval, ${auth.sub})
    `;
    return { token, clientName: client.full_name as string, email: client.email as string, nuevo: !client.portal_user_id };
  });

  if (!emitido) return reply.code(404).send({ error: 'Cliente no encontrado' });
  if ('error' in emitido) return reply.code(409).send({ error: emitido.error });
  return reply.code(201).send({
    url: new URL(`/#acceso=${emitido.token}`, config.APP_URL).toString(),
    clientName: emitido.clientName, email: emitido.email,
    expiresInHours: accessLinkHours, firstTime: emitido.nuevo
  });
});

// Público: quien tiene el enlace todavía no puede iniciar sesión.
app.get('/api/auth/access-link/:token', async (request, reply) => {
  const token = z.string().min(20).max(80).parse((request.params as { token: string }).token);
  const [row] = await sql`
    SELECT t.id, t.used_at, t.expires_at, c.full_name, u.email
    FROM portal_access_tokens t JOIN clients c ON c.id = t.client_id JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ${hashToken(token)}
  `;
  // El mismo mensaje para inexistente, usado y vencido: distinguirlos le diría
  // a quien pruebe enlaces al azar cuáles existieron.
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    return reply.code(410).send({ error: 'Este enlace ya no es válido. Pídele uno nuevo a tu entrenadora.' });
  }
  return { clientName: row.full_name, email: row.email };
});

const accessLinkPasswordSchema = z.object({ password: z.string().min(10).max(200) });
app.post('/api/auth/access-link/:token', async (request, reply) => {
  const token = z.string().min(20).max(80).parse((request.params as { token: string }).token);
  const input = accessLinkPasswordSchema.parse(request.body);
  const passwordHash = await bcrypt.hash(input.password, 12);

  const resultado = await sql.begin(async transaction => {
    // FOR UPDATE y la comprobación de used_at dentro de la transacción: dos
    // envíos simultáneos del mismo enlace no deben poder consumirlo dos veces.
    const [row] = await transaction`
      SELECT t.*, u.email, u.role FROM portal_access_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ${hashToken(token)} FOR UPDATE OF t
    `;
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) return null;
    await transaction`UPDATE portal_access_tokens SET used_at = now() WHERE id = ${row.id}`;
    const [user] = await transaction`
      UPDATE users SET password_hash = ${passwordHash}, active = true, updated_at = now()
      WHERE id = ${row.user_id} RETURNING id, email, full_name, role
    `;
    return user;
  });

  if (!resultado) return reply.code(410).send({ error: 'Este enlace ya no es válido. Pídele uno nuevo a tu entrenadora.' });
  const jwtToken = app.jwt.sign({ sub: resultado.id, email: resultado.email, role: resultado.role }, { expiresIn: sessionLifetime });
  return { user: { id: resultado.id, email: resultado.email, fullName: resultado.full_name, role: resultado.role }, token: jwtToken };
});

// Siguiente día de corte del cliente. Si hoy ya pasó el corte de este mes, cae
// en el del mes que viene. Se recorta al último día cuando el mes es más corto
// que el día pactado: un corte el 31 en febrero es el 28.
function proximoCorte(diaDeCorte: number) {
  const hoy = new Date();
  const enMes = (anio: number, mes: number) => new Date(Date.UTC(anio, mes, Math.min(diaDeCorte, new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate())));
  let corte = enMes(hoy.getUTCFullYear(), hoy.getUTCMonth());
  if (corte <= hoy) corte = enMes(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1);
  return corte.toISOString().slice(0, 10);
}

const packageSchema = z.object({
  // Sin esto la factura se fechaba siempre hoy, así que un cobro creado en
  // agosto para cubrir septiembre quedaba registrado como de agosto y la
  // generación automática emitía el de septiembre igualmente.
  dueOn: z.union([z.literal(''), z.null(), z.string().date()]).optional()
    .transform(v => (v === '' || v === undefined ? null : v)),
  clientId: z.string().uuid(), totalSessions: z.coerce.number().int().positive(), amount: z.coerce.number().positive(),
  expiresOn: z.string().date().optional(),
  kind: z.enum(['package', 'monthly']).default('package')
});
app.get('/api/packages', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`SELECT p.*, c.full_name FROM session_packages p JOIN clients c ON c.id = p.client_id WHERE c.owner_id = ${auth.sub} ORDER BY p.created_at DESC`;
});
app.post('/api/packages', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const input = packageSchema.parse(request.body);
  const [client] = await sql`SELECT id, billing_cutoff_day FROM clients WHERE id = ${input.clientId} AND owner_id = ${auth.sub}`;
  if (!client) return reply.code(404).send({ error: 'Cliente no encontrado' });

  const esCobroMensual = input.kind === 'monthly';
  const concepto = esCobroMensual ? 'Mensualidad' : 'Paquete de sesiones';
  // Una mensualidad vence en el próximo corte del cliente: es lo que delimita
  // el período que acaba de pagar. Sin vencimiento, sus sesiones no caducarían
  // nunca y se acumularían mes tras mes.
  const vence = input.expiresOn
    ? input.expiresOn
    : esCobroMensual ? proximoCorte(Number(client.billing_cutoff_day) || 1) : null;
  const etiqueta = esCobroMensual
    ? `Mensualidad ${new Intl.DateTimeFormat('es-PA', { month: 'long', year: 'numeric', timeZone: 'America/Panama' }).format(new Date())}`
    : `Paquete ${input.totalSessions} sesiones`;

  const pack = await sql.begin(async transaction => {
    const [created] = await transaction`INSERT INTO session_packages (client_id, label, total_sessions, amount, expires_on, kind) VALUES (${input.clientId}, ${etiqueta}, ${input.totalSessions}, ${input.amount}, ${vence}, ${input.kind}) RETURNING *`;
    const [invoice] = await transaction`
      INSERT INTO invoices (client_id, package_id, concept, amount, due_on, issued_on, billing_period)
      VALUES (${input.clientId}, ${created.id}, ${concepto}, ${input.amount},
        COALESCE(${input.dueOn}::date, current_date), current_date,
        -- Una mensualidad cubre el mes en que vence. Sin esto, un cobro creado
        -- hoy con vencimiento en septiembre se leía como de agosto —manda la
        -- fecha de emisión— y la generación emitía el de septiembre igualmente.
        CASE WHEN ${esCobroMensual}
          THEN date_trunc('month', COALESCE(${input.dueOn}::date, current_date))::date
          ELSE NULL END)
      RETURNING id`;
    return { ...created, invoice_id: invoice.id };
  });
  // Una mensualidad con sesiones también asienta precio y membresía: es un
  // cobro mensual aunque entre por esta puerta y no por /api/invoices.
  if (esCobroMensual && input.amount > 0) await asentarMensualidad(input.clientId, auth.sub, input.amount);
  return reply.code(201).send(pack);
});

// Reprogramar un saldo: se corre el vencimiento y las sesiones que quedaban
// vuelven a estar vivas. Existe porque el cumplimiento castiga al cliente por
// las sesiones que no se dieron, y muchas veces no se dieron por causa de la
// entrenadora —un mes que no alcanzó a agendarle—. Al mover la fecha, el saldo
// deja de estar vencido y el incumplimiento desaparece del cálculo.
const reschedulePackageSchema = z.object({ expiresOn: z.string().date(), note: z.string().trim().max(300).optional().nullable() });
app.patch('/api/packages/:id/reschedule', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = reschedulePackageSchema.parse(request.body);
  const [pack] = await sql`
    UPDATE session_packages SET
      expires_on = ${input.expiresOn}::date,
      -- Un saldo vencido vuelve a estar activo al reprogramarlo; si ya se
      -- había agotado, agotado se queda.
      status = CASE WHEN used_sessions >= total_sessions THEN 'exhausted' ELSE 'active' END,
      label = CASE WHEN ${input.note ?? null}::text IS NULL THEN label ELSE label || ' · ' || ${input.note ?? null} END
    WHERE id = ${id} AND client_id IN (SELECT id FROM clients WHERE owner_id = ${auth.sub})
    RETURNING *
  `;
  if (!pack) return reply.code(404).send({ error: 'Saldo no encontrado' });
  return pack;
});

// Editar un saldo ya creado. Hasta ahora sólo se podía reprogramar la fecha o
// borrarlo entero si no tenía uso, y un error de tecleo en las sesiones
// contratadas obligaba a rehacer el cobro. Las usadas también se corrigen: si
// una asistencia se marcó de más, el cliente perdía una sesión pagada.
const editPackageSchema = z.object({
  label: z.string().trim().min(2).max(120).optional(),
  totalSessions: z.coerce.number().int().min(1).max(400).optional(),
  usedSessions: z.coerce.number().int().min(0).max(400).optional(),
  expiresOn: z.union([z.literal(''), z.null(), z.string().date()]).optional()
    .transform(value => (value === '' || value === undefined ? null : value))
});
app.patch('/api/packages/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = editPackageSchema.parse(request.body);
  const tocaVencimiento = 'expiresOn' in (request.body as Record<string, unknown>);

  const [actual] = await sql`
    SELECT total_sessions, used_sessions FROM session_packages
    WHERE id = ${id} AND client_id IN (SELECT id FROM clients WHERE owner_id = ${auth.sub})
  `;
  if (!actual) return reply.code(404).send({ error: 'Saldo no encontrado' });

  const total = input.totalSessions ?? Number(actual.total_sessions);
  const usadas = input.usedSessions ?? Number(actual.used_sessions);
  // Usadas por encima de contratadas dejaría un saldo negativo en pantalla y
  // un cliente sin sesiones que sí pagó.
  if (usadas > total) return reply.code(400).send({ error: 'Las sesiones usadas no pueden superar las contratadas' });

  const [pack] = await sql`
    UPDATE session_packages SET
      label = COALESCE(${input.label ?? null}, label),
      total_sessions = ${total},
      used_sessions = ${usadas},
      expires_on = CASE WHEN ${tocaVencimiento} THEN ${input.expiresOn}::date ELSE expires_on END,
      -- El estado se recalcula siempre: subir las contratadas revive un saldo
      -- agotado, y bajarlas lo agota.
      -- Los ::int no son decorativos: sin ellos postgres.js manda los
      -- parámetros sin tipo y la comparación se hace como texto, donde '8'
      -- es mayor que '12'. Un saldo con 8 de 12 usadas se quedaba agotado.
      status = CASE WHEN status = 'pending' THEN 'pending'
                    WHEN ${usadas}::int >= ${total}::int THEN 'exhausted' ELSE 'active' END
    WHERE id = ${id} AND client_id IN (SELECT id FROM clients WHERE owner_id = ${auth.sub})
    RETURNING *
  `;
  return pack;
});

app.get('/api/clients/:clientId/balances', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const clientId = z.string().uuid().parse((request.params as { clientId: string }).clientId);
  if (!(await ownedClient(clientId, auth.sub))) return reply.code(404).send({ error: 'Cliente no encontrado' });
  return sql`
    SELECT id, label, kind, total_sessions, used_sessions, amount, status, purchased_on, expires_on,
      (total_sessions - used_sessions) AS remaining,
      (expires_on IS NOT NULL AND expires_on < current_date AND used_sessions < total_sessions) AS vencido_con_saldo
    FROM session_packages
    WHERE client_id = ${clientId} AND status <> 'cancelled'
    ORDER BY purchased_on DESC, created_at DESC
  `;
});

// Borrar un saldo de sesiones. Sólo si nadie lo usó: con sesiones consumidas,
// borrarlo escondería entrenamientos que sí ocurrieron y descuadraría el
// cumplimiento. La factura que lo originó no se toca —el cobro existió— y su
// referencia queda en nulo sola, por la clave foránea.
app.delete('/api/packages/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [pack] = await sql`
    SELECT sp.id, sp.label, sp.used_sessions FROM session_packages sp JOIN clients c ON c.id = sp.client_id
    WHERE sp.id = ${id} AND c.owner_id = ${auth.sub}
  `;
  if (!pack) return reply.code(404).send({ error: 'Saldo no encontrado' });
  if (Number(pack.used_sessions) > 0) {
    return reply.code(409).send({ error: `Este saldo ya tiene ${pack.used_sessions} sesión(es) usada(s). Reprogramarlo o dejarlo vencer conserva el registro; borrarlo lo perdería.` });
  }
  await sql`DELETE FROM session_packages WHERE id = ${id}`;
  return { deleted: true, label: pack.label };
});

const routineExerciseSchema = z.object({
  catalogId: z.string().max(80).optional(), name: z.string().min(1).max(120), english: z.string().max(120).optional(),
  category: z.string().max(80).optional(), level: z.string().max(40).optional(), machine: z.string().max(180).optional(),
  freeWeight: z.string().max(180).optional(), sets: z.coerce.number().int().min(1).max(20).optional(), reps: z.string().max(40).optional(),
  // Texto libre y no un número: aquí se escribe "20 lb", "12 kg" o "barra sola",
  // y forzar una unidad sería adivinar cómo trabaja cada quien.
  weight: z.string().max(40).optional(), notes: z.string().max(300).optional()
});
const routineSchema = z.object({ title: z.string().min(2), description: z.string().optional(), sessionsPerWeek: z.coerce.number().int().min(1).max(7), exercises: z.array(routineExerciseSchema).max(80).default([]), clientId: z.string().uuid().optional(), dueOn: z.union([z.literal(''), z.null(), z.string().date()]).optional().transform(value => (value === '' || value === undefined ? null : value)) });
app.get('/api/routines', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`
    SELECT r.*, COALESCE(array_agg(ra.client_id) FILTER (WHERE ra.active), '{}') AS assigned_client_ids,
      max(ra.due_on) FILTER (WHERE ra.active) AS due_on
    FROM routines r LEFT JOIN routine_assignments ra ON ra.routine_id = r.id
    WHERE r.owner_id = ${auth.sub} GROUP BY r.id ORDER BY r.created_at DESC
  `;
});
// Propuesta de rutina con IA. Devuelve un borrador para que la entrenadora lo
// revise y lo guarde ella: el modelo propone, no asigna. Una rutina mal puesta
// a alguien con una lesión no es un error de formato.
const routineSuggestionSchema = z.object({
  description: z.string().trim().min(10).max(600),
  clientId: z.string().uuid().optional(),
  repeatMuscleGroups: z.boolean().default(false)
});

// Los pesos que este cliente ya manejó, por ejercicio. Salen de sus rutinas
// anteriores: es el único registro que hay, y sirve para no empezar de cero
// cada vez ni tener que buscarlo en un cuaderno.
//
// Se sugiere, no se rellena: el peso de hoy lo decide quien está delante de la
// persona, y arrastrar el de hace dos meses como si siguiera vigente sería
// meterle un número que nadie revisó.
app.get('/api/clients/:clientId/exercise-weights', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const clientId = z.string().uuid().parse((request.params as { clientId: string }).clientId);
  const [cliente] = await sql`SELECT id FROM clients WHERE id = ${clientId} AND owner_id = ${auth.sub}`;
  if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });

  const previas = await sql`
    SELECT r.exercises, COALESCE(ra.starts_on, r.created_at::date) AS cuando
    FROM routine_assignments ra JOIN routines r ON r.id = ra.routine_id
    WHERE ra.client_id = ${clientId}
    ORDER BY COALESCE(ra.starts_on, r.created_at::date) DESC
    LIMIT 12
  `;
  // Se recorre de más reciente a más antigua y se queda con el primero que
  // aparezca de cada ejercicio: el último peso conocido.
  const ultimos: Record<string, { weight: string; on: string }> = {};
  for (const fila of previas) {
    const lista = Array.isArray(fila.exercises) ? fila.exercises as Array<{ name?: string; weight?: string }> : [];
    for (const ejercicio of lista) {
      const nombre = String(ejercicio?.name ?? '').trim();
      const peso = String(ejercicio?.weight ?? '').trim();
      if (!nombre || !peso || ultimos[nombre]) continue;
      ultimos[nombre] = { weight: peso, on: String(fila.cuando).slice(0, 10) };
    }
  }
  return ultimos;
});

app.post('/api/routines/suggest', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  if (!routineSuggestionsReady) return reply.code(503).send({ error: 'La propuesta con IA todavía no está configurada' });
  const input = routineSuggestionSchema.parse(request.body);

  const catalogo = await sql`
    SELECT name, section, level, machine FROM exercises
    WHERE owner_id = ${auth.sub} AND NOT archived ORDER BY section, name
  `;
  if (!catalogo.length) return reply.code(409).send({ error: 'No hay ejercicios en el catálogo para proponer una rutina' });

  let historial: Array<{ title: string; assignedOn: string | null; sections: string[] }> = [];
  let condiciones: string[] = [];
  let clienteNombre: string | undefined;

  if (input.clientId) {
    const [cliente] = await sql`SELECT full_name FROM clients WHERE id = ${input.clientId} AND owner_id = ${auth.sub}`;
    if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });
    clienteNombre = String(cliente.full_name);

    // Las últimas rutinas del cliente, con los grupos musculares que tocaron.
    // La sección sale del catálogo: los ejercicios de la rutina se guardan como
    // JSON y no traen la sección consigo.
    const previas = await sql`
      SELECT r.title, ra.starts_on, r.exercises
      FROM routine_assignments ra JOIN routines r ON r.id = ra.routine_id
      WHERE ra.client_id = ${input.clientId}
      ORDER BY ra.starts_on DESC NULLS LAST LIMIT 4
    `;
    const secciones = new Map(catalogo.map(e => [String(e.name).toLowerCase(), String(e.section)]));
    historial = previas.map(fila => {
      const lista = Array.isArray(fila.exercises) ? fila.exercises as Array<{ name?: string }> : [];
      const suyas = [...new Set(lista.map(e => secciones.get(String(e?.name ?? '').toLowerCase())).filter(Boolean))];
      return { title: String(fila.title), assignedOn: fila.starts_on ? String(fila.starts_on).slice(0, 10) : null, sections: suyas as string[] };
    });

    // 'recovered' es el estado de superada; las activas y las que siguen en
    // observación sí condicionan qué se le puede mandar.
    const lesiones = await sql`
      SELECT title, body_area, severity FROM client_conditions
      WHERE client_id = ${input.clientId} AND status IN ('active', 'monitoring')
    `;
    const gravedad: Record<string, string> = { mild: 'leve', moderate: 'moderada', severe: 'grave' };
    condiciones = lesiones.map(fila =>
      `${fila.title}${fila.body_area ? ` en ${fila.body_area}` : ''} (${gravedad[String(fila.severity)] || fila.severity})`);
  }

  try {
    const propuesta = await suggestRoutine({
      descripcion: input.description,
      catalogo: catalogo.map(e => ({ name: String(e.name), section: String(e.section), level: e.level as string, machine: e.machine as string })),
      historial, condiciones,
      repetirGrupos: input.repeatMuscleGroups,
      clienteNombre
    });
    return propuesta;
  } catch (error) {
    app.log.warn({ err: error, ownerId: auth.sub }, 'No se pudo proponer una rutina');
    return reply.code(502).send({ error: (error as Error).message });
  }
});

app.post('/api/routines', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const input = routineSchema.parse(request.body);
  const routine = await sql.begin(async transaction => {
    const [created] = await transaction`INSERT INTO routines (owner_id, title, description, sessions_per_week, exercises) VALUES (${auth.sub}, ${input.title}, ${input.description || null}, ${input.sessionsPerWeek}, ${transaction.json(input.exercises)}) RETURNING *`;
    if (input.clientId) await transaction`INSERT INTO routine_assignments (routine_id, client_id, due_on) SELECT ${created.id}, id, ${input.dueOn ?? null}::date FROM clients WHERE id = ${input.clientId} AND owner_id = ${auth.sub}`;
    return created;
  });
  return reply.code(201).send(routine);
});

app.patch('/api/routines/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = routineSchema.parse(request.body);
  const routine = await sql.begin(async transaction => {
    const [updated] = await transaction`UPDATE routines SET title = ${input.title}, description = ${input.description || null}, sessions_per_week = ${input.sessionsPerWeek}, exercises = ${transaction.json(input.exercises)}, updated_at = now() WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING *`;
    if (!updated) return null;
    await transaction`UPDATE routine_assignments SET active = false, ends_on = current_date WHERE routine_id = ${id} AND active = true`;
    if (input.clientId) await transaction`INSERT INTO routine_assignments (routine_id, client_id, due_on) SELECT ${id}, c.id, ${input.dueOn ?? null}::date FROM clients c WHERE c.id = ${input.clientId} AND c.owner_id = ${auth.sub} ON CONFLICT (routine_id, client_id, starts_on) DO UPDATE SET active = true, ends_on = null, due_on = EXCLUDED.due_on`;
    return updated;
  });
  if (!routine) return reply.code(404).send({ error: 'Rutina no encontrada' });
  return routine;
});

app.delete('/api/routines/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [routine] = await sql`DELETE FROM routines WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING id, title`;
  if (!routine) return reply.code(404).send({ error: 'Rutina no encontrada' });
  return { deleted: true, routine };
});

// ── Catálogo de ejercicios ────────────────────────────────────────────────
const exerciseSections = ['tren_inferior', 'tren_superior', 'core', 'cardio', 'hit'] as const;
const videoContentTypes = ['video/mp4', 'video/webm'] as const;
const maxVideoSize = 40 * 1024 * 1024;

const exerciseSchema = z.object({
  name: z.string().trim().min(2).max(120),
  english: z.string().trim().max(120).optional().nullable(),
  section: z.enum(exerciseSections),
  pattern: z.string().trim().max(60).optional().nullable(),
  level: z.string().trim().max(40).default('Todos'),
  machine: z.string().trim().max(180).optional().nullable(),
  freeWeight: z.string().trim().max(180).optional().nullable(),
  cues: z.string().trim().max(600).optional().nullable(),
  usesWeight: z.boolean().optional(),
  archived: z.boolean().optional()
});

// slug estable a partir del nombre, para que un ejercicio creado a mano tenga
// la misma clase de identificador que los sembrados y las rutinas viejas
// puedan seguir enganchando por catalogId.
function slugFrom(name: string) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'ejercicio';
}

const exerciseColumns = sql`
  id, slug, name, english, section, pattern, level, machine, free_weight, cues,
  uses_weight, archived, sort_order, video_content_type, video_size_bytes, video_duration_seconds,
  video_uploaded_at, (video_object_key IS NOT NULL) AS has_video
`;

app.get('/api/exercises', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  // z.coerce.boolean() leería la cadena "false" como true. Hoy el frontend no
  // manda este parámetro, pero la trampa quedaba armada para quien lo usara.
  const query = z.object({
    section: z.enum(exerciseSections).optional(),
    includeArchived: z.enum(['true', 'false']).default('false').transform(valor => valor === 'true')
  }).parse(request.query);
  return sql`
    SELECT ${exerciseColumns} FROM exercises
    WHERE owner_id = ${auth.sub}
      AND (${query.includeArchived} OR archived = false)
      AND (${query.section || null}::text IS NULL OR section = ${query.section || null})
    ORDER BY section, sort_order, name
  `;
});

app.post('/api/exercises', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const input = exerciseSchema.parse(request.body);
  const [exercise] = await sql`
    INSERT INTO exercises (owner_id, slug, name, english, section, pattern, level, machine, free_weight, cues, uses_weight)
    VALUES (${auth.sub}, ${slugFrom(input.name)}, ${input.name}, ${input.english || null}, ${input.section},
            ${input.pattern || null}, ${input.level}, ${input.machine || null}, ${input.freeWeight || null}, ${input.cues || null},
            ${input.usesWeight ?? false})
    ON CONFLICT (owner_id, slug) DO NOTHING
    RETURNING ${exerciseColumns}
  `;
  if (!exercise) return reply.code(409).send({ error: 'Ya existe un ejercicio con ese nombre' });
  return reply.code(201).send(exercise);
});

app.patch('/api/exercises/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = exerciseSchema.partial().parse(request.body);
  const [exercise] = await sql`
    UPDATE exercises SET
      name = COALESCE(${input.name ?? null}, name),
      english = COALESCE(${input.english ?? null}, english),
      section = COALESCE(${input.section ?? null}, section),
      pattern = COALESCE(${input.pattern ?? null}, pattern),
      level = COALESCE(${input.level ?? null}, level),
      machine = COALESCE(${input.machine ?? null}, machine),
      free_weight = COALESCE(${input.freeWeight ?? null}, free_weight),
      cues = COALESCE(${input.cues ?? null}, cues),
      uses_weight = COALESCE(${input.usesWeight ?? null}, uses_weight),
      archived = COALESCE(${input.archived ?? null}, archived),
      updated_at = now()
    WHERE id = ${id} AND owner_id = ${auth.sub}
    RETURNING ${exerciseColumns}
  `;
  if (!exercise) return reply.code(404).send({ error: 'Ejercicio no encontrado' });
  return exercise;
});

app.delete('/api/exercises/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [exercise] = await sql`DELETE FROM exercises WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING id, name, video_object_key`;
  if (!exercise) return reply.code(404).send({ error: 'Ejercicio no encontrado' });
  if (exercise.video_object_key && storageReady) {
    await deleteObject(exercise.video_object_key).catch(error => app.log.warn({ err: error, exerciseId: id }, 'No se pudo borrar el video del ejercicio'));
  }
  return { deleted: true, exercise: { id: exercise.id, name: exercise.name } };
});

// El video sube directo del navegador a R2 con una URL firmada. Pasarlo por
// Railway costaría ancho de banda y CPU por cada clip sin ganar nada.
app.post('/api/exercises/:id/video-upload-url', { preHandler: requireStaff }, async (request, reply) => {
  if (!storageReady) return reply.code(503).send({ error: 'El almacenamiento de video aún no está configurado' });
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = z.object({ contentType: z.enum(videoContentTypes), sizeBytes: z.coerce.number().int().positive().max(maxVideoSize) }).parse(request.body);
  const [exercise] = await sql`SELECT id FROM exercises WHERE id = ${id} AND owner_id = ${auth.sub}`;
  if (!exercise) return reply.code(404).send({ error: 'Ejercicio no encontrado' });
  const objectKey = `exercises/${id}/${randomUUID()}.${input.contentType === 'video/webm' ? 'webm' : 'mp4'}`;
  return { objectKey, uploadUrl: await createUploadUrl(objectKey, input.contentType), expiresInSeconds: 600 };
});

app.post('/api/exercises/:id/video', { preHandler: requireStaff }, async (request, reply) => {
  if (!storageReady) return reply.code(503).send({ error: 'El almacenamiento de video aún no está configurado' });
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = z.object({ objectKey: z.string().min(1).max(300), durationSeconds: z.coerce.number().positive().max(600).optional() }).parse(request.body);
  if (!input.objectKey.startsWith(`exercises/${id}/`)) return reply.code(400).send({ error: 'La ruta del video no corresponde a este ejercicio' });
  const [exercise] = await sql`SELECT id, video_object_key FROM exercises WHERE id = ${id} AND owner_id = ${auth.sub}`;
  if (!exercise) return reply.code(404).send({ error: 'Ejercicio no encontrado' });

  // Se confirma contra R2 antes de guardar: si la subida firmada falló a medias
  // no debe quedar un ejercicio anunciando un video que no se puede reproducir.
  const uploaded = await verifyUpload(input.objectKey).catch(() => null);
  if (!uploaded?.sizeBytes) return reply.code(409).send({ error: 'El video no llegó completo al almacenamiento' });

  const previousKey = exercise.video_object_key as string | null;
  const [updated] = await sql`
    UPDATE exercises SET video_object_key = ${input.objectKey}, video_content_type = ${uploaded.contentType || 'video/mp4'},
      video_size_bytes = ${uploaded.sizeBytes}, video_duration_seconds = ${input.durationSeconds ?? null},
      video_uploaded_at = now(), updated_at = now()
    WHERE id = ${id} AND owner_id = ${auth.sub}
    RETURNING ${exerciseColumns}
  `;
  if (previousKey && previousKey !== input.objectKey) {
    await deleteObject(previousKey).catch(error => app.log.warn({ err: error, exerciseId: id }, 'No se pudo borrar el video anterior'));
  }
  return updated;
});

app.delete('/api/exercises/:id/video', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  // RETURNING sobre un UPDATE entrega la fila ya modificada, así que la clave
  // del objeto se lee antes de limpiarla; si no, quedaría huérfana en R2.
  const [exercise] = await sql`SELECT video_object_key FROM exercises WHERE id = ${id} AND owner_id = ${auth.sub}`;
  if (!exercise) return reply.code(404).send({ error: 'Ejercicio no encontrado' });
  const [updated] = await sql`
    UPDATE exercises SET video_object_key = NULL, video_content_type = NULL, video_size_bytes = NULL,
      video_duration_seconds = NULL, video_uploaded_at = NULL, updated_at = now()
    WHERE id = ${id} AND owner_id = ${auth.sub}
    RETURNING ${exerciseColumns}
  `;
  if (exercise.video_object_key && storageReady) {
    await deleteObject(exercise.video_object_key).catch(error => app.log.warn({ err: error, exerciseId: id }, 'No se pudo borrar el video del ejercicio'));
  }
  return updated;
});

// La ve tanto la entrenadora como sus clientes: el cliente necesita el video
// para ejecutar el ejercicio sin asistencia, que es el punto de la función.
app.get('/api/exercises/:id/video-url', { preHandler: requireAuth }, async (request, reply) => {
  if (!storageReady) return reply.code(503).send({ error: 'El almacenamiento de video aún no está configurado' });
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [exercise] = await sql`SELECT id, owner_id, video_object_key, video_content_type FROM exercises WHERE id = ${id}`;
  if (!exercise?.video_object_key) return reply.code(404).send({ error: 'Este ejercicio todavía no tiene video' });

  const allowed = ['admin', 'trainer'].includes(auth.role)
    ? exercise.owner_id === auth.sub
    : (await portalClient(auth.sub))?.owner_id === exercise.owner_id;
  if (!allowed) return reply.code(403).send({ error: 'Sin acceso a este video' });

  return { exerciseId: id, contentType: exercise.video_content_type, videoUrl: await createDownloadUrl(exercise.video_object_key), expiresInSeconds: 300 };
});

// Agendar a alguien que ya no entrena no tiene sentido y ensucia su expediente:
// las sesiones cuentan para su cumplimiento aunque esté dado de baja.
async function clienteAgendable(clientId: string, ownerId: string) {
  const [cliente] = await sql`SELECT id, full_name, status FROM clients WHERE id = ${clientId} AND owner_id = ${ownerId}`;
  if (!cliente) return { error: 'Cliente no encontrado', code: 404 };
  if (cliente.status !== 'active') {
    return { error: `${cliente.full_name} está ${cliente.status === 'paused' ? 'en pausa' : 'inactivo'}. Actívalo antes de agendarle sesiones.`, code: 409 };
  }
  return { cliente };
}

const sessionSchema = z.object({ clientId: z.string().uuid(), routineId: z.string().uuid().optional(), startsAt: z.string().datetime(), durationMinutes: z.coerce.number().int().positive().default(60), mode: z.string().default('Presencial'), notes: z.string().optional() });
app.get('/api/sessions', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`SELECT s.*, c.full_name, r.title AS routine_title FROM sessions s JOIN clients c ON c.id = s.client_id LEFT JOIN routines r ON r.id = s.routine_id WHERE c.owner_id = ${auth.sub} ORDER BY s.starts_at`;
});
app.post('/api/sessions', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const input = sessionSchema.parse(request.body);
  const permiso = await clienteAgendable(input.clientId, auth.sub);
  if (permiso.error) return reply.code(permiso.code).send({ error: permiso.error });
  const [session] = await sql`INSERT INTO sessions (client_id, routine_id, starts_at, duration_minutes, mode, notes) SELECT c.id, ${input.routineId || null}, ${input.startsAt}, ${input.durationMinutes}, ${input.mode}, ${input.notes || null} FROM clients c WHERE c.id = ${input.clientId} AND c.owner_id = ${auth.sub} RETURNING *`;
  if (!session) return reply.code(404).send({ error: 'Cliente no encontrado' });
  try { await syncSessionToGoogle(auth.sub, session.id); }
  catch (error) { app.log.warn({ err: error, sessionId: session.id }, 'Session created but Google Calendar sync failed'); }
  return reply.code(201).send(session);
});
// ── Horarios que se repiten sin fecha de fin ──────────────────────────────
// Un cliente que entrena lunes y miércoles a las 5:30 no tiene fecha de fin:
// entrena hasta que deja de entrenar. Se guarda la regla y se mantienen creadas
// las sesiones de las próximas semanas, en vez de intentar guardar infinitas.
const HORIZONTE_DIAS = 56;

// `forzar` es la diferencia entre el proceso automático y el botón.
//
// El automático es prudente: si una ocurrencia ya está marcada, no la vuelve a
// crear, porque puede ser una clase que alguien movió o canceló y resucitarla
// sería deshacer una decisión. El botón lo pulsa una persona diciendo
// "rellena lo que falte", y entonces manda ella: si ese día está vacío a esa
// hora, se crea, aunque quede una marca vieja apuntando a otra parte. La marca
// suelta se libera antes, que si no el índice único rechazaría la nueva.
async function extenderRecurrencias(ownerId?: string, forzar = false) {
  const reglas = await sql`
    SELECT r.id, r.client_id, r.routine_id, r.weekdays, r.time_of_day, r.duration_minutes,
           r.mode, r.notes, r.starts_on, r.ends_on, c.owner_id
    FROM session_recurrences r
    JOIN clients c ON c.id = r.client_id
    WHERE r.active AND c.status = 'active'
      AND (r.ends_on IS NULL OR r.ends_on >= current_date)
      AND (${ownerId ?? null}::uuid IS NULL OR c.owner_id = ${ownerId ?? null}::uuid)
  `;
  let creadas = 0;
  const fallidas: { cliente: string; error: string }[] = [];
  for (const regla of reglas) {
    try {
    // Una sola consulta por regla: genera los días del horizonte, se queda con
    // los de la semana elegidos y salta los que ya tienen sesión viva. El
    // AT TIME ZONE convierte "las 5:30 en Panamá" al instante correcto.
    if (forzar) {
      // Se sueltan sólo las marcas de días en los que el cliente no tiene
      // ninguna clase viva. Mirar únicamente "a esa hora" no bastaba: una clase
      // movida a otra hora del mismo día dejaba libre la hora de la regla, y
      // rellenar le habría puesto una segunda encima —resucitando justo lo que
      // se movió a propósito—. Si ese día ya entrena, el día está atendido.
      await sql`
        UPDATE sessions SET recurrence_on = NULL
        WHERE recurrence_id = ${regla.id} AND recurrence_on IS NOT NULL
          AND recurrence_on >= current_date
          AND NOT EXISTS (
            SELECT 1 FROM sessions viva
            WHERE viva.client_id = ${regla.client_id}
              AND viva.status <> 'cancelled'
              AND (viva.starts_at AT TIME ZONE 'America/Panama')::date = sessions.recurrence_on
          )
      `;
    }
    const filas = await sql`
      INSERT INTO sessions (client_id, routine_id, starts_at, duration_minutes, mode, notes, recurrence_id, recurrence_on)
      SELECT ${regla.client_id}, ${regla.routine_id}, candidato.momento,
             ${regla.duration_minutes}, ${regla.mode}, ${regla.notes}, ${regla.id}, candidato.dia
      FROM (
        SELECT dia::date AS dia, ((dia::date + ${regla.time_of_day}::time) AT TIME ZONE 'America/Panama') AS momento
        FROM generate_series(
          GREATEST(current_date, ${regla.starts_on}::date),
          -- Los ::int hacen falta: sin ellos el número llega sin tipo y
          -- Postgres no sabe si "date + $1" suma días o un intervalo, así que
          -- se planta con "operator is not unique".
          LEAST(current_date + ${HORIZONTE_DIAS}::int, COALESCE(${regla.ends_on}::date, current_date + ${HORIZONTE_DIAS}::int)),
          interval '1 day'
        ) AS dia
        WHERE extract(dow FROM dia)::int = ANY(${regla.weekdays as number[]})
      ) AS candidato
      -- Cada día de la regla se crea una sola vez, pase lo que pase después.
      -- Mirar sólo si "hay algo a esa hora" convertía cualquier cambio en un
      -- duplicado: al mover la sesión, el hueco que dejaba se volvía a llenar,
      -- y al cancelarla reaparecía sola. Un hueco no es una sesión que falte:
      -- es una decisión que alguien tomó sobre ese día.
      WHERE NOT EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.recurrence_id = ${regla.id} AND s.recurrence_on = candidato.dia
      )
      -- Y sigue sin pisarse con lo que ya haya a esa misma hora, venga de
      -- donde venga: dos clases a la vez para la misma persona no es un
      -- horario, es un choque.
      AND NOT EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.client_id = ${regla.client_id} AND s.starts_at = candidato.momento AND s.status <> 'cancelled'
      )
      RETURNING id
    `;
    creadas += filas.length;
    for (const sesion of filas) {
      try { await syncSessionToGoogle(String(regla.owner_id), sesion.id as string); }
      catch { /* el calendario se reintenta solo; la sesión ya es válida aquí */ }
    }
    } catch (error) {
      // Una regla que falla no puede llevarse por delante a las demás. El
      // INSERT crea todos los días de una vez, así que un solo choque dejaba
      // a ese cliente sin ninguna sesión nueva —y, al propagarse, a todos los
      // que venían detrás—. Se anota y se sigue.
      fallidas.push({ cliente: String(regla.client_id), error: error instanceof Error ? error.message : String(error) });
      app.log.error({ err: error, recurrenceId: regla.id }, 'No se pudo extender un horario fijo');
    }
  }
  return { creadas, fallidas };
}

const recurrenceSchema = z.object({
  clientId: z.string().uuid(),
  routineId: z.string().uuid().optional(),
  weekdays: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7),
  timeOfDay: z.string().regex(/^\d{2}:\d{2}$/, 'Hora inválida'),
  durationMinutes: z.coerce.number().int().min(15).max(480).default(60),
  mode: z.string().default('Presencial'),
  notes: z.string().optional(),
  endsOn: z.union([z.literal(''), z.null(), z.string().date()]).optional()
    .transform(valor => (valor === '' || valor === undefined ? null : valor))
});

app.post('/api/session-recurrences', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const input = recurrenceSchema.parse(request.body);
  const permiso = await clienteAgendable(input.clientId, auth.sub);
  if (permiso.error) return reply.code(permiso.code).send({ error: permiso.error });

  const [regla] = await sql`
    INSERT INTO session_recurrences (client_id, routine_id, weekdays, time_of_day, duration_minutes, mode, notes, ends_on)
    VALUES (${input.clientId}, ${input.routineId || null}, ${[...new Set(input.weekdays)].sort()},
      ${input.timeOfDay}::time, ${input.durationMinutes}, ${input.mode}, ${input.notes || null}, ${input.endsOn}::date)
    RETURNING *
  `;
  const { creadas } = await extenderRecurrencias(auth.sub);
  return reply.code(201).send({ recurrence: regla, creadas });
});

// Rellenar ahora los días que le falten a los horarios fijos. El proceso pasa
// solo cada seis horas, y esperar media jornada para ver si un día aparece no
// es forma de averiguar nada. Con esto se comprueba en el momento: si el día
// sigue vacío después de pulsar, es que la regla no lo incluye.
app.post('/api/session-recurrences/extend', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  // El botón fuerza; el proceso de cada seis horas no.
  const { creadas, fallidas } = await extenderRecurrencias(auth.sub, true);
  return { creadas, fallidas, saltados: await diasSaltados(auth.sub) };
});

// Por qué un día de un horario fijo sigue vacío después de rellenar.
//
// Un día puede quedarse sin sesión por dos motivos legítimos, y desde fuera se
// ven igual: que la ocurrencia ya esté marcada —la sesión existe pero se movió
// a otro día u hora, o se canceló— o que el cliente ya tenga algo a esa misma
// hora. Sin decirlo, el único camino era adivinar.
async function diasSaltados(ownerId: string) {
  return sql`
    WITH reglas AS (
      SELECT r.id, r.client_id, r.weekdays, r.time_of_day, r.starts_on, r.ends_on, c.full_name
      FROM session_recurrences r
      JOIN clients c ON c.id = r.client_id
      WHERE r.active AND c.status = 'active' AND c.owner_id = ${ownerId}
        AND (r.ends_on IS NULL OR r.ends_on >= current_date)
    ), candidatos AS (
      SELECT r.*, dia::date AS dia,
        ((dia::date + r.time_of_day) AT TIME ZONE 'America/Panama') AS momento
      FROM reglas r
      CROSS JOIN generate_series(
        GREATEST(current_date, r.starts_on),
        LEAST(current_date + (${HORIZONTE_DIAS})::int, COALESCE(r.ends_on, current_date + (${HORIZONTE_DIAS})::int)),
        interval '1 day'
      ) AS dia
      WHERE extract(dow FROM dia)::int = ANY(r.weekdays)
    )
    SELECT c.full_name, c.dia,
      -- La sesión que se quedó con la ocurrencia, esté donde esté ahora.
      (SELECT json_build_object('id', s.id, 'starts_at', s.starts_at, 'status', s.status)
        FROM sessions s WHERE s.recurrence_id = c.id AND s.recurrence_on = c.dia LIMIT 1) AS marcada,
      -- O algo del propio cliente ocupando ya esa hora exacta.
      (SELECT json_build_object('id', s.id, 'status', s.status)
        FROM sessions s WHERE s.client_id = c.client_id AND s.starts_at = c.momento AND s.status <> 'cancelled' LIMIT 1) AS choque
    FROM candidatos c
    -- Sólo los días que de verdad quedaron vacíos: si hay una sesión viva ese
    -- día a esa hora, no hay nada que explicar.
    WHERE NOT EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.client_id = c.client_id AND s.starts_at = c.momento AND s.status = 'scheduled'
    )
    ORDER BY c.full_name, c.dia
    LIMIT 40
  `;
}

app.get('/api/session-recurrences', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`
    SELECT r.*, c.full_name, rt.title AS routine_title,
      (SELECT count(*)::int FROM sessions s WHERE s.recurrence_id = r.id AND s.starts_at >= now() AND s.status = 'scheduled') AS proximas
    FROM session_recurrences r
    JOIN clients c ON c.id = r.client_id
    LEFT JOIN routines rt ON rt.id = r.routine_id
    WHERE c.owner_id = ${auth.sub} AND r.active
    ORDER BY c.full_name
  `;
});

// Detener el horario: la entrenadora confirma que el cliente no sigue. Se
// retiran las sesiones futuras que aún nadie tocó, y se dejan intactas las
// pasadas y las que ya tienen asistencia registrada: son historial.
// Cambiar un horario fijo sin desmontarlo.
//
// Hasta ahora sólo se podía detener y crear otro. Para añadir un día olvidado
// —o corregir la hora— había que tirar abajo el horario entero, con lo que se
// perdían las sesiones ya puestas, y quedaban dos reglas para la misma persona
// si no se acordaba de detener la vieja.
const recurrenceEditSchema = z.object({
  weekdays: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7),
  timeOfDay: z.string().regex(/^\d{2}:\d{2}$/, 'Hora inválida'),
  durationMinutes: z.coerce.number().int().min(15).max(480),
  mode: z.string().min(1),
  notes: z.string().optional().nullable(),
  endsOn: z.union([z.literal(''), z.null(), z.string().date()]).optional()
    .transform(valor => (valor === '' || valor === undefined ? null : valor))
});

app.patch('/api/session-recurrences/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = recurrenceEditSchema.parse(request.body);
  const dias = [...new Set(input.weekdays)].sort();

  const [regla] = await sql`
    UPDATE session_recurrences r
    SET weekdays = ${dias}, time_of_day = ${input.timeOfDay}::time, duration_minutes = ${input.durationMinutes},
      mode = ${input.mode}, notes = ${input.notes || null}, ends_on = ${input.endsOn}::date, updated_at = now()
    FROM clients c
    WHERE r.id = ${id} AND c.id = r.client_id AND c.owner_id = ${auth.sub} AND r.active
    RETURNING r.*
  `;
  if (!regla) return reply.code(404).send({ error: 'Horario no encontrado o ya detenido' });

  // Las futuras que ya no encajan con la regla nueva se retiran: si se quita el
  // miércoles, las clases de los miércoles que venían de este horario sobran.
  // Sólo las que nadie ha tocado —programadas y por delante—; una ya marcada o
  // movida es historia de alguien y no se toca aquí.
  const sobrantes = await sql`
    SELECT id FROM sessions
    WHERE recurrence_id = ${id} AND starts_at > now() AND status = 'scheduled'
      AND (
        extract(dow FROM (starts_at AT TIME ZONE 'America/Panama'))::int <> ALL(${dias})
        OR (starts_at AT TIME ZONE 'America/Panama')::time <> ${input.timeOfDay}::time
      )
  `;
  for (const sesion of sobrantes) {
    try { await removeSessionFromGoogle(auth.sub, sesion.id as string); }
    catch (error) { app.log.warn({ err: error, sessionId: sesion.id }, 'Sesión retirada pero el evento sigue en Google Calendar'); }
  }
  if (sobrantes.length) {
    await sql`DELETE FROM sessions WHERE id IN ${sql(sobrantes.map(fila => fila.id as string))}`;
  }
  // Y se crean las que faltan con los días nuevos. Forzando, porque el sentido
  // de editar es que el cambio se vea ya.
  const { creadas } = await extenderRecurrencias(auth.sub, true);
  return { recurrence: regla, retiradas: sobrantes.length, creadas };
});

app.delete('/api/session-recurrences/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const motivo = z.object({ reason: z.string().trim().max(300).optional() })
    .parse(request.query as Record<string, unknown>).reason ?? null;

  const [regla] = await sql`
    UPDATE session_recurrences r SET active = false, stopped_at = now(), stopped_reason = ${motivo}, updated_at = now()
    FROM clients c WHERE r.id = ${id} AND c.id = r.client_id AND c.owner_id = ${auth.sub} AND r.active
    RETURNING r.*
  `;
  if (!regla) return reply.code(404).send({ error: 'Horario no encontrado o ya detenido' });

  // Se listan antes de borrar para poder retirarlas también de Google. Sin
  // esto, detener un horario dejaba decenas de eventos huérfanos en el
  // calendario de la entrenadora.
  const porRetirar = await sql`
    SELECT id FROM sessions
    WHERE recurrence_id = ${id} AND starts_at > now() AND status = 'scheduled'
  `;
  for (const sesion of porRetirar) {
    try { await removeSessionFromGoogle(auth.sub, sesion.id as string); }
    catch (error) { app.log.warn({ err: error, sessionId: sesion.id }, 'Sesión retirada pero el evento sigue en Google Calendar'); }
  }
  const retiradas = await sql`
    DELETE FROM sessions
    WHERE recurrence_id = ${id} AND starts_at > now() AND status = 'scheduled'
    RETURNING id
  `;
  return { stopped: true, recurrence: regla, sesionesRetiradas: retiradas.length };
});

// Agendar varias fechas de una vez, para el caso normal: "Julio entrena lunes,
// miércoles y viernes a las 8". Antes había que repetir el modal una vez por
// sesión, doce veces para un mes.
//
// Las fechas llegan ya calculadas desde el navegador y no se deducen aquí a
// partir de días de la semana: el horario es de Panamá y la conversión ya vive
// en el frontend. Duplicarla en el servidor sería tener dos sitios donde
// equivocarse con la zona horaria.
const sessionBatchSchema = z.object({
  clientId: z.string().uuid(),
  routineId: z.string().uuid().optional(),
  startsAt: z.array(z.string().datetime()).min(1).max(60),
  durationMinutes: z.coerce.number().int().positive().default(60),
  mode: z.string().default('Presencial'),
  notes: z.string().optional()
});
app.post('/api/sessions/batch', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const input = sessionBatchSchema.parse(request.body);
  const permiso = await clienteAgendable(input.clientId, auth.sub);
  if (permiso.error) return reply.code(permiso.code).send({ error: permiso.error });

  const fechas = [...new Set(input.startsAt)].sort();
  const creadas = await sql.begin(async transaction => {
    const hechas: Record<string, unknown>[] = [];
    for (const cuando of fechas) {
      // Si ya hay sesión viva a esa hora para ese cliente, no se duplica:
      // reenviar el formulario no debe dejarle el calendario doble.
      const [existente] = await transaction`
        SELECT id FROM sessions
        WHERE client_id = ${input.clientId} AND starts_at = ${cuando} AND status <> 'cancelled'
      `;
      if (existente) continue;
      const [sesion] = await transaction`
        INSERT INTO sessions (client_id, routine_id, starts_at, duration_minutes, mode, notes)
        VALUES (${input.clientId}, ${input.routineId || null}, ${cuando}, ${input.durationMinutes}, ${input.mode}, ${input.notes || null})
        RETURNING *
      `;
      hechas.push(sesion);
    }
    return hechas;
  });

  // El calendario se sincroniza fuera de la transacción: un fallo de Google no
  // debe deshacer sesiones que en la aplicación ya son válidas.
  for (const sesion of creadas) {
    try { await syncSessionToGoogle(auth.sub, sesion.id as string); }
    catch (error) { app.log.warn({ err: error, sessionId: sesion.id }, 'Sesión creada pero falló la sincronización con Google Calendar'); }
  }
  return reply.code(201).send({ creadas: creadas.length, omitidas: fechas.length - creadas.length, sesiones: creadas });
});

const sessionScheduleSchema = z.object({
  startsAt: z.string().datetime(),
  durationMinutes: z.coerce.number().int().min(15).max(480),
  mode: z.string().trim().min(2).max(60),
  notes: z.string().trim().max(1000).optional(),
  // Cambiar de cliente: agendar a la persona equivocada es un error frecuente
  // y hasta ahora obligaba a borrar la sesión y volver a crearla.
  clientId: z.string().uuid().optional()
});
app.patch('/api/sessions/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = sessionScheduleSchema.parse(request.body);
  if (input.clientId) {
    const destino = await clienteAgendable(input.clientId, auth.sub);
    if (destino.error) return reply.code(destino.code).send({ error: destino.error });
    // Una sesión ya completada descontó del saldo de quien la hizo; moverla a
    // otra persona dejaría ese descuento colgado del cliente equivocado.
    const [actual] = await sql`
      SELECT s.status FROM sessions s JOIN clients c ON c.id = s.client_id
      WHERE s.id = ${id} AND c.owner_id = ${auth.sub}
    `;
    if (actual?.status === 'completed') {
      return reply.code(409).send({ error: 'Esta sesión ya se marcó como realizada. Deshaz el cumplimiento antes de cambiar de cliente.' });
    }
  }
  const [anterior] = await sql`
    SELECT s.starts_at FROM sessions s JOIN clients c ON c.id = s.client_id
    WHERE s.id = ${id} AND c.owner_id = ${auth.sub}
  `;
  const [session] = await sql`
    UPDATE sessions s SET starts_at = ${input.startsAt}, duration_minutes = ${input.durationMinutes},
      mode = ${input.mode}, notes = ${input.notes || null},
      client_id = COALESCE(${input.clientId ?? null}, s.client_id),
      google_sync_error = NULL, updated_at = now()
    FROM clients c
    WHERE s.id = ${id} AND c.id = s.client_id AND c.owner_id = ${auth.sub} AND s.status <> 'cancelled'
    RETURNING s.*
  `;
  if (!session) return reply.code(404).send({ error: 'Sesión no encontrada o cancelada' });
  // Correrla de hora dentro del mismo día no es reprogramar: es ajustar. Lo
  // que cuenta es cambiarla de día, que es lo que el cliente pide cuando no
  // puede venir.
  if (anterior && diaEnPanama(anterior.starts_at) !== diaEnPanama(session.starts_at)) {
    await sql`
      INSERT INTO session_reschedules (session_id, client_id, from_starts_at, to_starts_at, origin)
      VALUES (${session.id}, ${session.client_id}, ${anterior.starts_at}, ${session.starts_at}, 'moved')
    `;
  }
  try { await syncSessionToGoogle(auth.sub, session.id); }
  catch (error) { app.log.warn({ err: error, sessionId: session.id }, 'Session updated but Google Calendar sync failed'); }
  const [updated] = await sql`SELECT * FROM sessions WHERE id = ${session.id}`;
  return updated;
});

// Quitar de la agenda una sesión cancelada. Cancelar no borra: la sesión se
// queda en el listado marcada como "Cancelada" y sigue sumando en el contador
// de canceladas del expediente. Para una que se agendó por error —o de prueba—
// eso es ruido permanente en el historial de un cliente.
//
// Sólo se permite sobre canceladas: una sesión viva se cancela primero, y así
// nunca se pierde por accidente una que estaba en pie. Las completadas tampoco
// se tocan, porque descontaron una sesión del saldo y borrarlas descuadraría
// el cumplimiento.
app.delete('/api/sessions/:id/permanent', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [sesion] = await sql`
    SELECT s.id, s.status FROM sessions s JOIN clients c ON c.id = s.client_id
    WHERE s.id = ${id} AND c.owner_id = ${auth.sub}
  `;
  if (!sesion) return reply.code(404).send({ error: 'Sesión no encontrada' });
  // Una sesión creada por error se borra directamente. Obligarla a pasar por
  // "cancelada" la contaría como incumplida en el cumplimiento del cliente, y
  // una clase que nunca debió existir no es una clase que alguien perdió.
  // Las realizadas no se tocan: descontaron del saldo.
  if (!['cancelled', 'scheduled'].includes(String(sesion.status))) {
    return reply.code(409).send({ error: 'Sólo se borran las sesiones programadas o canceladas.' });
  }
  // Primero Google, luego la fila: si se borra antes, se pierde el
  // google_event_id y el evento se queda huérfano en el calendario para
  // siempre, apuntando a una sesión que ya no existe.
  try { await removeSessionFromGoogle(auth.sub, id); }
  catch (error) { app.log.warn({ err: error, sessionId: id }, 'Sesión borrada pero el evento sigue en Google Calendar'); }
  const [borrada] = await sql`DELETE FROM sessions WHERE id = ${id} RETURNING id, starts_at`;
  return { deleted: true, session: borrada };
});

app.delete('/api/sessions/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  // Reprogramada o no: es la diferencia entre mover una clase y perderla, y
  // sólo la segunda debe afectar al cumplimiento del cliente.
  // No se usa z.coerce.boolean(): convierte la cadena "false" en true, porque
  // cualquier texto no vacío es verdadero. Se compara con "true" a mano.
  const reprogramada = (request.query as { rescheduled?: string }).rescheduled === 'true';
  const [session] = await sql`UPDATE sessions s SET status = 'cancelled', cancellation_kind = ${reprogramada ? 'rescheduled' : 'not_rescheduled'}, updated_at = now() FROM clients c WHERE s.id = ${id} AND c.id = s.client_id AND c.owner_id = ${auth.sub} AND s.status <> 'cancelled' RETURNING s.*`;
  if (!session) return reply.code(404).send({ error: 'Sesión no encontrada o ya cancelada' });
  // Cancelar pidiendo otro día es reprogramar; cancelar y perderla, no. Sólo
  // la primera se cuenta, que es la distinción que la entrenadora ya hace en
  // el diálogo y que hasta ahora no se guardaba en ninguna parte.
  if (reprogramada) {
    await sql`
      INSERT INTO session_reschedules (session_id, client_id, from_starts_at, origin)
      VALUES (${id}, ${session.client_id}, ${session.starts_at}, 'cancelled')
    `;
  }
  try { await cancelSessionInGoogle(auth.sub, id); }
  catch (error) { app.log.warn({ err: error, sessionId: id }, 'Session cancelled but Google Calendar deletion failed'); }
  return { cancelled: true, session };
});
// El resultado de una sesión es de tres estados, no de dos. Antes se deducía
// de una casilla: desmarcarla equivalía a decir "no cumplió", así que quien la
// marcaba por error no tenía forma de retirar la marca —al quitarla y guardar,
// la sesión quedaba incumplida y le bajaba el cumplimiento al cliente por algo
// que ni siquiera había ocurrido todavía—. Volver a "programada" es su propio
// estado, y se pide en claro.
type ResultadoSesion = 'scheduled' | 'completed' | 'no_show';

async function recordSessionCompliance(id: string, ownerId: string, markedBy: string, resultado: ResultadoSesion, completionPercent: number) {
  const completed = resultado === 'completed';
  return sql.begin(async transaction => {
    const [current] = await transaction`SELECT s.* FROM sessions s JOIN clients c ON c.id = s.client_id WHERE s.id = ${id} AND c.owner_id = ${ownerId} FOR UPDATE`;
    if (!current) return null;
    // Devolverla a programada: se deshace lo que la marca había hecho —incluido
    // el descuento del saldo— y la sesión vuelve a estar por delante, sin
    // contar ni a favor ni en contra.
    if (resultado === 'scheduled') {
      if (current.package_debited && current.package_id) {
        await transaction`UPDATE session_packages SET used_sessions = GREATEST(0, used_sessions - 1), status = 'active' WHERE id = ${current.package_id}`;
      }
      const [devuelta] = await transaction`
        UPDATE sessions SET status = 'scheduled', completion_percent = 0, package_id = null, package_debited = false,
          completed_by_user_id = null, completion_recorded_at = null, updated_at = now()
        WHERE id = ${id} RETURNING *
      `;
      return devuelta;
    }
    if (!completed && current.package_debited && current.package_id) {
      await transaction`UPDATE session_packages SET used_sessions = GREATEST(0, used_sessions - 1), status = 'active' WHERE id = ${current.package_id}`;
      const [updated] = await transaction`
        UPDATE sessions SET status = 'no_show', completion_percent = 0, package_id = null, package_debited = false,
          completed_by_user_id = ${markedBy}, completion_recorded_at = now(), updated_at = now()
        WHERE id = ${id} RETURNING *
      `;
      return updated;
    }
    if (completed && !current.package_debited) {
      // El saldo es de cada quien, aunque pague otro. Antes se descontaba del
      // bolsillo del pagador y, si dos personas suyas entrenaban el mismo día,
      // sólo se descontaba una vez: se asumía una bolsa compartida.
      //
      // Con un paquete configurado por persona eso falseaba la métrica del
      // segundo, que entrenaba y no veía bajar su saldo. Entrenar juntos no
      // hace que consuman una sola clase: cada uno gasta una de las suyas.
      //
      // Lo que sigue siendo del pagador es el dinero, no las clases.
      const grupo = current.client_id as string;

      // Se gasta el saldo que caduca antes. Ir por el más antiguo parecía
      // razonable hasta que un cliente tuvo dos a la vez: su mensualidad, que
      // vence en el corte, y un paquete suelto comprado antes que no vence
      // nunca. Con el orden viejo se consumía el paquete y las clases de la
      // mensualidad se perdían al vencer —y el cumplimiento se las apuntaba
      // como incumplidas, cuando el cliente sí había entrenado—.
      const [pack] = await transaction`
        SELECT * FROM session_packages
        WHERE client_id = ${grupo} AND status = 'active' AND used_sessions < total_sessions
        ORDER BY expires_on ASC NULLS LAST, purchased_on
        LIMIT 1 FOR UPDATE
      `;
      if (!pack) {
        const [updated] = await transaction`
          UPDATE sessions SET status = 'completed', completion_percent = ${completionPercent}, debited_group_id = ${grupo}, completed_by_user_id = ${markedBy}, completion_recorded_at = now(), updated_at = now()
          WHERE id = ${id} RETURNING *
        `;
        return updated;
      }
      const nextUsed = pack.used_sessions + 1;
      await transaction`UPDATE session_packages SET used_sessions = ${nextUsed}, status = ${nextUsed >= pack.total_sessions ? 'exhausted' : 'active'} WHERE id = ${pack.id}`;
      const [updated] = await transaction`
        UPDATE sessions SET status = 'completed', completion_percent = ${completionPercent}, package_id = ${pack.id}, package_debited = true, debited_group_id = ${grupo},
          completed_by_user_id = ${markedBy}, completion_recorded_at = now(), updated_at = now()
        WHERE id = ${id} RETURNING *
      `;
      return updated;
    }
    const [updated] = await transaction`
      UPDATE sessions SET status = ${completed ? 'completed' : 'no_show'}, completion_percent = ${completed ? completionPercent : 0},
        completed_by_user_id = ${markedBy}, completion_recorded_at = now(), updated_at = now()
      WHERE id = ${id} RETURNING *
    `;
    return updated;
  });
}

app.post('/api/sessions/:id/complete', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id);
  const session = await recordSessionCompliance(id, auth.sub, auth.sub, 'completed', 100);
  if (!session) return reply.code(404).send({ error: 'Sesión no encontrada' }); return session;
});

// 'completed' se sigue aceptando: lo usan el registro diario y el portal, y
// cambiarles el contrato de golpe rompería dos pantallas por arreglar una.
const sessionComplianceSchema = z.object({
  completed: z.boolean().optional(),
  outcome: z.enum(['scheduled', 'completed', 'no_show']).optional(),
  completionPercent: z.coerce.number().int().min(0).max(100)
}).refine(v => v.outcome !== undefined || v.completed !== undefined, { message: 'Falta el resultado de la sesión' });
app.patch('/api/sessions/:id/compliance', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id); const input = sessionComplianceSchema.parse(request.body);
  const resultado: ResultadoSesion = input.outcome ?? (input.completed ? 'completed' : 'no_show');
  const session = await recordSessionCompliance(id, auth.sub, auth.sub, resultado, resultado === 'completed' ? input.completionPercent : 0);
  if (!session) return reply.code(404).send({ error: 'Sesión no encontrada' });
  return session;
});

// ── Registro diario de entrenamientos presenciales ────────────────────────
// La entrenadora atiende a la mayoría en persona y no alcanza a crear una
// rutina para cada día. Esta pantalla le deja marcar quién entrenó y que eso
// cuente igual en el cumplimiento, que ya sumaba sesiones sin rutina.
const dailyDateSchema = z.object({ date: z.string().date().default(() => new Date().toISOString().slice(0, 10)) });

app.get('/api/trainings/daily', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const { date } = dailyDateSchema.parse(request.query);
  return sql`
    SELECT c.id AS client_id, c.full_name, c.status, c.billing_model,
      COALESCE((SELECT sum(total_sessions - used_sessions) FROM session_packages sp WHERE sp.client_id = c.id AND sp.status = 'active'), 0)::integer AS available_sessions,
      s.id AS session_id, s.status AS session_status, s.completion_percent, s.quick_logged,
      COALESCE(r.title, '') AS routine_title
    FROM clients c
    LEFT JOIN LATERAL (
      SELECT * FROM sessions WHERE client_id = c.id AND starts_at::date = ${date}::date
      ORDER BY quick_logged DESC, starts_at LIMIT 1
    ) s ON true
    LEFT JOIN routines r ON r.id = s.routine_id
    WHERE c.owner_id = ${auth.sub} AND c.status = 'active'
    ORDER BY c.full_name
  `;
});

const dailyLogSchema = z.object({
  date: z.string().date(),
  clientIds: z.array(z.string().uuid()).max(200)
});

app.post('/api/trainings/daily', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const input = dailyLogSchema.parse(request.body);
  // Mediodía de Panamá: la sesión debe caer en el día marcado sin importar
  // desde qué huso horario se guarde.
  const startsAt = `${input.date}T12:00:00-05:00`;

  const result = await sql.begin(async transaction => {
    const owned = await transaction`SELECT id FROM clients WHERE owner_id = ${auth.sub} AND id = ANY(${input.clientIds}::uuid[])`;
    const ownedIds = owned.map(row => row.id as string);

    // Se crean las que faltan. Si ese día ya hay una sesión agendada de verdad
    // no se toca: esta pantalla no debe alterar la agenda real.
    const created: string[] = [];
    for (const clientId of ownedIds) {
      const [existing] = await transaction`SELECT id FROM sessions WHERE client_id = ${clientId} AND starts_at::date = ${input.date}::date LIMIT 1`;
      if (existing) continue;
      const [session] = await transaction`
        INSERT INTO sessions (client_id, starts_at, duration_minutes, mode, status, completion_percent, quick_logged, completed_by_user_id, completion_recorded_at)
        VALUES (${clientId}, ${startsAt}::timestamptz, 60, 'Presencial', 'completed', 100, true, ${auth.sub}, now())
        RETURNING id
      `;
      created.push(session.id as string);
    }

    // Desmarcar sólo borra lo que esta pantalla creó. Una sesión agendada o
    // completada por otra vía se queda donde está.
    const removed = await transaction`
      DELETE FROM sessions USING clients c
      WHERE sessions.client_id = c.id AND c.owner_id = ${auth.sub}
        AND sessions.quick_logged = true
        AND sessions.starts_at::date = ${input.date}::date
        AND NOT (sessions.client_id = ANY(${ownedIds}::uuid[]))
      RETURNING sessions.id, sessions.package_id, sessions.package_debited
    `;
    // Devolver al paquete lo que se había descontado al marcar.
    for (const session of removed) {
      if (session.package_debited && session.package_id) {
        await transaction`UPDATE session_packages SET used_sessions = GREATEST(0, used_sessions - 1), status = 'active' WHERE id = ${session.package_id}`;
      }
    }
    return { created, removed: removed.length };
  });

  // El descuento del paquete reutiliza la misma ruta que completar una sesión
  // desde la agenda, para que no haya dos maneras distintas de consumirlo.
  for (const sessionId of result.created) await recordSessionCompliance(sessionId, auth.sub, auth.sub, 'completed', 100);

  return reply.code(201).send({ date: input.date, registrados: result.created.length, eliminados: result.removed });
});

const invoiceSchema = z.object({ clientId: z.string().uuid(), packageId: z.string().uuid().optional(), concept: z.string().min(2), amount: z.coerce.number().min(0), dueOn: z.string().date() });
const statementQuerySchema = z.object({ clientId: z.string().uuid(), from: z.string().date(), to: z.string().date() }).refine(value => value.from <= value.to, { message: 'La fecha inicial debe ser anterior a la fecha final' });
const receivablesQuerySchema = z.object({ asOf: z.string().date().default(new Date().toISOString().slice(0, 10)) });

async function accountStatementData(ownerId: string, query: z.infer<typeof statementQuerySchema>) {
  const [client] = await sql`SELECT id, full_name, email, phone FROM clients WHERE id = ${query.clientId} AND owner_id = ${ownerId}`;
  if (!client) return null;
  const rows = await sql`
    SELECT i.id, COALESCE(i.issued_on, i.created_at::date) AS issued_on, i.due_on,
      COALESCE(i.invoice_number, 'EIL-' || upper(substr(i.id::text, 1, 8))) AS invoice_number,
      i.concept, i.amount,
      CASE WHEN i.source_system = 'zoho_invoice' THEN GREATEST(i.amount - i.balance, 0) WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END AS paid_amount,
      CASE WHEN i.source_system = 'zoho_invoice' THEN i.balance WHEN i.status = 'confirmed' THEN 0 ELSE i.amount END AS balance_amount,
      i.status,
      CASE WHEN i.source_system = 'zoho_invoice' THEN 'Zoho' ELSE 'Eileen' END AS source_label
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE c.owner_id = ${ownerId} AND c.id = ${query.clientId} AND i.status <> 'void'
      AND COALESCE(i.issued_on, i.created_at::date) >= ${query.from}::date
      AND COALESCE(i.issued_on, i.created_at::date) <= ${query.to}::date
    ORDER BY issued_on, i.created_at
  `;
  return { client, rows };
}

async function receivablesData(ownerId: string, asOf: string) {
  const rows = await sql`
    SELECT i.id, i.client_id, c.full_name, i.due_on,
      COALESCE(i.invoice_number, 'EIL-' || upper(substr(i.id::text, 1, 8))) AS invoice_number,
      i.concept, CASE WHEN i.source_system = 'zoho_invoice' THEN i.balance WHEN i.status = 'confirmed' THEN 0 ELSE i.amount END AS balance_amount,
      (${asOf}::date - i.due_on)::integer AS days_overdue,
      CASE WHEN i.source_system = 'zoho_invoice' THEN 'Zoho' ELSE 'Eileen' END AS source_label
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE c.owner_id = ${ownerId} AND i.status <> 'void'
      AND CASE WHEN i.source_system = 'zoho_invoice' THEN i.balance WHEN i.status = 'confirmed' THEN 0 ELSE i.amount END > 0
      AND COALESCE(i.issued_on, i.created_at::date) <= ${asOf}::date
    ORDER BY days_overdue DESC, c.full_name
  ` as unknown as Record<string, any>[];
  return rows.map((row: Record<string, any>): Record<string, any> => {
    const days = Number(row.days_overdue);
    const aging = days <= 0 ? 'Por vencer' : days <= 30 ? '1-30 días' : days <= 60 ? '31-60 días' : days <= 90 ? '61-90 días' : 'Más de 90 días';
    return { ...row, days_overdue: days, balance_amount: Number(row.balance_amount), aging };
  });
}

const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const csvDate = (value: unknown) => String(value ?? '').slice(0, 10);
function sendPdf(reply: any, buffer: Buffer, fileName: string) {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '-');
  reply.header('Content-Type', 'application/pdf');
  reply.header('Content-Disposition', `inline; filename="${safeName}"`);
  reply.header('Cache-Control', 'private, no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  return reply.send(buffer);
}

app.get('/api/invoices', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  // Sin source_payload ni line_items: son el JSON crudo que devolvió Zoho por
  // cada factura y el desglose de líneas. Nadie los lee en la lista y hacían
  // que 1.400 facturas pesaran 3,6 MB, que se descargan enteros cada vez que
  // se refresca cualquier cosa.
  return sql`
    SELECT i.id, i.client_id, i.package_id, i.concept, i.amount, i.currency, i.due_on, i.status,
      i.payment_method, i.payment_reference, i.confirmed_at, i.created_at, i.source_system,
      i.external_id, i.invoice_number, i.issued_on, i.subtotal, i.tax_total, i.balance,
      i.external_status, i.notes, i.external_updated_at, i.billing_period, i.auto_generated,
      i.billed_for_client_id, c.full_name
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE c.owner_id = ${auth.sub} ORDER BY i.created_at DESC
  `;
});


// Cobros sin saldo de sesiones vinculado, para cerrar la migración.

app.get('/api/billing/analytics', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const { year } = z.object({ year: z.coerce.number().int().min(2000).max(2100) }).parse(request.query);
  const start = `${year}-01-01`; const end = `${year + 1}-01-01`;
  const [monthlyRows, topClientRows] = await Promise.all([
    sql`
      SELECT EXTRACT(month FROM COALESCE(i.issued_on, i.due_on))::integer AS month,
        count(*)::integer AS invoice_count, COALESCE(sum(i.amount), 0)::numeric AS amount
      FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE c.owner_id = ${auth.sub} AND i.status <> 'void'
        AND COALESCE(i.issued_on, i.due_on) >= ${start}::date AND COALESCE(i.issued_on, i.due_on) < ${end}::date
      GROUP BY 1 ORDER BY 1
    `,
    sql`
      WITH received_payments AS (
        SELECT p.client_id, p.amount, p.paid_on
        FROM invoice_payments p JOIN clients c ON c.id = p.client_id
        WHERE c.owner_id = ${auth.sub} AND p.paid_on >= ${start}::date AND p.paid_on < ${end}::date
        UNION ALL
        SELECT i.client_id, i.amount, COALESCE(i.confirmed_at::date, i.issued_on, i.due_on) AS paid_on
        FROM invoices i JOIN clients c ON c.id = i.client_id
        WHERE c.owner_id = ${auth.sub} AND i.status = 'confirmed' AND i.source_system IS DISTINCT FROM 'zoho_invoice'
          AND COALESCE(i.confirmed_at::date, i.issued_on, i.due_on) >= ${start}::date
          AND COALESCE(i.confirmed_at::date, i.issued_on, i.due_on) < ${end}::date
      )
      SELECT c.id, c.full_name, count(*)::integer AS payment_count, COALESCE(sum(p.amount), 0)::numeric AS amount
      FROM received_payments p JOIN clients c ON c.id = p.client_id
      GROUP BY c.id, c.full_name ORDER BY amount DESC, c.full_name LIMIT 7
    `
  ]);
  const monthMap = new Map(monthlyRows.map(row => [Number(row.month), row]));
  const months = Array.from({ length: 12 }, (_, index) => {
    const row = monthMap.get(index + 1);
    return { month: index + 1, invoiceCount: Number(row?.invoice_count || 0), amount: Number(row?.amount || 0) };
  });
  return {
    year,
    totalBilled: months.reduce((sum, month) => sum + month.amount, 0),
    months,
    topClients: topClientRows.map(row => ({ id: row.id, name: row.full_name, paymentCount: Number(row.payment_count), amount: Number(row.amount) }))
  };
});
app.get('/api/invoices/:id/pdf', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id);
  const staff = ['admin', 'trainer'].includes(auth.role);
  const [invoice] = await sql`
    SELECT i.*, c.full_name, c.email,
      CASE WHEN i.source_system = 'zoho_invoice' THEN GREATEST(i.amount - i.balance, 0) WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END AS paid_amount,
      CASE WHEN i.source_system = 'zoho_invoice' THEN i.balance WHEN i.status = 'confirmed' THEN 0 ELSE i.amount END AS balance_amount
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.id = ${id} AND ((${staff}::boolean AND c.owner_id = ${auth.sub}) OR (${!staff}::boolean AND c.portal_user_id = ${auth.sub}))
  `;
  if (!invoice) return reply.code(404).send({ error: 'Factura no encontrada' });
  const payments = await sql`
    SELECT p.paid_on, p.method, p.reference, pa.amount
    FROM payment_allocations pa JOIN invoice_payments p ON p.id = pa.payment_id
    WHERE pa.invoice_id = ${id} ORDER BY p.paid_on DESC
  `;
  return sendPdf(reply, await invoicePdf(invoice, payments), `factura-${invoice.invoice_number || String(invoice.id).slice(0, 8)}.pdf`);
});
app.get('/api/reports/account-statement.pdf', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const query = statementQuerySchema.parse(request.query); const report = await accountStatementData(auth.sub, query);
  if (!report) return reply.code(404).send({ error: 'Cliente no encontrado' });
  return sendPdf(reply, await accountStatementPdf(report.client, report.rows, query.from, query.to), `estado-de-cuenta-${query.from}-${query.to}.pdf`);
});
app.get('/api/reports/account-statement.csv', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const query = statementQuerySchema.parse(request.query); const report = await accountStatementData(auth.sub, query);
  if (!report) return reply.code(404).send({ error: 'Cliente no encontrado' });
  const lines = [['Fecha', 'Factura', 'Concepto', 'Facturado USD', 'Pagado USD', 'Saldo USD', 'Estado', 'Origen'].map(csvCell).join(','), ...report.rows.map(row => [csvDate(row.issued_on), row.invoice_number, row.concept, Number(row.amount).toFixed(2), Number(row.paid_amount).toFixed(2), Number(row.balance_amount).toFixed(2), row.status, row.source_label].map(csvCell).join(','))];
  reply.header('Content-Type', 'text/csv; charset=utf-8'); reply.header('Content-Disposition', `attachment; filename="estado-de-cuenta-${query.from}-${query.to}.csv"`);
  return `\uFEFF${lines.join('\n')}`;
});
app.get('/api/reports/accounts-receivable.pdf', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const { asOf } = receivablesQuerySchema.parse(request.query); const rows = await receivablesData(auth.sub, asOf);
  return sendPdf(reply, await accountsReceivablePdf(rows, asOf), `cuentas-por-cobrar-${asOf}.pdf`);
});
app.get('/api/reports/accounts-receivable.csv', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const { asOf } = receivablesQuerySchema.parse(request.query); const rows = await receivablesData(auth.sub, asOf);
  const lines = [['Cliente', 'Factura', 'Concepto', 'Vencimiento', 'Días vencidos', 'Antigüedad', 'Saldo USD', 'Origen'].map(csvCell).join(','), ...rows.map(row => [row.full_name, row.invoice_number, row.concept, csvDate(row.due_on), row.days_overdue, row.aging, Number(row.balance_amount).toFixed(2), row.source_label].map(csvCell).join(','))];
  reply.header('Content-Type', 'text/csv; charset=utf-8'); reply.header('Content-Disposition', `attachment; filename="cuentas-por-cobrar-${asOf}.csv"`);
  return `\uFEFF${lines.join('\n')}`;
});
// Un cobro de mensualidad fija además el precio mensual del cliente y le abre
// membresía si no tenía. Antes no hacía ninguna de las dos cosas: la ficha
// seguía marcando $0.00 y, peor, la generación recurrente exige precio mayor
// que cero y membresía activa, así que ese cliente no se volvía a cobrar solo.
const esMensualidad = (concepto: string) => /mensual/i.test(concepto);

async function asentarMensualidad(clientId: string, ownerId: string, amount: number) {
  await sql.begin(async transaction => {
    const [client] = await transaction`SELECT id, billing_cutoff_day FROM clients WHERE id = ${clientId} AND owner_id = ${ownerId} FOR UPDATE`;
    if (!client) return;
    await transaction`UPDATE clients SET standard_price = ${amount}, billing_model = 'monthly', updated_at = now() WHERE id = ${clientId}`;
    const [membresia] = await transaction`SELECT id FROM memberships WHERE client_id = ${clientId} AND status = 'active' LIMIT 1`;
    if (membresia) await transaction`UPDATE memberships SET amount = ${amount} WHERE id = ${membresia.id}`;
    else await transaction`INSERT INTO memberships (client_id, amount, renewal_day, status) VALUES (${clientId}, ${amount}, ${Number(client.billing_cutoff_day) || 1}, 'active')`;
  });
}

app.post('/api/invoices', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const input = invoiceSchema.parse(request.body);
  const [invoice] = await sql`INSERT INTO invoices (client_id, package_id, concept, amount, due_on) SELECT c.id, ${input.packageId || null}, ${input.concept}, ${input.amount}, ${input.dueOn} FROM clients c WHERE c.id = ${input.clientId} AND c.owner_id = ${auth.sub} RETURNING *`;
  if (!invoice) return reply.code(404).send({ error: 'Cliente no encontrado' });
  if (esMensualidad(input.concept) && input.amount > 0) await asentarMensualidad(input.clientId, auth.sub, input.amount);
  return reply.code(201).send(invoice);
});
const invoiceEditSchema = z.object({ concept: z.string().min(2).max(180), amount: z.coerce.number().min(0), dueOn: z.string().date() });


// Corregir uno suelto, cuando el reparto en bloque no acierta.

app.patch('/api/invoices/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id); const input = invoiceEditSchema.parse(request.body);
  const [invoice] = await sql`UPDATE invoices i SET concept = ${input.concept}, amount = ${input.amount}, due_on = ${input.dueOn} FROM clients c WHERE i.id = ${id} AND c.id = i.client_id AND c.owner_id = ${auth.sub} AND i.status = 'pending' AND i.source_system IS DISTINCT FROM 'zoho_invoice' RETURNING i.*`;
  if (!invoice) return reply.code(404).send({ error: 'Solo se pueden editar cobros locales pendientes' });
  return invoice;
});
app.delete('/api/invoices/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [invoice] = await sql`UPDATE invoices i SET status = 'void' FROM clients c WHERE i.id = ${id} AND c.id = i.client_id AND c.owner_id = ${auth.sub} AND i.status = 'pending' AND i.source_system IS DISTINCT FROM 'zoho_invoice' RETURNING i.*`;
  if (!invoice) return reply.code(404).send({ error: 'Solo se pueden anular cobros locales pendientes' });
  return { deleted: true, voided: true, invoice };
});

// ---------------------------------------------------------------------------
// Cobertura: a quién cubre un cobro cuando el cobro no lo dice.
//
// Las facturas de Zoho llegan como llegan —una línea de $350 a nombre de quien
// paga— y no hay forma de editarlas: sobre lo suyo manda Zoho. Esto permite
// anotar por fuera que esos $350 son la mensualidad de dos personas, y abrirle
// a cada una sus sesiones sin emitir un cobro nuevo ni tocar la factura.
// ---------------------------------------------------------------------------

// El mes que cubre un cobro. La mensualidad se paga por adelantado, así que lo
// normal es que el pago del 28 de agosto cubra septiembre. Es sólo la
// propuesta: Eileen elige el mes en la pantalla y manda lo que elija.
function mesCubiertoPorDefecto(dueOn: Date | string): string {
  const dia = mediodiaEnPanama(dueOn);
  return new Date(Date.UTC(dia.getUTCFullYear(), dia.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

// El día en que se cierra el ciclo cubierto: el corte del cliente dentro del
// mes que cubre. Sin esto el saldo no vencería nunca y las sesiones no dadas
// se acumularían mes tras mes.
function cierreDelCiclo(periodo: string, diaDeCorte: number): string {
  const inicio = mediodiaEnPanama(periodo);
  const ultimo = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth(), Math.min(diaDeCorte || 1, ultimo))).toISOString().slice(0, 10);
}

async function coberturaDeCobro(ownerId: string, invoiceId: string) {
  const [invoice] = await sql`
    SELECT i.id, i.client_id, i.concept, i.amount, i.due_on, i.billing_period, i.status,
      i.source_system, c.full_name
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.id = ${invoiceId} AND c.owner_id = ${ownerId}
  `;
  if (!invoice) return null;
  // El titular del cobro y todas las personas a su cargo. Quien paga suele
  // entrenar también, así que entra en la lista como uno más.
  const candidates = await sql`
    SELECT c.id, c.full_name, c.status, c.billing_cutoff_day,
      COALESCE(p.price, c.standard_price, 0) AS suggested_amount,
      COALESCE(p.sessions_included, c.monthly_session_target, 0)::integer AS suggested_sessions,
      p.name AS plan_name
    FROM clients c
    LEFT JOIN service_plans p ON p.id = c.plan_id
    WHERE c.owner_id = ${ownerId}
      AND (c.id = ${invoice.client_id} OR c.billing_responsible_client_id = ${invoice.client_id})
    ORDER BY (c.id = ${invoice.client_id}) DESC, c.full_name
  `;
  const applied = await sql`
    SELECT cov.id, cov.client_id, cov.amount, cov.billing_period, cov.package_id,
      c.full_name, sp.total_sessions, sp.used_sessions, sp.expires_on
    FROM invoice_coverage cov
    JOIN clients c ON c.id = cov.client_id
    LEFT JOIN session_packages sp ON sp.id = cov.package_id
    WHERE cov.invoice_id = ${invoiceId}
    ORDER BY c.full_name
  `;
  return { invoice, candidates, applied, suggestedPeriod: mesCubiertoPorDefecto(invoice.billing_period || invoice.due_on) };
}

app.get('/api/invoices/:id/coverage', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const datos = await coberturaDeCobro(auth.sub, id);
  if (!datos) return reply.code(404).send({ error: 'Cobro no encontrado' });
  return datos;
});

const coverageSchema = z.object({
  billingPeriod: z.string().date(),
  entries: z.array(z.object({
    clientId: z.string().uuid(),
    amount: z.coerce.number().min(0),
    sessions: z.coerce.number().int().min(0)
  })).min(1)
});

app.post('/api/invoices/:id/coverage', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = coverageSchema.parse(request.body);
  const [invoice] = await sql`
    SELECT i.id, i.client_id, i.amount FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.id = ${id} AND c.owner_id = ${auth.sub} AND i.status <> 'void'
  `;
  if (!invoice) return reply.code(404).send({ error: 'Cobro no encontrado' });
  // El mes se guarda siempre por su día uno: es la unidad con la que compara
  // la generación, y un día suelto la haría fallar por un día de diferencia.
  const periodo = input.billingPeriod.slice(0, 8) + '01';

  const resultado = await sql.begin(async transaction => {
    const abiertos = [];
    for (const entry of input.entries) {
      const [cliente] = await transaction`
        SELECT c.id, c.full_name, c.billing_cutoff_day
        FROM clients c
        WHERE c.id = ${entry.clientId} AND c.owner_id = ${auth.sub}
          AND (c.id = ${invoice.client_id} OR c.billing_responsible_client_id = ${invoice.client_id})
      `;
      // Sólo el titular del cobro y su gente: cubrir a un tercero desde aquí
      // sería mover dinero de un expediente a otro sin dejar rastro.
      if (!cliente) return { error: 'Esa persona no depende de quien paga este cobro', code: 400 };

      let packageId: string | null = null;
      if (entry.sessions > 0) {
        const vence = cierreDelCiclo(periodo, Number(cliente.billing_cutoff_day) || 1);
        const [pack] = await transaction`
          INSERT INTO session_packages (client_id, label, total_sessions, amount, expires_on, kind, purchased_on, status)
          VALUES (${cliente.id},
            ${'Mensualidad ' + new Intl.DateTimeFormat('es-PA', { month: 'long', year: 'numeric', timeZone: 'America/Panama' }).format(mediodiaEnPanama(periodo))},
            ${entry.sessions}, ${entry.amount}, ${vence}::date, 'monthly', current_date, 'active')
          RETURNING id
        `;
        packageId = pack.id;
        await cobrarClasesYaDadas(transaction, pack.id, cliente.id, vence, entry.sessions);
      }
      // El índice único de (cliente, período) es lo que hace inofensivo pulsar
      // dos veces: la segunda no abre otro saldo, actualiza el mismo.
      const [cov] = await transaction`
        INSERT INTO invoice_coverage (invoice_id, client_id, package_id, amount, billing_period)
        VALUES (${id}, ${cliente.id}, ${packageId}, ${entry.amount}, ${periodo}::date)
        ON CONFLICT (client_id, billing_period) DO NOTHING
        RETURNING id
      `;
      if (!cov) {
        // Ya estaba cubierta. El saldo que se acaba de abrir sobra y se
        // deshace: dejarlo suelto le regalaría las clases por partida doble.
        if (packageId) await transaction`DELETE FROM session_packages WHERE id = ${packageId}`;
        continue;
      }
      abiertos.push({ clientId: cliente.id, fullName: cliente.full_name, sessions: entry.sessions, packageId });
    }
    return { abiertos };
  });
  if ('error' in resultado) return reply.code(resultado.code || 400).send({ error: resultado.error });
  return reply.code(201).send({ applied: resultado.abiertos, ...(await coberturaDeCobro(auth.sub, id)) });
});

app.delete('/api/invoices/:id/coverage/:coverageId', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const params = request.params as { id: string; coverageId: string };
  const id = z.string().uuid().parse(params.id);
  const coverageId = z.string().uuid().parse(params.coverageId);
  const resultado = await sql.begin(async transaction => {
    const [cov] = await transaction`
      SELECT cov.id, cov.package_id, c.full_name
      FROM invoice_coverage cov
      JOIN clients c ON c.id = cov.client_id
      WHERE cov.id = ${coverageId} AND cov.invoice_id = ${id} AND c.owner_id = ${auth.sub}
      FOR UPDATE OF cov
    `;
    if (!cov) return { error: 'Cobertura no encontrada', code: 404 };
    // El saldo se va con la cobertura, pero sólo si nadie lo usó. Con clases
    // ya dadas encima, borrarlo dejaría a esas clases sin de dónde salieron.
    let saldoBorrado = false;
    if (cov.package_id) {
      const [pack] = await transaction`SELECT id, used_sessions FROM session_packages WHERE id = ${cov.package_id} FOR UPDATE`;
      if (pack && Number(pack.used_sessions) === 0) {
        await transaction`DELETE FROM session_packages WHERE id = ${pack.id}`;
        saldoBorrado = true;
      }
    }
    await transaction`DELETE FROM invoice_coverage WHERE id = ${coverageId}`;
    return { deleted: true, saldoBorrado, fullName: cov.full_name };
  });
  if ('error' in resultado) return reply.code(resultado.code || 400).send({ error: resultado.error });
  return resultado;
});

// Borrado definitivo, para cobros que nunca debieron existir: pruebas,
// duplicados por error. Anular deja constancia de una transacción real; un
// cobro de prueba no lo es y no tiene por qué ensuciar la contabilidad para
// siempre.
//
// Se permite sólo si nada de dinero llegó a moverse: cobro local (Zoho manda
// sobre lo suyo), sin pagos registrados y sin notas de crédito. Con un pago
// encima, borrarlo escondería dinero recibido, y eso sí es un agujero.
app.delete('/api/invoices/:id/permanent', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  // Misma trampa que arriba: "false" como cadena sería true con coerce.
  const forzar = (request.query as { force?: string }).force === 'true';

  const resultado = await sql.begin(async transaction => {
    const [invoice] = await transaction`
      SELECT i.* FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.id = ${id} AND c.owner_id = ${auth.sub} FOR UPDATE OF i
    `;
    if (!invoice) return { error: 'Cobro no encontrado', code: 404 };
    if (invoice.source_system === 'zoho_invoice') return { error: 'Los cobros de Zoho no se borran desde aquí: Zoho es su fuente', code: 409 };
    // Un cobro ya pagado sólo se borra si se pide a conciencia: se lleva por
    // delante el pago, y con él el ingreso que figura en finanzas. Antes esto
    // era un callejón sin salida —el mensaje mandaba a "editar el pago
    // primero", pero editarlo no lo borra— y un cobro de prueba confirmado por
    // error se quedaba para siempre.
    // payment_allocations tiene clave primaria compuesta y no columna id.
    const pagos = await transaction`SELECT payment_id, amount FROM payment_allocations WHERE invoice_id = ${id}`;
    if (pagos.length && !forzar) {
      return { error: 'Este cobro tiene un pago registrado. Bórralo con la opción de borrado definitivo si de verdad quieres quitarlo', code: 409 };
    }
    if (invoice.status === 'confirmed' && !forzar) {
      return { error: 'Este cobro está confirmado como pagado. Usa el borrado definitivo si de verdad quieres quitarlo', code: 409 };
    }

    let pagosBorrados = 0;
    for (const asignacion of pagos) {
      // Si ese pago cubre además otros cobros, no se toca: sería un movimiento
      // de banco real y recortarlo aquí falsearía los otros cobros. Se dice y
      // se para, en vez de arreglarlo por dentro a ojo.
      const [otra] = await transaction`
        SELECT invoice_id FROM payment_allocations
        WHERE payment_id = ${asignacion.payment_id} AND invoice_id <> ${id} LIMIT 1
      `;
      if (otra) return { error: 'El pago de este cobro cubre también otros cobros. Sepáralos antes de borrarlo', code: 409 };
      // Las asignaciones caen en cascada con el pago.
      await transaction`DELETE FROM invoice_payments WHERE id = ${asignacion.payment_id}`;
      pagosBorrados += 1;
    }

    // Si el cobro creó un saldo de sesiones y nadie lo usó, se va con él: era
    // parte del mismo error. Si ya se consumieron sesiones, el saldo se queda.
    let saldoBorrado = false;
    if (invoice.package_id) {
      const [pack] = await transaction`SELECT id, used_sessions FROM session_packages WHERE id = ${invoice.package_id} FOR UPDATE`;
      if (pack && Number(pack.used_sessions) === 0) {
        await transaction`DELETE FROM session_packages WHERE id = ${pack.id}`;
        saldoBorrado = true;
      }
    }
    await transaction`DELETE FROM invoices WHERE id = ${id}`;
    return { deleted: true, saldoBorrado, pagosBorrados, concept: invoice.concept as string, error: undefined as string | undefined, code: 0 };
  });

  if (resultado.error) return reply.code(resultado.code || 400).send({ error: resultado.error });
  return { deleted: true, saldoBorrado: resultado.saldoBorrado, pagosBorrados: resultado.pagosBorrados, concept: resultado.concept };
});

const paymentSchema = z.object({ method: z.enum(['Efectivo', 'Yappy', 'Transferencia bancaria', 'Tarjeta', 'Otro']), reference: z.string().max(160).optional(), paidOn: z.string().date() });
async function saveNativeInvoicePayment(ownerId: string, id: string, input: z.infer<typeof paymentSchema>) {
  return sql.begin(async transaction => {
    const [invoice] = await transaction`
      UPDATE invoices i SET status = 'confirmed', payment_method = ${input.method}, payment_reference = ${input.reference || null},
        confirmed_at = ${`${input.paidOn}T12:00:00-05:00`}, balance = 0
      FROM clients c WHERE i.id = ${id} AND c.id = i.client_id AND c.owner_id = ${ownerId} AND i.source_system IS DISTINCT FROM 'zoho_invoice'
      RETURNING i.*
    `;
    if (!invoice) return null;
    const externalId = `eileen-payment:${id}`;
    const [payment] = await transaction`
      INSERT INTO invoice_payments (client_id, source_system, external_id, payment_number, amount, paid_on, method, reference)
      VALUES (${invoice.client_id}, 'eileen', ${externalId}, ${invoice.invoice_number || null}, ${invoice.amount}, ${input.paidOn}, ${input.method}, ${input.reference || null})
      ON CONFLICT (source_system, external_id) DO UPDATE SET amount = EXCLUDED.amount, paid_on = EXCLUDED.paid_on, method = EXCLUDED.method, reference = EXCLUDED.reference, updated_at = now()
      RETURNING *
    `;
    await transaction`INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (${payment.id}, ${invoice.id}, ${invoice.amount}) ON CONFLICT (payment_id, invoice_id) DO UPDATE SET amount = EXCLUDED.amount`;
    if (invoice.package_id) await transaction`UPDATE session_packages SET status = 'active' WHERE id = ${invoice.package_id} AND status = 'pending'`;
    return { invoice, payment };
  });
}
app.post('/api/invoices/:id/confirm', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id); const input = paymentSchema.parse(request.body);
  const result = await saveNativeInvoicePayment(auth.sub, id, input);
  if (!result) return reply.code(404).send({ error: 'Cobro local no encontrado' });
  return result.invoice;
});
app.patch('/api/invoices/:id/payment', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id); const input = paymentSchema.parse(request.body);
  const result = await saveNativeInvoicePayment(auth.sub, id, input);
  if (!result) return reply.code(404).send({ error: 'Pago local no encontrado' });
  return result;
});

// ── Panel de finanzas ─────────────────────────────────────────────────────
// Ingresos contra gastos, mes a mes.
//
// Ingreso = pagos recibidos, no facturas emitidas. Una factura es una promesa
// y un pago es dinero que entró; compararlos con gastos reales daría un
// resultado optimista y falso. Incluye los pagos importados de Zoho, que
// también fueron dinero recibido.
app.get('/api/finance/summary', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const query = z.object({
    months: z.coerce.number().int().min(2).max(36).default(12),
    rango: z.enum(['meses', 'anio', 'anioAnterior', 'todo']).default('meses')
  }).parse(request.query);

  const hoy = new Date();
  const anioActual = hoy.getUTCFullYear();
  let desde: Date;
  let hasta: Date | null = null;
  if (query.rango === 'anio') {
    desde = new Date(Date.UTC(anioActual, 0, 1));
    hasta = new Date(Date.UTC(anioActual, 11, 31));
  } else if (query.rango === 'anioAnterior') {
    desde = new Date(Date.UTC(anioActual - 1, 0, 1));
    hasta = new Date(Date.UTC(anioActual - 1, 11, 31));
  } else if (query.rango === 'todo') {
    // El primer movimiento real, sea un pago o un gasto. Empezar en una fecha
    // fija inventaría años vacíos por delante.
    const [primero] = await sql`
      SELECT least(
        COALESCE((SELECT min(p.paid_on) FROM invoice_payments p JOIN clients c ON c.id = p.client_id WHERE c.owner_id = ${auth.sub}), current_date),
        COALESCE((SELECT min(spent_on) FROM expenses WHERE owner_id = ${auth.sub}), current_date)
      ) AS inicio
    `;
    // postgres.js devuelve un Date para las columnas date, y String(fecha) da
    // "Wed Jan 01 2024 ...": cortar diez caracteres de ahí produce una fecha
    // inválida y toISOString() más abajo revienta. De ahí el 500 del rango
    // "todo" siempre que hubiera algún movimiento registrado.
    const inicioBruto = primero?.inicio;
    const inicioIso = inicioBruto instanceof Date
      ? inicioBruto.toISOString()
      : String(inicioBruto ?? new Date().toISOString());
    desde = new Date(`${inicioIso.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(desde.getTime())) desde = new Date(Date.UTC(anioActual, 0, 1));
    desde.setUTCDate(1);
  } else {
    desde = new Date();
    desde.setUTCDate(1); desde.setUTCHours(0, 0, 0, 0);
    desde.setUTCMonth(desde.getUTCMonth() - (query.months - 1));
  }
  const inicio = desde.toISOString().slice(0, 10);
  const fin = hasta ? hasta.toISOString().slice(0, 10) : null;
  // Cuántos meses cubre el rango elegido, para armar la línea de tiempo.
  const ultimo = hasta || hoy;
  const months = Math.max(1, Math.min(600,
    (ultimo.getUTCFullYear() - desde.getUTCFullYear()) * 12 + (ultimo.getUTCMonth() - desde.getUTCMonth()) + 1));

  const [ingresos, gastos, porCategoria] = await Promise.all([
    sql`
      SELECT to_char(date_trunc('month', p.paid_on), 'YYYY-MM') AS month,
        COALESCE(sum(p.amount), 0)::numeric AS total, count(*)::int AS cantidad
      FROM invoice_payments p JOIN clients c ON c.id = p.client_id
      WHERE c.owner_id = ${auth.sub} AND p.paid_on >= ${inicio}::date
        AND (${fin}::date IS NULL OR p.paid_on <= ${fin}::date)
      GROUP BY 1
    `,
    sql`
      SELECT to_char(date_trunc('month', e.spent_on), 'YYYY-MM') AS month,
        COALESCE(sum(e.amount), 0)::numeric AS total, count(*)::int AS cantidad,
        COALESCE(sum(e.amount) FILTER (WHERE c.ambito = 'negocio'), 0)::numeric AS negocio,
        COALESCE(sum(e.amount) FILTER (WHERE c.ambito = 'personal'), 0)::numeric AS personal,
        COALESCE(sum(e.amount) FILTER (WHERE c.ambito IS NULL), 0)::numeric AS sin_clasificar
      FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id
      WHERE e.owner_id = ${auth.sub} AND e.spent_on >= ${inicio}::date
        AND (${fin}::date IS NULL OR e.spent_on <= ${fin}::date)
      GROUP BY 1
    `,
    sql`
      SELECT COALESCE(c.name, 'Sin categoría') AS categoria, c.ambito,
        COALESCE(sum(e.amount), 0)::numeric AS total, count(*)::int AS cantidad
      FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id
      WHERE e.owner_id = ${auth.sub} AND e.spent_on >= ${inicio}::date
        AND (${fin}::date IS NULL OR e.spent_on <= ${fin}::date)
      GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 12
    `
  ]);

  const mapaIngresos = new Map(ingresos.map(row => [row.month as string, row]));
  const mapaGastos = new Map(gastos.map(row => [row.month as string, row]));
  const timeline = Array.from({ length: months }, (_, i) => {
    const fecha = new Date(Date.UTC(desde.getUTCFullYear(), desde.getUTCMonth() + i, 1));
    const month = `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, '0')}`;
    const income = Number(mapaIngresos.get(month)?.total || 0);
    const expense = Number(mapaGastos.get(month)?.total || 0);
    const fila = mapaGastos.get(month);
    const negocio = Number(fila?.negocio || 0);
    return {
      month, income: Number(income.toFixed(2)), expense: Number(expense.toFixed(2)),
      net: Number((income - expense).toFixed(2)),
      // El neto del negocio ignora el gasto personal: es el que dice si el
      // entrenamiento se sostiene solo.
      expenseNegocio: Number(negocio.toFixed(2)),
      expensePersonal: Number(Number(fila?.personal || 0).toFixed(2)),
      expenseSinClasificar: Number(Number(fila?.sin_clasificar || 0).toFixed(2)),
      netNegocio: Number((income - negocio).toFixed(2)),
      payments: Number(mapaIngresos.get(month)?.cantidad || 0),
      expenseCount: Number(fila?.cantidad || 0)
    };
  });

  const totalIngresos = timeline.reduce((suma, mes) => suma + mes.income, 0);
  const totalGastos = timeline.reduce((suma, mes) => suma + mes.expense, 0);
  const gastosNegocio = timeline.reduce((suma, mes) => suma + mes.expenseNegocio, 0);
  const gastosPersonal = timeline.reduce((suma, mes) => suma + mes.expensePersonal, 0);
  const gastosSinClasificar = timeline.reduce((suma, mes) => suma + mes.expenseSinClasificar, 0);
  const conActividad = timeline.filter(mes => mes.income > 0 || mes.expense > 0);

  return {
    timeline, categorias: porCategoria,
    totales: {
      ingresos: Number(totalIngresos.toFixed(2)),
      gastos: Number(totalGastos.toFixed(2)),
      neto: Number((totalIngresos - totalGastos).toFixed(2)),
      // Cuánto de cada dólar cobrado se queda. Sin ingresos no se calcula, en
      // vez de mostrar un 0% que parecería un negocio en ruina.
      margen: totalIngresos > 0 ? Math.round(((totalIngresos - totalGastos) / totalIngresos) * 100) : null,
      gastosNegocio: Number(gastosNegocio.toFixed(2)),
      gastosPersonal: Number(gastosPersonal.toFixed(2)),
      gastosSinClasificar: Number(gastosSinClasificar.toFixed(2)),
      netoNegocio: Number((totalIngresos - gastosNegocio).toFixed(2)),
      // Mientras quede gasto sin clasificar no se da margen del negocio: con
      // todo sin marcar saldría un 100% impecable y falso, que es peor que el
      // número mezclado que esto vino a corregir. Sin dato es más honesto.
      margenNegocio: totalIngresos > 0 && gastosSinClasificar === 0
        ? Math.round(((totalIngresos - gastosNegocio) / totalIngresos) * 100)
        : null,
      mesesConActividad: conActividad.length,
      promedioMensualNeto: conActividad.length ? Number(((totalIngresos - totalGastos) / conActividad.length).toFixed(2)) : 0
    }
  };
});

// ── Gastos ────────────────────────────────────────────────────────────────
// La otra mitad de las finanzas. Hasta ahora la aplicación sólo sabía de
// ingresos, así que no había con qué comparar.
const expenseCategorySchema = z.object({
  name: z.string().trim().min(2).max(120),
  ambito: z.enum(['negocio', 'personal']).nullable().optional(),
  description: z.string().trim().max(300).optional().nullable(),
  archived: z.boolean().optional()
});

app.get('/api/expense-categories', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`
    SELECT c.*, count(e.id)::int AS usos, COALESCE(sum(e.amount), 0)::numeric AS total
    FROM expense_categories c LEFT JOIN expenses e ON e.category_id = c.id
    WHERE c.owner_id = ${auth.sub}
    GROUP BY c.id ORDER BY c.archived, c.name
  `;
});

app.post('/api/expense-categories', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const input = expenseCategorySchema.parse(request.body);
  const [categoria] = await sql`
    INSERT INTO expense_categories (owner_id, name, ambito, description)
    VALUES (${auth.sub}, ${input.name}, ${input.ambito ?? null}, ${input.description || null})
    ON CONFLICT (owner_id, name) DO NOTHING RETURNING *
  `;
  if (!categoria) return reply.code(409).send({ error: 'Ya existe una categoría con ese nombre' });
  return reply.code(201).send(categoria);
});

app.patch('/api/expense-categories/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = expenseCategorySchema.partial().parse(request.body);
  const [categoria] = await sql`
    UPDATE expense_categories SET
      name = COALESCE(${input.name ?? null}, name),
      ambito = CASE WHEN ${'ambito' in (input as Record<string, unknown>)} THEN ${input.ambito ?? null} ELSE ambito END,
      description = COALESCE(${input.description ?? null}, description),
      archived = COALESCE(${input.archived ?? null}, archived),
      updated_at = now()
    WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING *
  `;
  if (!categoria) return reply.code(404).send({ error: 'Categoría no encontrada' });
  return categoria;
});

app.delete('/api/expense-categories/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  // Los gastos no se borran con la categoría: quedan sin clasificar. Perder el
  // gasto por reordenar categorías sería perder dinero del registro.
  const [categoria] = await sql`DELETE FROM expense_categories WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING id, name`;
  if (!categoria) return reply.code(404).send({ error: 'Categoría no encontrada' });
  return { deleted: true, categoria };
});

const expenseSchema = z.object({
  description: z.string().trim().min(2).max(300),
  amount: z.coerce.number().min(0),
  spentOn: z.string().date(),
  categoryId: z.union([z.literal(''), z.null(), z.string().uuid()]).optional().transform(v => (v === '' || v === undefined ? null : v)),
  clientId: z.union([z.literal(''), z.null(), z.string().uuid()]).optional().transform(v => (v === '' || v === undefined ? null : v)),
  paymentMethod: z.string().trim().max(60).optional().nullable(),
  reference: z.string().trim().max(160).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable()
});

app.get('/api/expenses', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const query = z.object({
    from: z.string().date().optional(), to: z.string().date().optional(),
    categoryId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(200)
  }).parse(request.query);
  return sql`
    SELECT e.*, c.name AS category_name, cl.full_name AS client_name
    FROM expenses e
    LEFT JOIN expense_categories c ON c.id = e.category_id
    LEFT JOIN clients cl ON cl.id = e.client_id
    WHERE e.owner_id = ${auth.sub}
      AND (${query.from || null}::date IS NULL OR e.spent_on >= ${query.from || null}::date)
      AND (${query.to || null}::date IS NULL OR e.spent_on <= ${query.to || null}::date)
      AND (${query.categoryId || null}::uuid IS NULL OR e.category_id = ${query.categoryId || null}::uuid)
    ORDER BY e.spent_on DESC, e.created_at DESC
    LIMIT ${query.limit}
  `;
});

app.post('/api/expenses', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const input = expenseSchema.parse(request.body);
  const [gasto] = await sql`
    INSERT INTO expenses (owner_id, category_id, client_id, description, amount, spent_on, payment_method, reference, notes)
    VALUES (${auth.sub}, ${input.categoryId}, ${input.clientId}, ${input.description}, ${input.amount}, ${input.spentOn}::date,
            ${input.paymentMethod || null}, ${input.reference || null}, ${input.notes || null})
    RETURNING *
  `;
  return reply.code(201).send(gasto);
});

app.patch('/api/expenses/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = expenseSchema.partial().parse(request.body);
  const [gasto] = await sql`
    UPDATE expenses SET
      description = COALESCE(${input.description ?? null}, description),
      amount = COALESCE(${input.amount ?? null}, amount),
      spent_on = COALESCE(${input.spentOn ?? null}::date, spent_on),
      category_id = ${input.categoryId === undefined ? sql`category_id` : input.categoryId},
      client_id = ${input.clientId === undefined ? sql`client_id` : input.clientId},
      payment_method = COALESCE(${input.paymentMethod ?? null}, payment_method),
      reference = COALESCE(${input.reference ?? null}, reference),
      notes = COALESCE(${input.notes ?? null}, notes),
      updated_at = now()
    WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING *
  `;
  if (!gasto) return reply.code(404).send({ error: 'Gasto no encontrado' });
  return gasto;
});

app.delete('/api/expenses/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [gasto] = await sql`DELETE FROM expenses WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING id, description`;
  if (!gasto) return reply.code(404).send({ error: 'Gasto no encontrado' });
  return { deleted: true, gasto };
});

const reportPeriodSchema = z.enum(['week', 'month', '3months', '6months', 'year']);
const reportStart = (period: z.infer<typeof reportPeriodSchema>) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (period === 'week') start.setDate(start.getDate() - 7);
  else if (period === 'month') start.setMonth(start.getMonth() - 1);
  else if (period === '3months') start.setMonth(start.getMonth() - 3);
  else if (period === '6months') start.setMonth(start.getMonth() - 6);
  else start.setFullYear(start.getFullYear() - 1);
  return start.toISOString();
};

// El informe mensual necesita la misma definición de actividad pero sobre una
// ventana propia, así que el inicio se puede imponer en vez de derivarlo del
// período. Duplicar la consulta habría dejado dos definiciones de
// "cumplimiento" que se irían separando con el tiempo.
async function complianceRows(ownerId: string, period: z.infer<typeof reportPeriodSchema>, clientId?: string, startOverride?: string) {
  const start = startOverride || reportStart(period);
  return sql`
    WITH activities AS (
      SELECT c.id AS client_id, c.full_name, s.starts_at AS occurred_at, 'Sesión'::text AS source,
        COALESCE(r.title, CASE WHEN s.quick_logged THEN 'Entrenamiento presencial' ELSE 'Evaluación / seguimiento' END) AS activity,
        CASE WHEN s.status = 'cancelled' THEN 'missed' ELSE s.status END AS status,
        CASE WHEN s.status = 'cancelled' THEN 0::smallint ELSE s.completion_percent END AS completion_percent,
        false AS late
      FROM sessions s JOIN clients c ON c.id = s.client_id LEFT JOIN routines r ON r.id = s.routine_id
      -- Las canceladas entran sólo si nadie las reprogramó: cuentan como
      -- incumplidas con 0%. Si se movieron a otro día, la que cuenta es la
      -- nueva sesión y penalizar ambas sería cobrar dos veces lo mismo.
      WHERE c.owner_id = ${ownerId} AND s.starts_at >= ${start} AND s.starts_at <= now()
        AND (s.status <> 'cancelled' OR s.cancellation_kind = 'not_rescheduled')
      UNION ALL
      SELECT c.id AS client_id, c.full_name, rc.completed_on::timestamptz AS occurred_at, 'Rutina'::text AS source,
        r.title AS activity, 'completed'::text AS status, rc.completion_percent,
        -- Cumplir tarde sigue siendo cumplir: no baja el porcentaje, sólo se
        -- señala aparte para que la entrenadora vea a quien siempre se atrasa.
        COALESCE(asignada.due_on IS NOT NULL AND rc.completed_on > asignada.due_on, false) AS late
      FROM routine_completions rc JOIN clients c ON c.id = rc.client_id JOIN routines r ON r.id = rc.routine_id
      LEFT JOIN LATERAL (
        SELECT ra.due_on FROM routine_assignments ra
        WHERE ra.routine_id = rc.routine_id AND ra.client_id = rc.client_id
        ORDER BY ra.starts_on DESC LIMIT 1
      ) AS asignada ON true
      WHERE c.owner_id = ${ownerId} AND rc.completed_on >= ${start}::date AND rc.completed_on <= current_date
      UNION ALL
      -- Rutinas con fecha límite vencida que nunca se registraron. Sin esto una
      -- rutina que jamás se hizo simplemente no aparecía, así que no bajaba el
      -- promedio y el número se veía mejor de lo que era.
      SELECT c.id AS client_id, c.full_name, ra.due_on::timestamptz AS occurred_at, 'Rutina'::text AS source,
        r.title AS activity, 'missed'::text AS status, 0::smallint AS completion_percent, false AS late
      FROM routine_assignments ra JOIN clients c ON c.id = ra.client_id JOIN routines r ON r.id = ra.routine_id
      WHERE c.owner_id = ${ownerId} AND ra.due_on IS NOT NULL
        AND ra.due_on >= ${start}::date AND ra.due_on < current_date
        AND NOT EXISTS (
          SELECT 1 FROM routine_completions rc
          WHERE rc.routine_id = ra.routine_id AND rc.client_id = ra.client_id AND rc.completion_percent > 0
        )
      UNION ALL
      -- Sesiones contratadas que vencieron sin darse. Una fila por cada una:
      -- un paquete de 8 que venció con 5 usadas aporta 3 incumplimientos, y
      -- junto a las 5 completadas —que ya entran por la rama de sesiones— deja
      -- el cumplimiento en 5 de 8. Vale igual para mensualidad, que desde el
      -- cambio de hoy también lleva saldo con vencimiento.
      SELECT c.id AS client_id, c.full_name, sp.expires_on::timestamptz AS occurred_at,
        CASE WHEN sp.kind = 'monthly' THEN 'Mensualidad' ELSE 'Paquete' END::text AS source,
        sp.label AS activity, 'missed'::text AS status, 0::smallint AS completion_percent, false AS late
      FROM session_packages sp
      JOIN clients c ON c.id = sp.client_id
      CROSS JOIN LATERAL generate_series(1, sp.total_sessions - sp.used_sessions) AS faltante
      WHERE c.owner_id = ${ownerId}
        AND sp.expires_on IS NOT NULL
        AND sp.expires_on >= ${start}::date AND sp.expires_on < current_date
        AND sp.status <> 'cancelled'
        AND sp.used_sessions < sp.total_sessions
    )
    SELECT * FROM activities WHERE (${clientId || null}::uuid IS NULL OR client_id = ${clientId || null}) ORDER BY occurred_at DESC, full_name
  `;
}

app.get('/api/compliance/summary', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser; const query = z.object({ period: reportPeriodSchema.default('week') }).parse(request.query);
  const rows = await complianceRows(auth.sub, query.period);
  const clients = new Map<string, { clientId: string; name: string; total: number; sum: number; completed: number; late: number; missed: number }>();
  for (const row of rows) {
    const current = clients.get(row.client_id) || { clientId: row.client_id, name: row.full_name, total: 0, sum: 0, completed: 0, late: 0, missed: 0 };
    current.total += 1; current.sum += Number(row.completion_percent);
    if (Number(row.completion_percent) > 0) current.completed += 1;
    if (row.late) current.late += 1;
    if (row.status === 'missed') current.missed += 1;
    clients.set(row.client_id, current);
  }
  const clientSummaries = [...clients.values()].map(item => ({
    clientId: item.clientId, name: item.name, activities: item.total, completed: item.completed,
    // Puntualidad aparte del porcentaje: quien cumple siempre tarde no debe
    // verse igual que quien no cumple, pero tampoco igual que quien es puntual.
    late: item.late, missed: item.missed,
    compliancePercent: item.total ? Math.round(item.sum / item.total) : 0
  })).sort((a, b) => b.compliancePercent - a.compliancePercent || a.name.localeCompare(b.name));
  return {
    period: query.period, activities: rows.length,
    late: rows.filter(row => row.late).length,
    missed: rows.filter(row => row.status === 'missed').length,
    compliancePercent: rows.length ? Math.round(rows.reduce((sum, row) => sum + Number(row.completion_percent), 0) / rows.length) : 0,
    clients: clientSummaries
  };
});

// Informe mensual de cumplimiento, para revisar la evolución de un cliente y
// mandársela al cierre de cada mes.
const monthlyReportSchema = z.object({
  clientId: z.string().uuid().optional(),
  months: z.coerce.number().int().min(2).max(24).default(6)
});

async function complianceMonthly(ownerId: string, clientId: string | undefined, months: number) {
  const desde = new Date();
  desde.setUTCDate(1); desde.setUTCHours(0, 0, 0, 0);
  desde.setUTCMonth(desde.getUTCMonth() - (months - 1));
  const filas = await complianceRows(ownerId, 'year', clientId, desde.toISOString());

  const porMes = new Map<string, { month: string; activities: number; completed: number; late: number; missed: number; suma: number }>();
  for (let i = 0; i < months; i += 1) {
    const fecha = new Date(Date.UTC(desde.getUTCFullYear(), desde.getUTCMonth() + i, 1));
    const clave = `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, '0')}`;
    porMes.set(clave, { month: clave, activities: 0, completed: 0, late: 0, missed: 0, suma: 0 });
  }
  for (const fila of filas) {
    const fecha = new Date(fila.occurred_at as string);
    const clave = `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, '0')}`;
    const mes = porMes.get(clave);
    if (!mes) continue;
    mes.activities += 1; mes.suma += Number(fila.completion_percent);
    if (Number(fila.completion_percent) > 0) mes.completed += 1;
    if (fila.late) mes.late += 1;
    if (fila.status === 'missed') mes.missed += 1;
  }
  // Un mes sin actividad devuelve null, no 0%: no es lo mismo "no entrenó
  // nada" que "no había nada que medir", y pintar un cero hundiría la gráfica
  // por meses en los que el cliente ni siquiera estaba activo.
  return [...porMes.values()].map(mes => ({
    month: mes.month, activities: mes.activities, completed: mes.completed, late: mes.late, missed: mes.missed,
    compliancePercent: mes.activities ? Math.round(mes.suma / mes.activities) : null
  }));
}

app.get('/api/compliance/monthly', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const query = monthlyReportSchema.parse(request.query);
  let client = null;
  if (query.clientId) {
    client = await ownedClient(query.clientId, auth.sub);
    if (!client) return reply.code(404).send({ error: 'Cliente no encontrado' });
  }
  const timeline = await complianceMonthly(auth.sub, query.clientId, query.months);
  const conDatos = timeline.filter(mes => mes.compliancePercent !== null);
  return {
    timeline,
    clientId: query.clientId || null,
    promedio: conDatos.length ? Math.round(conDatos.reduce((suma, mes) => suma + (mes.compliancePercent || 0), 0) / conDatos.length) : null,
    totalActividades: timeline.reduce((suma, mes) => suma + mes.activities, 0),
    totalTardias: timeline.reduce((suma, mes) => suma + mes.late, 0),
    totalIncumplidas: timeline.reduce((suma, mes) => suma + mes.missed, 0)
  };
});

app.get('/api/compliance/report.pdf', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const query = monthlyReportSchema.parse(request.query);
  let client = null;
  if (query.clientId) {
    const [row] = await sql`SELECT id, full_name, email FROM clients WHERE id = ${query.clientId} AND owner_id = ${auth.sub}`;
    if (!row) return reply.code(404).send({ error: 'Cliente no encontrado' });
    client = row;
  }
  const timeline = await complianceMonthly(auth.sub, query.clientId, query.months);
  const conDatos = timeline.filter(mes => mes.compliancePercent !== null);
  const resumen = {
    promedio: conDatos.length ? Math.round(conDatos.reduce((suma, mes) => suma + (mes.compliancePercent || 0), 0) / conDatos.length) : null,
    totalActividades: timeline.reduce((suma, mes) => suma + mes.activities, 0),
    totalTardias: timeline.reduce((suma, mes) => suma + mes.late, 0),
    totalIncumplidas: timeline.reduce((suma, mes) => suma + mes.missed, 0)
  };
  const nombre = client ? String(client.full_name).replace(/\s+/g, '-').toLowerCase() : 'todos';
  return sendPdf(reply, await compliancePdf(client, resumen, timeline), `cumplimiento-${nombre}.pdf`);
});

app.get('/api/compliance/report.csv', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const query = z.object({ period: reportPeriodSchema.default('month'), clientId: z.string().uuid().optional() }).parse(request.query);
  const rows = await complianceRows(auth.sub, query.period, query.clientId);
  const header = ['Cliente', 'Fecha', 'Origen', 'Actividad', 'Estado', 'Cumplimiento (%)'];
  const lines = rows.map(row => [row.full_name, new Date(row.occurred_at).toLocaleString('es-PA', { timeZone: 'America/Panama' }), row.source, row.activity, row.status, row.completion_percent].map(csvCell).join(','));
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="cumplimiento-${query.period}.csv"`);
  return `\uFEFF${header.map(csvCell).join(',')}\n${lines.join('\n')}`;
});

const notificationPreferenceSchema = z.object({
  inAppEnabled: z.boolean(), browserEnabled: z.boolean(),
  sessionReminderHours: z.coerce.number().int().min(1).max(168), paymentReminderDays: z.coerce.number().int().min(0).max(30)
});

app.get('/api/notification-preferences', { preHandler: requireAuth }, async request => {
  const auth = request.user as AuthUser;
  const [preference] = await sql`
    INSERT INTO notification_preferences (user_id) VALUES (${auth.sub})
    ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
    RETURNING *
  `;
  return preference;
});

app.patch('/api/notification-preferences', { preHandler: requireAuth }, async request => {
  const auth = request.user as AuthUser; const input = notificationPreferenceSchema.parse(request.body);
  const [preference] = await sql`
    INSERT INTO notification_preferences (user_id, in_app_enabled, browser_enabled, session_reminder_hours, payment_reminder_days)
    VALUES (${auth.sub}, ${input.inAppEnabled}, ${input.browserEnabled}, ${input.sessionReminderHours}, ${input.paymentReminderDays})
    ON CONFLICT (user_id) DO UPDATE SET in_app_enabled = EXCLUDED.in_app_enabled, browser_enabled = EXCLUDED.browser_enabled,
      session_reminder_hours = EXCLUDED.session_reminder_hours, payment_reminder_days = EXCLUDED.payment_reminder_days, updated_at = now()
    RETURNING *
  `;
  return preference;
});

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) })
});

app.get('/api/push/config', { preHandler: requireAuth }, async () => ({
  configured: webPushReady,
  publicKey: webPushReady ? config.VAPID_PUBLIC_KEY : null
}));

app.post('/api/push/subscriptions', { preHandler: requireAuth }, async (request, reply) => {
  if (!webPushReady) return reply.code(503).send({ error: 'Las notificaciones push todavía no están configuradas' });
  const auth = request.user as AuthUser; const input = pushSubscriptionSchema.parse(request.body);
  const [subscription] = await sql`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (${auth.sub}, ${input.endpoint}, ${input.keys.p256dh}, ${input.keys.auth})
    ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth, active = true, updated_at = now()
    RETURNING id, active, updated_at
  `;
  return reply.code(201).send(subscription);
});

app.get('/api/notifications', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const [preference] = await sql`SELECT * FROM notification_preferences WHERE user_id = ${auth.sub}`;
  const sessionHours = Number(preference?.session_reminder_hours || 24); const paymentDays = Number(preference?.payment_reminder_days || 3);
  if (auth.role === 'client') {
    const [client] = await sql`SELECT * FROM clients WHERE portal_user_id = ${auth.sub}`;
    if (!client) return reply.code(404).send({ error: 'Portal de cliente no encontrado' });
    const sessions = await sql`SELECT starts_at, duration_minutes FROM sessions WHERE client_id = ${client.id} AND status = 'scheduled' AND starts_at BETWEEN now() AND now() + ${`${sessionHours} hours`}::interval ORDER BY starts_at`;
    const invoices = await sql`SELECT due_on, amount, concept FROM invoices WHERE client_id = ${client.id} AND status = 'pending' AND due_on <= current_date + (${paymentDays})::integer ORDER BY due_on`;
    return [
      ...sessions.map(session => ({ type: 'session', title: 'Próximo entrenamiento', body: `Tienes una sesión el ${new Date(session.starts_at).toLocaleString('es-PA', { timeZone: 'America/Panama' })}.`, scheduledFor: session.starts_at })),
      ...invoices.map(invoice => ({ type: 'payment', title: 'Recordatorio de pago', body: `${invoice.concept}: $${Number(invoice.amount).toFixed(2)} · vence ${invoice.due_on}.`, scheduledFor: invoice.due_on }))
    ];
  }
  const sessions = await sql`
    SELECT s.starts_at, c.full_name FROM sessions s JOIN clients c ON c.id = s.client_id
    WHERE c.owner_id = ${auth.sub} AND s.status = 'scheduled' AND s.starts_at BETWEEN now() AND now() + ${`${sessionHours} hours`}::interval ORDER BY s.starts_at
  `;
  const invoices = await sql`
    SELECT i.due_on, i.amount, i.concept, c.full_name FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE c.owner_id = ${auth.sub} AND i.status = 'pending' AND i.due_on <= current_date + (${paymentDays})::integer ORDER BY i.due_on
  `;
  // Clases cuya hora ya pasó y siguen sin resolverse. Una sesión que se quedó
  // en 'programada' después de su hora no dice nada: ni que se dio, ni que se
  // perdió, ni que se canceló. Y el cumplimiento del cliente la cuenta como
  // incumplida en cuanto vence su saldo, sin que nadie lo haya decidido.
  //
  // Se miran sólo los últimos siete días: más atrás es historial que ya no se
  // va a marcar de memoria, y una lista infinita no se revisa nunca.
  const pendientes = await sql`
    SELECT s.id, s.starts_at, s.duration_minutes, c.full_name
    FROM sessions s JOIN clients c ON c.id = s.client_id
    WHERE c.owner_id = ${auth.sub} AND s.status = 'scheduled'
      AND s.starts_at + make_interval(mins => s.duration_minutes) <= now()
      AND s.starts_at >= now() - interval '7 days'
    ORDER BY s.starts_at DESC
  `;
  return [
    ...pendientes.map(session => ({
      type: 'pending', sessionId: session.id,
      title: `Falta marcar: ${session.full_name}`,
      body: `${new Date(session.starts_at).toLocaleString('es-PA', { timeZone: 'America/Panama', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} · ya terminó y sigue sin marcar.`,
      scheduledFor: session.starts_at
    })),
    ...sessions.map(session => ({ type: 'session', title: `Sesión con ${session.full_name}`, body: new Date(session.starts_at).toLocaleString('es-PA', { timeZone: 'America/Panama' }), scheduledFor: session.starts_at })),
    ...invoices.map(invoice => ({ type: 'payment', title: `Pago de ${invoice.full_name}`, body: `${invoice.concept}: $${Number(invoice.amount).toFixed(2)} · vence ${invoice.due_on}.`, scheduledFor: invoice.due_on }))
  ];
});

type ReminderCandidate = {
  user_id: string;
  kind: 'session' | 'payment' | 'pending';
  reference_id: string;
  role: AuthUser['role'];
  full_name: string;
  starts_at?: string;
  due_on?: string;
  amount?: number | string;
  concept?: string;
};

// Enviar una notificación de prueba al propio usuario. Existe porque hasta
// ahora no había forma de saber si el circuito completo funcionaba: se
// activaba la casilla, se veía un aviso local —que no prueba nada, lo dibuja
// el propio navegador— y había que esperar a que hubiera una sesión o un cobro
// próximo para descubrir si el push de verdad llegaba. Esta ruta recorre el
// camino entero: servidor, servicio de push del navegador y teléfono.
app.post('/api/push/test', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser;
  if (!webPushReady) return reply.code(503).send({ error: 'Las notificaciones push todavía no están configuradas' });
  const [{ count }] = await sql`SELECT count(*)::int FROM push_subscriptions WHERE user_id = ${auth.sub} AND active = true`;
  if (!Number(count)) return reply.code(409).send({ error: 'Este dispositivo todavía no está registrado para notificaciones' });
  const entregada = await sendPushToUser(auth.sub, {
    title: 'Eileen Lifestyle',
    body: 'Notificación de prueba: si la ves, los recordatorios llegarán bien.',
    url: '/'
  });
  // Un 502 y no un 200 con bandera: si no salió, es un fallo y quien llama
  // debe enterarse sin tener que leer el cuerpo.
  if (!entregada) return reply.code(502).send({ error: 'No se pudo entregar en ningún dispositivo registrado. Vuelve a activarlas.' });
  return { delivered: true, dispositivos: Number(count) };
});

async function sendPushToUser(userId: string, payload: { title: string; body: string; url: string }) {
  if (!webPushReady) return false;
  const subscriptions = await sql`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ${userId} AND active = true`;
  let delivered = false;
  await Promise.all(subscriptions.map(async subscription => {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth }
      }, JSON.stringify(payload), { TTL: 86_400, urgency: 'normal' });
      delivered = true;
    } catch (error) {
      const statusCode = error instanceof webpush.WebPushError ? error.statusCode : undefined;
      if (statusCode === 404 || statusCode === 410) {
        await sql`UPDATE push_subscriptions SET active = false, updated_at = now() WHERE id = ${subscription.id}`;
      }
      app.log.warn({ err: error, userId, statusCode }, 'No se pudo entregar una notificación push');
    }
  }));
  return delivered;
}

async function dispatchReminders() {
  if (!webPushReady) return;
  const [sessionRows, paymentRows] = await Promise.all([
    sql<ReminderCandidate[]>`
      SELECT u.id AS user_id, 'session' AS kind, s.id AS reference_id, u.role, c.full_name, s.starts_at
      FROM notification_preferences np
      JOIN users u ON u.id = np.user_id AND u.active = true
      JOIN clients c ON (u.role = 'client' AND c.portal_user_id = u.id)
        OR (u.role IN ('admin', 'trainer') AND c.owner_id = u.id)
      JOIN sessions s ON s.client_id = c.id
      WHERE np.browser_enabled = true AND s.status = 'scheduled'
        AND s.starts_at BETWEEN now() AND now() + make_interval(hours => np.session_reminder_hours)
        AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id AND ps.active = true)
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.user_id = u.id AND nd.kind = 'session' AND nd.reference_id = s.id
        )
    `,
    sql<ReminderCandidate[]>`
      SELECT u.id AS user_id, 'payment' AS kind, i.id AS reference_id, u.role, c.full_name,
        i.due_on, i.amount, i.concept
      FROM notification_preferences np
      JOIN users u ON u.id = np.user_id AND u.active = true
      JOIN clients c ON (u.role = 'client' AND c.portal_user_id = u.id)
        OR (u.role IN ('admin', 'trainer') AND c.owner_id = u.id)
      JOIN invoices i ON i.client_id = c.id
      WHERE np.browser_enabled = true AND i.status = 'pending'
        AND i.due_on BETWEEN current_date - 30 AND current_date + np.payment_reminder_days
        AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id AND ps.active = true)
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.user_id = u.id AND nd.kind = 'payment' AND nd.reference_id = i.id
        )
    `
  ]);

  // La clase terminó y nadie dijo si se dio. Es el único aviso que llega
  // *después* del hecho, y por eso hace falta: los otros dos recuerdan lo que
  // viene, y esto se olvida justo por haber pasado. Sólo a la entrenadora: al
  // cliente no le toca resolverlo.
  const pendingRows = await sql<ReminderCandidate[]>`
    SELECT u.id AS user_id, 'pending' AS kind, s.id AS reference_id, u.role, c.full_name, s.starts_at
    FROM notification_preferences np
    JOIN users u ON u.id = np.user_id AND u.active = true AND u.role IN ('admin', 'trainer')
    JOIN clients c ON c.owner_id = u.id
    JOIN sessions s ON s.client_id = c.id
    WHERE np.browser_enabled = true AND s.status = 'scheduled'
      AND s.starts_at + make_interval(mins => s.duration_minutes) <= now()
      AND s.starts_at >= now() - interval '7 days'
      AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id AND ps.active = true)
      AND NOT EXISTS (
        SELECT 1 FROM notification_deliveries nd
        WHERE nd.user_id = u.id AND nd.kind = 'pending' AND nd.reference_id = s.id
      )
  `;

  for (const reminder of [...pendingRows, ...sessionRows, ...paymentRows]) {
    const [reserved] = await sql`
      INSERT INTO notification_deliveries (user_id, kind, reference_id)
      VALUES (${reminder.user_id}, ${reminder.kind}, ${reminder.reference_id})
      ON CONFLICT DO NOTHING RETURNING user_id
    `;
    if (!reserved) continue;
    const isClient = reminder.role === 'client';
    const payload = reminder.kind === 'pending'
      ? {
          title: `Falta marcar: ${reminder.full_name}`,
          body: `Su clase de ${new Date(reminder.starts_at!).toLocaleString('es-PA', { timeZone: 'America/Panama', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} ya terminó. ¿Cumplió?`,
          url: new URL('/#calendar', config.APP_URL).toString()
        }
      : reminder.kind === 'session'
      ? {
          title: isClient ? 'Próximo entrenamiento' : `Sesión con ${reminder.full_name}`,
          body: `Programada para ${new Date(reminder.starts_at!).toLocaleString('es-PA', { timeZone: 'America/Panama' })}.`,
          url: new URL(isClient ? '/#portal-calendar' : '/#calendar', config.APP_URL).toString()
        }
      : {
          title: isClient ? 'Recordatorio de pago' : `Pago de ${reminder.full_name}`,
          body: `${reminder.concept}: $${Number(reminder.amount).toFixed(2)} · vence ${reminder.due_on}.`,
          url: new URL(isClient ? '/#portal-billing' : '/#billing', config.APP_URL).toString()
        };
    if (!(await sendPushToUser(reminder.user_id, payload))) {
      await sql`DELETE FROM notification_deliveries WHERE user_id = ${reminder.user_id} AND kind = ${reminder.kind} AND reference_id = ${reminder.reference_id}`;
    }
  }
}

async function portalClient(userId: string) {
  const [client] = await sql`
    SELECT c.*, p.name AS plan_name, p.sessions_included, p.validity_days
    FROM clients c LEFT JOIN service_plans p ON p.id = c.plan_id WHERE c.portal_user_id = ${userId}
  `;
  return client;
}

app.get('/api/portal/summary', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser;
  if (auth.role !== 'client') return reply.code(403).send({ error: 'Acceso exclusivo para clientes' });
  const client = await portalClient(auth.sub); if (!client) return reply.code(404).send({ error: 'Portal de cliente no encontrado' });
  const [invoices, routines, sessions, busySlots, assessments, completions, exercises] = await Promise.all([
    sql`SELECT id, concept, amount, balance, currency, due_on, status, payment_method, invoice_number, issued_on FROM invoices WHERE client_id = ${client.id} ORDER BY COALESCE(issued_on, due_on) DESC LIMIT 60`,
    sql`SELECT ra.id AS assignment_id, ra.due_on, r.id, r.title, r.description, r.sessions_per_week, r.exercises FROM routine_assignments ra JOIN routines r ON r.id = ra.routine_id WHERE ra.client_id = ${client.id} AND ra.active = true AND (ra.ends_on IS NULL OR ra.ends_on >= current_date) ORDER BY ra.starts_on DESC`,
    sql`SELECT s.id, s.routine_id, s.starts_at, s.duration_minutes, s.mode, s.status, s.completion_percent, r.title AS routine_title FROM sessions s LEFT JOIN routines r ON r.id = s.routine_id WHERE s.client_id = ${client.id} AND s.starts_at >= now() - interval '1 year' ORDER BY s.starts_at`,
    sql`SELECT s.id, s.starts_at, s.duration_minutes, (s.client_id = ${client.id}) AS is_mine FROM sessions s JOIN clients c ON c.id = s.client_id WHERE c.owner_id = ${client.owner_id} AND s.status <> 'cancelled' AND s.starts_at BETWEEN now() - interval '60 days' AND now() + interval '90 days' ORDER BY s.starts_at`,
    sql`SELECT tested_at, values FROM inbody_assessments WHERE client_id = ${client.id} AND extraction_status = 'ready' ORDER BY tested_at`,
    sql`SELECT routine_id, completed_on, completion_percent FROM routine_completions WHERE client_id = ${client.id} AND completed_on >= current_date - interval '1 year' ORDER BY completed_on`,
    // El catálogo entero, no sólo lo asignado: la rutina guarda los ejercicios
    // como copia en JSON, y es por catalogId que el portal sabe cuáles tienen
    // video que mostrar. La URL firmada se pide aparte, al darle reproducir.
    sql`
      SELECT id, slug, name, english, section, level, machine, free_weight, cues,
             video_duration_seconds, (video_object_key IS NOT NULL) AS has_video
      FROM exercises WHERE owner_id = ${client.owner_id} AND archived = false
    `
  ]);
  const profile = {
    id: client.id, full_name: client.full_name, email: client.email, goal: client.goal, status: client.status,
    billing_model: client.billing_model, standard_price: client.standard_price, billing_cutoff_day: client.billing_cutoff_day,
    plan_name: client.plan_name, sessions_included: client.sessions_included, validity_days: client.validity_days
  };
  const privateBusySlots = busySlots.map(slot => slot.is_mine
    ? { id: slot.id, starts_at: slot.starts_at, duration_minutes: slot.duration_minutes, is_mine: true }
    : { starts_at: slot.starts_at, duration_minutes: slot.duration_minutes, is_mine: false });
  return { client: profile, invoices, routines, sessions, busySlots: privateBusySlots, assessments, routineCompletions: completions, exercises };
});

const routineCompletionSchema = z.object({ routineId: z.string().uuid(), completedOn: z.string().date(), completionPercent: z.coerce.number().int().min(0).max(100), notes: z.string().max(300).optional() });
app.post('/api/portal/routine-completions', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser; if (auth.role !== 'client') return reply.code(403).send({ error: 'Acceso exclusivo para clientes' });
  const input = routineCompletionSchema.parse(request.body); const client = await portalClient(auth.sub); if (!client) return reply.code(404).send({ error: 'Portal de cliente no encontrado' });
  const [assignment] = await sql`SELECT id FROM routine_assignments WHERE routine_id = ${input.routineId} AND client_id = ${client.id} AND active = true`;
  if (!assignment) return reply.code(404).send({ error: 'La rutina no está asignada a este cliente' });
  const [completion] = await sql`
    INSERT INTO routine_completions (routine_id, client_id, completed_on, completion_percent, marked_by_user_id, notes)
    VALUES (${input.routineId}, ${client.id}, ${input.completedOn}, ${input.completionPercent}, ${auth.sub}, ${input.notes || null})
    ON CONFLICT (routine_id, client_id, completed_on) DO UPDATE SET completion_percent = EXCLUDED.completion_percent,
      marked_by_user_id = EXCLUDED.marked_by_user_id, notes = EXCLUDED.notes, updated_at = now()
    RETURNING *
  `;
  return reply.code(201).send(completion);
});

app.patch('/api/portal/sessions/:id/compliance', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser; if (auth.role !== 'client') return reply.code(403).send({ error: 'Acceso exclusivo para clientes' });
  const id = z.string().uuid().parse((request.params as { id: string }).id); const input = sessionComplianceSchema.parse(request.body);
  const client = await portalClient(auth.sub); if (!client) return reply.code(404).send({ error: 'Portal de cliente no encontrado' });
  const [owned] = await sql`SELECT id FROM sessions WHERE id = ${id} AND client_id = ${client.id}`; if (!owned) return reply.code(404).send({ error: 'Sesión no encontrada' });
  const session = await recordSessionCompliance(id, client.owner_id, auth.sub, input.outcome ?? (input.completed ? 'completed' : 'no_show'), input.completed ? input.completionPercent : 0);
  return session;
});

const documentKind = z.enum(['inbody', 'contract', 'receipt', 'progress_photo', 'other']);
const uploadSchema = z.object({
  clientId: z.string().uuid(),
  kind: documentKind,
  fileName: z.string().trim().min(1).max(180),
  contentType: z.enum(documentContentTypes),
  sizeBytes: z.coerce.number().int().positive().max(maxDocumentSize).optional()
});

function safeFileName(fileName: string) {
  const normalized = fileName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return normalized.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-120) || 'documento';
}

app.post('/api/documents/upload-url', { preHandler: requireStaff }, async (request, reply) => {
  if (!storageReady) return reply.code(503).send({ error: 'El almacenamiento de documentos aún no está configurado' });
  const auth = request.user as AuthUser;
  const input = uploadSchema.parse(request.body);
  const [client] = await sql`SELECT id FROM clients WHERE id = ${input.clientId} AND owner_id = ${auth.sub}`;
  if (!client) return reply.code(404).send({ error: 'Cliente no encontrado' });

  const objectKey = `clients/${input.clientId}/${input.kind}/${randomUUID()}-${safeFileName(input.fileName)}`;
  const [document] = await sql`
    INSERT INTO documents (client_id, kind, object_key, original_name, content_type, size_bytes)
    VALUES (${input.clientId}, ${input.kind}, ${objectKey}, ${input.fileName}, ${input.contentType}, ${input.sizeBytes || null})
    RETURNING id, client_id, kind, original_name, content_type, size_bytes, upload_status, created_at
  `;
  const uploadUrl = await createUploadUrl(objectKey, input.contentType);
  return reply.code(201).send({ document, uploadUrl, expiresInSeconds: 600 });
});

app.put('/api/documents/:id/content', { preHandler: requireStaff, bodyLimit: maxDocumentSize }, async (request, reply) => {
  if (!storageReady) return reply.code(503).send({ error: 'El almacenamiento de documentos aún no está configurado' });
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const contentType = z.enum(documentContentTypes).parse(String(request.headers['content-type'] || '').split(';')[0].trim());
  const body = request.body;
  if (!Buffer.isBuffer(body) || body.byteLength === 0) return reply.code(400).send({ error: 'El archivo está vacío' });

  const [document] = await sql`
    SELECT d.* FROM documents d JOIN clients c ON c.id = d.client_id
    WHERE d.id = ${id} AND c.owner_id = ${auth.sub}
  `;
  if (!document) return reply.code(404).send({ error: 'Documento no encontrado' });
  if (document.content_type !== contentType) return reply.code(400).send({ error: 'El tipo de archivo no coincide con el documento registrado' });

  const uploaded = await uploadObject(document.object_key, contentType, body);
  const [updated] = await sql`
    UPDATE documents SET upload_status = 'ready', size_bytes = ${uploaded.sizeBytes}, content_type = ${uploaded.contentType}
    WHERE id = ${id}
    RETURNING id, client_id, kind, original_name, content_type, size_bytes, upload_status, created_at
  `;
  return updated;
});

app.post('/api/documents/:id/complete', { preHandler: requireStaff }, async (request, reply) => {
  if (!storageReady) return reply.code(503).send({ error: 'El almacenamiento de documentos aún no está configurado' });
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [document] = await sql`
    SELECT d.* FROM documents d JOIN clients c ON c.id = d.client_id
    WHERE d.id = ${id} AND c.owner_id = ${auth.sub}
  `;
  if (!document) return reply.code(404).send({ error: 'Documento no encontrado' });

  try {
    const uploaded = await verifyUpload(document.object_key);
    const [updated] = await sql`
      UPDATE documents SET upload_status = 'ready',
        size_bytes = COALESCE(${uploaded.sizeBytes || null}, size_bytes),
        content_type = COALESCE(${uploaded.contentType || null}, content_type)
      WHERE id = ${id}
      RETURNING id, client_id, kind, original_name, content_type, size_bytes, upload_status, created_at
    `;
    return updated;
  } catch (error) {
    request.log.warn({ err: error, documentId: id }, 'No se encontró el archivo cargado en R2');
    return reply.code(409).send({ error: 'La carga todavía no aparece en el almacenamiento' });
  }
});

app.get('/api/documents', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const query = z.object({ clientId: z.string().uuid().optional() }).parse(request.query);
  return sql`
    SELECT d.id, d.client_id, d.kind, d.original_name, d.content_type, d.size_bytes, d.upload_status, d.created_at, c.full_name
    FROM documents d JOIN clients c ON c.id = d.client_id
    WHERE c.owner_id = ${auth.sub} AND (${query.clientId || null}::uuid IS NULL OR d.client_id = ${query.clientId || null})
    ORDER BY d.created_at DESC
  `;
});

app.get('/api/documents/:id/download-url', { preHandler: requireStaff }, async (request, reply) => {
  if (!storageReady) return reply.code(503).send({ error: 'El almacenamiento de documentos aún no está configurado' });
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [document] = await sql`
    SELECT d.id, d.object_key, d.original_name, d.upload_status
    FROM documents d JOIN clients c ON c.id = d.client_id
    WHERE d.id = ${id} AND c.owner_id = ${auth.sub}
  `;
  if (!document) return reply.code(404).send({ error: 'Documento no encontrado' });
  if (document.upload_status !== 'ready') return reply.code(409).send({ error: 'El documento todavía no está disponible' });
  return { documentId: document.id, fileName: document.original_name, downloadUrl: await createDownloadUrl(document.object_key), expiresInSeconds: 300 };
});

app.delete('/api/documents/:id', { preHandler: requireStaff }, async (request, reply) => {
  if (!storageReady) return reply.code(503).send({ error: 'El almacenamiento de documentos aún no está configurado' });
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [document] = await sql`
    SELECT d.id, d.object_key, d.original_name
    FROM documents d JOIN clients c ON c.id = d.client_id
    WHERE d.id = ${id} AND c.owner_id = ${auth.sub}
  `;
  if (!document) return reply.code(404).send({ error: 'Documento no encontrado' });
  await deleteObject(document.object_key);
  const removedAssessments = await sql.begin(async transaction => {
    const assessments = await transaction`DELETE FROM inbody_assessments WHERE document_id = ${id} RETURNING id`;
    await transaction`DELETE FROM documents WHERE id = ${id}`;
    return assessments.length;
  });
  return { deleted: true, document: { id: document.id, originalName: document.original_name }, removedAssessments };
});

const inbodySchema = z.object({ clientId: z.string().uuid(), documentId: z.string().uuid().optional(), deviceModel: z.string().optional(), testedAt: z.string().datetime({ offset: true }), values: z.record(z.string(), z.union([z.number(), z.string(), z.null()])), confidence: z.record(z.string(), z.number()).default({}), extractionStatus: z.enum(['pending', 'processing', 'ready', 'review', 'failed']).default('ready') });
app.get('/api/clients/:clientId/inbody', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const clientId = z.string().uuid().parse((request.params as { clientId: string }).clientId);
  const [client] = await sql`SELECT id FROM clients WHERE id = ${clientId} AND owner_id = ${auth.sub}`; if (!client) return reply.code(404).send({ error: 'Cliente no encontrado' });
  const assessments = await sql`SELECT * FROM inbody_assessments WHERE client_id = ${clientId} ORDER BY tested_at`;
  const numericKeys = ['weightKg', 'skeletalMuscleMassKg', 'bodyFatMassKg', 'percentBodyFat', 'bmi', 'visceralFatLevel', 'ecwRatio', 'inBodyScore'];
  const withChanges = assessments.map((assessment, index) => {
    const previous = assessments[index - 1]; const changes: Record<string, number> = {};
    if (previous) for (const key of numericKeys) { const currentValue = Number(assessment.values[key]); const previousValue = Number(previous.values[key]); if (Number.isFinite(currentValue) && Number.isFinite(previousValue)) changes[key] = Number((currentValue - previousValue).toFixed(3)); }
    return { ...assessment, changes };
  });
  return { assessments: withChanges };
});
app.post('/api/inbody', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const input = inbodySchema.parse(request.body);
  const [assessment] = await sql`INSERT INTO inbody_assessments (client_id, document_id, device_model, tested_at, values, confidence, extraction_status) SELECT c.id, ${input.documentId || null}, ${input.deviceModel || null}, ${input.testedAt}, ${sql.json(input.values)}, ${sql.json(input.confidence)}, ${input.extractionStatus} FROM clients c WHERE c.id = ${input.clientId} AND c.owner_id = ${auth.sub} RETURNING *`;
  if (!assessment) return reply.code(404).send({ error: 'Cliente no encontrado' }); return reply.code(201).send(assessment);
});

const analyzeInBodySchema = z.object({
  clientId: z.string().uuid(),
  documentIds: z.array(z.string().uuid()).min(1).max(10)
});

const inbodyPageNeedsAi = (name: string, contentType: string) => {
  if (contentType === 'application/pdf') return true;
  if (/result[\s_-]*interpretation/i.test(name)) return false;
  const historyPage = name.match(/body[\s_-]*history[\s_-]*(\d+)/i);
  return !historyPage || Number(historyPage[1]) < 2;
};
app.post('/api/inbody/analyze', { preHandler: requireStaff }, async (request, reply) => {
  if (!inbodyAnalysisReady) return reply.code(503).send({
    error: 'El análisis automático aún no está configurado',
    setup: inbodyAnalysisSetup
  });
  const auth = request.user as AuthUser; const input = analyzeInBodySchema.parse(request.body);
  const documents = await sql`
    SELECT d.* FROM documents d JOIN clients c ON c.id = d.client_id
    WHERE c.owner_id = ${auth.sub} AND d.client_id = ${input.clientId}
      AND d.kind = 'inbody' AND d.upload_status = 'ready' AND d.id = ANY(${input.documentIds}::uuid[])
    ORDER BY d.created_at
  `;
  if (documents.length !== input.documentIds.length) return reply.code(404).send({ error: 'Uno o más reportes no están disponibles' });
  const analysisDocuments = documents.filter(document => inbodyPageNeedsAi(document.original_name, document.content_type));
  const skippedPages = documents.filter(document => !inbodyPageNeedsAi(document.original_name, document.content_type)).map(document => document.original_name);
  if (!analysisDocuments.length) return reply.code(422).send({ error: 'Selecciona la hoja principal o una página BodyHistory 0/1 para analizar' });

  const merged = new Map<string, { documentId: string; deviceModel: string | null; values: Record<string, number>; confidence: Record<string, number>; warnings: string[] }>();
  const pageErrors: string[] = [];
  for (const document of analysisDocuments) {
    try {
      const raw = document.content_type === 'application/pdf'
        ? await (async () => { const file = await downloadObject(document.object_key); return extractInBodyDocument(file.body, document.original_name, document.content_type); })()
        : await (async () => { const file = await downloadObject(document.object_key); return extractInBodyImage(await prepareInBodyImage(file.body, document.original_name), document.original_name); })();
      const extracted = validateExtraction(raw, document.original_name);
      for (const measurement of extracted.measurements) {
        const current = merged.get(measurement.testedAt);
        merged.set(measurement.testedAt, {
          documentId: document.id,
          deviceModel: extracted.deviceModel || current?.deviceModel || null,
          values: { ...(current?.values || {}), ...measurement.values },
          confidence: { ...(current?.confidence || {}), ...measurement.confidence },
          warnings: [...new Set([...(current?.warnings || []), ...measurement.warnings])]
        });
      }
    } catch (error) {
      request.log.warn({ err: error, documentId: document.id }, 'Falló la extracción del reporte InBody');
      pageErrors.push(`${document.original_name}: ${(error as Error).message}`);
    }
  }
  if (!merged.size) return reply.code(422).send({ error: pageErrors[0] || 'No se encontraron métricas InBody en los archivos' });
  for (const measurement of merged.values()) {
    measurement.warnings = [...new Set([...measurement.warnings, ...validateInBodyValues(measurement.values)])];
  }

  const assessments = await sql.begin(async transaction => {
    const saved = [];
    for (const [testedAt, measurement] of [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [assessment] = await transaction`
        INSERT INTO inbody_assessments (client_id, document_id, device_model, tested_at, values, confidence, extraction_status, review_notes)
        VALUES (${input.clientId}, ${measurement.documentId}, ${measurement.deviceModel}, ${testedAt}, ${transaction.json(measurement.values)}, ${transaction.json(measurement.confidence)}, 'review', ${transaction.json(measurement.warnings)})
        ON CONFLICT (client_id, tested_at) DO UPDATE SET
          document_id = EXCLUDED.document_id,
          device_model = COALESCE(EXCLUDED.device_model, inbody_assessments.device_model),
          values = EXCLUDED.values,
          confidence = EXCLUDED.confidence,
          extraction_status = 'review',
          review_notes = EXCLUDED.review_notes
        RETURNING *
      `;
      saved.push(assessment);
    }
    return saved;
  });
  return { assessments, pageErrors, skippedPages, requiresReview: true };
});

const reviewInBodySchema = z.object({
  testedAt: z.string().datetime({ offset: true }),
  values: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  extractionStatus: z.enum(['ready', 'review']).default('ready')
});

app.patch('/api/inbody/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = reviewInBodySchema.parse(request.body);
  const [assessment] = await sql`
    UPDATE inbody_assessments a SET tested_at = ${input.testedAt}, values = ${sql.json(input.values)},
      extraction_status = ${input.extractionStatus}, review_notes = '[]'::jsonb
    FROM clients c WHERE a.id = ${id} AND c.id = a.client_id AND c.owner_id = ${auth.sub}
    RETURNING a.*
  `;
  if (!assessment) return reply.code(404).send({ error: 'Evaluación InBody no encontrada' });
  return assessment;
});

app.delete('/api/inbody/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [assessment] = await sql`
    DELETE FROM inbody_assessments a
    USING clients c
    WHERE a.id = ${id} AND c.id = a.client_id AND c.owner_id = ${auth.sub}
    RETURNING a.id, a.document_id
  `;
  if (!assessment) return reply.code(404).send({ error: 'Evaluación InBody no encontrada' });
  return { deleted: true, assessment };
});

async function ownedClient(clientId: string, ownerId: string) {
  const [client] = await sql`SELECT id, billing_model, monthly_session_target FROM clients WHERE id = ${clientId} AND owner_id = ${ownerId}`;
  return client;
}

// Cumplimiento de asistencia mensual contra el paquete contratado.
app.get('/api/clients/:clientId/attendance', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const clientId = z.string().uuid().parse((request.params as { clientId: string }).clientId);
  const months = z.coerce.number().int().min(1).max(24).default(6).parse((request.query as { months?: string }).months ?? 6);
  const client = await ownedClient(clientId, auth.sub);
  if (!client) return reply.code(404).send({ error: 'Cliente no encontrado' });

  const [monthly, packages, cadence] = await Promise.all([
    sql`
      SELECT to_char(date_trunc('month', starts_at), 'YYYY-MM') AS month,
             count(*)::int AS booked,
             count(*) FILTER (WHERE status = 'completed')::int AS completed,
             count(*) FILTER (WHERE status = 'no_show')::int AS no_show,
             count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
             count(*) FILTER (WHERE status = 'scheduled')::int AS scheduled
      FROM sessions
      WHERE client_id = ${clientId}
        AND starts_at >= date_trunc('month', current_date) - make_interval(months => ${months - 1})
      GROUP BY 1
    `,
    sql`
      SELECT id, label, total_sessions, used_sessions, status, purchased_on, expires_on
      FROM session_packages WHERE client_id = ${clientId} ORDER BY purchased_on
    `,
    sql`
      SELECT r.sessions_per_week
      FROM routine_assignments a JOIN routines r ON r.id = a.routine_id
      WHERE a.client_id = ${clientId} AND a.active = true
      ORDER BY a.starts_on DESC LIMIT 1
    `
  ]);

  const byMonth = new Map(monthly.map(row => [row.month as string, row]));
  const packageRows = packages as unknown as Array<{ id: string; label: string; total_sessions: number; used_sessions: number; status: string; purchased_on: string; expires_on: string | null }>;
  const sessionsPerWeek = Number(cadence[0]?.sessions_per_week) || null;

  // Precedencia de la meta mensual:
  //   1. La pactada en la ficha del cliente, si la hay. Manda sobre todo
  //      porque es lo que la entrenadora acordó, y es lo único que cubre a los
  //      clientes de mensualidad, que no tienen paquete ni siempre rutina.
  //   2. El paquete: su total repartido entre los meses que cubre. Sin fecha
  //      de vencimiento no hay ritmo pactado y no sirve.
  //   3. La cadencia de la rutina activa.
  // Si no hay ninguna, no se inventa una meta: el mes queda sin referencia y
  // la interfaz lo dice.
  const clientTarget = Number(client.monthly_session_target) || null;
  function expectedFor(monthKey: string) {
    if (clientTarget) return { expected: clientTarget, basis: 'client' as const, packageLabel: null };
    const monthStart = new Date(`${monthKey}-01T00:00:00Z`);
    const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0));
    const covering = packageRows.find(row => {
      const from = new Date(`${row.purchased_on}T00:00:00Z`);
      const to = row.expires_on ? new Date(`${row.expires_on}T00:00:00Z`) : null;
      return from <= monthEnd && (!to || to >= monthStart);
    });
    if (covering?.expires_on) {
      const from = new Date(`${covering.purchased_on}T00:00:00Z`);
      const to = new Date(`${covering.expires_on}T00:00:00Z`);
      const span = Math.max(1, (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) + 1);
      return { expected: Math.round(covering.total_sessions / span), basis: 'package' as const, packageLabel: covering.label };
    }
    if (sessionsPerWeek) {
      const daysInMonth = monthEnd.getUTCDate();
      return { expected: Math.round(sessionsPerWeek * (daysInMonth / 7)), basis: 'routine' as const, packageLabel: null };
    }
    return { expected: null, basis: 'none' as const, packageLabel: covering?.label ?? null };
  }

  const today = new Date();
  const timeline = Array.from({ length: months }, (_, index) => {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (months - 1 - index), 1));
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const row = byMonth.get(month);
    const completed = Number(row?.completed ?? 0);
    const noShow = Number(row?.no_show ?? 0);
    const cancelled = Number(row?.cancelled ?? 0);
    const held = completed + noShow;
    const { expected, basis, packageLabel } = expectedFor(month);
    return {
      month,
      booked: Number(row?.booked ?? 0),
      completed,
      noShow,
      cancelled,
      scheduled: Number(row?.scheduled ?? 0),
      expected,
      basis,
      packageLabel,
      // Asistencia: de las sesiones que llegaron a su fecha, cuántas se cumplieron.
      attendanceRate: held ? Number((completed / held).toFixed(3)) : null,
      // Cumplimiento: cuánto de lo pactado se ejecutó de verdad.
      complianceRate: expected ? Number((completed / expected).toFixed(3)) : null
    };
  });

  return { timeline, packages: packageRows, sessionsPerWeek, billingModel: client.billing_model, monthlySessionTarget: clientTarget };
});

const conditionSchema = z.object({
  kind: z.enum(['injury', 'condition']).default('injury'),
  title: z.string().trim().min(1).max(160),
  bodyArea: z.string().trim().max(120).optional().nullable(),
  severity: z.enum(['mild', 'moderate', 'severe']).default('moderate'),
  status: z.enum(['active', 'monitoring', 'recovered']).default('active'),
  startedOn: z.string().date().optional().nullable(),
  resolvedOn: z.string().date().optional().nullable(),
  restrictions: z.string().trim().max(1000).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable()
});

app.get('/api/clients/:clientId/conditions', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const clientId = z.string().uuid().parse((request.params as { clientId: string }).clientId);
  if (!(await ownedClient(clientId, auth.sub))) return reply.code(404).send({ error: 'Cliente no encontrado' });
  return sql`
    SELECT * FROM client_conditions WHERE client_id = ${clientId}
    ORDER BY (status = 'recovered'), started_on DESC NULLS LAST, created_at DESC
  `;
});

app.post('/api/clients/:clientId/conditions', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const clientId = z.string().uuid().parse((request.params as { clientId: string }).clientId);
  if (!(await ownedClient(clientId, auth.sub))) return reply.code(404).send({ error: 'Cliente no encontrado' });
  const input = conditionSchema.parse(request.body);
  const [condition] = await sql`
    INSERT INTO client_conditions (client_id, kind, title, body_area, severity, status, started_on, resolved_on, restrictions, notes)
    VALUES (${clientId}, ${input.kind}, ${input.title}, ${input.bodyArea || null}, ${input.severity}, ${input.status},
            ${input.startedOn || null}, ${input.resolvedOn || null}, ${input.restrictions || null}, ${input.notes || null})
    RETURNING *
  `;
  return reply.code(201).send(condition);
});

app.patch('/api/conditions/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = conditionSchema.partial().parse(request.body);
  // Sin join a clients: la pertenencia se comprueba con una subconsulta. Un
  // FROM clients aquí vuelve ambiguas status, notes, created_at y updated_at,
  // que existen en las dos tablas, y Postgres rechaza la sentencia entera.
  const [condition] = await sql`
    UPDATE client_conditions SET
      kind = COALESCE(${input.kind ?? null}, kind),
      title = COALESCE(${input.title ?? null}, title),
      body_area = COALESCE(${input.bodyArea ?? null}, body_area),
      severity = COALESCE(${input.severity ?? null}, severity),
      status = COALESCE(${input.status ?? null}, status),
      started_on = COALESCE(${input.startedOn ?? null}::date, started_on),
      resolved_on = COALESCE(${input.resolvedOn ?? null}::date, resolved_on),
      restrictions = COALESCE(${input.restrictions ?? null}, restrictions),
      notes = COALESCE(${input.notes ?? null}, notes),
      updated_at = now()
    WHERE id = ${id} AND client_id IN (SELECT id FROM clients WHERE owner_id = ${auth.sub})
    RETURNING *
  `;
  if (!condition) return reply.code(404).send({ error: 'Registro no encontrado' });
  return condition;
});

app.delete('/api/conditions/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [condition] = await sql`
    DELETE FROM client_conditions USING clients c
    WHERE client_conditions.id = ${id} AND c.id = client_conditions.client_id AND c.owner_id = ${auth.sub}
    RETURNING client_conditions.id
  `;
  if (!condition) return reply.code(404).send({ error: 'Registro no encontrado' });
  return { deleted: true };
});

const progressPhotoSchema = z.object({
  documentId: z.string().uuid(),
  takenOn: z.string().date().optional(),
  pose: z.enum(['front', 'side', 'back', 'other']).default('front'),
  notes: z.string().trim().max(500).optional().nullable()
});

app.get('/api/clients/:clientId/progress-photos', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const clientId = z.string().uuid().parse((request.params as { clientId: string }).clientId);
  if (!(await ownedClient(clientId, auth.sub))) return reply.code(404).send({ error: 'Cliente no encontrado' });
  // El InBody más cercano se resuelve al leer, no al guardar: cuando entra una
  // medición nueva, las fotos ya guardadas se re-emparejan solas con ella.
  const photos = await sql`
    SELECT p.id, p.taken_on, p.pose, p.notes, p.created_at,
           d.id AS document_id, d.original_name, d.content_type, d.upload_status, d.object_key,
           (
             SELECT json_build_object('id', a.id, 'testedAt', a.tested_at, 'values', a.values,
                                      'daysApart', abs(a.tested_at::date - p.taken_on))
             FROM inbody_assessments a
             WHERE a.client_id = p.client_id AND a.extraction_status <> 'failed'
             ORDER BY abs(a.tested_at::date - p.taken_on)
             LIMIT 1
           ) AS nearest_inbody
    FROM progress_photos p JOIN documents d ON d.id = p.document_id
    WHERE p.client_id = ${clientId}
    ORDER BY p.taken_on DESC, p.created_at DESC
  `;
  return Promise.all(photos.map(async photo => {
    const { object_key: objectKey, ...rest } = photo;
    return { ...rest, viewUrl: storageReady && photo.upload_status === 'ready' ? await createDownloadUrl(objectKey) : null };
  }));
});

app.post('/api/clients/:clientId/progress-photos', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const clientId = z.string().uuid().parse((request.params as { clientId: string }).clientId);
  const input = progressPhotoSchema.parse(request.body);
  const [document] = await sql`
    SELECT d.id, d.kind FROM documents d JOIN clients c ON c.id = d.client_id
    WHERE d.id = ${input.documentId} AND d.client_id = ${clientId} AND c.owner_id = ${auth.sub}
  `;
  if (!document) return reply.code(404).send({ error: 'Archivo no encontrado en el expediente' });
  if (document.kind !== 'progress_photo') return reply.code(400).send({ error: 'El archivo no está registrado como foto de progreso' });
  const [photo] = await sql`
    INSERT INTO progress_photos (client_id, document_id, taken_on, pose, notes)
    VALUES (${clientId}, ${input.documentId}, COALESCE(${input.takenOn || null}::date, current_date), ${input.pose}, ${input.notes || null})
    ON CONFLICT (document_id) DO UPDATE SET taken_on = EXCLUDED.taken_on, pose = EXCLUDED.pose, notes = EXCLUDED.notes
    RETURNING *
  `;
  return reply.code(201).send(photo);
});

app.delete('/api/progress-photos/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [photo] = await sql`
    DELETE FROM progress_photos USING clients c
    WHERE progress_photos.id = ${id} AND c.id = progress_photos.client_id AND c.owner_id = ${auth.sub}
    RETURNING progress_photos.id, progress_photos.document_id
  `;
  if (!photo) return reply.code(404).send({ error: 'Foto no encontrada' });
  return { deleted: true, documentId: photo.document_id };
});

const firstReminderRun = setTimeout(() => dispatchReminders().catch(error => app.log.error(error)), 10_000);
const reminderInterval = setInterval(() => dispatchReminders().catch(error => app.log.error(error)), config.REMINDER_INTERVAL_MINUTES * 60_000);
const firstBillingRun = setTimeout(() => generateRecurringInvoices().catch(error => app.log.error(error)), 15_000);
const billingInterval = setInterval(() => generateRecurringInvoices().catch(error => app.log.error(error)), config.BILLING_INTERVAL_MINUTES * 60_000);
// Los intentos de acceso viejos no sirven para nada pasada la ventana; se
// barren una vez al día para que la tabla no crezca sin fin.
const purgaIntentos = setInterval(() => purgarIntentos().catch(error => app.log.error(error)), 24 * 60 * 60_000);
purgaIntentos.unref();
// Mantiene creadas las sesiones de los horarios fijos. Corre cada seis horas:
// el horizonte es de ocho semanas, así que no hay ninguna prisa, y si el
// servicio estuvo caído un rato se pone al día en el siguiente ciclo.
const primeraExtension = setTimeout(() => extenderRecurrencias().catch(error => app.log.error(error)), 20_000);
const extensionRecurrencias = setInterval(() => extenderRecurrencias().catch(error => app.log.error(error)), 6 * 60 * 60_000);
primeraExtension.unref();
extensionRecurrencias.unref();
firstReminderRun.unref();
reminderInterval.unref();
firstBillingRun.unref();
billingInterval.unref();

app.addHook('onClose', async () => {
  clearTimeout(firstReminderRun);
  clearInterval(reminderInterval);
  clearTimeout(firstBillingRun);
  clearInterval(billingInterval);
  await sql.end();
});
await app.listen({ port: config.PORT, host: '::' });
