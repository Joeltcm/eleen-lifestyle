import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import webpush from 'web-push';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import type { Fragment, TransactionSql } from 'postgres';
import { sql } from './db.js';
import { createDownloadUrl, createUploadUrl, deleteObject, downloadObject, storageReady, uploadObject, verifyUpload } from './storage.js';
import { extractInBodyDocument, extractInBodyImage, inbodyAnalysisReady, inbodyAnalysisSetup, prepareInBodyImage, validateExtraction, validateInBodyValues } from './inbody-analysis.js';
import { registerZohoRoutes } from './zoho-routes.js';
import { cancelSessionInGoogle, registerGoogleCalendarRoutes, removeSessionFromGoogle, syncSessionToGoogle } from './google-calendar.js';
import { moveSessionInTransaction } from './session-reschedule.js';
import { complianceCompletionExpression, complianceSessionCondition } from './compliance.js';
import { routineSuggestionsReady, suggestRoutine } from './routine-suggestions.js';
import { accountStatementPdf, accountsReceivablePdf, billingInvoicePdf, compliancePdf, invoicePdf, monthlyFinancePdf } from './billing-reports.js';
import { fechaDeNegocioPanama, fechaPanamaDiasAtras } from './panama-date.js';
import { resolveBillingEngine } from './billing-engine.js';
import { planBillingGeneration, runBillingGeneration, shiftCutAfterPause } from './billing-generator.js';
import { DEFAULT_IMPORT_MANIFEST, applyBatch, approveBatch, createPreviewBatch, getBatch, listBatches, reverseBatch, type ImportManifest } from './billing-import.js';

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

// Estado operativo de la facturación: qué generador puede escribir (1B-0).
const billingEngine = resolveBillingEngine({ legacy: config.LEGACY_BILLING_GENERATION, next: config.NEW_BILLING_GENERATION });

// Todas las rutas que pueden abrir o consumir un saldo mensual toman el mismo
// lock transaccional por cliente. El índice único de facturas no protege
// session_packages, y un lock sólo en memoria no coordina procesos distintos.
async function lockBillingClient(transaction: TransactionSql, clientId: string) {
  await transaction`SELECT pg_advisory_xact_lock(hashtext('eileen:billing'), hashtext(${clientId}))`;
}

// Al mover el corte, sólo las facturas automáticas futuras y pendientes siguen
// siendo editables. El historial confirmado, vencido o externo conserva su
// fecha original; si el nuevo día ya pasó este mes, la próxima generación toma
// el ciclo siguiente con el nuevo corte.
async function actualizarFacturasFuturasPorCorte(transaction: TransactionSql, clientId: string, cutoffDay: number) {
  await transaction`
    WITH futuras AS (
      SELECT i.id,
        make_date(
          extract(year FROM COALESCE(i.billing_period, i.due_on))::integer,
          extract(month FROM COALESCE(i.billing_period, i.due_on))::integer,
          least(
            ${cutoffDay}::integer,
            extract(day FROM (
              date_trunc('month', COALESCE(i.billing_period, i.due_on))
              + interval '1 month - 1 day'
            ))::integer
          )
        )::date AS nuevo_due_on
      FROM invoices i
      WHERE COALESCE(i.billed_for_client_id, i.client_id) = ${clientId}
        AND i.auto_generated = true
        AND i.source_system IS NULL
        AND i.status = 'pending'
        AND i.due_on >= current_date
    )
    UPDATE invoices i
    SET due_on = futuras.nuevo_due_on
    FROM futuras
    WHERE i.id = futuras.id AND futuras.nuevo_due_on >= current_date
  `;
}

function sessionStateConflict(message: string): never {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 409;
  throw error;
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
      count(*) FILTER (WHERE billing_period = date_trunc('month', current_date)::date AND due_on <= current_date AND NOT has_invoice)::integer AS ready_to_generate,
      min(due_on) FILTER (WHERE due_on >= current_date) AS next_due_on
    FROM covered
  `;
  return {
    automatic: !zohoConnection,
    blockedByZoho: Boolean(zohoConnection),
    zohoStatus: zohoConnection?.status || null,
    daysAhead: 0,
    activeClients: Number(summary?.active_clients || 0),
    currentPeriodInvoices: Number(summary?.current_period_invoices || 0),
    readyToGenerate: Number(summary?.ready_to_generate || 0),
    nextDueOn: summary?.next_due_on || null
  };
}

// El día de emisión no debe adelantar el ciclo: una factura automática se
// emite el día del corte. La reparación corrige sólo due_on de facturas locales
// automáticas; no cambia emisión, monto, estado ni pagos. Las manuales y las
// importadas de Zoho quedan fuera.
async function normalizarFechasFacturasAutomaticas(ownerId?: string) {
  const actualizadas = await sql`
    UPDATE invoices i
    SET due_on = make_date(
      extract(year FROM COALESCE(i.billing_period, date_trunc('month', i.due_on)::date))::integer,
      extract(month FROM COALESCE(i.billing_period, date_trunc('month', i.due_on)::date))::integer,
      least(
        c.billing_cutoff_day,
        extract(day FROM (COALESCE(i.billing_period, date_trunc('month', i.due_on)::date) + interval '1 month - 1 day'))::integer
      )
    )
    FROM clients c
    WHERE c.id = COALESCE(i.billed_for_client_id, i.client_id)
      AND (${ownerId || null}::uuid IS NULL OR c.owner_id = ${ownerId || null}::uuid)
      AND i.auto_generated = true
      AND i.source_system IS NULL
      AND i.status <> 'void'
      AND i.due_on IS DISTINCT FROM make_date(
        extract(year FROM COALESCE(i.billing_period, date_trunc('month', i.due_on)::date))::integer,
        extract(month FROM COALESCE(i.billing_period, date_trunc('month', i.due_on)::date))::integer,
        least(
          c.billing_cutoff_day,
          extract(day FROM (COALESCE(i.billing_period, date_trunc('month', i.due_on)::date) + interval '1 month - 1 day'))::integer
        )
      )
      RETURNING i.id
  `;
  return actualizadas.length;
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
// consumieron dentro de su ciclo.
//
// El orden real de los hechos es ése: la clase se marca dada (o el cliente la
// cancela y la pierde) por la mañana y el saldo se abre después, al aplicar el
// pago o al renovar. En ese momento no había de dónde descontar, así que la
// sesión quedó sin cobrar a ningún saldo, y nada volvía a mirarla: el saldo
// nacía entero y esa clase no se le descontaba a nadie nunca.
//
// Cuentan tanto las clases DADAS como las que el cliente CANCELÓ y perdió sin
// pedir reprogramación, o que quedaron marcadas como NO CUMPLIDAS: una clase
// perdida por el cliente consume su cupo igual que una dada. Las que canceló
// la entrenadora, o las que se reprogramaron, no se descuentan (esas se reponen
// o se le devuelven al cliente).
//
// Esto no es tocar el pasado, que es lo que no se debe hacer con el dinero.
// Es al revés: la clase se consumió, y el saldo tiene que decir la verdad sobre
// lo que queda. Sólo alcanza a las de su propio ciclo, nunca a las de un mes ya
// cerrado, y nunca gasta más sesiones de las que el saldo tiene.
async function cobrarClasesYaDadas(
  transaction: TransactionSql | typeof sql,
  packageId: string,
  clientId: string,
  expiresOn: string,
  totalSessions: number
) {
  const [saldo] = await transaction`
    SELECT total_sessions, used_sessions FROM session_packages
    WHERE id = ${packageId} FOR UPDATE
  `;
  if (!saldo) return 0;
  const capacidad = Math.max(0, Number(saldo.total_sessions) - Number(saldo.used_sessions));
  const limite = Math.min(totalSessions, capacidad);
  if (limite <= 0) return 0;
  const pendientes = await transaction`
    SELECT id FROM sessions
    WHERE client_id = ${clientId} AND package_debited = false
      AND (
        status IN ('completed', 'no_show')
        OR (status = 'cancelled' AND cancellation_kind = 'not_rescheduled'
          AND COALESCE(cancelled_by, 'client') = 'client')
      )
      AND starts_at > (${expiresOn}::date - interval '1 month')
      AND starts_at < (${expiresOn}::date + interval '1 day')
    ORDER BY starts_at
    LIMIT ${limite}
    FOR UPDATE SKIP LOCKED
  `;
  if (!pendientes.length) return 0;
  const ids = pendientes.map(fila => fila.id as string);
  const cobradas = await transaction`
    UPDATE sessions SET package_id = ${packageId}, package_debited = true,
      debited_group_id = ${clientId}, updated_at = now()
    WHERE id IN ${transaction(ids)} AND package_debited = false
    RETURNING id
  `;
  if (!cobradas.length) return 0;
  await transaction`
    UPDATE session_packages
    SET used_sessions = used_sessions + ${cobradas.length},
      status = CASE WHEN used_sessions + ${cobradas.length} >= total_sessions THEN 'exhausted' ELSE 'active' END
    WHERE id = ${packageId}
  `;
  return cobradas.length;
}

type FacturaCredito = {
  id: string;
  client_id: string;
  billed_for_client_id: string | null;
  due_on: Date | string;
  status: string;
  amount: string | number;
  paid_amount: string | number;
  standard_price: string | number;
  credit_session_price: string | number | null;
  target_sessions: string | number;
  billing_cutoff_day: string | number;
};

// El no anticipado no cobra una bolsa fija: cobra las sesiones realmente
// impartidas durante el ciclo. Una cancelación del cliente sólo entra cuando
// Eileen la marca explícitamente como cobrable; no_show sigue afectando el
// cumplimiento, pero no crea un cargo automático. El corte sigue siendo la
// frontera —el pago no mueve las fechas— y el cliente puede seguir entrenando
// aunque la factura esté pendiente.
function cicloQueCierraEn(dueOn: Date | string, cutoffDay: number) {
  const referencia = mediodiaEnPanama(dueOn);
  referencia.setUTCDate(referencia.getUTCDate() - 1);
  return cicloDelCorte(referencia, cutoffDay);
}

function clasesCreditoLineItems(rows: Array<{ starts_at: Date | string; credit_charge: boolean }>, rate: number) {
  return rows.map(row => ({
    name: `${row.credit_charge ? 'Cancelación cobrada' : 'Sesión'} · ${new Intl.DateTimeFormat('es-PA', {
      day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Panama'
    }).format(new Date(row.starts_at))}`,
    quantity: 1,
    rate: Number(rate.toFixed(2)),
    item_total: Number(rate.toFixed(2))
  }));
}

async function calcularFacturaCredito(factura: FacturaCredito) {
  const base = Number(factura.credit_session_price || 25);
  const target = Number(factura.target_sessions);
  if (!(base > 0)) return null;
  const cycle = cicloQueCierraEn(factura.due_on, Number(factura.billing_cutoff_day) || 1);
  const sesiones = await sql`
    SELECT s.starts_at, s.credit_charge
    FROM sessions s
    WHERE s.client_id = ${factura.billed_for_client_id || factura.client_id}
      AND (s.starts_at AT TIME ZONE 'America/Panama')::date > ${cycle.inicio}::date
      AND (s.starts_at AT TIME ZONE 'America/Panama')::date <= ${cycle.vence}::date
      AND (s.status = 'completed'
        OR (s.status = 'cancelled' AND s.cancellation_kind = 'not_rescheduled'
          AND COALESCE(s.cancelled_by, 'client') = 'client' AND s.credit_charge = true))
    ORDER BY s.starts_at
  ` as unknown as Array<{ starts_at: Date | string; credit_charge: boolean }>;
  const billable = sesiones.length;
  const amount = Number((billable * base).toFixed(2));
  const paidAmount = Number(factura.paid_amount || 0);
  const lineItems = clasesCreditoLineItems(sesiones, base);
  const concept = `Sesiones a crédito · ${billable} clase${billable === 1 ? '' : 's'} · ${(soloFecha(factura.due_on) || '').slice(0, 7).replace('-', '/')}`;
  const status = amount === 0 || paidAmount >= amount - 0.01 ? 'confirmed' : 'pending';
  return { cycle, target, base, sesiones, billable, amount, paidAmount, lineItems, concept, status };
}

// X-019: el descuento por cancelación de la entrenadora vivía en billing_credits, que solo consume el sistema anterior. Fuera de legacy se rechaza con un aviso claro
// (en vez de dejar un descuento huérfano que el cliente nunca vería); reprogramar o cancelar "sin descuento" sigue funcionando.
const DESCUENTO_NO_DISPONIBLE = 'El descuento por clase cancelada por la entrenadora todavía no se aplica en la facturación nueva. Reprograma la clase o cancélala sin descuento.';
// Reescribe las facturas VIEJAS de crédito. Fuera del estado legacy (X-018) no debe tocar nada: la fuente de verdad es el módulo nuevo y el archivo queda intacto.
async function recalcularFacturasNoAnticipadas(ownerId?: string) {
  if (!billingEngine.legacyWrites) return 0;
  const facturas = await sql`
    SELECT i.id, i.client_id, i.billed_for_client_id, i.due_on, i.status, i.amount,
      COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id),
        CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END, 0)::numeric AS paid_amount,
      c.standard_price, c.credit_session_price, c.billing_cutoff_day,
      COALESCE(c.monthly_session_target, p.sessions_included, 0)::integer AS target_sessions
    FROM invoices i
    JOIN clients c ON c.id = COALESCE(i.billed_for_client_id, i.client_id)
    LEFT JOIN service_plans p ON p.id = c.plan_id
    WHERE c.payment_mode = 'no_anticipado' AND c.billing_model = 'monthly'
      AND i.status <> 'void' AND i.source_system IS NULL
      AND (i.auto_generated = true OR lower(i.concept) LIKE '%mensual%' OR lower(i.concept) LIKE '%sesiones a crédito%')
      AND (${ownerId || null}::uuid IS NULL OR c.owner_id = ${ownerId || null}::uuid)
  ` as unknown as FacturaCredito[];

  let updated = 0;
  for (const factura of facturas) {
    // Once a credit invoice has been paid and its cycle has closed, its amount
    // is an accounting record. A later calendar correction must not silently
    // rewrite what Eileen already collected; changing a closed invoice is an
    // explicit staff action, outside this automatic reconciliation.
    const cycle = cicloQueCierraEn(factura.due_on, Number(factura.billing_cutoff_day) || 1);
    if (factura.status === 'confirmed' && cycle.vence < diaEnPanama(new Date())) continue;
    const calculation = await calcularFacturaCredito(factura);
    if (!calculation) continue;
    const { billable, amount, paidAmount, lineItems, concept, target, base } = calculation;
    await sql.begin(async transaction => {
      await transaction`
        UPDATE invoices i SET amount = ${amount}, subtotal = ${amount},
          concept = ${concept}, line_items = ${transaction.json(lineItems)},
          balance = GREATEST(${amount}::numeric - ${paidAmount}::numeric, 0),
          status = CASE WHEN ${amount}::numeric = 0 OR ${paidAmount}::numeric >= ${amount}::numeric - 0.01
            THEN 'confirmed' ELSE 'pending' END
        WHERE i.id = ${factura.id} AND i.status <> 'void'
      `;
    });
    updated += 1;
    app.log.info({ invoiceId: factura.id, cycle, billable, target, rate: base, amount }, 'Factura de crédito recalculada');
  }
  return updated;
}

async function generateRecurringInvoices(ownerId?: string) {
  const selectedOwner = ownerId || null;
  const fechasCorregidas = await normalizarFechasFacturasAutomaticas(selectedOwner || undefined);
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
        c.owner_id, CASE WHEN c.payment_mode = 'no_anticipado' THEN 0 ELSE c.standard_price END AS amount,
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
      -- La factura nace el día del corte. Si el proceso no corrió ese día,
      -- puede recuperar el ciclo vigente después, conservando due_on en el
      -- día del corte; nunca se emite una mensualidad antes de tiempo.
      WHERE s.billing_period = date_trunc('month', current_date)::date
        AND s.due_on <= current_date
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
        --
        -- Se compara por el MES DEL COBRO ORIGEN de la cobertura, no por su
        -- etiqueta billing_period. Con corte tardío (25–28) la cobertura del
        -- cobro de agosto quedaba etiquetada "septiembre" (por el punto medio del
        -- ciclo) y bloqueaba el cobro NUEVO de septiembre, que es de otro ciclo.
        -- El día del cobro origen dice a qué ciclo pertenece de verdad.
        AND NOT EXISTS (
          SELECT 1 FROM invoice_coverage cov
          JOIN invoices ci ON ci.id = cov.invoice_id AND ci.status <> 'void'
          WHERE cov.client_id = s.billed_for_client_id
            AND date_trunc('month', ci.due_on)::date = s.billing_period
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
  const candidatosPendientes = await sql`
    SELECT * FROM (
      SELECT COALESCE(i.billed_for_client_id, i.client_id) AS entrena,
        i.id AS invoice_id, i.due_on, i.amount,
        COALESCE(i.billing_period, date_trunc('month', i.due_on)::date) AS billing_period,
        -- Las sesiones de la renovación salen de lo configurado en el perfil del
        -- cliente ("Sesiones esperadas al mes"): ajustarlo ahí manda de un mes al
        -- siguiente. Si no está puesto, del plan asignado; y de último, del
        -- saldo previo (para quien no tenga ni target ni plan).
        COALESCE(
          c.monthly_session_target,
          pl.sessions_included,
          (SELECT sp.total_sessions FROM session_packages sp
            WHERE sp.client_id = COALESCE(i.billed_for_client_id, i.client_id) AND sp.kind = 'monthly'
            ORDER BY sp.purchased_on DESC, sp.created_at DESC LIMIT 1)
        ) AS total_sessions,
        c.payment_mode, c.billing_cutoff_day AS corte
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
        -- descontar. Se procesan todos los cobros elegibles; la idempotencia
        -- se resuelve por invoice_id para no borrar saldos familiares válidos.
        AND i.due_on >= current_date
        AND c.payment_mode <> 'no_anticipado'
        AND (${selectedOwner}::uuid IS NULL OR c.owner_id = ${selectedOwner}::uuid)
    ) q
    WHERE q.total_sessions > 0
    ORDER BY entrena, due_on
  `;
  // Un cobro puede existir hasta siete días antes de su vencimiento, pero eso
  // no significa que el saldo deba nacer ya. El saldo abre cuando empieza el
  // ciclo que representa. Así Sally (corte 1), Sandy y Julio (corte 31) no
  // reciben el próximo ciclo mientras el vigente todavía está abierto; en el
  // propio día de corte no queda hueco, porque el inicio es inclusivo.
  const hoy = diaEnPanama(new Date());
  const pendientes = candidatosPendientes.filter(cobro => {
    const ciclo = cicloDelCorte(cobro.due_on as Date, Number(cobro.corte) || 1);
    return ciclo.inicio <= hoy;
  });
  for (const cobro of pendientes) {
    // El saldo del ciclo que EMPIEZA en el corte se abre para el flujo
    // anticipado: el cliente puede entrenar aunque todavía no haya pagado.
    // Los clientes a crédito no llegan a este conjunto: su factura se
    // recalcula con las sesiones reales y no tienen una bolsa anticipada.
    // El ciclo del saldo se ancla al DÍA DE CORTE del cliente con la MISMA
    // función que las demás rutas (cicloDelCorte, que clampa al último día del
    // mes). Es la única fuente de verdad del ciclo: sumar un mes sin clampar
    // desbordaba en cortes 30/31 hacia meses cortos (un corte 31 en enero vencía
    // el 3 de marzo en vez del 28 de febrero) y no coincidía con la asignación de
    // plan, la cobertura ni la confirmación de pago.
    const ciclo = cicloDelCorte(cobro.due_on as Date, Number(cobro.corte) || 1);
    await sql.begin(async transaction => {
      await lockBillingClient(transaction, cobro.entrena as string);
      // Idempotencia por cobro, no por cliente ni por ciclo: un mismo ciclo
      // puede tener más de un saldo legítimo (propio + familiar).
      const [yaProcesado] = await transaction`
        SELECT id FROM session_packages
        WHERE origin_invoice_id = ${cobro.invoice_id} AND status <> 'cancelled'
        LIMIT 1
      `;
      if (yaProcesado) return;
      // La asignación de un plan puede haber abierto ya este mismo ciclo sin
      // cobro de origen. En ese caso se reutiliza y se enlaza al cobro. Sólo
      // se considera el rango exacto del ciclo: un saldo de otro origen (por
      // ejemplo, otra línea familiar) sigue siendo paralelo y no se absorbe.
      const [saldoDelPlan] = await transaction`
        SELECT id FROM session_packages
        WHERE client_id = ${cobro.entrena} AND kind = 'monthly'
          AND purchased_on = ${ciclo.inicio}::date
          AND expires_on = ${ciclo.vence}::date
          AND origin_invoice_id IS NULL AND status = 'active'
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE
      `;
      if (saldoDelPlan) {
        await transaction`
          UPDATE session_packages SET origin_invoice_id = ${cobro.invoice_id}
          WHERE id = ${saldoDelPlan.id}
        `;
        return;
      } else {
        const [existente] = await transaction`
          SELECT id FROM session_packages
          WHERE client_id = ${cobro.entrena} AND kind = 'monthly'
            AND expires_on IS NOT NULL AND expires_on > ${soloFecha(cobro.due_on)}::date
            AND origin_invoice_id = ${cobro.invoice_id}
            AND status <> 'cancelled'
          LIMIT 1
        `;
        if (existente) return;
        const [abierto] = await transaction`
        INSERT INTO session_packages (client_id, label, total_sessions, amount, expires_on, kind, purchased_on, origin_invoice_id, status)
        VALUES (${cobro.entrena},
          ${'Mensualidad · ' + rangoDelCiclo(ciclo.inicio, ciclo.vence)},
          ${cobro.total_sessions}, ${cobro.amount}, ${ciclo.vence}::date, 'monthly', ${ciclo.inicio}::date,
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
          ${cobro.invoice_id}, 'active')
        RETURNING id
        `;
        await cobrarClasesYaDadas(transaction, abierto.id as string, cobro.entrena as string,
          ciclo.vence, Number(cobro.total_sessions));
      }
    });
  }
  const creditInvoicesRecalculated = await recalcularFacturasNoAnticipadas(selectedOwner || undefined);
  const descuentos = await aplicarCreditos(invoices as unknown as CobroGenerado[]);
  return { generated: invoices.length, balances: pendientes.length, reposiciones: 0, descuentos, creditInvoicesRecalculated, fechasCorregidas, invoices };
}

// Sistema anterior RETIRADO tras el corte (J-067): fuera del estado `legacy` (o `shadow`) las rutas que ESCRIBÍAN cobros, pagos y coberturas del sistema
// viejo responden 410 y no tocan nada; las lecturas (listados, PDF, archivo) siguen. Es reversible a propósito: si se vuelve a LEGACY_BILLING_GENERATION=on y
// NEW_BILLING_GENERATION=off, vuelven a funcionar. El código se borrará cuando la primera emisión automática del 15-10 salga bien.
// POST /api/packages y /api/packages/:id/renew crean factura y cobro heredados (X-018); las demás rutas de paquetes (reprogramar, editar, borrar) no facturan y siguen.
const legacyWritePaths = [/^\/api\/invoices(\/|$)/, /^\/api\/maintenance\/(reconcile-monthly-billing|cerrar-zoho-viejas)$/, /^\/api\/packages$/, /^\/api\/packages\/[^/]+\/renew$/];
app.addHook('onRequest', async (request, reply) => {
  if (billingEngine.legacyWrites || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const path = request.url.split('?')[0];
  if (!legacyWritePaths.some(pattern => pattern.test(path))) return;
  return reply.code(410).send({ error: 'Retirado: los cobros y facturas ahora se manejan en Facturas y Cobros. El sistema anterior es solo de consulta (Archivo).' });
});

app.get('/api/billing/recurring/status', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return recurringBillingStatus(auth.sub);
});

// ── Facturas del módulo nuevo (1B-2) ─────────────────────────────────────────
// Documento por cobrar con número FAC-, de un pagador y un ciclo, con una línea por
// beneficiario. Estas rutas NO leen ni escriben el sistema anterior (`invoices`), no
// abren saldos y no tocan el precio ni la membresía de ningún cliente. El dinero
// recibido (cobros) y su aplicación llegan en 1B-3.
const billingInvoiceKinds = ['mensual', 'credito', 'clase_suelta', 'paquete', 'manual'] as const;
const billingInvoiceLineInput = z.object({
  beneficiaryClientId: z.string().uuid(),
  description: z.string().trim().min(1).max(200).optional(),
  quantity: z.coerce.number().positive().max(1000).default(1),
  unitAmount: z.coerce.number().min(-100000).max(100000),
  planId: z.string().uuid().nullable().optional(),
  lineType: z.enum(['plan', 'sesion', 'ajuste']).default('plan'),
  sessionsReference: z.coerce.number().int().positive().max(1000).nullable().optional()
});
const billingInvoiceInput = z.object({
  payerClientId: z.string().uuid(),
  kind: z.enum(billingInvoiceKinds),
  cycleStart: z.string().date().optional(),
  cycleEnd: z.string().date().optional(),
  cycleDays: z.coerce.number().int().min(1).max(366).optional(),
  cutDay: z.coerce.number().int().min(1).max(31).optional(),
  issuedOn: z.string().date().optional(),
  dueOn: z.string().date().optional(),
  notes: z.string().trim().max(500).optional(),
  lines: z.array(billingInvoiceLineInput).min(1).max(30)
});
const billingInvoiceListQuery = z.object({
  status: z.enum(['all', 'activa', 'abierta', 'pendiente', 'parcial', 'pagada', 'anulada', 'vencida']).default('all'),
  kind: z.enum(billingInvoiceKinds).optional(),
  payerId: z.string().uuid().optional(),
  // Panel: cliente = pagador O beneficiario de alguna línea; mes = mes de emisión; corte = día de corte del pagador.
  clientId: z.string().uuid().optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  cutDay: z.coerce.number().int().min(1).max(31).optional(),
  details: z.enum(['1']).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200)
});

const centavos = (value: number) => Math.round(value * 100);
const desdeCentavos = (value: number) => value / 100;
const billingCode = (number: unknown) => `FAC-${String(number).padStart(4, '0')}`;

function sumarDias(fecha: string, dias: number): string {
  const base = new Date(`${fecha}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + dias);
  return base.toISOString().slice(0, 10);
}

function billingInvoiceValue(row: Record<string, any>, hoy: string) {
  const total = Number(row.total);
  const paid = Number(row.paid ?? 0);
  const balance = row.status === 'anulada' ? 0 : Math.max(0, desdeCentavos(centavos(total) - centavos(paid)));
  const overdue = (row.status === 'pendiente' || row.status === 'parcial') && String(row.due_on) < hoy && balance > 0;
  return {
    id: row.id, number: Number(row.number), code: billingCode(row.number),
    payerClientId: row.payer_client_id, payerName: row.payer_name,
    kind: row.kind, origin: row.origin, cycleStart: row.cycle_start, cycleEnd: row.cycle_end, cutDay: Number(row.cut_day),
    issuedOn: row.issued_on, dueOn: row.due_on, status: row.status, overdue,
    total, paid, balance, notes: row.notes ?? null,
    voidReason: row.void_reason ?? null, voidedAt: row.voided_at ?? null, createdAt: row.created_at
  };
}

const billingInvoiceColumns = `i.id, i.number, i.payer_client_id, i.kind, i.origin, i.cycle_start::text AS cycle_start,
  i.cycle_end::text AS cycle_end, i.cut_day, i.issued_on::text AS issued_on, i.due_on::text AS due_on, i.status, i.total,
  i.notes, i.void_reason, i.voided_at, i.created_at, p.full_name AS payer_name, p.email AS payer_email,
  COALESCE((SELECT sum(a.amount) FROM billing_payment_applications a WHERE a.invoice_id = i.id AND a.reversed_at IS NULL), 0) AS paid`;

async function auditBilling(transaction: TransactionSql, ownerId: string, userId: string | null, action: string, entity: string, entityId: string, detail: unknown) {
  await transaction`
    INSERT INTO billing_audit (owner_id, user_id, action, entity, entity_id, detail)
    VALUES (${ownerId}, ${userId}, ${action}, ${entity}, ${entityId}, ${transaction.json(detail as any)})
  `;
}

app.get('/api/billing/invoices', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const query = billingInvoiceListQuery.parse(request.query);
  const hoy = fechaDeNegocioPanama();
  const rows = await sql.unsafe(`
    SELECT ${billingInvoiceColumns}
    FROM billing_invoices i JOIN clients p ON p.id = i.payer_client_id
    WHERE i.owner_id = $1
      AND ($2::text = 'all' OR $2::text = 'vencida' OR ($2::text = 'activa' AND i.status <> 'anulada') OR ($2::text = 'abierta' AND i.status IN ('pendiente', 'parcial')) OR i.status = $2)
      AND ($3::text IS NULL OR i.kind = $3)
      AND ($4::uuid IS NULL OR i.payer_client_id = $4)
      AND ($5::date IS NULL OR i.issued_on >= $5)
      AND ($6::date IS NULL OR i.issued_on <= $6)
      AND ($8::text IS NULL OR to_char(i.issued_on, 'YYYY-MM') = $8)
      AND ($9::int IS NULL OR i.cut_day = $9)
      AND ($10::uuid IS NULL OR i.payer_client_id = $10 OR EXISTS (SELECT 1 FROM billing_invoice_lines l0 WHERE l0.invoice_id = i.id AND l0.beneficiary_client_id = $10))
    ORDER BY i.number DESC LIMIT $7`,
    [auth.sub, query.status, query.kind ?? null, query.payerId ?? null, query.from ?? null, query.to ?? null, query.limit, query.month ?? null, query.cutDay ?? null, query.clientId ?? null]
  ) as unknown as Record<string, any>[];
  let invoices: Record<string, any>[] = rows.map(row => billingInvoiceValue(row, hoy));
  if (query.status === 'vencida') invoices = invoices.filter(invoice => invoice.overdue);
  const open = invoices.filter(invoice => invoice.status !== 'anulada');
  const summary: Record<string, unknown> = {
    count: invoices.length,
    total: desdeCentavos(open.reduce((sum, invoice) => sum + centavos(invoice.total), 0)),
    balance: desdeCentavos(open.reduce((sum, invoice) => sum + centavos(invoice.balance), 0))
  };
  if (query.details !== '1') return { invoices, summary };

  // Panel: líneas y cobros aplicados de cada factura, totales y los meses/cortes que existen (sin filtros).
  const ids = invoices.map(invoice => invoice.id as string);
  const lineRows = ids.length ? await sql`
    SELECT l.invoice_id::text AS invoice_id, l.beneficiary_client_id::text AS beneficiary_id, c.full_name AS beneficiary_name, l.amount::text AS amount
    FROM billing_invoice_lines l JOIN clients c ON c.id = l.beneficiary_client_id
    WHERE l.invoice_id IN ${sql(ids)} ORDER BY c.full_name, l.line_type` : [];
  const paymentRows = ids.length ? await sql`
    SELECT a.invoice_id::text AS invoice_id, p.id::text AS payment_id, p.paid_on::text AS paid_on, p.method, a.amount::text AS amount
    FROM billing_payment_applications a JOIN billing_payments p ON p.id = a.payment_id
    WHERE a.invoice_id IN ${sql(ids)} AND a.reversed_at IS NULL ORDER BY p.paid_on, a.created_at` : [];
  const detailed: Record<string, any>[] = invoices.map(invoice => ({
    ...invoice,
    lines: lineRows.filter(row => row.invoice_id === invoice.id).map(row => ({ beneficiaryClientId: row.beneficiary_id as string, beneficiaryName: row.beneficiary_name as string, amount: Number(row.amount) })),
    payments: paymentRows.filter(row => row.invoice_id === invoice.id).map(row => ({ paymentId: row.payment_id as string, paidOn: row.paid_on as string, method: row.method as string, amount: Number(row.amount) }))
  }));
  const active = detailed.filter(invoice => invoice.status !== 'anulada');
  const applied: { paymentId: string }[] = active.flatMap(invoice => invoice.payments);
  const [meta] = await sql`
    SELECT COALESCE(array_agg(DISTINCT to_char(issued_on, 'YYYY-MM')), '{}') AS months, COALESCE(array_agg(DISTINCT cut_day), '{}') AS cut_days
    FROM billing_invoices WHERE owner_id = ${auth.sub} AND status <> 'anulada'`;
  return {
    invoices: detailed,
    summary: {
      ...summary,
      paid: desdeCentavos(active.reduce((sum, invoice) => sum + centavos(invoice.paid), 0)),
      paymentsCount: new Set(applied.map(item => item.paymentId)).size,
      paidCount: active.filter(invoice => invoice.status === 'pagada').length,
      pendingCount: active.filter(invoice => invoice.status === 'pendiente' || invoice.status === 'parcial').length,
      overdueCount: active.filter(invoice => invoice.overdue).length,
      overdueBalance: desdeCentavos(active.filter(invoice => invoice.overdue).reduce((sum, invoice) => sum + centavos(invoice.balance), 0))
    },
    meta: { months: (meta.months as string[]).slice().sort(), cutDays: (meta.cut_days as number[]).map(Number).sort((a, b) => a - b) }
  };
});

app.get('/api/billing/invoices/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [row] = await sql.unsafe(`
    SELECT ${billingInvoiceColumns} FROM billing_invoices i JOIN clients p ON p.id = i.payer_client_id
    WHERE i.id = $1 AND i.owner_id = $2`, [id, auth.sub]) as unknown as Record<string, any>[];
  if (!row) return reply.code(404).send({ error: 'Factura no encontrada' });
  const lines = await sql`
    SELECT l.id, l.beneficiary_client_id, c.full_name AS beneficiary_name, l.line_type, l.description,
      l.quantity, l.unit_amount, l.amount, l.sessions_reference
    FROM billing_invoice_lines l JOIN clients c ON c.id = l.beneficiary_client_id
    WHERE l.invoice_id = ${id} ORDER BY c.full_name, l.line_type
  `;
  const applications = await sql`
    SELECT a.id, a.amount, a.applied_on::text AS applied_on, a.reversed_at, a.reversal_reason,
      p.paid_on::text AS paid_on, p.method, p.reference
    FROM billing_payment_applications a JOIN billing_payments p ON p.id = a.payment_id
    WHERE a.invoice_id = ${id} ORDER BY a.created_at
  `;
  const audit = await sql`
    SELECT at, action, detail FROM billing_audit WHERE owner_id = ${auth.sub} AND entity = 'invoice' AND entity_id = ${id} ORDER BY at
  `;
  return {
    ...billingInvoiceValue(row, fechaDeNegocioPanama()),
    lines: lines.map(line => ({
      id: line.id, beneficiaryClientId: line.beneficiary_client_id, beneficiaryName: line.beneficiary_name,
      lineType: line.line_type, description: line.description, quantity: Number(line.quantity),
      unitAmount: Number(line.unit_amount), amount: Number(line.amount), sessionsReference: line.sessions_reference
    })),
    applications: applications.map(item => ({
      id: item.id, amount: Number(item.amount), appliedOn: item.applied_on, paidOn: item.paid_on, method: item.method,
      reference: item.reference, reversedAt: item.reversed_at, reversalReason: item.reversal_reason
    })),
    audit: audit.map(item => ({ at: item.at, action: item.action, detail: item.detail }))
  };
});

app.post('/api/billing/invoices', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const input = billingInvoiceInput.parse(request.body);
  const issuedOn = input.issuedOn ?? fechaDeNegocioPanama();
  const cycleStart = input.cycleStart ?? issuedOn;
  const puntual = input.kind === 'clase_suelta' || input.kind === 'manual';
  if (input.kind === 'paquete' && !input.cycleDays && !input.cycleEnd) {
    return reply.code(400).send({ error: 'Un paquete necesita los días del ciclo o su fecha final' });
  }

  // Todas las personas deben ser del mismo dueño (otro dueño recibe 404 como si no existiera).
  const ids = [...new Set([input.payerClientId, ...input.lines.map(line => line.beneficiaryClientId)])];
  const found = await sql`SELECT id, billing_cutoff_day FROM clients WHERE owner_id = ${auth.sub} AND id IN ${sql(ids)}`;
  if (found.length !== ids.length) return reply.code(404).send({ error: 'Cliente no encontrado' });
  const payer = found.find(client => client.id === input.payerClientId)!;

  const cutDay = input.cutDay ?? (Number(payer.billing_cutoff_day) || Number(cycleStart.slice(8, 10)));
  let cycleEnd = input.cycleEnd;
  if (!cycleEnd) {
    if (puntual) cycleEnd = cycleStart;
    else if (input.kind === 'paquete') cycleEnd = sumarDias(cycleStart, input.cycleDays!);
    else cycleEnd = corteSiguiente(mediodiaEnPanama(cycleStart), cutDay).toISOString().slice(0, 10);
  }
  if (cycleEnd < cycleStart) return reply.code(400).send({ error: 'El fin del ciclo no puede ser anterior a su inicio' });
  const dueOn = input.dueOn ?? issuedOn;

  const lines = input.lines.map(line => {
    const amount = desdeCentavos(centavos(line.quantity * line.unitAmount));
    if (line.lineType !== 'ajuste' && amount < 0) return null;
    return {
      beneficiaryClientId: line.beneficiaryClientId, planId: line.planId ?? null, lineType: line.lineType,
      description: line.description ?? (line.lineType === 'ajuste' ? 'Ajuste' : 'Plan'),
      quantity: line.quantity, unitAmount: line.unitAmount, amount, sessionsReference: line.sessionsReference ?? null
    };
  });
  if (lines.some(line => line === null)) return reply.code(400).send({ error: 'Solo los ajustes pueden tener un importe negativo' });
  const valid = lines as NonNullable<(typeof lines)[number]>[];
  const total = desdeCentavos(valid.reduce((sum, line) => sum + centavos(line.amount), 0));
  if (total < 0) return reply.code(400).send({ error: 'El total de la factura no puede ser negativo' });

  try {
    const created = await sql.begin(async transaction => {
      const [{ n }] = await transaction`SELECT billing_next_number(${auth.sub}) AS n`;
      const [invoice] = await transaction`
        INSERT INTO billing_invoices (owner_id, number, payer_client_id, kind, origin, cycle_start, cycle_end, cut_day,
          issued_on, due_on, total, notes, created_by)
        VALUES (${auth.sub}, ${n}, ${input.payerClientId}, ${input.kind}, 'manual', ${cycleStart}, ${cycleEnd}, ${cutDay},
          ${issuedOn}, ${dueOn}, ${total}, ${input.notes || null}, ${auth.sub})
        RETURNING id, number`;
      for (const line of valid) {
        await transaction`
          INSERT INTO billing_invoice_lines (invoice_id, beneficiary_client_id, plan_id, line_type, description, quantity, unit_amount, amount, sessions_reference)
          VALUES (${invoice.id}, ${line.beneficiaryClientId}, ${line.planId}, ${line.lineType}, ${line.description}, ${line.quantity}, ${line.unitAmount}, ${line.amount}, ${line.sessionsReference})`;
      }
      await auditBilling(transaction, auth.sub, auth.sub, 'CREATE_INVOICE', 'invoice', invoice.id, {
        code: billingCode(invoice.number), payerClientId: input.payerClientId, kind: input.kind, cycleStart, cycleEnd, total, lines: valid.length
      });
      return invoice;
    });
    return reply.code(201).send({ id: created.id, number: Number(created.number), code: billingCode(created.number), total });
  } catch (error) {
    const pg = error as { code?: string; constraint_name?: string; message?: string };
    if (pg.code === '23505' && pg.constraint_name === 'billing_invoices_cycle_idx') {
      return reply.code(409).send({ error: `Ya existe una factura de este tipo para ese pagador en el ciclo que empieza el ${cycleStart.split('-').reverse().join('-')}` });
    }
    if (pg.code === '23505' && pg.constraint_name === 'billing_invoice_lines_plan_idx') {
      return reply.code(400).send({ error: 'Una persona solo puede aparecer una vez por factura; sume sus conceptos en una sola línea' });
    }
    throw error;
  }
});

app.post('/api/billing/invoices/:id/void', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Indique el motivo').max(300) }).parse(request.body);
  const result = await sql.begin(async transaction => {
    const [invoice] = await transaction`
      SELECT id, number, status FROM billing_invoices WHERE id = ${id} AND owner_id = ${auth.sub} FOR UPDATE`;
    if (!invoice) return { error: 404 as const };
    if (invoice.status === 'anulada') return { error: 409 as const, message: 'La factura ya está anulada' };
    const [{ n }] = await transaction`
      SELECT count(*)::int AS n FROM billing_payment_applications WHERE invoice_id = ${id} AND reversed_at IS NULL`;
    if (n > 0) return { error: 409 as const, message: 'La factura tiene cobros aplicados: revierta primero esas aplicaciones, con su motivo' };
    await transaction`UPDATE billing_invoices SET status = 'anulada', void_reason = ${reason}, voided_at = now(), voided_by = ${auth.sub} WHERE id = ${id}`;
    await auditBilling(transaction, auth.sub, auth.sub, 'VOID_INVOICE', 'invoice', id, { code: billingCode(invoice.number), reason });
    return { number: Number(invoice.number) };
  });
  if ('error' in result) {
    if (result.error === 404) return reply.code(404).send({ error: 'Factura no encontrada' });
    return reply.code(409).send({ error: result.message });
  }
  return { voided: true, code: billingCode(result.number) };
});

// Corrige el REPARTO por persona de una factura ya emitida (aunque esté pagada) sin cambiar su total: en una sola transacción revierte las aplicaciones de cobro,
// anula la factura vieja con motivo, emite una nueva con el mismo ciclo, fechas y pagador y las líneas corregidas, y vuelve a aplicar los mismos cobros. Si algo falla no queda nada a medias.
const billingRedistributeInput = z.object({
  reason: z.string().trim().min(3, 'Indique el motivo').max(300),
  lines: z.array(z.object({ beneficiaryClientId: z.string().uuid(), amount: z.coerce.number().positive().max(100000) })).min(1).max(30)
});
app.post('/api/billing/invoices/:id/redistribute', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = billingRedistributeInput.parse(request.body);
  try {
    const result = await sql.begin(async transaction => {
      const [old] = await transaction`
        SELECT id, number, payer_client_id, kind, cycle_start::text AS cycle_start, cycle_end::text AS cycle_end, cut_day, issued_on::text AS issued_on, due_on::text AS due_on, total, status, notes
        FROM billing_invoices WHERE id = ${id} AND owner_id = ${auth.sub} FOR UPDATE`;
      if (!old) throw new BillingNotFound('Factura no encontrada');
      if (old.status === 'anulada') throw new BillingConflict('La factura está anulada');
      if (!['mensual', 'paquete'].includes(old.kind as string)) throw new BillingConflict('Solo se corrige el reparto de mensualidades y paquetes');
      const total = desdeCentavos(input.lines.reduce((sum, line) => sum + centavos(line.amount), 0));
      if (centavos(total) !== centavos(Number(old.total))) {
        throw Object.assign(new Error(`El reparto debe seguir sumando ${money(Number(old.total))} (suma ${money(total)}); si el total cambia, anula la factura y crea otra`), { statusCode: 400 });
      }
      const beneficiaries = input.lines.map(line => line.beneficiaryClientId);
      if (new Set(beneficiaries).size !== beneficiaries.length) throw Object.assign(new Error('Una persona solo puede aparecer una vez'), { statusCode: 400 });
      const owned = await transaction`SELECT id FROM clients WHERE owner_id = ${auth.sub} AND id IN ${transaction(beneficiaries)}`;
      if (owned.length !== beneficiaries.length) throw new BillingNotFound('Cliente no encontrado');
      const oldLines = await transaction`SELECT beneficiary_client_id::text AS beneficiary, plan_id, description, sessions_reference, amount FROM billing_invoice_lines WHERE invoice_id = ${id} AND line_type = 'plan'`;
      const applications = await transaction`
        SELECT id, payment_id::text AS payment_id, amount, applied_on::text AS applied_on FROM billing_payment_applications
        WHERE invoice_id = ${id} AND reversed_at IS NULL ORDER BY created_at FOR UPDATE`;
      const oldCode = billingCode(old.number);
      for (const application of applications) {
        await transaction`UPDATE billing_payment_applications SET reversed_at = now(), reversed_by = ${auth.sub}, reversal_reason = ${`Reparto corregido: ${input.reason}`} WHERE id = ${application.id}`;
      }
      await transaction`UPDATE billing_invoices SET status = 'anulada', void_reason = ${`Reparto corregido (la reemplaza una factura nueva): ${input.reason}`}, voided_at = now(), voided_by = ${auth.sub} WHERE id = ${id}`;
      const [{ n }] = await transaction`SELECT billing_next_number(${auth.sub}) AS n`;
      const [created] = await transaction`
        INSERT INTO billing_invoices (owner_id, number, payer_client_id, kind, origin, cycle_start, cycle_end, cut_day, issued_on, due_on, total, notes, created_by)
        VALUES (${auth.sub}, ${n}, ${old.payer_client_id}, ${old.kind}, 'manual', ${old.cycle_start}, ${old.cycle_end}, ${old.cut_day}, ${old.issued_on}, ${old.due_on}, ${total},
          ${`Reemplaza a ${oldCode}: reparto por persona corregido. ${input.reason}`}, ${auth.sub})
        RETURNING id, number`;
      for (const line of input.lines) {
        const previous = oldLines.find(item => item.beneficiary === line.beneficiaryClientId);
        await transaction`
          INSERT INTO billing_invoice_lines (invoice_id, beneficiary_client_id, plan_id, line_type, description, quantity, unit_amount, amount, sessions_reference)
          VALUES (${created.id}, ${line.beneficiaryClientId}, ${previous?.plan_id ?? null}, 'plan', ${previous?.description ?? (old.kind === 'paquete' ? 'Paquete' : 'Mensualidad')}, 1, ${line.amount}, ${line.amount}, ${previous?.sessions_reference ?? null})`;
      }
      const byPayment = new Map<string, { amount: number; appliedOn: string }>();
      for (const application of applications) {
        const current = byPayment.get(application.payment_id as string);
        byPayment.set(application.payment_id as string, { amount: desdeCentavos(centavos(current?.amount ?? 0) + centavos(Number(application.amount))), appliedOn: current?.appliedOn ?? (application.applied_on as string) });
      }
      for (const [paymentId, item] of byPayment) await applyBillingPayment(transaction, auth.sub, auth.sub, paymentId, [{ invoiceId: created.id as string, amount: item.amount }], item.appliedOn);
      const newCode = billingCode(created.number);
      await auditBilling(transaction, auth.sub, auth.sub, 'REDISTRIBUTE_INVOICE', 'invoice', created.id as string, {
        replaced: oldCode, replacement: newCode, reason: input.reason, total,
        before: oldLines.map(item => ({ beneficiary: item.beneficiary, amount: Number(item.amount) })), after: input.lines, reappliedPayments: byPayment.size
      });
      return { oldCode, newCode, newId: created.id as string, total, reappliedPayments: byPayment.size };
    });
    return reply.code(201).send(result);
  } catch (error) { throw billingDbError(error); }
});

app.get('/api/billing/invoices/:id/pdf', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [row] = await sql.unsafe(`
    SELECT i.id, i.number, i.kind, i.status, i.total, i.notes, i.void_reason, i.voided_at,
      i.cycle_start::text AS cycle_start, i.cycle_end::text AS cycle_end, i.issued_on::text AS issued_on, i.due_on::text AS due_on,
      p.full_name AS payer_name, p.email AS payer_email
    FROM billing_invoices i JOIN clients p ON p.id = i.payer_client_id
    WHERE i.id = $1 AND i.owner_id = $2`, [id, auth.sub]) as unknown as Record<string, any>[];
  if (!row) return reply.code(404).send({ error: 'Factura no encontrada' });
  const lines = await sql`
    SELECT c.full_name AS beneficiary_name, l.description, l.quantity, l.amount
    FROM billing_invoice_lines l JOIN clients c ON c.id = l.beneficiary_client_id
    WHERE l.invoice_id = ${id} ORDER BY c.full_name`;
  const applications = await sql`
    SELECT a.amount, a.reversed_at, p.paid_on::text AS paid_on, p.method, p.reference
    FROM billing_payment_applications a JOIN billing_payments p ON p.id = a.payment_id
    WHERE a.invoice_id = ${id} ORDER BY a.created_at`;
  return sendPdf(reply, await billingInvoicePdf(row, lines as unknown as Record<string, any>[], applications as unknown as Record<string, any>[]), `factura-${billingCode(row.number)}.pdf`);
});

// ── Cobros del módulo nuevo (1B-3) ───────────────────────────────────────────
// COBRO = dinero recibido. Se registra aparte de la factura y se APLICA a una o varias
// facturas del mismo pagador; lo no aplicado queda como saldo a favor. Un cobro no se
// edita ni se borra: una aplicación equivocada se REVIERTE (con motivo) y un cobro
// mal registrado se ANULA (con motivo, tras revertir sus aplicaciones). El estado de
// cada factura (pendiente / parcial / pagada) se recalcula en la misma transacción.
const billingPaymentMethods = ['Efectivo', 'Yappy', 'Transferencia bancaria', 'Tarjeta', 'Otro'] as const;
const billingApplicationItem = z.object({ invoiceId: z.string().uuid(), amount: z.coerce.number().positive().max(1_000_000) });
const billingPaymentInput = z.object({
  payerClientId: z.string().uuid(),
  paidOn: z.string().date().optional(),
  amount: z.coerce.number().positive().max(1_000_000),
  method: z.enum(billingPaymentMethods),
  reference: z.string().trim().max(160).optional(),
  notes: z.string().trim().max(500).optional(),
  applications: z.array(billingApplicationItem).max(30).optional()
});
const billingApplyInput = z.object({ applications: z.array(billingApplicationItem).min(1).max(30), appliedOn: z.string().date().optional() });
const billingReasonInput = z.object({ reason: z.string().trim().min(3, 'Indique el motivo').max(300) });
const billingPaymentListQuery = z.object({
  status: z.enum(['all', 'available', 'voided']).default('all'),
  payerId: z.string().uuid().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200)
});

const billingPaymentColumns = `p.id, p.payer_client_id, pc.full_name AS payer_name, p.paid_on::text AS paid_on, p.amount, p.method,
  p.reference, p.notes, p.created_at, p.voided_at, p.void_reason,
  COALESCE((SELECT sum(a.amount) FROM billing_payment_applications a WHERE a.payment_id = p.id AND a.reversed_at IS NULL), 0) AS applied`;

function billingPaymentValue(row: Record<string, any>) {
  const amount = Number(row.amount);
  const applied = Number(row.applied ?? 0);
  const voided = row.voided_at != null;
  return {
    id: row.id, payerClientId: row.payer_client_id, payerName: row.payer_name, paidOn: row.paid_on, amount,
    method: row.method, reference: row.reference ?? null, notes: row.notes ?? null,
    applied, available: voided ? 0 : desdeCentavos(centavos(amount) - centavos(applied)),
    status: voided ? 'anulado' : centavos(applied) === 0 ? 'sin_aplicar' : centavos(applied) < centavos(amount) ? 'parcial' : 'aplicado',
    voidedAt: row.voided_at ?? null, voidReason: row.void_reason ?? null, createdAt: row.created_at
  };
}

class BillingConflict extends Error { statusCode = 409; }
class BillingNotFound extends Error { statusCode = 404; }

// Recalcula el estado de una factura según sus aplicaciones vigentes (misma transacción).
async function refreshBillingInvoiceStatus(transaction: TransactionSql, invoiceId: string) {
  const [invoice] = await transaction`SELECT id, total, status FROM billing_invoices WHERE id = ${invoiceId} FOR UPDATE`;
  if (!invoice || invoice.status === 'anulada') return;
  const [{ paid }] = await transaction`
    SELECT COALESCE(sum(amount), 0) AS paid FROM billing_payment_applications WHERE invoice_id = ${invoiceId} AND reversed_at IS NULL`;
  const total = centavos(Number(invoice.total)); const pagado = centavos(Number(paid));
  const next = total > 0 && pagado >= total ? 'pagada' : pagado > 0 ? 'parcial' : 'pendiente';
  if (next !== invoice.status) await transaction`UPDATE billing_invoices SET status = ${next} WHERE id = ${invoiceId}`;
}

// Aplica un cobro a facturas dentro de una transacción ya abierta. Valida con mensajes claros;
// la base repite las mismas reglas como respaldo.
async function applyBillingPayment(transaction: TransactionSql, ownerId: string, userId: string, paymentId: string,
  items: { invoiceId: string; amount: number }[], appliedOn: string) {
  const ids = items.map(item => item.invoiceId);
  if (new Set(ids).size !== ids.length) throw Object.assign(new Error('Una factura solo puede aparecer una vez en la misma aplicación'), { statusCode: 400 });
  const [payment] = await transaction`
    SELECT id, payer_client_id, amount, voided_at FROM billing_payments WHERE id = ${paymentId} AND owner_id = ${ownerId} FOR UPDATE`;
  if (!payment) throw new BillingNotFound('Cobro no encontrado');
  if (payment.voided_at) throw new BillingConflict('El cobro está anulado');
  const [{ applied }] = await transaction`
    SELECT COALESCE(sum(amount), 0) AS applied FROM billing_payment_applications WHERE payment_id = ${paymentId} AND reversed_at IS NULL`;
  let disponible = centavos(Number(payment.amount)) - centavos(Number(applied));
  const aplicadas: { invoiceId: string; code: string; amount: number }[] = [];
  for (const item of items) {
    const [invoice] = await transaction`
      SELECT id, number, payer_client_id, total, status FROM billing_invoices WHERE id = ${item.invoiceId} AND owner_id = ${ownerId} FOR UPDATE`;
    if (!invoice) throw new BillingNotFound('Factura no encontrada');
    const code = billingCode(invoice.number);
    if (invoice.payer_client_id !== payment.payer_client_id) throw new BillingConflict(`${code} es de otro pagador: un cobro solo se aplica a facturas de su pagador`);
    if (invoice.status === 'anulada') throw new BillingConflict(`${code} está anulada`);
    const [{ paid }] = await transaction`
      SELECT COALESCE(sum(amount), 0) AS paid FROM billing_payment_applications WHERE invoice_id = ${item.invoiceId} AND reversed_at IS NULL`;
    const saldo = centavos(Number(invoice.total)) - centavos(Number(paid));
    const monto = centavos(item.amount);
    if (monto > saldo) throw new BillingConflict(`La aplicación supera el saldo de ${code} (${money(desdeCentavos(saldo))})`);
    if (monto > disponible) throw new BillingConflict(`La aplicación supera lo disponible del cobro (${money(desdeCentavos(disponible))})`);
    await transaction`
      INSERT INTO billing_payment_applications (payment_id, invoice_id, amount, applied_on, created_by)
      VALUES (${paymentId}, ${item.invoiceId}, ${desdeCentavos(monto)}, ${appliedOn}, ${userId})`;
    disponible -= monto;
    await refreshBillingInvoiceStatus(transaction, item.invoiceId);
    aplicadas.push({ invoiceId: item.invoiceId, code, amount: desdeCentavos(monto) });
  }
  await auditBilling(transaction, ownerId, userId, 'APPLY_PAYMENT', 'payment', paymentId, { applications: aplicadas, available: desdeCentavos(disponible) });
  return { applications: aplicadas, available: desdeCentavos(disponible) };
}

const money = (value: number) => `$${value.toFixed(2)}`;

function billingDbError(error: unknown) {
  const pg = error as { code?: string; message?: string };
  // check_violation / restrict_violation lanzadas por las guardas de la base: mensaje claro, no un 500.
  if (pg.code === '23514' || pg.code === '23001') return new BillingConflict(pg.message || 'La operación no cumple las reglas de facturación');
  return error;
}

app.get('/api/billing/payments', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const query = billingPaymentListQuery.parse(request.query);
  const rows = await sql.unsafe(`
    SELECT ${billingPaymentColumns}
    FROM billing_payments p JOIN clients pc ON pc.id = p.payer_client_id
    WHERE p.owner_id = $1
      AND ($2::uuid IS NULL OR p.payer_client_id = $2)
      AND ($3::date IS NULL OR p.paid_on >= $3)
      AND ($4::date IS NULL OR p.paid_on <= $4)
      AND ($5::text <> 'voided' OR p.voided_at IS NOT NULL)
    ORDER BY p.paid_on DESC, p.created_at DESC LIMIT $6`,
    [auth.sub, query.payerId ?? null, query.from ?? null, query.to ?? null, query.status, query.limit]
  ) as unknown as Record<string, any>[];
  let payments = rows.map(billingPaymentValue);
  if (query.status === 'available') payments = payments.filter(payment => payment.available > 0);
  const live = payments.filter(payment => payment.status !== 'anulado');
  return {
    payments,
    summary: {
      count: payments.length,
      total: desdeCentavos(live.reduce((sum, payment) => sum + centavos(payment.amount), 0)),
      applied: desdeCentavos(live.reduce((sum, payment) => sum + centavos(payment.applied), 0)),
      available: desdeCentavos(live.reduce((sum, payment) => sum + centavos(payment.available), 0))
    }
  };
});

app.get('/api/billing/payments/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [row] = await sql.unsafe(`
    SELECT ${billingPaymentColumns} FROM billing_payments p JOIN clients pc ON pc.id = p.payer_client_id
    WHERE p.id = $1 AND p.owner_id = $2`, [id, auth.sub]) as unknown as Record<string, any>[];
  if (!row) return reply.code(404).send({ error: 'Cobro no encontrado' });
  const applications = await sql`
    SELECT a.id, a.invoice_id, i.number, a.amount, a.applied_on::text AS applied_on, a.reversed_at, a.reversal_reason
    FROM billing_payment_applications a JOIN billing_invoices i ON i.id = a.invoice_id
    WHERE a.payment_id = ${id} ORDER BY a.created_at`;
  const audit = await sql`
    SELECT at, action, detail FROM billing_audit WHERE owner_id = ${auth.sub} AND entity = 'payment' AND entity_id = ${id} ORDER BY at`;
  return {
    ...billingPaymentValue(row),
    applications: applications.map(item => ({
      id: item.id, invoiceId: item.invoice_id, invoiceCode: billingCode(item.number), amount: Number(item.amount),
      appliedOn: item.applied_on, reversedAt: item.reversed_at, reversalReason: item.reversal_reason
    })),
    audit: audit.map(item => ({ at: item.at, action: item.action, detail: item.detail }))
  };
});

app.post('/api/billing/payments', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const input = billingPaymentInput.parse(request.body);
  const paidOn = input.paidOn ?? fechaDeNegocioPanama();
  const [payer] = await sql`SELECT id FROM clients WHERE id = ${input.payerClientId} AND owner_id = ${auth.sub}`;
  if (!payer) return reply.code(404).send({ error: 'Cliente no encontrado' });
  const amount = desdeCentavos(centavos(input.amount));
  try {
    const result = await sql.begin(async transaction => {
      const [payment] = await transaction`
        INSERT INTO billing_payments (owner_id, payer_client_id, paid_on, amount, method, reference, notes, created_by)
        VALUES (${auth.sub}, ${input.payerClientId}, ${paidOn}, ${amount}, ${input.method}, ${input.reference || null}, ${input.notes || null}, ${auth.sub})
        RETURNING id`;
      await auditBilling(transaction, auth.sub, auth.sub, 'CREATE_PAYMENT', 'payment', payment.id, {
        payerClientId: input.payerClientId, paidOn, amount, method: input.method, reference: input.reference || null
      });
      let available = amount;
      if (input.applications?.length) {
        available = (await applyBillingPayment(transaction, auth.sub, auth.sub, payment.id, input.applications, paidOn)).available;
      }
      return { id: payment.id, available };
    });
    return reply.code(201).send({ id: result.id, amount, available: result.available });
  } catch (error) { throw billingDbError(error); }
});

app.post('/api/billing/payments/:id/applications', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = billingApplyInput.parse(request.body);
  try {
    const result = await sql.begin(transaction => applyBillingPayment(transaction, auth.sub, auth.sub, id, input.applications, input.appliedOn ?? fechaDeNegocioPanama()));
    return reply.code(201).send(result);
  } catch (error) { throw billingDbError(error); }
});

app.post('/api/billing/payment-applications/:id/reverse', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const { reason } = billingReasonInput.parse(request.body);
  try {
    const result = await sql.begin(async transaction => {
      const [application] = await transaction`
        SELECT a.id, a.payment_id, a.invoice_id, a.amount, a.reversed_at, i.number
        FROM billing_payment_applications a
        JOIN billing_payments p ON p.id = a.payment_id
        JOIN billing_invoices i ON i.id = a.invoice_id
        WHERE a.id = ${id} AND p.owner_id = ${auth.sub} FOR UPDATE OF a`;
      if (!application) throw new BillingNotFound('Aplicación no encontrada');
      if (application.reversed_at) throw new BillingConflict('La aplicación ya está revertida');
      await transaction`UPDATE billing_payment_applications SET reversed_at = now(), reversed_by = ${auth.sub}, reversal_reason = ${reason} WHERE id = ${id}`;
      await refreshBillingInvoiceStatus(transaction, application.invoice_id);
      await auditBilling(transaction, auth.sub, auth.sub, 'REVERSE_APPLICATION', 'payment', application.payment_id, {
        applicationId: id, invoice: billingCode(application.number), amount: Number(application.amount), reason
      });
      return { reversed: true, invoice: billingCode(application.number) };
    });
    return result;
  } catch (error) { throw billingDbError(error); }
});

app.post('/api/billing/payments/:id/void', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const { reason } = billingReasonInput.parse(request.body);
  try {
    return await sql.begin(async transaction => {
      const [payment] = await transaction`SELECT id, voided_at FROM billing_payments WHERE id = ${id} AND owner_id = ${auth.sub} FOR UPDATE`;
      if (!payment) throw new BillingNotFound('Cobro no encontrado');
      if (payment.voided_at) throw new BillingConflict('El cobro ya está anulado');
      const [{ n }] = await transaction`SELECT count(*)::int AS n FROM billing_payment_applications WHERE payment_id = ${id} AND reversed_at IS NULL`;
      if (n > 0) throw new BillingConflict('El cobro tiene aplicaciones vigentes: revierta primero esas aplicaciones, con su motivo');
      await transaction`UPDATE billing_payments SET voided_at = now(), void_reason = ${reason}, voided_by = ${auth.sub} WHERE id = ${id}`;
      await auditBilling(transaction, auth.sub, auth.sub, 'VOID_PAYMENT', 'payment', id, { reason });
      return { voided: true };
    });
  } catch (error) { throw billingDbError(error); }
});

// ── Carga inicial: cargador con vista previa (1B-4) ──────────────────────────
// Lleva al módulo nuevo lo que cuadra del sistema anterior. NO modifica el sistema anterior.
// Vista previa -> aprobación (por hash) -> aplicación (solo con el generador viejo apagado) ->
// reversión (solo si nada cambió después). Ver billing-import.ts.
const importDate = z.string().date();
const importManifestInput = z.object({
  name: z.string().trim().min(1).max(200),
  entries: z.array(z.object({
    key: z.string().trim().min(1).max(80), label: z.string().trim().min(1).max(200), payer: z.string().trim().min(1).max(200),
    kind: z.enum(['mensual', 'credito', 'clase_suelta', 'paquete', 'manual']),
    cycleStart: importDate, cycleEnd: importDate, cutDay: z.coerce.number().int().min(1).max(31).optional(),
    issuedOn: importDate.optional(), dueOn: importDate.optional(), amountFrom: z.literal('legacy').optional(), allowWithoutEvidence: z.string().trim().min(3).max(300).optional(),
    lines: z.array(z.object({
      beneficiary: z.string().trim().min(1).max(200), description: z.string().trim().max(200).optional(),
      amount: z.coerce.number().min(0).max(100000).optional(), sessionsReference: z.coerce.number().int().positive().max(1000).optional()
    })).min(1).max(30),
    payment: z.object({
      paidOn: z.union([importDate, z.literal('legacy')]), method: z.enum([...billingPaymentMethods, 'legacy'] as const), amount: z.coerce.number().positive().max(1_000_000), reference: z.string().trim().max(160).optional()
    }).optional()
  })).min(1).max(200),
  exclusions: z.array(z.object({ key: z.string().trim().min(1).max(80), label: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(500) })).max(200),
  singleClasses: z.array(z.object({ key: z.string().trim().min(1).max(80), label: z.string().trim().min(1).max(200), client: z.string().trim().min(1).max(200), since: importDate, accept: z.array(z.object({ date: importDate, amount: z.coerce.number().positive().max(100000) })).max(50).optional() })).max(50).optional()
});

function importBatchValue(batch: Record<string, any>, items?: Record<string, any>[]) {
  return {
    id: batch.id, status: batch.status, previewHash: batch.preview_hash, manifestHash: batch.manifest_hash, totals: batch.totals,
    sourceInfo: batch.source_info, counterBefore: batch.counter_before, counterAfter: batch.counter_after,
    createdAt: batch.created_at, approvedAt: batch.approved_at, appliedAt: batch.applied_at, reversedAt: batch.reversed_at,
    reversalReason: batch.reversal_reason, failureReason: batch.failure_reason,
    manifestName: batch.manifest?.name ?? null,
    items: items?.map(item => ({
      seq: item.seq, kind: item.kind, decision: item.decision, key: item.key, label: item.label, externalId: item.external_id,
      reasons: item.reasons, data: item.data, sourceIds: item.source_ids,
      destinationInvoiceId: item.destination_invoice_id ?? null, destinationPaymentId: item.destination_payment_id ?? null
    }))
  };
}

app.get('/api/billing/imports/default-manifest', { preHandler: requireStaff }, async () => DEFAULT_IMPORT_MANIFEST);

app.get('/api/billing/imports', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const rows = await listBatches(auth.sub);
  return { batches: rows.map(row => ({ id: row.id, status: row.status, previewHash: row.preview_hash, totals: row.totals, counterBefore: row.counter_before, counterAfter: row.counter_after,
    createdAt: row.created_at, approvedAt: row.approved_at, appliedAt: row.applied_at, reversedAt: row.reversed_at })) };
});

app.post('/api/billing/imports/preview', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const body = z.object({ manifest: importManifestInput.optional() }).parse(request.body ?? {});
  const manifest = (body.manifest ?? DEFAULT_IMPORT_MANIFEST) as ImportManifest;
  const created = await createPreviewBatch(auth.sub, auth.sub, manifest);
  const { batch, items } = await getBatch(auth.sub, created.id);
  return reply.code(201).send({ ...importBatchValue(batch, items as unknown as Record<string, any>[]), engine: billingEngine });
});

app.get('/api/billing/imports/:id', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const { batch, items } = await getBatch(auth.sub, id);
  return { ...importBatchValue(batch, items as unknown as Record<string, any>[]), engine: billingEngine };
});

app.post('/api/billing/imports/:id/approve', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const { previewHash } = z.object({ previewHash: z.string().regex(/^[0-9a-f]{64}$/) }).parse(request.body);
  return approveBatch(auth.sub, auth.sub, id, previewHash);
});

app.post('/api/billing/imports/:id/apply', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  return applyBatch(auth.sub, auth.sub, id, { legacyWrites: billingEngine.legacyWrites });
});

app.post('/api/billing/imports/:id/reverse', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const { reason } = billingReasonInput.parse(request.body);
  return reverseBatch(auth.sub, auth.sub, id, reason);
});

// ── Generador nuevo y preparación del corte (1B-6) ───────────────────────────
// El generador nuevo emite las facturas recurrentes desde los planes de facturación del expediente
// (billing-generator.ts). Solo ESCRIBE si el estado operativo es `new`; en cualquier otro estado el plan
// se puede consultar (modo sombra) pero no crea nada.
async function runNewBillingGenerationForAll() {
  const owners = await sql`SELECT DISTINCT owner_id::text AS owner_id FROM billing_subscriptions`;
  for (const owner of owners) {
    const result = await runBillingGeneration(owner.owner_id as string);
    if (result.created.length) app.log.info({ owner: owner.owner_id, created: result.created.map(item => item.code) }, 'Facturas generadas por el generador nuevo');
  }
}

app.get('/api/billing/generation/plan', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const { horizon } = z.object({ horizon: z.coerce.number().int().min(0).max(120).default(35) }).parse(request.query);
  const today = fechaDeNegocioPanama();
  const plan = await sql.begin('isolation level repeatable read read only', tx => planBillingGeneration(tx as any, auth.sub, today, horizon));
  const count = (status: string) => plan.filter(item => item.status === status).length;
  return {
    today, horizon, engine: billingEngine, plan,
    summary: { toIssueToday: count('emitir'), scheduled: count('programada'), omitted: count('omitida'), noCharge: count('sin_cargo'), noReference: count('sin_referencia'),
      totalToIssueToday: plan.filter(item => item.status === 'emitir').reduce((sum, item) => sum + centavos(item.total), 0) / 100 }
  };
});

app.post('/api/billing/generation/run', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  if (!billingEngine.newWrites) {
    throw Object.assign(new Error(`El generador nuevo no está activo (estado ${billingEngine.state}): solo escribe cuando el corte lo activa`), { statusCode: 409 });
  }
  return runBillingGeneration(auth.sub);
});

// Planes de facturación PROPUESTOS para quien aún no tiene ninguno, leídos del expediente actual (precio, pagador, corte).
// No escribe: Joel los revisa y confirma. Lo que el expediente actual no puede expresar (un segundo plan propio de
// Ernesto, el paquete de 35 días de Sara si no está declarado) se agrega a mano con "Agregar concepto a facturar".
async function proposedBillingLines(ownerId: string, today: string) {
  const rows = await sql`
    SELECT c.id::text AS id, c.full_name, c.billing_responsible_client_id::text AS responsible,
      (SELECT r.full_name FROM clients r WHERE r.id = c.billing_responsible_client_id) AS responsible_name,
      c.billing_model, c.payment_mode, c.standard_price::text AS standard_price, c.credit_session_price::text AS credit_session_price,
      c.billing_cutoff_day, c.monthly_session_target, p.sessions_included, p.validity_days
    FROM clients c LEFT JOIN service_plans p ON p.id = c.plan_id
    WHERE c.owner_id = ${ownerId} AND c.status = 'active' AND c.billing_model IN ('monthly', 'package')
      AND (c.standard_price > 0 OR c.payment_mode = 'no_anticipado')
      -- Se compara por la PAREJA beneficiario + pagador del expediente actual: quien tiene además un plan propio (Ernesto) sigue necesitando
      -- la línea con el pagador de su plan familiar.
      AND NOT EXISTS (SELECT 1 FROM billing_subscriptions s WHERE s.beneficiary_client_id = c.id AND s.payer_client_id = COALESCE(c.billing_responsible_client_id, c.id)
        AND s.starts_on <= ${today}::date AND (s.ends_on IS NULL OR s.ends_on >= ${today}::date))
    ORDER BY c.full_name`;
  return rows.map(row => {
    const kind = row.billing_model === 'package' ? 'package' : row.payment_mode === 'no_anticipado' ? 'credit' : 'monthly';
    const cut = Number(row.billing_cutoff_day) || 1;
    return {
      beneficiaryClientId: row.id as string, beneficiaryName: row.full_name as string,
      payerClientId: (row.responsible || row.id) as string, payerName: (row.responsible_name || row.full_name) as string,
      kind, cycleDays: kind === 'package' ? Number(row.validity_days || 35) : null,
      sessionsReference: Number(row.monthly_session_target || row.sessions_included || 0) || null,
      startsOn: cicloDelCorte(today, cut).inicio,
      price: Number(kind === 'credit' ? row.credit_session_price || 25 : row.standard_price || 0)
    };
  }).filter(line => line.price > 0);
}

app.get('/api/billing/cutover/proposed-lines', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return { lines: await proposedBillingLines(auth.sub, fechaDeNegocioPanama()) };
});

app.post('/api/billing/cutover/proposed-lines/apply', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  z.object({ confirm: z.literal(true) }).parse(request.body);
  const today = fechaDeNegocioPanama();
  const lines = await proposedBillingLines(auth.sub, today);
  const created = await sql.begin(async transaction => {
    const made: { id: string; beneficiary: string; payer: string; kind: string; price: number }[] = [];
    for (const line of lines) {
      const { beneficiary, payer } = await assertBillingClients(transaction, auth.sub, line.beneficiaryClientId, line.payerClientId);
      if (!beneficiary || !payer) continue;
      await assertSubscriptionNoOverlap(transaction, auth.sub, { beneficiaryClientId: line.beneficiaryClientId, payerClientId: line.payerClientId, kind: line.kind, startsOn: line.startsOn, endsOn: null });
      const [row] = await transaction`
        INSERT INTO billing_subscriptions (owner_id, beneficiary_client_id, payer_client_id, kind, cycle_days, sessions_reference, starts_on, ends_on, price, auto_generate)
        VALUES (${auth.sub}, ${line.beneficiaryClientId}, ${line.payerClientId}, ${line.kind}, ${line.cycleDays}, ${line.sessionsReference}, ${line.startsOn}, NULL, ${line.price}, true)
        RETURNING *`;
      await auditBillingSubscription(transaction, request, auth, 'CREATE_BILLING_SUBSCRIPTION', row.id, null, billingSubscriptionValue({ ...row, beneficiary_name: line.beneficiaryName, payer_name: line.payerName }));
      made.push({ id: row.id as string, beneficiary: line.beneficiaryName, payer: line.payerName, kind: line.kind, price: line.price });
    }
    return made;
  });
  return reply.code(201).send({ created, count: created.length });
});

// Lista de comprobación antes del corte: qué falta para que apagar el generador viejo sea seguro.
app.get('/api/billing/cutover/readiness', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const today = fechaDeNegocioPanama();
  const checks: { key: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string; items?: Record<string, unknown>[] }[] = [];

  const [batch] = await sql`SELECT id::text AS id, applied_at, totals FROM billing_import_batches WHERE owner_id = ${auth.sub} AND status = 'applied' ORDER BY applied_at DESC LIMIT 1`;
  checks.push(batch
    ? { key: 'import', label: 'La carga inicial está aplicada', status: 'ok', detail: `${(batch.totals as any)?.invoices ?? 0} facturas y ${(batch.totals as any)?.payments ?? 0} cobros cargados` }
    : { key: 'import', label: 'La carga inicial está aplicada', status: 'fail', detail: 'Aún no se aplicó la carga inicial (Facturación → Carga inicial).' });

  const missing = await sql`
    SELECT c.id::text AS id, c.full_name AS name, c.standard_price::text AS price, c.payment_mode, c.billing_model
    FROM clients c
    WHERE c.owner_id = ${auth.sub} AND c.status = 'active' AND c.billing_model IN ('monthly', 'package')
      AND (c.standard_price > 0 OR c.payment_mode = 'no_anticipado')
      AND NOT EXISTS (SELECT 1 FROM billing_subscriptions s WHERE s.beneficiary_client_id = c.id AND s.payer_client_id = COALESCE(c.billing_responsible_client_id, c.id)
        AND s.starts_on <= ${today}::date AND (s.ends_on IS NULL OR s.ends_on >= ${today}::date))
    ORDER BY c.full_name`;
  checks.push(missing.length
    ? { key: 'plans', label: 'Todos los clientes con cobro tienen su Plan de facturación', status: 'fail', detail: `${missing.length} cliente(s) activos con cobro no tienen plan de facturación declarado: sin él el generador nuevo no los facturaría.`,
        items: missing.map(row => ({ name: row.name, price: Number(row.price), mode: row.payment_mode })) }
    : { key: 'plans', label: 'Todos los clientes con cobro tienen su Plan de facturación', status: 'ok', detail: 'Todos tienen al menos un plan vigente.' });

  const plan = await sql.begin('isolation level repeatable read read only', tx => planBillingGeneration(tx as any, auth.sub, today, 35));
  const noRef = plan.filter(item => item.status === 'sin_referencia');
  checks.push(noRef.length
    ? { key: 'reference', label: 'Cada pagador tiene su factura de referencia', status: 'fail', detail: 'Estos pagadores tienen plan pero no tienen una factura previa de esa modalidad; el generador no emite la primera (se crea a mano, D-15).',
        items: noRef.map(item => ({ payer: item.payerName, kind: item.kind })) }
    : { key: 'reference', label: 'Cada pagador tiene su factura de referencia', status: 'ok', detail: 'Todos los pagadores con plan tienen una factura previa.' });
  // La factura de un pagador se repite con las líneas de sus planes: quien figura en la última factura y ya no tiene plan con ESE pagador
  // dejaría de facturarse (p. ej. la parte familiar de Ernesto en la factura de Riccardo). Se compara con la última factura de cada pagador.
  const dropped = await sql`
    SELECT DISTINCT p.full_name AS payer, b.full_name AS beneficiary, l.amount::text AS amount, i.kind, i.number
    FROM billing_invoices i
    JOIN (SELECT payer_client_id, kind, max(cycle_start) AS cycle_start FROM billing_invoices
          WHERE owner_id = ${auth.sub} AND kind IN ('mensual', 'paquete') AND status <> 'anulada' GROUP BY payer_client_id, kind) last
      ON last.payer_client_id = i.payer_client_id AND last.kind = i.kind AND last.cycle_start = i.cycle_start
    JOIN billing_invoice_lines l ON l.invoice_id = i.id AND l.line_type = 'plan'
    JOIN clients p ON p.id = i.payer_client_id JOIN clients b ON b.id = l.beneficiary_client_id
    WHERE i.owner_id = ${auth.sub} AND i.status <> 'anulada'
      AND EXISTS (SELECT 1 FROM billing_subscriptions s0 WHERE s0.payer_client_id = i.payer_client_id AND s0.auto_generate AND s0.starts_on <= ${today}::date AND (s0.ends_on IS NULL OR s0.ends_on >= ${today}::date))
      AND NOT EXISTS (SELECT 1 FROM billing_subscriptions s WHERE s.payer_client_id = i.payer_client_id AND s.beneficiary_client_id = l.beneficiary_client_id
        AND s.kind = CASE i.kind WHEN 'mensual' THEN 'monthly' ELSE 'package' END AND s.starts_on <= ${today}::date AND (s.ends_on IS NULL OR s.ends_on >= ${today}::date))
    ORDER BY p.full_name, b.full_name`;
  checks.push(dropped.length
    ? { key: 'dropped-lines', label: 'La próxima factura de cada pagador conserva todas sus líneas', status: 'fail',
        detail: 'Estas personas figuran en la última factura de su pagador pero no tienen un plan vigente con ese pagador: la próxima factura saldría con menos importe. Agrégales su plan en el expediente ("Agregar concepto a facturar", con ese pagador).',
        items: dropped.map(row => ({ payer: row.payer, beneficiary: row.beneficiary, amount: Number(row.amount) })) }
    : { key: 'dropped-lines', label: 'La próxima factura de cada pagador conserva todas sus líneas', status: 'ok', detail: 'Cada línea de la última factura sigue teniendo su plan vigente.' });
  const omitted = plan.filter(item => item.status === 'omitida');
  checks.push(omitted.length
    ? { key: 'omitted', label: 'No hay ciclos atrasados sin emitir', status: 'warn', detail: 'Estos ciclos están más atrasados que el límite del generador: se crean a mano.',
        items: omitted.map(item => ({ payer: item.payerName, kind: item.kind, cycleStart: item.cycleStart, reason: item.reason })) }
    : { key: 'omitted', label: 'No hay ciclos atrasados sin emitir', status: 'ok', detail: 'Ninguno.' });

  // Facturas del sistema anterior que siguen pendientes y NO se cargaron: quedan en el archivo.
  const loaded = batch ? await sql`SELECT source_ids FROM billing_import_items WHERE batch_id = ${batch.id}` : [];
  const loadedIds = new Set(loaded.flatMap(row => ((row.source_ids as any)?.invoices ?? []) as string[]));
  const legacyPending = await sql`
    SELECT i.id::text AS id, c.full_name AS client, i.concept, i.amount::text AS amount, i.due_on::text AS due_on
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE c.owner_id = ${auth.sub} AND i.status = 'pending' AND i.amount > 0 ORDER BY i.due_on, c.full_name`;
  const notLoaded = legacyPending.filter(row => !loadedIds.has(row.id as string));
  checks.push(notLoaded.length
    ? { key: 'legacy-pending', label: 'Facturas pendientes del sistema anterior que no se cargaron', status: 'warn',
        detail: `${notLoaded.length} factura(s) pendientes quedan solo en el archivo del sistema anterior: hay que cargarlas a mano o cobrarlas antes del corte.`,
        items: notLoaded.map(row => ({ client: row.client, concept: row.concept, amount: Number(row.amount), dueOn: row.due_on })) }
    : { key: 'legacy-pending', label: 'Facturas pendientes del sistema anterior que no se cargaron', status: 'ok', detail: 'No quedan pendientes fuera de la carga.' });

  const summary = {
    toIssueToday: plan.filter(item => item.status === 'emitir').length, scheduledIn35Days: plan.filter(item => item.status === 'programada').length
  };
  return { today, engine: billingEngine, ready: !checks.some(check => check.status === 'fail'), checks, summary };
});

// ── Fuente unificada de ingresos (1B-5) ──
// Septiembre de 2026 es el inicio en limpio (D-02): hasta el corte los ingresos salen del sistema anterior; en el estado `new`
// salen de los pagos anteriores a esa fecha (historia de Zoho y agosto) MÁS los cobros del módulo nuevo. Los cobros viejos de
// septiembre en adelante se ignoran porque la carga inicial ya los trajo (o Joel los reingresó a mano): sumarlos duplicaría.
const NEW_BILLING_CLEAN_START = '2026-09-01';
function incomePaymentsSource(ownerId: string) {
  if (billingEngine.state !== 'new') {
    return sql`(SELECT p.id, p.client_id, p.paid_on, p.amount, p.method, p.reference FROM invoice_payments p JOIN clients c0 ON c0.id = p.client_id WHERE c0.owner_id = ${ownerId})`;
  }
  return sql`(
    SELECT p.id, p.client_id, p.paid_on, p.amount, p.method, p.reference FROM invoice_payments p JOIN clients c0 ON c0.id = p.client_id
      WHERE c0.owner_id = ${ownerId} AND p.paid_on < ${NEW_BILLING_CLEAN_START}::date
    UNION ALL
    SELECT bp.id, bp.payer_client_id, bp.paid_on, bp.amount, bp.method, bp.reference FROM billing_payments bp
      WHERE bp.owner_id = ${ownerId} AND bp.voided_at IS NULL)`;
}

// ── Estado de cuenta, reportes y aviso al beneficiario del módulo nuevo (1B-5) ──
// Leen SOLO las tablas billing_*. El portal y los PDF pasan a leerlas cuando el estado operativo es `new` (tras el corte);
// antes siguen leyendo el sistema anterior, para no mostrar nada a medias.
const billingKindText: Record<string, string> = { mensual: 'Mensualidad', credito: 'Sesiones a crédito', paquete: 'Paquete', clase_suelta: 'Clase suelta', manual: 'Factura' };
const dmy = (iso: unknown) => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}-${m}-${y}`; };
const agingBucket = (daysOverdue: number) => daysOverdue <= 0 ? 'al_dia' : daysOverdue <= 7 ? '1-7' : daysOverdue <= 30 ? '8-30' : '31+';

async function newAccountStatementData(ownerId: string, payerId: string, from: string, to: string) {
  const [payer] = await sql`SELECT id::text AS id, full_name, email FROM clients WHERE id = ${payerId} AND owner_id = ${ownerId}`;
  if (!payer) return null;
  const invoices = await sql`
    SELECT i.id::text AS id, i.number, i.kind, i.cycle_start::text AS cycle_start, i.cycle_end::text AS cycle_end, i.issued_on::text AS issued_on, i.due_on::text AS due_on,
      i.total::text AS total, i.status,
      COALESCE((SELECT sum(a.amount) FROM billing_payment_applications a WHERE a.invoice_id = i.id AND a.reversed_at IS NULL), 0)::text AS paid
    FROM billing_invoices i
    WHERE i.owner_id = ${ownerId} AND i.payer_client_id = ${payerId} AND i.status <> 'anulada' AND i.issued_on BETWEEN ${from}::date AND ${to}::date
    ORDER BY i.issued_on, i.number`;
  const payments = await sql`
    SELECT p.id::text AS id, p.paid_on::text AS paid_on, p.amount::text AS amount, p.method, p.reference,
      COALESCE((SELECT sum(a.amount) FROM billing_payment_applications a WHERE a.payment_id = p.id AND a.reversed_at IS NULL), 0)::text AS applied
    FROM billing_payments p
    WHERE p.owner_id = ${ownerId} AND p.payer_client_id = ${payerId} AND p.voided_at IS NULL AND p.paid_on BETWEEN ${from}::date AND ${to}::date
    ORDER BY p.paid_on, p.created_at`;
  const rows = invoices.map(row => ({
    id: row.id, issued_on: row.issued_on, due_on: row.due_on, invoice_number: billingCode(row.number),
    concept: `${billingKindText[row.kind as string] || row.kind} · ${dmy(row.cycle_start)} → ${dmy(row.cycle_end)}`,
    amount: Number(row.total), paid_amount: Number(row.paid), balance_amount: desdeCentavos(centavos(Number(row.total)) - centavos(Number(row.paid))), status: row.status
  }));
  return { client: { id: payer.id, full_name: payer.full_name, email: payer.email }, rows,
    payments: payments.map(row => ({ id: row.id, paid_on: row.paid_on, amount: Number(row.amount), method: row.method, reference: row.reference, applied: Number(row.applied),
      available: desdeCentavos(centavos(Number(row.amount)) - centavos(Number(row.applied))) })) };
}

app.get('/api/billing/accounts/:payerId/statement', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const payerId = z.string().uuid().parse((request.params as { payerId: string }).payerId);
  const query = z.object({
    from: z.string().date().default(() => fechaPanamaDiasAtras(180)), to: z.string().date().default(() => fechaDeNegocioPanama()),
    format: z.enum(['json', 'csv', 'pdf']).default('json')
  }).parse(request.query);
  const report = await newAccountStatementData(auth.sub, payerId, query.from, query.to);
  if (!report) return reply.code(404).send({ error: 'Cliente no encontrado' });
  const totals = {
    invoiced: desdeCentavos(report.rows.reduce((sum, row) => sum + centavos(row.amount), 0)),
    paid: desdeCentavos(report.rows.reduce((sum, row) => sum + centavos(row.paid_amount), 0)),
    balance: desdeCentavos(report.rows.reduce((sum, row) => sum + centavos(row.balance_amount), 0)),
    received: desdeCentavos(report.payments.reduce((sum, row) => sum + centavos(row.amount), 0)),
    unapplied: desdeCentavos(report.payments.reduce((sum, row) => sum + centavos(row.available), 0))
  };
  if (query.format === 'pdf') return sendPdf(reply, await accountStatementPdf(report.client, report.rows, query.from, query.to), `estado-de-cuenta-${report.client.full_name.replace(/\s+/g, '-')}-${query.from}-${query.to}.pdf`);
  if (query.format === 'csv') {
    const lines = [['Tipo', 'Fecha', 'Documento', 'Concepto', 'Facturado', 'Cobrado/aplicado', 'Saldo'].map(csvCell).join(','),
      ...report.rows.map(row => ['Factura', dmy(row.issued_on), row.invoice_number, row.concept, row.amount.toFixed(2), row.paid_amount.toFixed(2), row.balance_amount.toFixed(2)].map(csvCell).join(',')),
      ...report.payments.map(row => ['Cobro', dmy(row.paid_on), row.method, row.reference || '', '', row.amount.toFixed(2), row.available.toFixed(2)].map(csvCell).join(','))];
    reply.header('Content-Type', 'text/csv; charset=utf-8'); reply.header('Content-Disposition', `attachment; filename="estado-de-cuenta-${query.from}-${query.to}.csv"`);
    return `﻿${lines.join('\n')}`;
  }
  return { ...report, from: query.from, to: query.to, totals };
});

app.get('/api/billing/reports/receivables', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const query = z.object({ asOf: z.string().date().default(() => fechaDeNegocioPanama()), format: z.enum(['json', 'csv']).default('json') }).parse(request.query);
  const rows = await sql`
    SELECT i.id::text AS id, i.number, i.kind, i.payer_client_id::text AS payer_id, p.full_name AS payer, i.cycle_start::text AS cycle_start, i.cycle_end::text AS cycle_end,
      i.due_on::text AS due_on, i.total::text AS total, i.status,
      COALESCE((SELECT sum(a.amount) FROM billing_payment_applications a WHERE a.invoice_id = i.id AND a.reversed_at IS NULL), 0)::text AS paid
    FROM billing_invoices i JOIN clients p ON p.id = i.payer_client_id
    WHERE i.owner_id = ${auth.sub} AND i.status IN ('pendiente', 'parcial') ORDER BY i.due_on, i.number`;
  const detail = rows.map(row => {
    const balance = desdeCentavos(centavos(Number(row.total)) - centavos(Number(row.paid)));
    const daysOverdue = Math.max(0, Math.round((Date.parse(`${query.asOf}T12:00:00Z`) - Date.parse(`${String(row.due_on)}T12:00:00Z`)) / 86_400_000));
    return { code: billingCode(row.number), payerId: row.payer_id, payer: row.payer, kind: row.kind, cycleStart: row.cycle_start, cycleEnd: row.cycle_end, dueOn: row.due_on,
      total: Number(row.total), paid: Number(row.paid), balance, daysOverdue, bucket: agingBucket(daysOverdue) };
  }).filter(row => row.balance > 0);
  const buckets = ['al_dia', '1-7', '8-30', '31+'].map(bucket => ({ bucket, count: detail.filter(row => row.bucket === bucket).length,
    balance: desdeCentavos(detail.filter(row => row.bucket === bucket).reduce((sum, row) => sum + centavos(row.balance), 0)) }));
  if (query.format === 'csv') {
    const lines = [['Pagador', 'Factura', 'Modalidad', 'Ciclo', 'Vence', 'Total', 'Pagado', 'Saldo', 'Días con pago pendiente', 'Antigüedad'].map(csvCell).join(','),
      ...detail.map(row => [row.payer, row.code, row.kind, `${dmy(row.cycleStart)} → ${dmy(row.cycleEnd)}`, dmy(row.dueOn), row.total.toFixed(2), row.paid.toFixed(2), row.balance.toFixed(2), row.daysOverdue, row.bucket].map(csvCell).join(','))];
    reply.header('Content-Type', 'text/csv; charset=utf-8'); reply.header('Content-Disposition', `attachment; filename="cuentas-por-cobrar-${query.asOf}.csv"`);
    return `﻿${lines.join('\n')}`;
  }
  return { asOf: query.asOf, rows: detail, buckets, total: desdeCentavos(detail.reduce((sum, row) => sum + centavos(row.balance), 0)) };
});

app.get('/api/billing/reports/collections', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const query = z.object({ year: z.coerce.number().int().min(2020).max(2100).default(() => Number(fechaDeNegocioPanama().slice(0, 4))), format: z.enum(['json', 'csv']).default('json') }).parse(request.query);
  const rows = await sql`
    SELECT to_char(p.paid_on, 'YYYY-MM') AS month, p.method, count(*)::int AS count, sum(p.amount)::text AS total
    FROM billing_payments p WHERE p.owner_id = ${auth.sub} AND p.voided_at IS NULL AND extract(year FROM p.paid_on) = ${query.year}
    GROUP BY 1, 2 ORDER BY 1, 2`;
  const byMonth = new Map<string, { month: string; total: number; count: number; methods: Record<string, number> }>();
  for (const row of rows) {
    const entry = byMonth.get(row.month as string) ?? { month: row.month as string, total: 0, count: 0, methods: {} };
    entry.total = desdeCentavos(centavos(entry.total) + centavos(Number(row.total))); entry.count += Number(row.count);
    entry.methods[row.method as string] = Number(row.total); byMonth.set(row.month as string, entry);
  }
  const months = [...byMonth.values()];
  if (query.format === 'csv') {
    const lines = [['Mes', 'Método', 'Cobros', 'Total'].map(csvCell).join(','), ...rows.map(row => [row.month, row.method, row.count, Number(row.total).toFixed(2)].map(csvCell).join(','))];
    reply.header('Content-Type', 'text/csv; charset=utf-8'); reply.header('Content-Disposition', `attachment; filename="cobrado-${query.year}.csv"`);
    return `﻿${lines.join('\n')}`;
  }
  return { year: query.year, months, total: desdeCentavos(months.reduce((sum, row) => sum + centavos(row.total), 0)) };
});

// Morosidad: pagadores con facturas vencidas (vence ANTES de hoy) y los beneficiarios que ese atraso toca.
app.get('/api/billing/reports/delinquency', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const today = fechaDeNegocioPanama();
  const rows = await sql`
    SELECT i.id::text AS id, i.number, i.payer_client_id::text AS payer_id, p.full_name AS payer, i.due_on::text AS due_on, i.total::text AS total,
      COALESCE((SELECT sum(a.amount) FROM billing_payment_applications a WHERE a.invoice_id = i.id AND a.reversed_at IS NULL), 0)::text AS paid,
      COALESCE((SELECT array_agg(DISTINCT b.full_name ORDER BY b.full_name) FROM billing_invoice_lines l JOIN clients b ON b.id = l.beneficiary_client_id
        WHERE l.invoice_id = i.id AND l.beneficiary_client_id <> i.payer_client_id), ARRAY[]::text[]) AS beneficiaries
    FROM billing_invoices i JOIN clients p ON p.id = i.payer_client_id
    WHERE i.owner_id = ${auth.sub} AND i.status IN ('pendiente', 'parcial') AND i.due_on < ${today}::date ORDER BY i.due_on, p.full_name`;
  const payers = new Map<string, { payerId: string; payer: string; balance: number; oldestDays: number; invoices: { code: string; dueOn: string; balance: number; daysOverdue: number }[]; beneficiaries: Set<string> }>();
  for (const row of rows) {
    const balance = desdeCentavos(centavos(Number(row.total)) - centavos(Number(row.paid)));
    if (balance <= 0) continue;
    const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${String(row.due_on)}T12:00:00Z`)) / 86_400_000);
    const entry = payers.get(row.payer_id as string) ?? { payerId: row.payer_id as string, payer: row.payer as string, balance: 0, oldestDays: 0, invoices: [], beneficiaries: new Set<string>() };
    entry.balance = desdeCentavos(centavos(entry.balance) + centavos(balance)); entry.oldestDays = Math.max(entry.oldestDays, days);
    entry.invoices.push({ code: billingCode(row.number), dueOn: row.due_on as string, balance, daysOverdue: days });
    for (const name of (row.beneficiaries as string[])) entry.beneficiaries.add(name);
    payers.set(row.payer_id as string, entry);
  }
  const list = [...payers.values()].map(entry => ({ ...entry, beneficiaries: [...entry.beneficiaries] })).sort((a, b) => b.oldestDays - a.oldestDays);
  return { today, payers: list, total: desdeCentavos(list.reduce((sum, entry) => sum + centavos(entry.balance), 0)) };
});

app.get('/api/billing/audit', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
  const rows = await sql`
    SELECT a.at, a.action, a.entity, a.entity_id::text AS entity_id, a.detail, u.email AS user_email
    FROM billing_audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.owner_id = ${auth.sub} ORDER BY a.at DESC, a.id DESC LIMIT ${limit}`;
  return { entries: rows.map(row => ({ at: row.at, action: row.action, entity: row.entity, entityId: row.entity_id, detail: row.detail, user: row.user_email ?? 'automático' })) };
});

// Diagnóstico del estado operativo (solo lectura): permite comprobar desde fuera
// qué generador está escribiendo.
app.get('/api/billing/engine-status', { preHandler: requireStaff }, async () => billingEngine);

app.post('/api/billing/recurring/generate', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const status = await recurringBillingStatus(auth.sub);
  if (status.blockedByZoho) {
    return { ...status, generated: 0, message: 'La facturación automática se activará después del corte final de Zoho.' };
  }
  if (!billingEngine.legacyWrites) {
    return { ...status, generated: 0, message: `La generación del sistema anterior está apagada (${billingEngine.state}).` };
  }
  const result = await generateRecurringInvoices(auth.sub);
  return { ...(await recurringBillingStatus(auth.sub)), generated: result.generated, balances: result.balances, reposiciones: result.reposiciones, descuentos: result.descuentos, creditInvoicesRecalculated: result.creditInvoicesRecalculated, fechasCorregidas: result.fechasCorregidas };
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
  zone: z.string().trim().max(80).optional().transform(value => value || null),
  specialFor: z.string().trim().max(120).optional().transform(value => value || null),
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
    INSERT INTO service_plans (owner_id, name, description, billing_model, price, sessions_included, validity_days, zone, special_for, active)
    VALUES (${auth.sub}, ${input.name}, ${input.description || null}, ${input.billingModel}, ${input.price}, ${input.billingModel === 'single' ? null : input.sessionsIncluded!}, ${input.billingModel === 'package' ? input.validityDays || 30 : null}, ${input.zone}, ${input.specialFor}, ${input.active})
    RETURNING *
  `;
  return reply.code(201).send(plan);
});

app.patch('/api/plans/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id); const input = planSchema.parse(request.body);
  const [plan] = await sql`
    UPDATE service_plans SET name = ${input.name}, description = ${input.description || null}, billing_model = ${input.billingModel},
      price = ${input.price}, sessions_included = ${input.billingModel === 'single' ? null : input.sessionsIncluded!},
      validity_days = ${input.billingModel === 'package' ? input.validityDays || 30 : null}, zone = ${input.zone}, special_for = ${input.specialFor}, active = ${input.active}, updated_at = now()
    WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING *
  `;
  if (!plan) return reply.code(404).send({ error: 'Plan no encontrado' });
  // E1 (J-092, C-113): el catálogo es una lista de TARIFAS DE REFERENCIA, no un vínculo vivo. Editar una tarifa NO cambia el precio ni la mensualidad de los
  // clientes que ya la tienen: cada expediente conserva su copia (standard_price, billing_model...) y su Plan de facturación; la tarifa nueva solo rige para
  // asignaciones futuras. (Antes se propagaba el precio a clients.standard_price y a memberships.)
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
  // Tarifa por sesión para clientes que entrenan a crédito. Vacío conserva la
  // tarifa guardada al editar; al crear, el valor pactado de Julio es $25.
  creditSessionPrice: z.union([z.literal(''), z.null(), z.coerce.number().positive().max(10000)]).optional()
    .transform(value => (value === '' || value === undefined ? null : value)),
  // Quién paga por este cliente. Vacío = paga él mismo.
  billingResponsibleClientId: z.union([z.literal(''), z.null(), z.string().uuid()]).optional()
    .transform(value => (value === '' || value === undefined ? null : value)),
  // Desactivar en vez de borrar: quien deja de entrenar conserva su expediente,
  // su historial de InBody y sus cobros, pero sale de las listas del día a día.
  status: z.enum(['active', 'paused', 'inactive']).optional(),
  // Anticipado (default): paga por adelantado. No anticipado: entrena a crédito
  // y paga al final; se le señala el pago pendiente. Ver migración 046.
  paymentMode: z.enum(['anticipado', 'no_anticipado']).default('anticipado')
});
const clientEditSchema = clientSchema.pick({
  fullName: true, email: true, phone: true, goal: true, notes: true,
  monthlySessionTarget: true, creditSessionPrice: true,
  billingResponsibleClientId: true, status: true, cutoffDay: true, paymentMode: true
}).extend({
  // El monto propio sólo se acepta desde el formulario explícito de edición
  // y sólo se aplica a clientes con mensualidad. No reutilizamos el default
  // de alta (0), porque omitir el campo debe conservar el precio existente.
  standardPrice: z.coerce.number().positive().max(100000).optional()
});
app.get('/api/clients', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`
    SELECT c.*, p.name AS plan_name, p.price AS plan_catalog_price, p.sessions_included, p.validity_days,
      COALESCE((SELECT sum(total_sessions - used_sessions) FROM session_packages sp WHERE sp.client_id = c.id AND sp.status = 'active' AND (sp.expires_on IS NULL OR sp.expires_on >= current_date)), 0)::integer AS available_sessions,
      -- Movimientos del ciclo en curso, separados. Este contador cuenta los
      -- eventos por sr.created_at (cuando se pidió la reprogramación), mientras
      -- que Asistencia cuenta sesiones por starts_at. No son la misma métrica.
      -- Cancelar y perder la clase
      -- no es lo mismo que pedir otro día: lo primero mide el cumplimiento del
      -- cliente, lo segundo el desgaste de la agenda. Juntos no dicen nada.
      (SELECT count(*)::int FROM session_reschedules sr
        WHERE sr.client_id = c.id AND sr.created_at >= inicio_ciclo(c.billing_cutoff_day)) AS reprogramaciones_ciclo,
      -- Sólo las que perdió el cliente. Las que canceló la entrenadora no son
      -- de él: se le reponen o se le descuentan, y contarlas aquí sería
      -- pasarle la cuenta de algo ajeno.
      (SELECT count(*)::int FROM sessions s
        WHERE s.client_id = c.id AND s.status = 'cancelled' AND s.cancellation_kind = 'not_rescheduled'
          AND COALESCE(s.cancelled_by, 'client') = 'client'
          AND s.starts_at >= inicio_ciclo(c.billing_cutoff_day)) AS canceladas_ciclo,
      -- Y aparte, lo que canceló ella: es un número suyo, no del cliente, pero
      -- verlo junto al otro dice de un vistazo de quién viene el desorden.
      (SELECT count(*)::int FROM sessions s
        WHERE s.client_id = c.id AND s.status = 'cancelled' AND s.cancelled_by = 'trainer'
          AND s.starts_at >= inicio_ciclo(c.billing_cutoff_day)) AS canceladas_por_ella_ciclo,
      -- Descuentos que se le deben y todavía no se han aplicado. Sin verlos,
      -- la única señal de que existen es que un cobro sale más bajo el mes que
      -- viene, y para entonces ya nadie recuerda por qué.
      COALESCE((SELECT sum(bc.amount) FROM billing_credits bc
        WHERE bc.client_id = c.id AND bc.applied_invoice_id IS NULL), 0)::numeric(12,2) AS credito_pendiente,
      -- Lo que se debe por las clases de esta persona, aunque el cobro salga a
      -- nombre de quien paga. El saldo se renueva igual —no se le cierra la
      -- puerta a nadie por un pago que entra tarde—, pero queda dicho.
      ${billingEngine.state === 'new' ? sql`COALESCE((
        -- Fuente nueva: lo que falta pagar de las líneas de ESTA persona en facturas abiertas (su parte proporcional del saldo).
        SELECT sum(l.amount * (GREATEST(bi.total - COALESCE((SELECT sum(a.amount) FROM billing_payment_applications a WHERE a.invoice_id = bi.id AND a.reversed_at IS NULL), 0), 0) / NULLIF(bi.total, 0)))
        FROM billing_invoice_lines l JOIN billing_invoices bi ON bi.id = l.invoice_id
        WHERE l.beneficiary_client_id = c.id AND bi.status IN ('pendiente', 'parcial') AND l.line_type = 'plan'
      ), 0)::numeric(12,2)` : sql`COALESCE((
        SELECT sum(CASE WHEN i.source_system = 'zoho_invoice' THEN i.balance
          ELSE GREATEST(i.amount - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), 0), 0)
        END)
        FROM invoices i
        WHERE COALESCE(i.billed_for_client_id, i.client_id) = c.id AND i.status = 'pending'
      ), 0)::numeric(12,2)`} AS deuda_pendiente
      ,pp.id AS active_pause_id, pp.starts_on AS pause_started_on, pp.reason AS pause_reason,
      pp.package_id AS paused_package_id
    FROM clients c LEFT JOIN service_plans p ON p.id = c.plan_id
      LEFT JOIN LATERAL (SELECT id, starts_on, reason, package_id FROM client_package_pauses
        WHERE client_id = c.id AND status = 'active' LIMIT 1) pp ON true
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
      INSERT INTO clients (owner_id, full_name, email, phone, goal, notes, billing_model, standard_price, plan_id, billing_cutoff_day, payment_mode, credit_session_price)
      VALUES (${auth.sub}, ${input.fullName}, ${input.email || null}, ${input.phone || null}, ${input.goal || null}, ${input.notes || null}, ${billingModel}, ${standardPrice}, ${selectedPlan?.id || null}, ${input.cutoffDay}, ${input.paymentMode}, ${input.creditSessionPrice ?? (input.paymentMode === 'no_anticipado' ? 25 : null)}) RETURNING *
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
      const expiresOn = vencePaqueteDesde(new Date());
      const [pack] = await transaction`INSERT INTO session_packages (client_id, label, total_sessions, amount, expires_on) VALUES (${client.id}, ${selectedPlan?.name || `Paquete ${packageSessions} sesiones`}, ${packageSessions}, ${standardPrice}, ${expiresOn}) RETURNING id`;
      if (billingEngine.legacyWrites) await transaction`INSERT INTO invoices (client_id, package_id, concept, amount, due_on) VALUES (${client.id}, ${pack.id}, 'Paquete de sesiones', ${standardPrice}, current_date)`;
    }
    return client;
  });
  if (!result) return reply.code(404).send({ error: 'Plan no encontrado o inactivo' });
  return reply.code(201).send(result);
});

app.patch('/api/clients/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = clientEditSchema.parse(request.body);
  // cutoffDay lleva .default(1) en el esquema, así que si no viene en el cuerpo
  // llega valiendo 1: editar sólo el nombre habría movido el día de cobro al
  // primero de mes sin avisar. Se mira si venía de verdad.
  const tocaCorte = 'cutoffDay' in (request.body as Record<string, unknown>);
  // Igual que cutoffDay: paymentMode tiene .default('anticipado'), así que si no
  // viene en el cuerpo no debe pisar la modalidad ya guardada.
  const tocaModalidad = 'paymentMode' in (request.body as Record<string, unknown>);
  const tocaTarifaCredito = 'creditSessionPrice' in (request.body as Record<string, unknown>);
  const tocaMontoMensual = 'standardPrice' in (request.body as Record<string, unknown>);
  const montoMensualSolicitado = input.standardPrice ?? 0;
  if (tocaMontoMensual && input.standardPrice === undefined) {
    return reply.code(400).send({ error: 'El monto mensual es obligatorio' });
  }
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
  const desactiva = input.status === 'inactive';
  const actualizacion = await sql.begin(async transaction => {
    const [antes] = await transaction`
      SELECT status, billing_model, standard_price
      FROM clients WHERE id = ${id} AND owner_id = ${auth.sub} FOR UPDATE
    `;
    if (!antes) return null;
    if (tocaMontoMensual && antes.billing_model !== 'monthly') {
      sessionStateConflict('El monto mensual sólo aplica a clientes con mensualidad');
    }
    const cambiaMontoMensual = tocaMontoMensual && Number(antes.standard_price) !== Number(montoMensualSolicitado);
    let membresiaMensual: { id: string } | undefined;
    if (cambiaMontoMensual) {
      const membresias = await transaction`
        SELECT id FROM memberships
        WHERE client_id = ${id} AND status = 'active'
        FOR UPDATE
      `;
      membresiaMensual = membresias[0] as { id: string } | undefined;
      if (!membresiaMensual) {
        sessionStateConflict('El cliente mensual no tiene una membresía activa para actualizar');
      }
    }

    const [client] = await transaction`UPDATE clients SET full_name = ${input.fullName}, email = ${input.email || null}, phone = ${input.phone || null}, goal = ${input.goal || null}, notes = ${input.notes || null}, monthly_session_target = ${input.monthlySessionTarget ?? null}, credit_session_price = CASE WHEN ${tocaTarifaCredito} THEN ${input.creditSessionPrice ?? null} WHEN ${tocaModalidad} AND ${input.paymentMode} = 'no_anticipado' AND credit_session_price IS NULL THEN 25 ELSE credit_session_price END, billing_responsible_client_id = ${input.billingResponsibleClientId ?? null}, status = COALESCE(${input.status ?? null}, status),
      standard_price = CASE WHEN ${tocaMontoMensual} THEN ${montoMensualSolicitado}::numeric ELSE standard_price END,
      billing_cutoff_day = CASE WHEN ${tocaCorte} THEN ${input.cutoffDay}::int ELSE billing_cutoff_day END,
      payment_mode = CASE WHEN ${tocaModalidad} THEN ${input.paymentMode} ELSE payment_mode END, updated_at = now() WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING *`;

    if (cambiaMontoMensual) {
      await transaction`UPDATE memberships SET amount = ${montoMensualSolicitado} WHERE id = ${membresiaMensual!.id}`;
      await transaction`
        INSERT INTO audit_log (user_id, user_email, action, route, target_id, detail, ip)
        VALUES (${auth.sub}, ${auth.email || null}, 'UPDATE_CLIENT_MONTHLY_AMOUNT',
          ${request.routeOptions?.url || request.url}, ${id},
          ${transaction.json({ previousAmount: Number(antes.standard_price), newAmount: Number(montoMensualSolicitado), membershipId: membresiaMensual!.id })},
          ${request.ip || null})
      `;
    }

    // La membresía guarda su propio día de renovación. Si sólo se moviera el
    // del cliente, quedarían dos fechas distintas para lo mismo y cuál manda
    // dependería de por dónde se mire.
    if (tocaCorte) {
      // memberships no tiene updated_at; añadirlo aquí rompía el guardado entero.
      await transaction`UPDATE memberships SET renewal_day = ${input.cutoffDay} WHERE client_id = ${id} AND status = 'active'`;
      await actualizarFacturasFuturasPorCorte(transaction, id, input.cutoffDay);
    }

    // Inactivar termina el contrato operativo: el expediente y el historial
    // permanecen, pero el horario futuro deja de reservar un hueco. Se listan
    // aquí, antes de borrarlas, para retirar también sus eventos de Google
    // después de cerrar la transacción.
    let futuras: string[] = [];
    if (desactiva && antes.status !== 'inactive') {
      await transaction`
        UPDATE session_recurrences
        SET active = false, stopped_at = now(),
            stopped_reason = 'Cliente marcado inactivo', updated_at = now()
        WHERE client_id = ${id} AND active = true
      `;
      const sesiones = await transaction`
        SELECT id FROM sessions
        WHERE client_id = ${id} AND starts_at > now() AND status = 'scheduled'
        FOR UPDATE
      `;
      futuras = sesiones.map(sesion => String(sesion.id));
    }
    return { client, futuras };
  });
  if (!actualizacion) return reply.code(404).send({ error: 'Cliente no encontrado' });

  // Google necesita que la fila aún exista para encontrar el evento asociado.
  // Un fallo de sincronización no debe conservar un horario que el cliente ya
  // no puede ocupar, por eso se registra y se continúa con la liberación local.
  for (const sessionId of actualizacion.futuras) {
    try { await removeSessionFromGoogle(auth.sub, sessionId); }
    catch (error) { app.log.warn({ err: error, sessionId }, 'Sesión liberada pero el evento sigue en Google Calendar'); }
  }
  if (actualizacion.futuras.length) {
    await sql`
      DELETE FROM sessions
      WHERE id IN ${sql(actualizacion.futuras)} AND client_id = ${id}
        AND starts_at > now() AND status = 'scheduled'
    `;
  }
  return actualizacion.client;
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

// ── Cobro declarativo del expediente (etapa 1A) ───────────────────────────
// Estas líneas describen el acuerdo comercial, pero todavía no emiten cobros
// ni sustituyen al motor legado. Son deliberadamente aditivas y reversibles:
// el expediente puede prepararse mientras la facturación actual sigue intacta.
const billingSubscriptionKinds = ['monthly', 'credit', 'package'] as const;
const billingSubscriptionInput = z.object({
  beneficiaryClientId: z.string().uuid().optional(),
  payerClientId: z.string().uuid().optional(),
  kind: z.enum(billingSubscriptionKinds),
  cycleDays: z.coerce.number().int().min(1).max(366).nullable().optional(),
  sessionsReference: z.coerce.number().int().positive().max(1000).nullable().optional(),
  startsOn: z.string().date(),
  endsOn: z.string().date().nullable().optional(),
  price: z.coerce.number().positive().max(100000),
  autoGenerate: z.boolean().default(true)
}).superRefine((value, context) => {
  if (value.endsOn && value.startsOn > value.endsOn) context.addIssue({ code: z.ZodIssueCode.custom, path: ['endsOn'], message: 'La fecha final no puede ser anterior a la inicial' });
  if (value.kind === 'package' && !value.cycleDays) context.addIssue({ code: z.ZodIssueCode.custom, path: ['cycleDays'], message: 'Un paquete requiere días de ciclo' });
  if (value.kind !== 'package' && value.cycleDays != null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['cycleDays'], message: 'Los cobros mensuales o a crédito no usan días de ciclo' });
});
const billingSubscriptionPatch = z.object({
  price: z.coerce.number().positive().max(100000).optional(),
  startsOn: z.string().date().optional(),
  endsOn: z.string().date().nullable().optional(),
  cycleDays: z.coerce.number().int().min(1).max(366).nullable().optional(),
  sessionsReference: z.coerce.number().int().positive().max(1000).nullable().optional(),
  autoGenerate: z.boolean().optional()
});

function dayAfter(date: string): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function dayBefore(date: string): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function dateOnly(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function billingSubscriptionValue(row: Record<string, any>) {
  return {
    id: row.id,
    beneficiaryClientId: row.beneficiary_client_id,
    beneficiaryName: row.beneficiary_name,
    payerClientId: row.payer_client_id,
    payerName: row.payer_name,
    kind: row.kind,
    cycleDays: row.cycle_days == null ? null : Number(row.cycle_days),
    sessionsReference: row.sessions_reference == null ? null : Number(row.sessions_reference),
    startsOn: dateOnly(row.starts_on),
    endsOn: row.ends_on ? dateOnly(row.ends_on) : null,
    price: Number(row.price),
    autoGenerate: row.auto_generate !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function auditBillingSubscription(transaction: TransactionSql, request: FastifyRequest, auth: AuthUser, action: string, id: string, previous: unknown, next: unknown) {
  await transaction`
    INSERT INTO audit_log (user_id, user_email, action, route, target_id, detail, ip)
    VALUES (${auth.sub}, ${auth.email || null}, ${action}, ${request.routeOptions?.url || request.url}, ${id},
      ${transaction.json({ previous: previous as any, next: next as any })}, ${request.ip || null})
  `;
}

async function assertBillingClients(transaction: TransactionSql, ownerId: string, beneficiaryId: string, payerId: string) {
  const clients = await transaction`
    SELECT id, full_name, billing_responsible_client_id, billing_model, payment_mode,
      standard_price, credit_session_price, billing_cutoff_day, monthly_session_target,
      plan_id, created_at
    FROM clients WHERE owner_id = ${ownerId} AND (id = ${beneficiaryId} OR id = ${payerId})
  `;
  const beneficiary = clients.find(client => client.id === beneficiaryId);
  const payer = clients.find(client => client.id === payerId);
  if (!beneficiary || !payer) return { beneficiary: null, payer: null };
  // La línea declarativa permite que un beneficiario tenga una línea propia y
  // otra familiar. Sólo se prohíbe encadenar a un pagador que ya depende de
  // otro cliente; no se toca billing_responsible_client_id.
  if (payerId !== beneficiaryId && payer.billing_responsible_client_id) {
    sessionStateConflict('El pagador seleccionado depende de otro cliente y no puede encadenarse');
  }
  return { beneficiary, payer };
}

async function assertSubscriptionNoOverlap(transaction: TransactionSql, ownerId: string, input: { beneficiaryClientId: string; payerClientId: string; kind: string; startsOn: string; endsOn?: string | null }, excludeId?: string) {
  const [overlap] = await transaction`
    SELECT id FROM billing_subscriptions
    WHERE owner_id = ${ownerId}
      AND beneficiary_client_id = ${input.beneficiaryClientId}
      AND payer_client_id = ${input.payerClientId}
      AND kind = ${input.kind}
      AND (${excludeId || null}::uuid IS NULL OR id <> ${excludeId || null}::uuid)
      AND starts_on <= COALESCE(${input.endsOn || null}::date, '9999-12-31'::date)
      AND COALESCE(ends_on, '9999-12-31'::date) >= ${input.startsOn}::date
    FOR UPDATE
  `;
  if (overlap) sessionStateConflict('Ya existe un concepto a facturar del mismo tipo para ese beneficiario y pagador en ese período');
}

app.get('/api/clients/:id/billing-subscriptions', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const clientId = z.string().uuid().parse((request.params as { id: string }).id);
  const [focus] = await sql`
    SELECT c.id, c.full_name, c.billing_responsible_client_id, c.billing_model, c.payment_mode,
      c.standard_price, c.credit_session_price, c.billing_cutoff_day, c.monthly_session_target,
      c.plan_id, c.created_at
    FROM clients c WHERE c.id = ${clientId} AND c.owner_id = ${auth.sub}
  `;
  if (!focus) return reply.code(404).send({ error: 'Cliente no encontrado' });
  const rows = await sql`
    SELECT bs.*, b.full_name AS beneficiary_name, p.full_name AS payer_name
    FROM billing_subscriptions bs
    JOIN clients b ON b.id = bs.beneficiary_client_id
    JOIN clients p ON p.id = bs.payer_client_id
    WHERE bs.owner_id = ${auth.sub} AND (bs.beneficiary_client_id = ${clientId} OR bs.payer_client_id = ${clientId})
    ORDER BY bs.starts_on DESC, bs.created_at DESC
  ` as unknown as Record<string, any>[];
  const hoy = fechaDeNegocioPanama();
  const lines = rows.map(billingSubscriptionValue);
  // Vigente HOY = ya empezó y no ha terminado. Las líneas que empiezan después (un monto nuevo del próximo corte) no suman al total de hoy; se muestran aparte como "próximo".
  const activeOn = (row: Record<string, any>, day: string) => dateOnly(row.starts_on) <= day && (!row.ends_on || dateOnly(row.ends_on) >= day);
  const active = rows.filter(row => !row.ends_on || dateOnly(row.ends_on) >= hoy);
  const payerActive = rows.filter(row => row.payer_client_id === clientId && activeOn(row, hoy));
  const breakdown = payerActive.map(row => ({ beneficiaryClientId: row.beneficiary_client_id, beneficiaryName: row.beneficiary_name, amount: Number(row.price), kind: row.kind }));
  const nextStart = rows.filter(row => row.payer_client_id === clientId && dateOnly(row.starts_on) > hoy).map(row => dateOnly(row.starts_on)).sort()[0] ?? null;
  const upcoming = nextStart ? (() => {
    const lines = rows.filter(row => row.payer_client_id === clientId && activeOn(row, nextStart));
    return { startsOn: nextStart, totalForPayer: lines.reduce((sum, row) => sum + Number(row.price), 0), breakdown: lines.map(row => ({ beneficiaryClientId: row.beneficiary_client_id, beneficiaryName: row.beneficiary_name, amount: Number(row.price), kind: row.kind })) };
  })() : null;
  const payersOfFocus = [...new Set(rows.filter(row => row.beneficiary_client_id === clientId && row.payer_client_id !== clientId && activeOn(row, hoy)).map(row => row.payer_name as string))];
  const candidates = await sql`
    SELECT c.id, c.full_name, c.billing_responsible_client_id, c.billing_model, c.payment_mode,
      c.standard_price, c.credit_session_price, c.billing_cutoff_day, c.monthly_session_target,
      c.plan_id, c.created_at, p.validity_days, p.sessions_included
    FROM clients c LEFT JOIN service_plans p ON p.id = c.plan_id
    WHERE c.owner_id = ${auth.sub} AND (c.id = ${clientId} OR c.billing_responsible_client_id = ${clientId})
    ORDER BY c.id = ${clientId} DESC, c.full_name
  ` as unknown as Record<string, any>[];
  const proposal = candidates.flatMap(candidate => {
    const kind = candidate.billing_model === 'package' ? 'package' : candidate.payment_mode === 'no_anticipado' ? 'credit' : 'monthly';
    const payerId = candidate.billing_responsible_client_id || candidate.id;
    const hasLine = rows.some(row => row.beneficiary_client_id === candidate.id && row.payer_client_id === payerId && row.kind === kind && (!row.ends_on || dateOnly(row.ends_on) >= hoy));
    if (hasLine) return [];
    return [{
      beneficiaryClientId: candidate.id, beneficiaryName: candidate.full_name, payerClientId: payerId,
      payerName: payerId === clientId ? focus.full_name : candidate.full_name, kind,
      cycleDays: kind === 'package' ? Number(candidate.validity_days || 35) : null,
      sessionsReference: Number(candidate.monthly_session_target || candidate.sessions_included || 0) || null,
      startsOn: cicloDelCorte(hoy, Number(candidate.billing_cutoff_day) || 1).inicio, endsOn: null,
      price: Number(kind === 'credit' ? candidate.credit_session_price || 25 : candidate.standard_price || 0),
      autoGenerate: true
    }];
  });
  return { client: { id: focus.id, name: focus.full_name }, lines, proposal, summary: { payerId: clientId, payerName: focus.full_name, totalForPayer: payerActive.reduce((sum, row) => sum + Number(row.price), 0), breakdown, upcoming, paidBy: payersOfFocus } };
});

app.post('/api/clients/:id/billing-subscriptions', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const routeClientId = z.string().uuid().parse((request.params as { id: string }).id);
  const parsed = billingSubscriptionInput.parse(request.body);
  const beneficiaryClientId = parsed.beneficiaryClientId || routeClientId;
  const payerClientId = parsed.payerClientId || beneficiaryClientId;
  const created = await sql.begin(async transaction => {
    const { beneficiary, payer } = await assertBillingClients(transaction, auth.sub, beneficiaryClientId, payerClientId);
    if (!beneficiary || !payer) return null;
    await assertSubscriptionNoOverlap(transaction, auth.sub, { beneficiaryClientId, payerClientId, kind: parsed.kind, startsOn: parsed.startsOn, endsOn: parsed.endsOn });
    const [row] = await transaction`
      INSERT INTO billing_subscriptions (owner_id, beneficiary_client_id, payer_client_id, kind, cycle_days, sessions_reference, starts_on, ends_on, price, auto_generate)
      VALUES (${auth.sub}, ${beneficiaryClientId}, ${payerClientId}, ${parsed.kind}, ${parsed.cycleDays ?? null}, ${parsed.sessionsReference ?? null}, ${parsed.startsOn}, ${parsed.endsOn || null}, ${parsed.price}, ${parsed.autoGenerate})
      RETURNING *
    `;
    await auditBillingSubscription(transaction, request, auth, 'CREATE_BILLING_SUBSCRIPTION', row.id, null, billingSubscriptionValue({ ...row, beneficiary_name: beneficiary.full_name, payer_name: payer.full_name }));
    return row;
  });
  if (!created) return reply.code(404).send({ error: 'Cliente beneficiario o pagador no encontrado' });
  const [result] = await sql`SELECT bs.*, b.full_name AS beneficiary_name, p.full_name AS payer_name FROM billing_subscriptions bs JOIN clients b ON b.id = bs.beneficiary_client_id JOIN clients p ON p.id = bs.payer_client_id WHERE bs.id = ${created.id}`;
  return reply.code(201).send(billingSubscriptionValue(result));
});

app.patch('/api/billing-subscriptions/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = billingSubscriptionPatch.parse(request.body);
  const updated = await sql.begin(async transaction => {
    const [current] = await transaction`
      SELECT bs.*, b.full_name AS beneficiary_name, p.full_name AS payer_name
      FROM billing_subscriptions bs JOIN clients b ON b.id = bs.beneficiary_client_id JOIN clients p ON p.id = bs.payer_client_id
      WHERE bs.id = ${id} AND bs.owner_id = ${auth.sub} FOR UPDATE
    ` as unknown as Record<string, any>[];
    if (!current) return null;
    const oldValue = billingSubscriptionValue(current);
    const nextStart = input.startsOn || dateOnly(current.starts_on);
    const nextEnd = input.endsOn === undefined ? (current.ends_on ? dateOnly(current.ends_on) : null) : input.endsOn;
    if (nextEnd && nextStart > nextEnd) sessionStateConflict('La fecha final no puede ser anterior a la inicial');
    const amountChanged = input.price !== undefined && Number(input.price) !== Number(current.price);
    if (amountChanged) {
      if (!input.startsOn || input.startsOn <= dateOnly(current.starts_on)) sessionStateConflict(`Un cambio de monto debe empezar DESPUÉS del inicio de la línea (${dateOnly(current.starts_on).split('-').reverse().join('-')}): elige en "Desde" la fecha desde la que rige el monto nuevo, por ejemplo el próximo corte`);
      const oldEnd = dayBefore(input.startsOn);
      await transaction`UPDATE billing_subscriptions SET ends_on = ${oldEnd}, updated_at = now() WHERE id = ${id}`;
      await assertSubscriptionNoOverlap(transaction, auth.sub, { beneficiaryClientId: current.beneficiary_client_id, payerClientId: current.payer_client_id, kind: current.kind, startsOn: input.startsOn, endsOn: nextEnd }, id);
      const [replacement] = await transaction`
        INSERT INTO billing_subscriptions (owner_id, beneficiary_client_id, payer_client_id, kind, cycle_days, sessions_reference, starts_on, ends_on, price, auto_generate)
        VALUES (${auth.sub}, ${current.beneficiary_client_id}, ${current.payer_client_id}, ${current.kind}, ${input.cycleDays ?? current.cycle_days}, ${input.sessionsReference ?? current.sessions_reference}, ${input.startsOn}, ${nextEnd}, ${input.price ?? current.price}, ${input.autoGenerate ?? (current.auto_generate !== false)}) RETURNING *
      `;
      await auditBillingSubscription(transaction, request, auth, 'REPLACE_BILLING_SUBSCRIPTION', id, oldValue, billingSubscriptionValue({ ...replacement, beneficiary_name: current.beneficiary_name, payer_name: current.payer_name }));
      return replacement;
    }
    if (input.startsOn && input.startsOn !== dateOnly(current.starts_on)) sessionStateConflict('La fecha inicial histórica no se puede editar; cierre el concepto y abra otro');
    if (input.cycleDays !== undefined && current.kind !== 'package' && input.cycleDays !== null) sessionStateConflict('Sólo los paquetes usan días de ciclo');
    await assertSubscriptionNoOverlap(transaction, auth.sub, { beneficiaryClientId: current.beneficiary_client_id, payerClientId: current.payer_client_id, kind: current.kind, startsOn: nextStart, endsOn: nextEnd }, id);
    const [row] = await transaction`
      UPDATE billing_subscriptions SET ends_on = ${nextEnd}, cycle_days = ${input.cycleDays === undefined ? current.cycle_days : input.cycleDays}, sessions_reference = ${input.sessionsReference === undefined ? current.sessions_reference : input.sessionsReference}, auto_generate = ${input.autoGenerate === undefined ? current.auto_generate !== false : input.autoGenerate}, updated_at = now()
      WHERE id = ${id} RETURNING *
    `;
    await auditBillingSubscription(transaction, request, auth, nextEnd ? 'CLOSE_BILLING_SUBSCRIPTION' : 'UPDATE_BILLING_SUBSCRIPTION', id, oldValue, billingSubscriptionValue({ ...row, beneficiary_name: current.beneficiary_name, payer_name: current.payer_name }));
    return row;
  });
  if (!updated) return reply.code(404).send({ error: 'Concepto a facturar no encontrado' });
  const [result] = await sql`SELECT bs.*, b.full_name AS beneficiary_name, p.full_name AS payer_name FROM billing_subscriptions bs JOIN clients b ON b.id = bs.beneficiary_client_id JOIN clients p ON p.id = bs.payer_client_id WHERE bs.id = ${updated.id}`;
  return billingSubscriptionValue(result);
});

// CORREGIR el monto de una línea del plan (era un error: no un cambio de precio con fecha). Cambia el importe en el mismo registro, con motivo y bitácora; y si el
// siguiente tramo (ya programado, aún no vigente) queda con el MISMO importe, los une en una sola línea para no dejar dos líneas iguales. Las facturas no dependen de estas líneas.
app.post('/api/billing-subscriptions/:id/correct-price', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = z.object({ price: z.coerce.number().positive().max(100000), reason: z.string().trim().min(3, 'Indique el motivo').max(300) }).parse(request.body);
  const result = await sql.begin(async transaction => {
    const [current] = await transaction`
      SELECT bs.*, b.full_name AS beneficiary_name, p.full_name AS payer_name
      FROM billing_subscriptions bs JOIN clients b ON b.id = bs.beneficiary_client_id JOIN clients p ON p.id = bs.payer_client_id
      WHERE bs.id = ${id} AND bs.owner_id = ${auth.sub} FOR UPDATE` as unknown as Record<string, any>[];
    if (!current) return null;
    if (centavos(Number(current.price)) === centavos(input.price)) sessionStateConflict('El monto ya es ese');
    const hoy = fechaDeNegocioPanama();
    const oldValue = billingSubscriptionValue(current);
    await transaction`UPDATE billing_subscriptions SET price = ${input.price}, updated_at = now() WHERE id = ${id}`;
    let merged: Record<string, any> | null = null;
    if (current.ends_on) {
      const [successor] = await transaction`
        SELECT * FROM billing_subscriptions
        WHERE owner_id = ${auth.sub} AND beneficiary_client_id = ${current.beneficiary_client_id} AND payer_client_id = ${current.payer_client_id} AND kind = ${current.kind}
          AND starts_on = ${dayAfter(dateOnly(current.ends_on))}::date AND id <> ${id} FOR UPDATE` as unknown as Record<string, any>[];
      if (successor && dateOnly(successor.starts_on) > hoy && centavos(Number(successor.price)) === centavos(input.price) && successor.auto_generate === current.auto_generate) {
        await transaction`DELETE FROM billing_subscriptions WHERE id = ${successor.id}`;
        await transaction`UPDATE billing_subscriptions SET ends_on = ${successor.ends_on ? dateOnly(successor.ends_on) : null}, updated_at = now() WHERE id = ${id}`;
        merged = successor;
      }
    }
    const [row] = await transaction`
      SELECT bs.*, b.full_name AS beneficiary_name, p.full_name AS payer_name
      FROM billing_subscriptions bs JOIN clients b ON b.id = bs.beneficiary_client_id JOIN clients p ON p.id = bs.payer_client_id WHERE bs.id = ${id}` as unknown as Record<string, any>[];
    await auditBillingSubscription(transaction, request, auth, 'CORRECT_BILLING_SUBSCRIPTION_PRICE', id, oldValue,
      { ...billingSubscriptionValue(row), reason: input.reason, mergedWith: merged ? billingSubscriptionValue({ ...merged, beneficiary_name: current.beneficiary_name, payer_name: current.payer_name }) : null });
    return { line: billingSubscriptionValue(row), merged: Boolean(merged) };
  });
  if (!result) return reply.code(404).send({ error: 'Concepto a facturar no encontrado' });
  return result;
});

// planId elige un plan existente; model 'single' pasa al cliente a clase suelta
// directo, sin necesidad de crear un plan de sesión suelta.
const clientPlanSchema = z.object({
  planId: z.string().uuid().optional(),
  model: z.enum(['single']).optional(),
  // Precio de referencia para clase suelta: prellena el cobro, pero cada cobro
  // se puede editar (montos variables, cobros de grupo por separado).
  referencePrice: z.coerce.number().min(0).optional(),
  cutoffDay: z.coerce.number().int().min(1).max(31)
}).refine(v => v.planId || v.model, { message: 'Falta el plan o el modelo' });
app.patch('/api/clients/:id/plan', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id); const input = clientPlanSchema.parse(request.body);
  const result = await sql.begin(async transaction => {
    await lockBillingClient(transaction, id);
    // Clase suelta directa: se cobra por sesión, sin bolsa ni mensualidad. Se
    // limpia la meta mensual y se pausa la membresía; conserva cumplimiento.
    if (input.model === 'single' && !input.planId) {
      const [client] = await transaction`
        UPDATE clients SET billing_model = 'single', plan_id = NULL, monthly_session_target = NULL,
          -- El precio de referencia sólo se toca si viene en la petición; si no,
          -- se respeta el que tenía.
          standard_price = COALESCE(${input.referencePrice ?? null}::numeric, standard_price),
          billing_cutoff_day = ${input.cutoffDay}, updated_at = now()
        WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING *
      `;
      if (!client) return null;
      await transaction`UPDATE memberships SET status = 'paused' WHERE client_id = ${id} AND status = 'active'`;
      await actualizarFacturasFuturasPorCorte(transaction, id, input.cutoffDay);
      return client;
    }
    if (!input.planId) return null;
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
      // Abrir el saldo del ciclo actual al asignar la mensualidad, para no
      // depender de "Generar cobros pendientes". Sólo si el plan trae sesiones y
      // no hay ya un saldo mensual vigente (mismo criterio anti-duplicado que la
      // generación y que el confirmar el pago). El cobro del ciclo lo sigue
      // emitiendo la generación —el índice de facturas evita duplicarlo—; esto
      // sólo adelanta el saldo para poder descontar clases desde ya. Nace activo
      // igual que en la generación (la mensualidad se paga por adelantado), y se
      // descuentan las clases ya dadas del ciclo.
      if (plan.sessions_included) {
        const [ciclo] = await transaction`SELECT inicio_ciclo(${input.cutoffDay})::text AS inicio`;
        const inicio = String(ciclo.inicio).slice(0, 10);
        const vence = corteSiguiente(mediodiaEnPanama(inicio), input.cutoffDay).toISOString().slice(0, 10);
        // Se compara contra el INICIO del ciclo nuevo, no contra hoy: un saldo
        // del ciclo anterior que vence justo el día de corte (expires_on = inicio)
        // no debe bloquear el del ciclo nuevo. Sólo bloquea uno que se extienda
        // más allá del inicio (o sea, que ya cubra este ciclo).
        const [existe] = await transaction`
          SELECT 1 FROM session_packages
          WHERE client_id = ${id} AND kind = 'monthly' AND status = 'active'
            AND expires_on IS NOT NULL AND expires_on > ${inicio}::date
          LIMIT 1`;
        if (!existe) {
          const [saldo] = await transaction`
            INSERT INTO session_packages (client_id, label, total_sessions, amount, expires_on, kind, purchased_on, status)
            VALUES (${id}, ${'Mensualidad · ' + rangoDelCiclo(inicio, vence)}, ${plan.sessions_included}, ${plan.price}, ${vence}::date, 'monthly', ${inicio}::date, 'active')
            RETURNING id`;
          await cobrarClasesYaDadas(transaction, saldo.id as string, id, vence, Number(plan.sessions_included));
        }
      }
    } else {
      await transaction`UPDATE memberships SET status = 'paused' WHERE client_id = ${id} AND status = 'active'`;
      // Las sesiones individuales no abren saldo ni cobro por adelantado: no
      // hay bolsa que crear. Sin este corte se insertaría un paquete con
      // total_sessions nulo y una factura por una sesión que aún no ocurrió.
      // También se limpia la meta mensual: la que hubiera quedado del plan
      // anterior seguiría midiendo el cumplimiento contra algo ya no pactado.
      if (plan.billing_model === 'single') {
        await transaction`UPDATE clients SET monthly_session_target = NULL WHERE id = ${id}`;
        await actualizarFacturasFuturasPorCorte(transaction, id, input.cutoffDay);
        return client;
      }
      const [existingPackage] = await transaction`SELECT id FROM session_packages WHERE client_id = ${id} AND status IN ('pending', 'active') AND label = ${plan.name} ORDER BY created_at DESC LIMIT 1`;
      if (!existingPackage) {
        const expiresOn = vencePaqueteDesde(new Date());
        const [createdPackage] = await transaction`INSERT INTO session_packages (client_id, label, total_sessions, amount, expires_on) VALUES (${id}, ${plan.name}, ${plan.sessions_included}, ${plan.price}, ${expiresOn}) RETURNING id`;
        if (billingEngine.legacyWrites) await transaction`INSERT INTO invoices (client_id, package_id, concept, amount, due_on) VALUES (${id}, ${createdPackage.id}, ${plan.name}, ${plan.price}, current_date)`;
      }
    }
    await actualizarFacturasFuturasPorCorte(transaction, id, input.cutoffDay);
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

// Un paquete de clases vive 6 semanas (42 días) desde el pago: ese es el tope de
// uso, hasta donde se pueden seguir descontando clases si aún quedan. A las 4
// semanas (28 días) sólo se marca "renovación pendiente" —no corta el uso—; el
// corte anticipado (perder clases) pasa sólo cuando la entrenadora renueva.
const DIAS_USO_PAQUETE = 42;
const DIAS_RENOVACION_PAQUETE = 28;
function vencePaqueteDesde(fecha: Date | string): string {
  const inicio = mediodiaEnPanama(fecha);
  return new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth(), inicio.getUTCDate() + DIAS_USO_PAQUETE)).toISOString().slice(0, 10);
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
  return sql`
    SELECT p.*, c.full_name,
      oi.invoice_number AS origin_invoice_number, oi.concept AS origin_concept,
      oi.source_system AS origin_source, oi.status AS origin_status,
      COALESCE(oi.confirmed_at::date, oi.issued_on, oi.due_on) AS origin_date,
      -- Paquete de clases pasado el mes (4 semanas) pero aún dentro del tope de
      -- uso: toca renovarlo, sin cortar el uso todavía.
      (p.kind = 'package' AND p.status = 'active' AND p.purchased_on IS NOT NULL
        AND p.purchased_on + ${DIAS_RENOVACION_PAQUETE}::int <= current_date) AS renovacion_pendiente,
      (p.expires_on IS NOT NULL AND p.expires_on < current_date AND p.used_sessions < p.total_sessions) AS vencido_con_saldo,
      -- El saldo se abre y se usa desde ya (el cliente entrena aunque pague días
      -- después), pero mientras el cobro que lo financia siga pendiente hay que
      -- poder verlo. Se mira por cualquiera de los dos enlaces cobro↔saldo.
      (EXISTS (
        SELECT 1 FROM invoices iv
        WHERE (iv.id = p.origin_invoice_id OR iv.package_id = p.id)
          AND iv.status = 'pending'
      )) AS pago_pendiente
    FROM session_packages p JOIN clients c ON c.id = p.client_id
    LEFT JOIN invoices oi ON oi.id = p.origin_invoice_id
    WHERE c.owner_id = ${auth.sub} AND p.status <> 'cancelled' ORDER BY p.created_at DESC`;
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
  // El paquete de clases vence a las 6 semanas del pago (tope de uso). La
  // mensualidad, en el próximo corte. Sin vencimiento, las sesiones no
  // caducarían nunca y se acumularían.
  // Una sola referencia de negocio para resolver el ciclo: sin esto, el
  // vencimiento y purchased_on podían salir de relojes/zona horaria distintos
  // y diferir un día cerca de medianoche.
  const refDia = input.dueOn || diaEnPanama(new Date());
  // La mensualidad usa la MISMA función de ciclo que el worker, la cobertura y
  // la asignación de plan (cicloDelCorte, que clampa el corte al último día del
  // mes) para no desbordar en cortes 30/31 hacia meses cortos.
  const cicloMensual = esCobroMensual ? cicloDelCorte(refDia, Number(client.billing_cutoff_day) || 1) : null;
  const vence = input.expiresOn
    ? input.expiresOn
    : esCobroMensual ? cicloMensual!.vence : vencePaqueteDesde(refDia);
  // En una mensualidad la compra puede registrarse tarde, pero el saldo sigue
  // representando el ciclo del expediente. Guardar el día del pago aquí
  // estrechaba artificialmente el ciclo y hacía que una clase del mismo mes,
  // marcada un día antes de registrar el cobro, pareciera de otro ciclo.
  const compradoEl = esCobroMensual ? cicloMensual!.inicio : refDia;
  const etiqueta = esCobroMensual
    ? `Mensualidad · ${rangoDelCiclo(cicloMensual!.inicio, vence || new Date())}`
    : `Paquete ${input.totalSessions} sesiones`;

  const pack = await sql.begin(async transaction => {
    await lockBillingClient(transaction, input.clientId);
    const [created] = await transaction`INSERT INTO session_packages (client_id, label, total_sessions, amount, expires_on, kind, purchased_on) VALUES (${input.clientId}, ${etiqueta}, ${input.totalSessions}, ${input.amount}, ${vence}, ${input.kind}, ${compradoEl}::date) RETURNING *`;
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
    await transaction`UPDATE session_packages SET origin_invoice_id = ${invoice.id} WHERE id = ${created.id}`;
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
    .transform(value => (value === '' || value === undefined ? null : value)),
  // Marcar un saldo pendiente como pagado a mano: para cuando el dinero entró
  // por fuera (p. ej. un cobro de Zoho) y el saldo se quedó 'pending' sin forma
  // de activarlo. El ingreso ya está registrado en su cobro; esto sólo despierta
  // las sesiones. false lo devuelve a pendiente.
  markPaid: z.boolean().optional()
});
app.patch('/api/packages/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = editPackageSchema.parse(request.body);
  const tocaVencimiento = 'expiresOn' in (request.body as Record<string, unknown>);

  const result = await sql.begin(async transaction => {
    const [actual] = await transaction`
      SELECT id, client_id, total_sessions, used_sessions FROM session_packages
      WHERE id = ${id} AND client_id IN (SELECT id FROM clients WHERE owner_id = ${auth.sub})
      FOR UPDATE
    `;
    if (!actual) return null;
    await lockBillingClient(transaction, actual.client_id as string);

    const total = input.totalSessions ?? Number(actual.total_sessions);
    const usadas = input.usedSessions ?? Number(actual.used_sessions);
    // Usadas por encima de contratadas dejaría un saldo negativo en pantalla y
    // un cliente sin sesiones que sí pagó.
    if (usadas > total) return { error: 'Las sesiones usadas no pueden superar las contratadas' };

    const [pack] = await transaction`
      UPDATE session_packages SET
        label = COALESCE(${input.label ?? null}, label),
        total_sessions = ${total},
        used_sessions = ${usadas},
        expires_on = CASE WHEN ${tocaVencimiento} THEN ${input.expiresOn}::date ELSE expires_on END,
        -- El estado se recalcula siempre: subir las contratadas revive un saldo
        -- agotado, y bajarlas lo agota.
        status = CASE
                      WHEN ${input.markPaid === true} THEN (CASE WHEN ${usadas}::int >= ${total}::int THEN 'exhausted' ELSE 'active' END)
                      WHEN ${input.markPaid === false} THEN 'pending'
                      WHEN status = 'pending' THEN 'pending'
                      WHEN ${usadas}::int >= ${total}::int THEN 'exhausted' ELSE 'active' END
      WHERE id = ${id}
      RETURNING *
    `;
    if (pack && pack.kind === 'monthly' && pack.status === 'active' && tocaVencimiento) {
      const restantes = Math.max(0, Number(pack.total_sessions) - Number(pack.used_sessions));
      if (restantes) await cobrarClasesYaDadas(transaction, pack.id as string, pack.client_id as string, soloFecha(pack.expires_on)!, restantes);
    }
    return pack;
  });
  if (!result) return reply.code(404).send({ error: 'Saldo no encontrado' });
  if ('error' in result) return reply.code(400).send({ error: result.error });
  return result;
});

// Renovar un paquete de clases, por decisión de la entrenadora. Abre uno nuevo
// de 6 semanas con su cobro ya pagado (método y fecha los indica ella en el
// modal). El viejo se cierra: si quedaban clases, ella elige perderlas —la
// palanca para renovar "al mes" y negociar— o arrastrarlas al nuevo.
const renewPackageSchema = z.object({
  method: z.string().trim().min(1).max(40),
  paidOn: z.string().date(),
  reference: z.string().trim().max(120).optional().nullable(),
  carryover: z.boolean().default(false),
  totalSessions: z.coerce.number().int().min(1).max(400).optional(),
  amount: z.coerce.number().min(0).optional()
});
app.post('/api/packages/:id/renew', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = renewPackageSchema.parse(request.body);
  const resultado = await sql.begin(async transaction => {
    const [viejo] = await transaction`
      SELECT sp.id, sp.client_id, sp.total_sessions, sp.used_sessions, sp.amount, sp.label, sp.kind
      FROM session_packages sp JOIN clients c ON c.id = sp.client_id
      WHERE sp.id = ${id} AND c.owner_id = ${auth.sub} AND sp.kind = 'package'
      FOR UPDATE OF sp
    `;
    if (!viejo) return null;
    // Lo que le quedaba sin tomar. Se arrastra sólo si ella lo decidió; si no,
    // se pierde (la regla de "renovar al mes aunque pierda clases").
    const restantes = Math.max(0, Number(viejo.total_sessions) - Number(viejo.used_sessions));
    const arrastradas = input.carryover ? restantes : 0;
    const contratadas = input.totalSessions ?? Number(viejo.total_sessions);
    const nuevasSesiones = contratadas + arrastradas;
    const monto = input.amount ?? Number(viejo.amount);
    const vence = vencePaqueteDesde(input.paidOn);

    // El viejo se cierra: se marca vencido para que sus clases dejen de contar.
    await transaction`UPDATE session_packages SET status = 'expired' WHERE id = ${viejo.id}`;

    const [nuevo] = await transaction`
      INSERT INTO session_packages (client_id, label, total_sessions, amount, expires_on, kind, purchased_on, status)
      VALUES (${viejo.client_id}, ${`Paquete ${nuevasSesiones} sesiones`}, ${nuevasSesiones}, ${monto}, ${vence}::date, 'package', ${input.paidOn}::date, 'active')
      RETURNING *
    `;
    // El cobro nace ya pagado: la entrenadora indicó método y fecha al renovar.
    const [invoice] = await transaction`
      INSERT INTO invoices (client_id, package_id, concept, amount, due_on, issued_on, status, payment_method, payment_reference, confirmed_at, balance)
      VALUES (${viejo.client_id}, ${nuevo.id}, 'Renovación de paquete', ${monto}, ${input.paidOn}::date, current_date, 'confirmed', ${input.method}, ${input.reference || null}, ${`${input.paidOn}T12:00:00-05:00`}, 0)
      RETURNING *
    `;
    const externalId = `eileen-payment:${invoice.id}`;
    const [payment] = await transaction`
      INSERT INTO invoice_payments (client_id, source_system, external_id, payment_number, amount, paid_on, method, reference)
      VALUES (${viejo.client_id}, 'eileen', ${externalId}, ${invoice.invoice_number || null}, ${monto}, ${input.paidOn}, ${input.method}, ${input.reference || null})
      ON CONFLICT (source_system, external_id) DO UPDATE SET amount = EXCLUDED.amount, paid_on = EXCLUDED.paid_on, method = EXCLUDED.method, reference = EXCLUDED.reference, updated_at = now()
      RETURNING *
    `;
    await transaction`INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (${payment.id}, ${invoice.id}, ${monto}) ON CONFLICT (payment_id, invoice_id) DO UPDATE SET amount = EXCLUDED.amount`;
    await transaction`UPDATE session_packages SET origin_invoice_id = ${invoice.id} WHERE id = ${nuevo.id}`;
    return { package: nuevo, sessions: nuevasSesiones, expiresOn: vence, perdidas: input.carryover ? 0 : restantes, arrastradas };
  });
  if (!resultado) return reply.code(404).send({ error: 'Paquete no encontrado' });
  return reply.code(201).send(resultado);
});

// Reparación de una sola vez: saldos mensuales con el ciclo degenerado (rango de
// un solo día) que dejó un cálculo de corte viejo. Recalcula cada uno al día de
// corte configurado de SU cliente, con su etiqueta. Sólo toca fechas y estado
// —no borra nada— y sólo a clientes mensuales; los saldos mensuales que quedaron
// en un cliente que ya NO es mensual (clase suelta) se listan aparte para que la
// entrenadora los borre a mano. Idempotente: un ciclo ya sano (>= 20 días) no se
// vuelve a tocar.
app.post('/api/maintenance/fix-cycles', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const filas = await sql`
    SELECT sp.id, sp.label, sp.purchased_on, sp.expires_on, sp.total_sessions, sp.used_sessions,
      c.full_name, c.billing_model, c.billing_cutoff_day
    FROM session_packages sp JOIN clients c ON c.id = sp.client_id
    WHERE c.owner_id = ${auth.sub} AND sp.kind = 'monthly' AND sp.status <> 'cancelled'
      AND sp.purchased_on IS NOT NULL AND sp.expires_on IS NOT NULL
      AND sp.expires_on - sp.purchased_on < 20
  `;
  const corregidos: { cliente: string; antes: string; despues: string; vence: string }[] = [];
  const noMensuales: { cliente: string; label: string; id: string }[] = [];
  for (const f of filas) {
    // Un saldo mensual en un cliente que ya no es mensual no se arregla: sobra.
    // Se reporta para que ella lo borre tras pasarlo a clase suelta.
    if (f.billing_model !== 'monthly') {
      noMensuales.push({ cliente: f.full_name as string, label: f.label as string, id: f.id as string });
      continue;
    }
    const cutoff = Number(f.billing_cutoff_day) || 1;
    const { inicio, vence } = cicloDelCorte(f.purchased_on as Date, cutoff);
    const nuevaEtiqueta = 'Mensualidad · ' + rangoDelCiclo(inicio, vence);
    const nuevoEstado = Number(f.used_sessions) >= Number(f.total_sessions) ? 'exhausted' : 'active';
    await sql`
      UPDATE session_packages
      SET expires_on = ${vence}::date, label = ${nuevaEtiqueta}, status = ${nuevoEstado}
      WHERE id = ${f.id}
    `;
    corregidos.push({ cliente: f.full_name as string, antes: f.label as string, despues: nuevaEtiqueta, vence });
  }
  return { corregidos, noMensuales };
});

// Reconciliación segura de saldos mensuales. La vista previa es el modo por
// defecto: permite revisar qué se corregiría sin tocar datos. Con `apply: true`
// se ejecuta todo dentro de una transacción y cada operación es idempotente.
//
// Primero retira débitos que quedaron colgados de una sesión cancelada como
// reprogramada (el bug de completed -> rescheduled). Después hace que
// used_sessions diga lo mismo que las sesiones que realmente apuntan al saldo,
// elimina sólo duplicados mensuales exactos sin clases usadas y recoge clases
// elegibles que quedaron sin cobrar dentro de la ventana del saldo.
const monthlyBillingReconciliationSchema = z.object({ apply: z.boolean().default(false) });
app.post('/api/maintenance/reconcile-monthly-billing', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const { apply } = monthlyBillingReconciliationSchema.parse(request.body || {});
  return sql.begin(async transaction => {
    const ghosts = await transaction`
      SELECT s.id AS session_id, s.client_id, s.package_id, c.full_name,
        sp.label AS package_label
      FROM sessions s
      JOIN clients c ON c.id = s.client_id
      JOIN session_packages sp ON sp.id = s.package_id AND sp.kind = 'monthly'
      WHERE c.owner_id = ${auth.sub}
        AND s.package_debited = true
        AND s.status = 'cancelled'
        AND s.cancellation_kind = 'rescheduled'
      FOR UPDATE OF s, sp
    `;

    const duplicates = await transaction`
      SELECT duplicate.id, duplicate.client_id, duplicate.label, duplicate.total_sessions,
        duplicate.amount, duplicate.expires_on, c.full_name
      FROM session_packages duplicate
      JOIN clients c ON c.id = duplicate.client_id
      WHERE c.owner_id = ${auth.sub}
        AND duplicate.kind = 'monthly'
        AND duplicate.status <> 'cancelled'
        AND duplicate.used_sessions = 0
        AND EXISTS (
          SELECT 1 FROM session_packages keep
          WHERE keep.client_id = duplicate.client_id
            AND keep.id <> duplicate.id
            AND keep.kind = 'monthly'
            AND keep.status <> 'cancelled'
            AND keep.used_sessions > 0
            AND keep.label = duplicate.label
            AND keep.total_sessions = duplicate.total_sessions
            AND keep.amount = duplicate.amount
            AND keep.expires_on IS NOT DISTINCT FROM duplicate.expires_on
        )
    `;

    const snapshot = async () => transaction`
      SELECT sp.id, sp.client_id, c.full_name, sp.label, sp.total_sessions,
        sp.used_sessions, sp.status, sp.expires_on,
        linked.linked_sessions,
        eligible.eligible_sessions
      FROM session_packages sp
      JOIN clients c ON c.id = sp.client_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS linked_sessions
        FROM sessions s
        WHERE s.package_id = sp.id AND s.package_debited = true
      ) linked ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS eligible_sessions
        FROM sessions s
        WHERE s.client_id = sp.client_id AND s.package_debited = false
          AND (
            s.status IN ('completed', 'no_show')
            OR (s.status = 'cancelled' AND s.cancellation_kind = 'not_rescheduled'
              AND COALESCE(s.cancelled_by, 'client') = 'client')
          )
          AND s.starts_at > (sp.expires_on::date - interval '1 month')
          AND s.starts_at < (sp.expires_on::date + interval '1 day')
      ) eligible ON true
      WHERE c.owner_id = ${auth.sub}
        AND sp.kind = 'monthly'
        AND sp.status <> 'cancelled'
      ORDER BY c.full_name, sp.expires_on NULLS LAST, sp.created_at
    `;

    const antes = await snapshot();
    if (!apply) {
      return {
        dryRun: true,
        ghosts: ghosts.map(row => ({ sessionId: row.session_id, client: row.full_name, package: row.package_label })),
        duplicatePackages: duplicates.map(row => ({ id: row.id, client: row.full_name, label: row.label })),
        balances: antes.map(row => ({
          id: row.id,
          client: row.full_name,
          label: row.label,
          used: Number(row.used_sessions),
          linked: Number(row.linked_sessions),
          eligible: Number(row.eligible_sessions)
        }))
      };
    }

    for (const ghost of ghosts) {
      await transaction`
        UPDATE session_packages
        SET used_sessions = GREATEST(0, used_sessions - 1),
            status = CASE WHEN GREATEST(0, used_sessions - 1) >= total_sessions THEN 'exhausted' ELSE 'active' END
        WHERE id = ${ghost.package_id}
      `;
      await transaction`
        UPDATE sessions
        SET package_id = NULL, package_debited = false, debited_group_id = NULL, updated_at = now()
        WHERE id = ${ghost.session_id}
      `;
    }

    for (const duplicate of duplicates) {
      await transaction`DELETE FROM session_packages WHERE id = ${duplicate.id} AND used_sessions = 0`;
    }

    const balances = await transaction`
      SELECT sp.id, sp.client_id, sp.expires_on, sp.total_sessions, sp.used_sessions, sp.status
      FROM session_packages sp JOIN clients c ON c.id = sp.client_id
      WHERE c.owner_id = ${auth.sub} AND sp.kind = 'monthly' AND sp.status <> 'cancelled'
      ORDER BY sp.expires_on NULLS LAST, sp.created_at
      FOR UPDATE OF sp
    `;
    const corrected: { id: string; from: number; to: number }[] = [];
    let recovered = 0;
    for (const balance of balances) {
      const [linked] = await transaction`
        SELECT count(*)::int AS count FROM sessions
        WHERE package_id = ${balance.id} AND package_debited = true
      `;
      const linkedCount = Number(linked.count);
      const currentUsed = Number(balance.used_sessions);
      if (linkedCount > Number(balance.total_sessions)) {
        // No se puede fabricar capacidad para un saldo que ya tiene más
        // sesiones vinculadas que las contratadas. Se conserva para revisión.
        continue;
      }
      if (linkedCount !== currentUsed || balance.status === 'exhausted' && linkedCount < Number(balance.total_sessions)) {
        await transaction`
          UPDATE session_packages
          SET used_sessions = ${linkedCount},
              status = CASE WHEN ${linkedCount} >= total_sessions THEN 'exhausted' ELSE 'active' END
          WHERE id = ${balance.id}
        `;
        corrected.push({ id: balance.id as string, from: currentUsed, to: linkedCount });
      }
      if (balance.status !== 'cancelled' && linkedCount < Number(balance.total_sessions) && balance.expires_on) {
        recovered += await cobrarClasesYaDadas(
          transaction, balance.id as string, balance.client_id as string,
          soloFecha(balance.expires_on)!, Number(balance.total_sessions) - linkedCount
        );
      }
    }

    return {
      dryRun: false,
      detachedRescheduledDebits: ghosts.length,
      deletedDuplicateBalances: duplicates.length,
      correctedBalances: corrected,
      recoveredSessions: recovered
    };
  });
});

app.get('/api/clients/:clientId/balances', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const clientId = z.string().uuid().parse((request.params as { clientId: string }).clientId);
  if (!(await ownedClient(clientId, auth.sub))) return reply.code(404).send({ error: 'Cliente no encontrado' });
  return sql`
    SELECT sp.id, sp.label, sp.kind, sp.total_sessions, sp.used_sessions, sp.amount, sp.status, sp.purchased_on, sp.expires_on,
      (sp.total_sessions - sp.used_sessions) AS remaining,
      (sp.expires_on IS NOT NULL AND sp.expires_on < current_date AND sp.used_sessions < sp.total_sessions) AS vencido_con_saldo,
      (sp.kind = 'package' AND sp.status = 'active' AND sp.purchased_on IS NOT NULL
        AND sp.purchased_on + ${DIAS_RENOVACION_PAQUETE}::int <= current_date) AS renovacion_pendiente,
      sp.origin_invoice_id,
      oi.invoice_number AS origin_invoice_number, oi.concept AS origin_concept, oi.source_system AS origin_source,
      COALESCE(oi.confirmed_at::date, oi.issued_on, oi.due_on) AS origin_date
    FROM session_packages sp
    LEFT JOIN invoices oi ON oi.id = sp.origin_invoice_id
    WHERE sp.client_id = ${clientId} AND sp.status <> 'cancelled'
    ORDER BY sp.purchased_on DESC, sp.created_at DESC
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
  repeatMuscleGroups: z.boolean().default(false),
  forClient: z.boolean().default(false),
  forTravel: z.boolean().default(false),
  durationMinutes: z.coerce.number().int().min(15).max(180).optional()
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
      clienteNombre,
      paraCliente: input.forClient || input.forTravel,
      paraViaje: input.forTravel,
      duracionMinutos: input.durationMinutes
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
  video_uploaded_at,
  (video_object_key IS NOT NULL OR EXISTS (SELECT 1 FROM exercise_videos ev WHERE ev.exercise_id = exercises.id)) AS has_video,
  (SELECT count(*)::int FROM exercise_videos ev WHERE ev.exercise_id = exercises.id) AS video_count
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
  const [exercise] = await sql`SELECT id, name, video_object_key FROM exercises WHERE id = ${id} AND owner_id = ${auth.sub}`;
  if (!exercise) return reply.code(404).send({ error: 'Ejercicio no encontrado' });
  const variantes = await sql`SELECT object_key FROM exercise_videos WHERE exercise_id = ${id} AND owner_id = ${auth.sub}`;
  await sql`DELETE FROM exercises WHERE id = ${id} AND owner_id = ${auth.sub}`;
  const keys = [...new Set([exercise.video_object_key, ...variantes.map(video => video.object_key)].filter(Boolean))] as string[];
  if (storageReady) {
    for (const objectKey of keys) await deleteObject(objectKey).catch(error => app.log.warn({ err: error, exerciseId: id }, 'No se pudo borrar el video del ejercicio'));
  }
  return { deleted: true, exercise: { id: exercise.id, name: exercise.name } };
});

const exerciseVideoInput = z.object({
  label: z.string().trim().min(1).max(80).default('Demostración'),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional()
});

// Metadatos para la entrenadora. Las claves de R2 nunca se exponen al
// navegador: sólo se usan en el endpoint de borrado del lado del servidor.
app.get('/api/exercises/:id/videos', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [exercise] = await sql`SELECT id FROM exercises WHERE id = ${id} AND owner_id = ${auth.sub}`;
  if (!exercise) return reply.code(404).send({ error: 'Ejercicio no encontrado' });
  return sql`
    SELECT id, label, content_type, size_bytes, duration_seconds, uploaded_at, sort_order
    FROM exercise_videos WHERE exercise_id = ${id} AND owner_id = ${auth.sub}
    ORDER BY sort_order, created_at
  `;
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
  // Compatibilidad con el endpoint antiguo: reemplazar el video predeterminado
  // también actualiza su fila de variantes, sin borrar las demás opciones.
  const [previousVariant] = previousKey ? await sql`SELECT id FROM exercise_videos WHERE exercise_id = ${id} AND object_key = ${previousKey}` : [];
  if (previousVariant) {
    await sql`
      UPDATE exercise_videos SET object_key = ${input.objectKey}, content_type = ${uploaded.contentType || 'video/mp4'},
        size_bytes = ${uploaded.sizeBytes}, duration_seconds = ${input.durationSeconds ?? null}, uploaded_at = now(), updated_at = now()
      WHERE id = ${previousVariant.id}
    `;
  } else {
    await sql`
      INSERT INTO exercise_videos (exercise_id, owner_id, label, object_key, content_type, size_bytes, duration_seconds, sort_order)
      VALUES (${id}, ${auth.sub}, 'Demostración', ${input.objectKey}, ${uploaded.contentType || 'video/mp4'}, ${uploaded.sizeBytes}, ${input.durationSeconds ?? null}, 0)
      ON CONFLICT (owner_id, object_key) DO NOTHING
    `;
  }
  return updated;
});

// Variante nueva: sube una demostración sin reemplazar las anteriores.
app.post('/api/exercises/:id/videos-upload-url', { preHandler: requireStaff }, async (request, reply) => {
  if (!storageReady) return reply.code(503).send({ error: 'El almacenamiento de video aún no está configurado' });
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = z.object({ contentType: z.enum(videoContentTypes), sizeBytes: z.coerce.number().int().positive().max(maxVideoSize) }).parse(request.body);
  const [exercise] = await sql`SELECT id FROM exercises WHERE id = ${id} AND owner_id = ${auth.sub}`;
  if (!exercise) return reply.code(404).send({ error: 'Ejercicio no encontrado' });
  const objectKey = `exercises/${id}/${randomUUID()}.${input.contentType === 'video/webm' ? 'webm' : 'mp4'}`;
  return { objectKey, uploadUrl: await createUploadUrl(objectKey, input.contentType), expiresInSeconds: 600 };
});

app.post('/api/exercises/:id/videos', { preHandler: requireStaff }, async (request, reply) => {
  if (!storageReady) return reply.code(503).send({ error: 'El almacenamiento de video aún no está configurado' });
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = z.object({ objectKey: z.string().min(1).max(300), durationSeconds: z.coerce.number().positive().max(600).optional(), ...exerciseVideoInput.shape }).parse(request.body);
  if (!input.objectKey.startsWith(`exercises/${id}/`)) return reply.code(400).send({ error: 'La ruta del video no corresponde a este ejercicio' });
  const [exercise] = await sql`SELECT id, video_object_key FROM exercises WHERE id = ${id} AND owner_id = ${auth.sub}`;
  if (!exercise) return reply.code(404).send({ error: 'Ejercicio no encontrado' });
  const uploaded = await verifyUpload(input.objectKey).catch(() => null);
  if (!uploaded?.sizeBytes) return reply.code(409).send({ error: 'El video no llegó completo al almacenamiento' });

  const [video] = await sql`
    INSERT INTO exercise_videos (exercise_id, owner_id, label, object_key, content_type, size_bytes, duration_seconds, sort_order)
    VALUES (${id}, ${auth.sub}, ${input.label}, ${input.objectKey}, ${uploaded.contentType || 'video/mp4'}, ${uploaded.sizeBytes}, ${input.durationSeconds ?? null}, ${input.sortOrder ?? 100})
    RETURNING id, label, content_type, size_bytes, duration_seconds, uploaded_at, sort_order
  `;
  // La primera variante mantiene funcionando a clientes y enlaces antiguos
  // que todavía consultan video_object_key.
  if (!exercise.video_object_key) {
    await sql`
      UPDATE exercises SET video_object_key = ${input.objectKey}, video_content_type = ${uploaded.contentType || 'video/mp4'},
        video_size_bytes = ${uploaded.sizeBytes}, video_duration_seconds = ${input.durationSeconds ?? null}, video_uploaded_at = now(), updated_at = now()
      WHERE id = ${id} AND owner_id = ${auth.sub}
    `;
  }
  return reply.code(201).send(video);
});

app.delete('/api/exercises/:id/videos/:videoId', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const { id, videoId } = request.params as { id: string; videoId: string };
  z.string().uuid().parse(id); z.string().uuid().parse(videoId);
  const [video] = await sql`
    SELECT ev.id, ev.object_key, e.video_object_key
    FROM exercise_videos ev JOIN exercises e ON e.id = ev.exercise_id
    WHERE ev.id = ${videoId} AND ev.exercise_id = ${id} AND ev.owner_id = ${auth.sub} AND e.owner_id = ${auth.sub}
  `;
  if (!video) return reply.code(404).send({ error: 'Demostración no encontrada' });
  await sql`DELETE FROM exercise_videos WHERE id = ${videoId} AND owner_id = ${auth.sub}`;
  if (video.video_object_key === video.object_key) {
    const [next] = await sql`
      SELECT object_key, content_type, size_bytes, duration_seconds, uploaded_at
      FROM exercise_videos WHERE exercise_id = ${id} AND owner_id = ${auth.sub}
      ORDER BY sort_order, created_at LIMIT 1
    `;
    await sql`
      UPDATE exercises SET video_object_key = ${next?.object_key || null}, video_content_type = ${next?.content_type || null},
        video_size_bytes = ${next?.size_bytes || null}, video_duration_seconds = ${next?.duration_seconds || null},
        video_uploaded_at = ${next?.uploaded_at || null}, updated_at = now()
      WHERE id = ${id} AND owner_id = ${auth.sub}
    `;
  }
  if (storageReady) await deleteObject(video.object_key).catch(error => app.log.warn({ err: error, exerciseId: id }, 'No se pudo borrar la demostración'));
  return { deleted: true, videoId };
});

app.delete('/api/exercises/:id/video', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [exercise] = await sql`SELECT video_object_key FROM exercises WHERE id = ${id} AND owner_id = ${auth.sub}`;
  if (!exercise) return reply.code(404).send({ error: 'Ejercicio no encontrado' });
  const [variant] = await sql`SELECT id, object_key FROM exercise_videos WHERE exercise_id = ${id} AND owner_id = ${auth.sub} ORDER BY sort_order, created_at LIMIT 1`;
  const objectKey = variant?.object_key || exercise.video_object_key;
  if (variant) await sql`DELETE FROM exercise_videos WHERE id = ${variant.id} AND owner_id = ${auth.sub}`;
  const [next] = await sql`SELECT object_key, content_type, size_bytes, duration_seconds, uploaded_at FROM exercise_videos WHERE exercise_id = ${id} AND owner_id = ${auth.sub} ORDER BY sort_order, created_at LIMIT 1`;
  const [updated] = await sql`
    UPDATE exercises SET video_object_key = ${next?.object_key || null}, video_content_type = ${next?.content_type || null},
      video_size_bytes = ${next?.size_bytes || null}, video_duration_seconds = ${next?.duration_seconds || null},
      video_uploaded_at = ${next?.uploaded_at || null}, updated_at = now()
    WHERE id = ${id} AND owner_id = ${auth.sub}
    RETURNING ${exerciseColumns}
  `;
  if (objectKey && storageReady) await deleteObject(objectKey).catch(error => app.log.warn({ err: error, exerciseId: id }, 'No se pudo borrar el video del ejercicio'));
  return updated;
});

// La ve tanto la entrenadora como sus clientes: el cliente necesita el video
// para ejecutar el ejercicio sin asistencia, que es el punto de la función.
app.get('/api/exercises/:id/video-url', { preHandler: requireAuth }, async (request, reply) => {
  if (!storageReady) return reply.code(503).send({ error: 'El almacenamiento de video aún no está configurado' });
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [exercise] = await sql`
    SELECT e.id, e.owner_id, e.video_object_key, e.video_content_type,
      COALESCE((SELECT ev.object_key FROM exercise_videos ev WHERE ev.exercise_id = e.id ORDER BY ev.sort_order, ev.created_at LIMIT 1), e.video_object_key) AS selected_object_key,
      COALESCE((SELECT ev.content_type FROM exercise_videos ev WHERE ev.exercise_id = e.id ORDER BY ev.sort_order, ev.created_at LIMIT 1), e.video_content_type) AS selected_content_type
    FROM exercises e WHERE e.id = ${id}
  `;
  if (!exercise?.selected_object_key) return reply.code(404).send({ error: 'Este ejercicio todavía no tiene video' });

  const allowed = ['admin', 'trainer'].includes(auth.role)
    ? exercise.owner_id === auth.sub
    : (await portalClient(auth.sub))?.owner_id === exercise.owner_id;
  if (!allowed) return reply.code(403).send({ error: 'Sin acceso a este video' });

  return { exerciseId: id, contentType: exercise.selected_content_type, videoUrl: await createDownloadUrl(exercise.selected_object_key), expiresInSeconds: 300 };
});

app.get('/api/exercises/:id/video-urls', { preHandler: requireAuth }, async (request, reply) => {
  if (!storageReady) return reply.code(503).send({ error: 'El almacenamiento de video aún no está configurado' });
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [exercise] = await sql`SELECT id, owner_id, video_object_key, video_content_type, video_size_bytes, video_duration_seconds, video_uploaded_at FROM exercises WHERE id = ${id}`;
  if (!exercise) return reply.code(404).send({ error: 'Ejercicio no encontrado' });
  const allowed = ['admin', 'trainer'].includes(auth.role)
    ? exercise.owner_id === auth.sub
    : (await portalClient(auth.sub))?.owner_id === exercise.owner_id;
  if (!allowed) return reply.code(403).send({ error: 'Sin acceso a este video' });
  const variants = await sql`
    SELECT id, label, content_type, size_bytes, duration_seconds, uploaded_at, object_key
    FROM exercise_videos WHERE exercise_id = ${id} ORDER BY sort_order, created_at
  `;
  const rows = variants.length ? variants : exercise.video_object_key ? [{ id: null, label: 'Demostración', content_type: exercise.video_content_type, size_bytes: exercise.video_size_bytes, duration_seconds: exercise.video_duration_seconds, uploaded_at: exercise.video_uploaded_at, object_key: exercise.video_object_key }] : [];
  if (!rows.length) return reply.code(404).send({ error: 'Este ejercicio todavía no tiene video' });
  return {
    exerciseId: id,
    videos: await Promise.all(rows.map(video => ({
      id: video.id, label: video.label, contentType: video.content_type, sizeBytes: video.size_bytes,
      durationSeconds: video.duration_seconds, uploadedAt: video.uploaded_at,
      videoUrl: createDownloadUrl(video.object_key)
    })).map(async video => ({ ...video, videoUrl: await video.videoUrl }))),
    expiresInSeconds: 300
  };
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

// completionPercent llega cuando la clase se registra ya dada: es el caso de
// la clase suelta que se cobra y se da en el mismo momento. Crearla y marcarla
// en dos llamadas dejaba una sesión programada colgando si la segunda fallaba.
const sessionSchema = z.object({ clientId: z.string().uuid(), routineId: z.string().uuid().optional(), startsAt: z.string().datetime(), durationMinutes: z.coerce.number().int().positive().default(60), mode: z.string().default('Presencial'), notes: z.string().optional(), completionPercent: z.coerce.number().int().min(0).max(100).optional() });
app.get('/api/sessions', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`SELECT s.*, c.full_name, r.title AS routine_title,
    charged.label AS charged_package_label, charged.used_sessions AS charged_package_used,
    charged.total_sessions AS charged_package_total,
    sro.status AS routine_offer_status, sro.duration_seconds AS routine_offer_duration_seconds,
    (sro.status = 'offered' AND (s.starts_at AT TIME ZONE 'America/Panama')::date < (now() AT TIME ZONE 'America/Panama')::date) AS routine_offer_expired,
    sro.origin AS routine_offer_origin
    FROM sessions s
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN routines r ON r.id = s.routine_id
    LEFT JOIN session_packages charged ON charged.id = s.package_id
    LEFT JOIN session_routine_offers sro ON sro.session_id = s.id AND sro.status <> 'withdrawn'
    WHERE c.owner_id = ${auth.sub} ORDER BY s.starts_at`;
});
// El horario de trabajo, por tramos. Sin tramos configurados la aplicación
// sigue deduciéndolo de la agenda, que es lo que hacía hasta ahora: nadie se
// queda sin huecos por no haber entrado aquí todavía.
const workingHoursSchema = z.object({
  tramos: z.array(z.object({
    weekday: z.coerce.number().int().min(0).max(6),
    startsAt: z.string().regex(/^\d{2}:\d{2}$/, 'Hora inválida'),
    endsAt: z.string().regex(/^\d{2}:\d{2}$/, 'Hora inválida')
  }).refine(t => t.endsAt > t.startsAt, { message: 'El tramo termina antes de empezar' })).max(40)
});

app.get('/api/working-hours', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const tramos = await sql`
    SELECT id, weekday, to_char(starts_at, 'HH24:MI') AS starts_at, to_char(ends_at, 'HH24:MI') AS ends_at
    FROM working_hours WHERE owner_id = ${auth.sub} ORDER BY weekday, starts_at
  `;
  return { tramos };
});

app.put('/api/working-hours', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const input = workingHoursSchema.parse(request.body);
  // Dos tramos del mismo día que se pisan no son un horario: son un error de
  // dedo, y dejarlos pasar haría que un hueco saliera dos veces.
  const porDia = new Map<number, { startsAt: string; endsAt: string }[]>();
  for (const tramo of input.tramos) {
    const lista = porDia.get(tramo.weekday) || [];
    if (lista.some(otro => tramo.startsAt < otro.endsAt && tramo.endsAt > otro.startsAt)) {
      return reply.code(400).send({ error: 'Hay dos tramos que se solapan el mismo día' });
    }
    lista.push(tramo);
    porDia.set(tramo.weekday, lista);
  }
  await sql.begin(async transaction => {
    await transaction`DELETE FROM working_hours WHERE owner_id = ${auth.sub}`;
    for (const tramo of input.tramos) {
      await transaction`
        INSERT INTO working_hours (owner_id, weekday, starts_at, ends_at)
        VALUES (${auth.sub}, ${tramo.weekday}, ${tramo.startsAt}::time, ${tramo.endsAt}::time)
      `;
    }
  });
  const tramos = await sql`
    SELECT id, weekday, to_char(starts_at, 'HH24:MI') AS starts_at, to_char(ends_at, 'HH24:MI') AS ends_at
    FROM working_hours WHERE owner_id = ${auth.sub} ORDER BY weekday, starts_at
  `;
  return { tramos };
});

// Huecos libres de la entrenadora, para colocar una reposición sin ir
// probando horas a ver cuál cae.
//
// La franja de trabajo no está configurada en ninguna parte, así que se deduce
// de su propia agenda de los últimos dos meses: desde la clase más temprana
// hasta el final de la más tardía. Inventar un horario fijo sería peor —le
// ofrecería huecos a las once de la noche, o le escondería sus 5:30—.
const availabilitySchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  durationMinutes: z.coerce.number().int().min(15).max(480).default(60),
  clientId: z.string().uuid().optional()
}).refine(v => v.from <= v.to, { message: 'El rango de fechas está al revés' });

app.get('/api/availability', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const query = availabilitySchema.parse(request.query);

  const [franja] = await sql`
    SELECT
      COALESCE(min((s.starts_at AT TIME ZONE 'America/Panama')::time), '06:00'::time) AS abre,
      -- El ::time va DENTRO del max. Fuera, el máximo se toma sobre la marca de
      -- tiempo entera y devuelve la hora de la clase más reciente en el
      -- calendario, no la más tardía del día: con eso la franja salía de una
      -- hora de ancho y casi no ofrecía huecos.
      COALESCE(max(((s.starts_at + make_interval(mins => s.duration_minutes)) AT TIME ZONE 'America/Panama')::time), '20:00'::time) AS cierra
    FROM sessions s JOIN clients c ON c.id = s.client_id
    WHERE c.owner_id = ${auth.sub} AND s.status <> 'cancelled'
      AND NOT EXISTS (SELECT 1 FROM client_package_pauses pp WHERE pp.client_id = c.id AND pp.status = 'active')
      AND s.starts_at >= now() - interval '60 days'
  `;
  // Lo ocupado del rango, con su hora local ya resuelta: comparar instantes en
  // el cliente obliga a repetir la conversión de huso en cada comparación.
  const ocupadas = await sql`
    SELECT (s.starts_at AT TIME ZONE 'America/Panama')::date AS dia,
      (s.starts_at AT TIME ZONE 'America/Panama')::time AS empieza,
      s.duration_minutes, c.full_name
    FROM sessions s JOIN clients c ON c.id = s.client_id
    WHERE c.owner_id = ${auth.sub} AND s.status <> 'cancelled'
      AND NOT EXISTS (SELECT 1 FROM client_package_pauses pp WHERE pp.client_id = c.id AND pp.status = 'active')
      AND (s.starts_at AT TIME ZONE 'America/Panama')::date BETWEEN ${query.from}::date AND ${query.to}::date
    ORDER BY s.starts_at
  `;

  const aMinutos = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const aTexto = (minutos: number) => `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
  // A media hora en punto. Deducir la franja de la agenda real deja bordes
  // sueltos —una clase de 5:35 abriría la rejilla en :05 y :35—, y ofrecerle
  // "las 13:05" en vez de "las 13:00" no es una hora que nadie acuerde.
  const abre = Math.floor(aMinutos(String(franja.abre)) / 30) * 30;
  const cierra = Math.ceil(aMinutos(String(franja.cierra)) / 30) * 30;
  const ahora = new Date();
  const hoyPanama = diaEnPanama(ahora);
  const [horaAhora, minutoAhora] = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Panama', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(ahora).split(':').map(Number);
  const minutosAhora = horaAhora * 60 + minutoAhora;

  // Los tramos configurados mandan sobre la franja deducida. Si no hay
  // ninguno, se sigue con lo deducido, que es lo que había antes.
  const tramos = await sql`
    SELECT weekday, to_char(starts_at, 'HH24:MI') AS starts_at, to_char(ends_at, 'HH24:MI') AS ends_at
    FROM working_hours WHERE owner_id = ${auth.sub} ORDER BY weekday, starts_at
  `;
  const configurado = tramos.length > 0;

  const dias = [];
  for (let cursor = new Date(`${query.from}T12:00:00-05:00`); diaEnPanama(cursor) <= query.to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const dia = diaEnPanama(cursor);
    // El día de la semana en Panamá, no en UTC: de madrugada allí es todavía
    // el día anterior y se aplicarían los tramos del día equivocado.
    const diaSemana = new Date(`${dia}T12:00:00-05:00`).getUTCDay();
    const delDiaTramos = configurado
      ? tramos.filter(t => Number(t.weekday) === diaSemana).map(t => ({ abre: aMinutos(String(t.starts_at)), cierra: aMinutos(String(t.ends_at)) }))
      : [{ abre, cierra }];
    // Las columnas date vuelven como Date: String() daría "Thu Sep 03 2026" y
    // la comparación no encajaría nunca, dejando el día entero como libre.
    const delDia = ocupadas.filter(fila => (fila.dia instanceof Date ? fila.dia.toISOString().slice(0, 10) : String(fila.dia).slice(0, 10)) === dia)
      .map(fila => ({ inicio: aMinutos(String(fila.empieza)), fin: aMinutos(String(fila.empieza)) + Number(fila.duration_minutes), quien: fila.full_name as string }));
    const libres = [];
    for (const tramo of delDiaTramos) {
      // La rejilla arranca en la media hora en punto de cada tramo: el de
      // tarde no tiene por qué heredar los minutos del de mañana.
      const primero = Math.ceil(tramo.abre / 30) * 30;
      for (let inicio = primero; inicio + query.durationMinutes <= tramo.cierra; inicio += 30) {
        // Nada en el pasado: un hueco de esta mañana no es un hueco.
        if (dia === hoyPanama && inicio <= minutosAhora) continue;
        const choca = delDia.some(ocupada => ocupada.inicio < inicio + query.durationMinutes && ocupada.fin > inicio);
        if (!choca) libres.push(aTexto(inicio));
      }
    }
    dias.push({ date: dia, libres, ocupadas: delDia.map(o => ({ hora: aTexto(o.inicio), quien: o.quien })) });
  }
  return { abre: aTexto(abre), cierra: aTexto(cierra), configurado, durationMinutes: query.durationMinutes, dias };
});

app.post('/api/sessions', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const input = sessionSchema.parse(request.body);
  const permiso = await clienteAgendable(input.clientId, auth.sub);
  if (permiso.error) return reply.code(permiso.code).send({ error: permiso.error });
  const [session] = await sql`INSERT INTO sessions (client_id, routine_id, starts_at, duration_minutes, mode, notes) SELECT c.id, ${input.routineId || null}, ${input.startsAt}, ${input.durationMinutes}, ${input.mode}, ${input.notes || null} FROM clients c WHERE c.id = ${input.clientId} AND c.owner_id = ${auth.sub} RETURNING *`;
  if (!session) return reply.code(404).send({ error: 'Cliente no encontrado' });
  const marcada = input.completionPercent === undefined
    ? session
    : await recordSessionCompliance(session.id, auth.sub, auth.sub, 'completed', input.completionPercent);
  try { await syncSessionToGoogle(auth.sub, session.id); }
  catch (error) { app.log.warn({ err: error, sessionId: session.id }, 'Session created but Google Calendar sync failed'); }
  return reply.code(201).send(marcada || session);
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
// Bajar del cobro nuevo lo que se le debe al cliente por clases que no se
// dieron. Se aplica sobre el cobro de quien entrena —el crédito es suyo—
// aunque el cobro salga a nombre de quien paga, y nunca deja el cobro en
// negativo: lo que sobre queda pendiente para el mes siguiente.
type CobroGenerado = { id: string; billed_for_client_id: string | null; client_id: string; amount: string };

async function aplicarCreditos(invoices: CobroGenerado[]) {
  let aplicados = 0;
  for (const invoice of invoices) {
    const entrena = invoice.billed_for_client_id || invoice.client_id;
    const creditos = await sql`
      SELECT id, concept, amount FROM billing_credits
      WHERE client_id = ${entrena} AND applied_invoice_id IS NULL
      ORDER BY created_at
    `;
    if (!creditos.length) continue;
    let restante = Number(invoice.amount);
    const usados = [];
    for (const credito of creditos) {
      if (Number(credito.amount) > restante) break;
      restante = Math.round((restante - Number(credito.amount)) * 100) / 100;
      usados.push(credito);
    }
    if (!usados.length) continue;
    await sql`
      UPDATE billing_credits SET applied_invoice_id = ${invoice.id}, applied_on = current_date
      WHERE id IN ${sql(usados.map(c => c.id as string))}
    `;
    const detalle = usados.map(c => c.concept).join(' · ');
    await sql`
      UPDATE invoices
      SET amount = ${restante}, subtotal = ${restante},
        concept = concept || ' · menos ' || ${usados.length}::text || ' clase' || CASE WHEN ${usados.length} = 1 THEN '' ELSE 's' END || ' no dada' || CASE WHEN ${usados.length} = 1 THEN '' ELSE 's' END,
        notes = COALESCE(notes || E'\n', '') || ${`Descuento aplicado: ${detalle}`}
      WHERE id = ${invoice.id}
    `;
    aplicados += usados.length;
  }
  return aplicados;
}

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
      -- Eliminar físicamente una sesión también es una decisión sobre ese día.
      -- La excepción sobrevive al borrado de la fila y evita que el proceso la
      -- resucite en la siguiente extensión.
      AND NOT EXISTS (
        SELECT 1 FROM session_recurrence_exceptions e
        WHERE e.recurrence_id = ${regla.id} AND e.recurrence_on = candidato.dia
      )
      -- Y sigue sin pisarse con lo que ya haya a esa misma hora, venga de
      -- donde venga: dos clases a la vez para la misma persona no es un
      -- horario, es un choque.
      AND NOT EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.client_id = ${regla.client_id} AND s.starts_at = candidato.momento AND s.status <> 'cancelled'
      )
      -- UNA clase por día y persona (J-101): si ese día el cliente ya entrena —de otro horario fijo o agendada a mano, a la hora que sea— el día está atendido y
      -- no se le pone una segunda. (Dos clases el mismo día se agendan a mano.)
      AND NOT EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.client_id = ${regla.client_id} AND s.status <> 'cancelled' AND (s.starts_at AT TIME ZONE 'America/Panama')::date = candidato.dia
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
  notes: z.string().optional()
});

app.post('/api/session-recurrences', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const input = recurrenceSchema.parse(request.body);
  const permiso = await clienteAgendable(input.clientId, auth.sub);
  if (permiso.error) return reply.code(permiso.code).send({ error: permiso.error });

  const [regla] = await sql`
    INSERT INTO session_recurrences (client_id, routine_id, weekdays, time_of_day, duration_minutes, mode, notes, ends_on)
    VALUES (${input.clientId}, ${input.routineId || null}, ${[...new Set(input.weekdays)].sort()},
      ${input.timeOfDay}::time, ${input.durationMinutes}, ${input.mode}, ${input.notes || null}, NULL)
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

// Reconciliar la agenda con los horarios fijos: borra las sesiones futuras
// sueltas (sin horario fijo, aún programadas) que caen justo en el mismo día de
// semana y hora de un horario fijo activo —las que se montaron encima y crean el
// duplicado— y luego rellena los huecos con las del horario. No toca las ligadas
// al horario, las ya dadas/canceladas, ni las sueltas de otra hora.
app.post('/api/maintenance/reconciliar-agenda', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const borradas = await sql`
    DELETE FROM sessions s
    USING session_recurrences r
    WHERE s.recurrence_id IS NULL AND s.status = 'scheduled' AND s.starts_at > now()
      AND r.client_id = s.client_id AND r.active = true
      AND s.client_id IN (SELECT id FROM clients WHERE owner_id = ${auth.sub})
      AND (extract(dow FROM (s.starts_at AT TIME ZONE 'America/Panama'))::int) = ANY(r.weekdays::int[])
      AND (s.starts_at AT TIME ZONE 'America/Panama')::time = r.time_of_day
    RETURNING s.id
  `;
  const { creadas } = await extenderRecurrencias(auth.sub, true);
  return { borradas: borradas.length, creadas };
});

// Cerrar como pagadas las facturas de Zoho viejas que quedaron pendientes tras
// la migración (se cobraron en Zoho en su momento). Sólo Zoho, pendientes y
// vencidas hace más de 60 días —las recientes no se tocan—. No crea ingresos: el
// dinero ya se registró en Zoho; sólo cierra el estado para que no aparezcan en
// avisos ni en cuentas por cobrar.
app.post('/api/maintenance/cerrar-zoho-viejas', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const cerradas = await sql`
    UPDATE invoices i SET status = 'confirmed', balance = 0,
      confirmed_at = COALESCE(i.confirmed_at, now()),
      payment_reference = COALESCE(i.payment_reference, 'Cerrada por migración Zoho')
    FROM clients c
    WHERE c.id = i.client_id AND c.owner_id = ${auth.sub}
      AND i.source_system = 'zoho_invoice' AND i.status = 'pending'
      AND i.due_on < current_date - interval '60 days'
    RETURNING i.id
  `;
  return { cerradas: cerradas.length };
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
      (SELECT count(*)::int FROM sessions s WHERE s.recurrence_id = r.id AND s.starts_at >= now() AND s.status = 'scheduled' AND NOT s.paused_hold) AS proximas,
      EXISTS (SELECT 1 FROM client_package_pauses pp WHERE pp.client_id = r.client_id AND pp.status = 'active') AS paused
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
  notes: z.string().optional().nullable()
});

app.patch('/api/session-recurrences/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = recurrenceEditSchema.parse(request.body);
  const dias = [...new Set(input.weekdays)].sort();

  const [regla] = await sql`
    UPDATE session_recurrences r
    SET weekdays = ${dias}, time_of_day = ${input.timeOfDay}::time, duration_minutes = ${input.durationMinutes},
      mode = ${input.mode}, notes = ${input.notes || null}, ends_on = NULL, updated_at = now()
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
  }
  const result = await sql.begin(async transaction => {
    const [actual] = await transaction`
      SELECT s.* FROM sessions s
      JOIN clients c ON c.id = s.client_id
      WHERE s.id = ${id} AND c.owner_id = ${auth.sub} AND s.status <> 'cancelled'
      FOR UPDATE
    `;
    if (!actual) return { error: 'Sesión no encontrada o cancelada', code: 404 };
    // Una sesión ya completada descontó del saldo de quien la hizo; moverla a
    // otra persona dejaría ese descuento colgado del cliente equivocado.
    if (input.clientId && actual.status === 'completed') {
      return { error: 'Esta sesión ya se marcó como realizada. Deshaz el cumplimiento antes de cambiar de cliente.', code: 409 };
    }
    const moved = await moveSessionInTransaction(transaction, String(id), {
      startsAt: input.startsAt,
      durationMinutes: input.durationMinutes,
      mode: input.mode,
      notes: input.notes || null,
      clientId: input.clientId
    });
    if (!moved) return { error: 'Sesión no encontrada o cancelada', code: 404 };
    const [session] = await transaction`
      UPDATE sessions SET google_sync_error = NULL, updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;
    return { session };
  });
  if ('error' in result) return reply.code(result.code || 400).send({ error: result.error });
  const session = result.session;
  try { await syncSessionToGoogle(auth.sub, session.id); }
  catch (error) { app.log.warn({ err: error, sessionId: session.id }, 'Session updated but Google Calendar sync failed'); }
  const [updated] = await sql`SELECT * FROM sessions WHERE id = ${session.id}`;
  return updated;
});

const packagePauseSchema = z.object({ packageId: z.string().uuid().optional(), recurrenceId: z.string().uuid().optional(), startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), reason: z.string().trim().max(300).optional() });
app.post('/api/clients/:id/package-pause', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const clientId = z.string().uuid().parse((request.params as { id: string }).id);
  const input = packagePauseSchema.parse(request.body || {});
  const result = await sql.begin(async transaction => {
    const [client] = await transaction`SELECT id, status FROM clients WHERE id = ${clientId} AND owner_id = ${auth.sub} FOR UPDATE`;
    if (!client) return { error: 'Cliente no encontrado', code: 404 };
    const [activePause] = await transaction`SELECT id FROM client_package_pauses WHERE client_id = ${clientId} AND status = 'active' LIMIT 1`;
    if (activePause) return { error: 'El paquete ya está en pausa', code: 409 };
    // "Hoy" en Panamá, no en UTC. El valor por defecto salía de toISOString()
    // —hora UTC—, y de madrugada eso ya marca el día siguiente: comparado
    // contra el hoy de Panamá, la pausa "de hoy" se leía como futura y el
    // endpoint fallaba con 400 sin que nadie hubiera puesto una fecha futura.
    const todayPanama = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Panama' }).format(new Date());
    const startsOn = input.startsOn || todayPanama;
    if (startsOn > todayPanama) return { error: 'La fecha inicial de la pausa no puede ser futura', code: 400 };
    if (input.endsOn && input.endsOn < startsOn) return { error: 'La fecha fin no puede ser anterior al inicio de la pausa', code: 400 };
    const [pack] = await transaction`SELECT id, total_sessions, used_sessions, expires_on FROM session_packages
      WHERE client_id = ${clientId} AND status = 'active' AND used_sessions < total_sessions
        AND (${input.packageId || null}::uuid IS NULL OR id = ${input.packageId || null})
      ORDER BY expires_on ASC NULLS LAST, purchased_on DESC LIMIT 1 FOR UPDATE`;
    if (!pack) return { error: 'No hay un paquete activo con clases pendientes para pausar', code: 409 };
    const [recurrence] = input.recurrenceId
      ? await transaction`SELECT id FROM session_recurrences WHERE id = ${input.recurrenceId} AND client_id = ${clientId} AND active FOR UPDATE`
      : await transaction`SELECT id FROM session_recurrences WHERE client_id = ${clientId} AND active ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
    const [pause] = await transaction`INSERT INTO client_package_pauses (client_id, package_id, recurrence_id, starts_on, ends_on, carried_sessions, reason, created_by)
      VALUES (${clientId}, ${pack.id}, ${recurrence?.id || null}, ${startsOn}::date, ${input.endsOn || null}::date, ${Number(pack.total_sessions) - Number(pack.used_sessions)}, ${input.reason || null}, ${auth.sub}) RETURNING *`;
    await transaction`UPDATE clients SET status = 'paused', updated_at = now() WHERE id = ${clientId}`;
    await transaction`UPDATE memberships SET status = 'paused' WHERE client_id = ${clientId} AND status = 'active'`;
    await transaction`UPDATE sessions SET paused_hold = true, updated_at = now()
      WHERE client_id = ${clientId} AND status = 'scheduled' AND starts_at >= now()`;
    return { pause, package: pack };
  });
  if ('error' in result) return reply.code(result.code || 400).send({ error: result.error });
  return reply.code(201).send(result);
});

app.post('/api/client-pauses/:id/resume', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const pauseId = z.string().uuid().parse((request.params as { id: string }).id);
  const result = await sql.begin(async transaction => {
    const [pause] = await transaction`SELECT pp.*, c.owner_id FROM client_package_pauses pp JOIN clients c ON c.id = pp.client_id
      WHERE pp.id = ${pauseId} AND c.owner_id = ${auth.sub} AND pp.status = 'active' FOR UPDATE`;
    if (!pause) return { error: 'Pausa no encontrada o ya reactivada', code: 404 };
    const [client] = await transaction`SELECT id FROM clients WHERE id = ${pause.client_id} FOR UPDATE`;
    const [updatedPause] = await transaction`UPDATE client_package_pauses SET status = 'resumed', resumed_on = current_date,
      days_frozen = GREATEST(0, current_date - starts_on), resumed_by = ${auth.sub}, resumed_at = now() WHERE id = ${pauseId} RETURNING *`;
    await transaction`UPDATE clients SET status = 'active', updated_at = now() WHERE id = ${client.id}`;
    await transaction`UPDATE memberships SET status = 'active' WHERE client_id = ${client.id} AND status = 'paused'`;
    if (pause.package_id) await transaction`UPDATE session_packages SET expires_on = CASE WHEN expires_on IS NULL THEN NULL ELSE expires_on + GREATEST(0, current_date - ${pause.starts_on}::date) END WHERE id = ${pause.package_id}`;
    await transaction`UPDATE sessions SET paused_hold = false, updated_at = now() WHERE client_id = ${client.id} AND paused_hold = true AND starts_at >= now()`;
    // Facturación nueva: el corte se corre lo que duró la pausa (solo en estado `new`, donde el generador nuevo es la fuente).
    const billing = billingEngine.newWrites ? await shiftCutAfterPause(transaction as any, auth.sub, client.id as string) : null;
    return { pause: updatedPause, billing };
  });
  if ('error' in result) return reply.code(result.code || 400).send({ error: result.error });
  await extenderRecurrencias(auth.sub, true);
  return result;
});

// Editar una cancelación recalcula el efecto de saldo sin crear descuentos o
// débitos duplicados. Las compensaciones ya aplicadas quedan protegidas.
const cancellationEditSchema = z.object({ cancelledBy: z.enum(['client', 'trainer']), rescheduled: z.boolean(), resolution: z.enum(['discount', 'none', 'debit']).optional(), creditCharge: z.boolean().optional(), amount: z.coerce.number().positive().optional() });
app.patch('/api/sessions/:id/cancellation', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = cancellationEditSchema.parse(request.body);
  const requestedResolution = input.resolution || (input.cancelledBy === 'client' && !input.rescheduled ? 'debit' : 'none');
  if (input.creditCharge && (input.cancelledBy !== 'client' || input.rescheduled)) return reply.code(400).send({ error: 'Sólo una cancelación del cliente no reprogramada puede cobrarse a crédito.' });
  const resolution = requestedResolution;
  if (input.rescheduled && resolution !== 'none') return reply.code(400).send({ error: 'Una sesión reprogramada no puede descontar ni generar compensación.' });
  if (!billingEngine.legacyWrites && input.cancelledBy === 'trainer' && resolution === 'discount') return reply.code(409).send({ error: DESCUENTO_NO_DISPONIBLE });
  if (input.cancelledBy === 'client' && !input.rescheduled && !['debit', 'none'].includes(resolution)) return reply.code(400).send({ error: 'Para una cancelación del cliente solo se permite descontar la clase o dejarla sin efecto.' });
  if (input.cancelledBy === 'trainer' && resolution === 'debit') return reply.code(400).send({ error: 'Una cancelación de la entrenadora no puede descontar una clase del cliente.' });
  const result = await sql.begin(async transaction => {
    const [session] = await transaction`SELECT s.*, c.owner_id, c.payment_mode FROM sessions s JOIN clients c ON c.id = s.client_id WHERE s.id = ${id} AND c.owner_id = ${auth.sub} FOR UPDATE`;
    if (!session || session.status !== 'cancelled') return { error: 'La sesión no está cancelada', code: 409 };
    if (session.cancellation_makeup_package_id) return { error: 'Esta compensación ya creó un paquete de reposición; edítala manualmente para no duplicar clases.', code: 409 };
    if (session.package_debited && session.package_id) {
      await transaction`UPDATE session_packages SET used_sessions = GREATEST(0, used_sessions - 1), status = CASE WHEN GREATEST(0, used_sessions - 1) >= total_sessions THEN 'exhausted' ELSE 'active' END WHERE id = ${session.package_id}`;
      await transaction`UPDATE sessions SET package_id = NULL, package_debited = false, debited_group_id = NULL WHERE id = ${id}`;
    }
    if (session.cancellation_resolution === 'discount') {
      const [credit] = await transaction`SELECT applied_invoice_id FROM billing_credits WHERE session_id = ${id} ORDER BY created_at DESC LIMIT 1`;
      if (credit?.applied_invoice_id) return { error: 'El descuento ya fue aplicado a una factura; no se puede revertir automáticamente.', code: 409 };
      // X-020: fuera de legacy no se tocan las filas heredadas de billing_credits.
      if (billingEngine.legacyWrites) await transaction`DELETE FROM billing_credits WHERE session_id = ${id} AND applied_invoice_id IS NULL`;
    }
    const isCreditClient = session.payment_mode === 'no_anticipado';
    if (isCreditClient && resolution === 'debit') return { error: 'Los clientes a crédito no descuentan una bolsa; decide si se cobra la cancelación.', code: 400 };
    const creditCharge = Boolean(isCreditClient && input.cancelledBy === 'client' && !input.rescheduled && input.creditCharge);
    if (input.cancelledBy === 'client' && !input.rescheduled && resolution === 'debit') {
      const [pack] = await transaction`SELECT id, total_sessions, used_sessions FROM session_packages WHERE client_id = ${session.client_id} AND status = 'active' AND used_sessions < total_sessions AND (expires_on IS NULL OR expires_on >= (${session.starts_at}::timestamptz AT TIME ZONE 'America/Panama')::date) ORDER BY expires_on ASC NULLS LAST, purchased_on LIMIT 1 FOR UPDATE`;
      if (pack) { const used = Number(pack.used_sessions) + 1; await transaction`UPDATE session_packages SET used_sessions = ${used}, status = CASE WHEN ${used} >= total_sessions THEN 'exhausted' ELSE 'active' END WHERE id = ${pack.id}`; await transaction`UPDATE sessions SET package_id = ${pack.id}, package_debited = true, debited_group_id = ${session.client_id} WHERE id = ${id}`; }
    }
    if (input.cancelledBy === 'trainer' && resolution === 'discount') {
      const [client] = await transaction`SELECT c.standard_price, COALESCE(p.sessions_included, c.monthly_session_target, 0)::int AS included FROM clients c LEFT JOIN service_plans p ON p.id = c.plan_id WHERE c.id = ${session.client_id}`;
      const amount = input.amount || (Number(client?.included) ? Number(client.standard_price) / Number(client.included) : 0);
      if (amount > 0) await transaction`INSERT INTO billing_credits (client_id, session_id, concept, amount) VALUES (${session.client_id}, ${id}, 'Clase cancelada por la entrenadora', ${Math.round(amount * 100) / 100})`;
    }
    const [updated] = await transaction`UPDATE sessions SET cancellation_kind = ${input.rescheduled ? 'rescheduled' : 'not_rescheduled'}, cancelled_by = ${input.cancelledBy}, cancellation_resolution = ${isCreditClient ? 'none' : resolution}, credit_charge = ${creditCharge}, cancellation_edited_at = now(), updated_at = now() WHERE id = ${id} RETURNING *`;
    await transaction`INSERT INTO session_cancellation_edits (session_id, editor_user_id, previous_cancelled_by, previous_cancellation_kind, previous_resolution, previous_credit_charge, new_cancelled_by, new_cancellation_kind, new_resolution, new_credit_charge) VALUES (${id}, ${auth.sub}, ${session.cancelled_by || null}, ${session.cancellation_kind || null}, ${session.cancellation_resolution || null}, ${Boolean(session.credit_charge)}, ${input.cancelledBy}, ${input.rescheduled ? 'rescheduled' : 'not_rescheduled'}, ${isCreditClient ? 'none' : resolution}, ${creditCharge})`;
    return { session: updated };
  });
  if ('error' in result) return reply.code(result.code || 400).send({ error: result.error });
  await recalcularFacturasNoAnticipadas(auth.sub);
  return result;
});

// Reactivar una sesión cancelada por equivocación: la devuelve a 'programada' y
// deshace lo que la cancelación había hecho —el descuento del paquete, el
// crédito pendiente o la clase de reposición—. Sin esto, la única salida a un
// clic mal dado era borrarla y volver a agendarla a mano, que no repone el
// consumo del saldo.
//
// No se toca una cancelación marcada como reprogramada: si ya se creó la clase
// de reemplazo, reactivar ésta dejaría dos, y desde aquí no hay forma de saber
// si esa otra existe. En ese caso primero se edita la cancelación a "no se
// reprograma" y luego se reactiva, que es una decisión que toma la persona.
app.post('/api/sessions/:id/reactivate', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const result = await sql.begin(async transaction => {
    const [session] = await transaction`SELECT s.* FROM sessions s JOIN clients c ON c.id = s.client_id WHERE s.id = ${id} AND c.owner_id = ${auth.sub} FOR UPDATE`;
    if (!session || session.status !== 'cancelled') return { error: 'La sesión no está cancelada', code: 409 };
    if (session.cancellation_kind === 'rescheduled') return { error: 'Esta cancelación está marcada como reprogramada; reactivarla podría dejar dos clases. Si no llegaste a crear la clase de reemplazo, edítala primero a «No, perdió la clase» y luego reactívala.', code: 409 };
    // Devolver la clase que se había descontado del saldo.
    if (session.package_debited && session.package_id) {
      await transaction`UPDATE session_packages SET used_sessions = GREATEST(0, used_sessions - 1), status = CASE WHEN GREATEST(0, used_sessions - 1) >= total_sessions THEN 'exhausted' ELSE 'active' END WHERE id = ${session.package_id}`;
    }
    // Quitar el crédito pendiente, salvo que ya se aplicara a una factura: eso
    // ya movió un cobro y no se puede deshacer solo desde aquí.
    if (session.cancellation_resolution === 'discount') {
      const [credit] = await transaction`SELECT applied_invoice_id FROM billing_credits WHERE session_id = ${id} ORDER BY created_at DESC LIMIT 1`;
      if (credit?.applied_invoice_id) return { error: 'El descuento de esta cancelación ya se aplicó a una factura; no se puede reactivar automáticamente.', code: 409 };
      // X-020: fuera de legacy no se tocan las filas heredadas de billing_credits.
      if (billingEngine.legacyWrites) await transaction`DELETE FROM billing_credits WHERE session_id = ${id} AND applied_invoice_id IS NULL`;
    }
    // Deshacer la clase de reposición. Si ya se usó, quitarla descuadraría el
    // saldo: se avisa y no se reactiva.
    if (session.cancellation_makeup_package_id) {
      const [makeup] = await transaction`SELECT id, total_sessions, used_sessions FROM session_packages WHERE id = ${session.cancellation_makeup_package_id} FOR UPDATE`;
      if (makeup) {
        if (Number(makeup.used_sessions) >= Number(makeup.total_sessions)) return { error: 'La clase de reposición que generó esta cancelación ya se usó; edítala manualmente para no descuadrar el saldo.', code: 409 };
        if (Number(makeup.total_sessions) <= 1 && Number(makeup.used_sessions) === 0) await transaction`DELETE FROM session_packages WHERE id = ${makeup.id}`;
        else await transaction`UPDATE session_packages SET total_sessions = GREATEST(0, total_sessions - 1), status = 'active' WHERE id = ${makeup.id}`;
      }
    }
    // Si quedó una reprogramación pendiente anotada, se retira con la cancelación.
    await transaction`DELETE FROM session_reschedules WHERE session_id = ${id} AND origin = 'cancelled'`;
    const [updated] = await transaction`
      UPDATE sessions SET status = 'scheduled', cancellation_kind = NULL, cancelled_by = NULL,
        cancellation_resolution = NULL, cancellation_makeup_package_id = NULL, cancellation_edited_at = NULL,
        package_id = NULL, package_debited = false, debited_group_id = NULL, updated_at = now()
      WHERE id = ${id} RETURNING *`;
    return { session: updated };
  });
  if ('error' in result) return reply.code(result.code || 400).send({ error: result.error });
  // El evento en Google no se borró al cancelar, sólo se repintó de rojo como
  // "CANCELADA": esto lo devuelve a su forma normal reusando el mismo evento.
  try { await syncSessionToGoogle(auth.sub, id); }
  catch (error) { app.log.warn({ err: error, sessionId: id }, 'Session reactivated but Google Calendar sync failed'); }
  return { reactivated: true, session: result.session };
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
// Clases DOBLES: días (futuros y de las últimas 2 semanas) en que una misma persona tiene dos o más clases vivas (programadas, realizadas o no cumplidas), aunque estén
// todas marcadas (J-101: Sara/Susie/Reina quedaron dobles y realizadas). Solo las programadas se pueden quitar desde aquí. Solo lectura: sugiere quitar (a) la programada de un día que ya tiene otra REALIZADA o no cumplida y
// (b) la creada por un horario fijo en las últimas 36 horas que no es la más antigua del día. Se borra con DELETE /api/sessions/:id/permanent (que anota la excepción para que
// el calendario no la resucite).
app.get('/api/sessions/duplicates', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const rows = await sql`
    WITH vivas AS (
      SELECT s.id::text AS id, s.client_id::text AS client_id, c.full_name, s.status, s.starts_at, (s.starts_at AT TIME ZONE 'America/Panama')::date AS dia,
        to_char(s.starts_at AT TIME ZONE 'America/Panama', 'HH24:MI') AS hora, s.created_at, s.recurrence_id IS NOT NULL AS de_horario_fijo
      FROM sessions s JOIN clients c ON c.id = s.client_id
      WHERE c.owner_id = ${auth.sub} AND s.status IN ('scheduled', 'completed', 'no_show') AND s.starts_at >= now() - interval '14 days' AND NOT COALESCE(s.paused_hold, false)),
    dobles AS (SELECT client_id, dia FROM vivas GROUP BY client_id, dia HAVING count(*) > 1)
    SELECT v.* FROM vivas v JOIN dobles d ON d.client_id = v.client_id AND d.dia = v.dia
    ORDER BY v.full_name, v.dia, v.created_at, v.starts_at`;
  type Sesion = { id: string; time: string; status: string; past: boolean; createdAt: string; fromRecurrence: boolean; removable: boolean; suggestedRemove: boolean };
  const grupos = new Map<string, { clientId: string; name: string; day: string; sessions: Sesion[] }>();
  const reciente = Date.now() - 36 * 3600_000;
  for (const row of rows) {
    const day = row.dia instanceof Date ? row.dia.toISOString().slice(0, 10) : String(row.dia).slice(0, 10);
    const key = `${row.client_id}|${day}`;
    const grupo = grupos.get(key) ?? { clientId: row.client_id as string, name: row.full_name as string, day, sessions: [] };
    grupo.sessions.push({
      id: row.id as string, time: row.hora as string, status: row.status as string, past: new Date(row.starts_at as string).getTime() < Date.now(),
      createdAt: new Date(row.created_at as string).toISOString(), fromRecurrence: Boolean(row.de_horario_fijo), removable: row.status === 'scheduled', suggestedRemove: false
    });
    grupos.set(key, grupo);
  }
  for (const grupo of grupos.values()) {
    const hayMarcada = grupo.sessions.some(item => item.status !== 'scheduled');
    grupo.sessions.forEach((item, index) => {
      if (!item.removable) return;
      item.suggestedRemove = hayMarcada || (index > 0 && item.fromRecurrence && new Date(item.createdAt).getTime() >= reciente);
    });
  }
  return { groups: [...grupos.values()] };
});

app.delete('/api/sessions/:id/permanent', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [sesion] = await sql`
    SELECT s.id, s.status, s.recurrence_id, s.recurrence_on FROM sessions s JOIN clients c ON c.id = s.client_id
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
  const [borrada] = await sql.begin(async transaction => {
    const [actual] = await transaction`
      SELECT recurrence_id, recurrence_on FROM sessions WHERE id = ${id} FOR UPDATE
    `;
    if (!actual) return [];
    if (actual.recurrence_id && actual.recurrence_on) {
      await transaction`
        INSERT INTO session_recurrence_exceptions (recurrence_id, recurrence_on)
        SELECT recurrence_id, recurrence_on
        FROM sessions
        WHERE id = ${id}
        ON CONFLICT (recurrence_id, recurrence_on) DO NOTHING
      `;
    }
    return transaction`DELETE FROM sessions WHERE id = ${id} RETURNING id, starts_at`;
  });
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
  // Quién cancela cambia a quién se le cobra la falta. Por omisión, el
  // cliente: es como se contaron todas las anteriores.
  const consulta = request.query as { by?: string; resolution?: string; amount?: string; creditCharge?: string };
  const laCancelaEllaSola = consulta.by === 'trainer';
  // 'none' es una respuesta legítima: puede que lo hable con el cliente y
  // decida después, o que no haya nada que compensar. Obligarla a elegir entre
  // reponer y descontar la empujaría a marcar cualquiera de las dos por salir
  // del paso, y eso ensucia el saldo o el cobro.
  const compensa = consulta.resolution === 'discount' ? 'discount' : 'none';
  if (!billingEngine.legacyWrites && laCancelaEllaSola && compensa === 'discount') return reply.code(409).send({ error: DESCUENTO_NO_DISPONIBLE });

  const result = await sql.begin(async transaction => {
    const [actual] = await transaction`
      SELECT s.*, c.payment_mode, COALESCE(c.credit_session_price, 25) AS credit_session_price FROM sessions s
      JOIN clients c ON c.id = s.client_id
      WHERE s.id = ${id} AND c.owner_id = ${auth.sub} AND s.status <> 'cancelled'
      FOR UPDATE
    `;
    if (!actual) return null;
    const esCredito = actual.payment_mode === 'no_anticipado';
    const cobraCancelacionCredito = Boolean(esCredito && !reprogramada && !laCancelaEllaSola && consulta.creditCharge === 'true');

    // Una sesión ya completada consumió una clase. Si después se marca como
    // reprogramada, deja de ser una clase consumida y ese débito debe revertirse
    // dentro de la misma transacción que la cancelación. Antes sólo cambiaba el
    // estado a "cancelled" y dejaba el vínculo con el saldo, creando los +1
    // vivos de Michelle y Julieta.
    if (reprogramada && actual.package_debited && actual.package_id) {
      await transaction`
        UPDATE session_packages
        SET used_sessions = GREATEST(0, used_sessions - 1),
            status = CASE WHEN GREATEST(0, used_sessions - 1) >= total_sessions THEN 'exhausted' ELSE 'active' END
        WHERE id = ${actual.package_id}
      `;
    }

    const [session] = await transaction`
      UPDATE sessions SET status = 'cancelled',
        cancellation_kind = ${reprogramada ? 'rescheduled' : 'not_rescheduled'},
        cancelled_by = ${laCancelaEllaSola ? 'trainer' : 'client'},
        cancellation_resolution = ${laCancelaEllaSola || reprogramada || esCredito ? 'none' : 'debit'},
        credit_charge = ${cobraCancelacionCredito},
        package_id = CASE WHEN ${reprogramada && Boolean(actual.package_debited)} THEN NULL ELSE package_id END,
        package_debited = CASE WHEN ${reprogramada && Boolean(actual.package_debited)} THEN false ELSE package_debited END,
        debited_group_id = CASE WHEN ${reprogramada && Boolean(actual.package_debited)} THEN NULL ELSE debited_group_id END,
        updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;

    // Cancelar pidiendo otro día es reprogramar; cancelar y perderla, no. Sólo
    // la primera se cuenta, que es la distinción que la entrenadora ya hace en
    // el diálogo y que hasta ahora no se guardaba en ninguna parte.
    if (reprogramada && !laCancelaEllaSola) {
      await transaction`
        INSERT INTO session_reschedules (session_id, client_id, from_starts_at, origin)
        VALUES (${id}, ${session.client_id}, ${session.starts_at}, 'cancelled')
      `;
    }

    // Si el cliente cancela y no solicita reprogramación, la clase contratada
    // se consume igual. Si ya estaba marcada como realizada, el débito existente
    // se conserva: no se vuelve a cobrar una segunda vez.
    let compensacion: { tipo: string; detalle: string } | null = null;
    if (!reprogramada && !laCancelaEllaSola && !esCredito && !actual.package_debited) {
      const pack = await seleccionarSaldoParaSesion(transaction, session.client_id as string, session.starts_at as Date | string);
      if (pack) {
        const siguiente = Number(pack.used_sessions) + 1;
        await transaction`
          UPDATE session_packages SET used_sessions = ${siguiente},
            status = CASE WHEN ${siguiente} >= total_sessions THEN 'exhausted' ELSE 'active' END
          WHERE id = ${pack.id}
        `;
        await transaction`
          UPDATE sessions SET package_id = ${pack.id}, package_debited = true,
            debited_group_id = ${session.client_id}, updated_at = now()
          WHERE id = ${id}
        `;
        compensacion = { tipo: 'debit', detalle: 'Una sesión descontada del plan contratado' };
      }
    }
    if (cobraCancelacionCredito) {
      compensacion = { tipo: 'credit_charge', detalle: `Cancelación registrada para cobro a $${Number(actual.credit_session_price || 25).toFixed(2)} por sesión` };
    }

    // Cuando cancela ella, el cliente no pierde una clase del plan. Si se
    // reprograma, la nueva sesión se marca normalmente y consume el saldo
    // mensual/paquete que corresponda a su fecha; no se abre una bolsa aparte.
    if (laCancelaEllaSola && compensa !== 'none') {
      const [cliente] = await transaction`
        SELECT c.id, c.standard_price, COALESCE(p.sessions_included, c.monthly_session_target, 0)::int AS incluidas
        FROM clients c LEFT JOIN service_plans p ON p.id = c.plan_id WHERE c.id = ${session.client_id}
      `;
      if (compensa === 'discount') {
        // El valor de la clase sale del plan; si no se puede deducir, se toma lo
        // que venga en la petición. Un descuento de cero no es un descuento.
        const porClase = Number(consulta.amount) > 0
          ? Number(consulta.amount)
          : (Number(cliente?.incluidas) > 0 ? Number(cliente.standard_price) / Number(cliente.incluidas) : 0);
        if (porClase > 0) {
          await transaction`
            INSERT INTO billing_credits (client_id, session_id, concept, amount)
            VALUES (${session.client_id}, ${id},
              ${`Clase no dada del ${new Intl.DateTimeFormat('es-PA', { day: 'numeric', month: 'long', timeZone: 'America/Panama' }).format(new Date(session.starts_at as string))}`},
              ${Math.round(porClase * 100) / 100})
          `;
          compensacion = { tipo: 'discount', detalle: `Descuento de ${porClase.toFixed(2)} para el próximo cobro` };
        }
      }
    }
    return { session, compensacion };
  });
  if (!result) return reply.code(404).send({ error: 'Sesión no encontrada o ya cancelada' });
  try { await cancelSessionInGoogle(auth.sub, id); }
  catch (error) { app.log.warn({ err: error, sessionId: id }, 'Session cancelled but Google Calendar deletion failed'); }
  await recalcularFacturasNoAnticipadas(auth.sub);
  return { cancelled: true, session: result.session, compensacion: result.compensacion };
});
// El resultado de una sesión es de tres estados, no de dos. Antes se deducía
// de una casilla: desmarcarla equivalía a decir "no cumplió", así que quien la
// marcaba por error no tenía forma de retirar la marca —al quitarla y guardar,
// la sesión quedaba incumplida y le bajaba el cumplimiento al cliente por algo
// que ni siquiera había ocurrido todavía—. Volver a "programada" es su propio
// estado, y se pide en claro.
type ResultadoSesion = 'scheduled' | 'completed' | 'no_show';

type SessionBillingNotice = {
  action: 'debited' | 'returned' | 'not_debited';
  packageId: string | null;
  packageLabel: string | null;
  usedSessions: number | null;
  totalSessions: number | null;
  remainingSessions: number | null;
  message: string;
};

type SessionPackageBalance = {
  id: string;
  label: string;
  total_sessions: number | string;
  used_sessions: number | string;
};

// Devuelve el saldo que puede consumir una sesión en su fecha real. Para una
// mensualidad, el día de corte compartido se resuelve a favor del ciclo que
// vence ese día (el ciclo anterior); si no existe, el ciclo que empieza ese
// día puede recibir la clase. Las clases sueltas y los paquetes conservan el
// selector anterior: su vigencia no se convierte en un corte mensual.
async function seleccionarSaldoParaSesion(
  transaction: TransactionSql | typeof sql,
  clientId: string,
  startsAt: Date | string
) {
  const [pack] = await transaction`
    SELECT sp.id, sp.label, sp.total_sessions, sp.used_sessions
    FROM session_packages sp
    JOIN clients c ON c.id = sp.client_id
    WHERE sp.client_id = ${clientId} AND sp.status = 'active' AND sp.used_sessions < sp.total_sessions
      AND c.payment_mode <> 'no_anticipado'
      AND (
        (
          COALESCE(sp.kind, 'package') = 'monthly'
          AND c.billing_model = 'monthly'
          AND sp.purchased_on IS NOT NULL AND sp.expires_on IS NOT NULL
          AND sp.purchased_on <= (${startsAt}::timestamptz AT TIME ZONE 'America/Panama')::date
          AND sp.expires_on >= (${startsAt}::timestamptz AT TIME ZONE 'America/Panama')::date
        )
        OR (
          (COALESCE(sp.kind, 'package') <> 'monthly' OR c.billing_model <> 'monthly')
          AND (sp.expires_on IS NULL OR sp.expires_on >= (${startsAt}::timestamptz AT TIME ZONE 'America/Panama')::date)
        )
      )
    ORDER BY sp.expires_on ASC NULLS LAST, sp.purchased_on, sp.created_at, sp.id
    LIMIT 1 FOR UPDATE
  `;
  return pack as SessionPackageBalance | undefined;
}

function sessionBillingNotice(pack: Record<string, unknown> | null | undefined, action: SessionBillingNotice['action']): SessionBillingNotice {
  if (!pack) {
    return {
      action, packageId: null, packageLabel: null, usedSessions: null, totalSessions: null, remainingSessions: null,
      message: action === 'returned' ? 'La sesión volvió a estar sin marcar y no consume saldo.' : 'No había un saldo vigente para descontar.'
    };
  }
  const used = Number(pack.used_sessions);
  const total = Number(pack.total_sessions);
  const remaining = Math.max(0, total - used);
  return {
    action,
    packageId: pack.id as string,
    packageLabel: pack.label as string,
    usedSessions: used,
    totalSessions: total,
    remainingSessions: remaining,
    message: action === 'returned'
      ? `Se devolvió la clase a «${pack.label}». Quedan ${remaining} disponibles.`
      : `Se descontó de «${pack.label}». Quedan ${remaining} disponibles.`
  };
}

async function recordSessionCompliance(id: string, ownerId: string, markedBy: string, resultado: ResultadoSesion, completionPercent: number, opciones: { permitirAnticipada?: boolean } = {}) {
  const completed = resultado === 'completed';
  return sql.begin(async transaction => {
    const [current] = await transaction`SELECT s.*, now() AS database_now FROM sessions s JOIN clients c ON c.id = s.client_id WHERE s.id = ${id} AND c.owner_id = ${ownerId} FOR UPDATE`;
    if (!current) return null;
    if (current.status === 'cancelled') {
      sessionStateConflict('Una sesión cancelada debe reactivarse antes de registrar su resultado.');
    }
    // Una sesión futura sigue siendo una reserva, no una asistencia ni una
    // falta. Permitir marcarla aquí hacía que un clic prematuro descontara una
    // clase antes de que llegara su fecha —el caso que dejó a Julieta con una
    // sesión usada pese a no haber entrenado—. Se compara contra now() de la
    // misma conexión para no depender del reloj del proceso ni de su zona horaria.
    // (Salvo la rutina ofrecida en lugar de la clase: ahí la prueba de que se entrenó es la propia rutina cumplida, aunque la hora de la clase no haya llegado.)
    if (current.status === 'scheduled' && resultado !== 'scheduled' && !opciones.permitirAnticipada
      && new Date(current.starts_at as Date | string) > new Date(current.database_now as Date | string)) {
      sessionStateConflict('No se puede marcar una sesión futura como realizada o no cumplida.');
    }
    const grupo = current.client_id as string;
    const descontarSaldo = async () => {
      const pack = await seleccionarSaldoParaSesion(transaction, current.client_id as string, current.starts_at as Date | string);
      if (!pack) return null;
      const nextUsed = Number(pack.used_sessions) + 1;
      const packageId = String(pack.id);
      await transaction`UPDATE session_packages SET used_sessions = ${nextUsed}, status = ${nextUsed >= Number(pack.total_sessions) ? 'exhausted' : 'active'} WHERE id = ${packageId}`;
      return { ...pack, id: packageId, used_sessions: nextUsed };
    };
    // Devolverla a programada: se deshace lo que la marca había hecho —incluido
    // el descuento del saldo— y la sesión vuelve a estar por delante, sin
    // contar ni a favor ni en contra.
    if (resultado === 'scheduled') {
      let billing: SessionBillingNotice = sessionBillingNotice(null, 'returned');
      if (current.package_debited && current.package_id) {
        const [pack] = await transaction`SELECT id, label, total_sessions, used_sessions FROM session_packages WHERE id = ${current.package_id} FOR UPDATE`;
        if (pack) {
          await transaction`UPDATE session_packages SET used_sessions = GREATEST(0, used_sessions - 1), status = 'active' WHERE id = ${current.package_id}`;
          billing = sessionBillingNotice({ ...pack, used_sessions: Math.max(0, Number(pack.used_sessions || 0) - 1) } as Record<string, unknown>, 'returned');
        }
      }
      const [devuelta] = await transaction`
        UPDATE sessions SET status = 'scheduled', completion_percent = 0, package_id = null, package_debited = false,
          completed_by_user_id = null, completion_recorded_at = null, updated_at = now()
        WHERE id = ${id} RETURNING *
      `;
      return { ...devuelta, billing };
    }
    if (!completed && current.status === 'no_show' && !current.package_debited) {
      return { ...current, billing: sessionBillingNotice(null, 'not_debited') };
    }
    if (!completed && current.package_debited && current.package_id) {
      const [pack] = await transaction`SELECT id, label, total_sessions, used_sessions FROM session_packages WHERE id = ${current.package_id} FOR UPDATE`;
      const billing = sessionBillingNotice(pack as Record<string, unknown>, 'debited');
      const [updated] = await transaction`
        UPDATE sessions SET status = 'no_show', completion_percent = 0,
          completed_by_user_id = ${markedBy}, completion_recorded_at = now(), updated_at = now()
        WHERE id = ${id} RETURNING *
      `;
      return { ...updated, billing };
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
      // Se gasta el saldo que caduca antes. Se compara contra el día de la
      // clase, no contra hoy, para que marcarla tarde no cambie el ciclo que
      // realmente consumió.
      const pack = await descontarSaldo();
      if (!pack) {
        const [updated] = await transaction`
          UPDATE sessions SET status = 'completed', completion_percent = ${completionPercent}, debited_group_id = ${grupo}, completed_by_user_id = ${markedBy}, completion_recorded_at = now(), updated_at = now()
          WHERE id = ${id} RETURNING *
        `;
        return { ...updated, billing: sessionBillingNotice(null, 'not_debited') };
      }
      const billing = sessionBillingNotice(pack, 'debited');
      const [updated] = await transaction`
        UPDATE sessions SET status = 'completed', completion_percent = ${completionPercent}, package_id = ${pack.id}, package_debited = true, debited_group_id = ${grupo},
          completed_by_user_id = ${markedBy}, completion_recorded_at = now(), updated_at = now()
        WHERE id = ${id} RETURNING *
      `;
      return { ...updated, billing };
    }
    if (!completed) {
      // No cumplió no crea una clase nueva ni la deja flotando: la clase se
      // pierde y consume el saldo que correspondía al día en que ocurrió.
      const pack = await descontarSaldo();
      const billing = sessionBillingNotice(pack, 'debited');
      const [updated] = await transaction`
        UPDATE sessions SET status = 'no_show', completion_percent = 0,
          package_id = ${pack?.id || null}, package_debited = ${Boolean(pack)}, debited_group_id = ${pack ? grupo : null},
          completed_by_user_id = ${markedBy}, completion_recorded_at = now(), updated_at = now()
        WHERE id = ${id} RETURNING *
      `;
      return { ...updated, billing };
    }
    let billing = sessionBillingNotice(null, 'not_debited');
    if (current.package_debited && current.package_id) {
      const [pack] = await transaction`SELECT id, label, total_sessions, used_sessions FROM session_packages WHERE id = ${current.package_id}`;
      billing = sessionBillingNotice(pack as Record<string, unknown>, 'debited');
    }
    const [updated] = await transaction`
      UPDATE sessions SET status = 'completed', completion_percent = ${completionPercent},
        completed_by_user_id = ${markedBy}, completion_recorded_at = now(), updated_at = now()
      WHERE id = ${id} RETURNING *
    `;
    return { ...updated, billing };
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
const dailyDateSchema = z.object({ date: z.string().date().default(() => fechaDeNegocioPanama()) });

app.get('/api/trainings/daily', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const { date } = dailyDateSchema.parse(request.query);
  return sql`
    SELECT c.id AS client_id, c.full_name, c.status, c.billing_model,
      COALESCE((SELECT sum(total_sessions - used_sessions) FROM session_packages sp WHERE sp.client_id = c.id AND sp.status = 'active' AND (sp.expires_on IS NULL OR sp.expires_on >= current_date)), 0)::integer AS available_sessions,
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
  const [calendario] = await sql`SELECT ${input.date}::date > current_date AS fecha_futura`;
  if (calendario?.fecha_futura) {
    return reply.code(409).send({ error: 'No se puede registrar entrenamiento en una fecha futura.' });
  }
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
const receivablesQuerySchema = z.object({ asOf: z.string().date().default(() => fechaDeNegocioPanama()) });

async function accountStatementData(ownerId: string, query: z.infer<typeof statementQuerySchema>) {
  const [client] = await sql`SELECT id, full_name, email, phone FROM clients WHERE id = ${query.clientId} AND owner_id = ${ownerId}`;
  if (!client) return null;
  const rows = await sql`
    SELECT i.id, COALESCE(i.issued_on, i.created_at::date) AS issued_on, i.due_on,
      COALESCE(i.invoice_number, 'EIL-' || upper(substr(i.id::text, 1, 8))) AS invoice_number,
      i.concept, i.amount,
      CASE WHEN i.source_system = 'zoho_invoice' THEN GREATEST(i.amount - i.balance, 0)
        ELSE COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END) END AS paid_amount,
      CASE WHEN i.source_system = 'zoho_invoice' THEN i.balance
        ELSE GREATEST(i.amount - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END), 0) END AS balance_amount,
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
      i.concept, CASE WHEN i.source_system = 'zoho_invoice' THEN i.balance
        ELSE GREATEST(i.amount - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END), 0) END AS balance_amount,
      (${asOf}::date - i.due_on)::integer AS days_overdue,
      CASE WHEN i.source_system = 'zoho_invoice' THEN 'Zoho' ELSE 'Eileen' END AS source_label
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE c.owner_id = ${ownerId} AND i.status <> 'void'
      AND CASE WHEN i.source_system = 'zoho_invoice' THEN i.balance
        ELSE GREATEST(i.amount - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END), 0) END > 0
      AND COALESCE(i.issued_on, i.created_at::date) <= ${asOf}::date
    ORDER BY days_overdue DESC, c.full_name
  ` as unknown as Record<string, any>[];
  return rows.map((row: Record<string, any>): Record<string, any> => {
    const days = Number(row.days_overdue);
    const aging = days <= 0 ? 'Por vencer' : days <= 30 ? '1-30 días' : days <= 60 ? '31-60 días' : days <= 90 ? '61-90 días' : 'Más de 90 días';
    return { ...row, days_overdue: days, balance_amount: Number(row.balance_amount), aging };
  });
}

// Enlaces de documento con NOMBRE de archivo (J-100): un PDF protegido se abría desde un blob y el visor del navegador lo guardaba con un nombre
// aleatorio (UUID). Aquí se canjea, con la sesión, un boleto de corta vida (5 min) por una URL cuyo último tramo ES el nombre del archivo y que responde con
// Content-Disposition; el visor, "Abrir PDF" y "Descargar" usan esa misma URL. El boleto repite el GET protegido con el token de quien lo pidió (mismas
// reglas de acceso), solo admite rutas /api/... de PDF y nunca se guarda en disco.
const pdfTickets = new Map<string, { token: string; path: string; expires: number }>();
const PDF_TICKET_MS = 5 * 60_000;
app.post('/api/pdf-tickets', { preHandler: requireAuth }, async (request, reply) => {
  const { path } = z.object({ path: z.string().min(5).max(400) }).parse(request.body);
  if (!/^\/api\/[A-Za-z0-9\/_\-.?=&%:,]+$/.test(path) || path.includes('..') || !/((\/pdf|\.pdf)(\?|$)|[?&]format=pdf)/.test(path)) {
    return reply.code(400).send({ error: 'Solo se puede abrir un documento PDF' });
  }
  const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const now = Date.now();
  for (const [key, value] of pdfTickets) if (value.expires < now) pdfTickets.delete(key);
  if (pdfTickets.size > 2000) return reply.code(429).send({ error: 'Demasiados documentos abiertos; intenta en unos minutos' });
  const id = randomBytes(24).toString('base64url');
  pdfTickets.set(id, { token, path, expires: now + PDF_TICKET_MS });
  return { id, expiresInSeconds: PDF_TICKET_MS / 1000 };
});
app.get('/api/pdf-ticket/:id/:name', async (request, reply) => {
  const { id, name } = request.params as { id: string; name: string };
  const ticket = pdfTickets.get(id);
  if (!ticket || ticket.expires < Date.now()) { pdfTickets.delete(id); return reply.code(404).send({ error: 'El enlace del documento venció; ábrelo de nuevo' }); }
  const res = await app.inject({ method: 'GET', url: ticket.path, headers: { authorization: `Bearer ${ticket.token}` } });
  if (res.statusCode !== 200) return reply.code(res.statusCode).type('application/json').send(res.body);
  const base = String(name).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || 'documento';
  const fileName = base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
  const attachment = (request.query as { download?: string }).download === '1';
  reply.header('Content-Type', 'application/pdf');
  reply.header('Content-Disposition', `${attachment ? 'attachment' : 'inline'}; filename="${fileName}"`);
  reply.header('Cache-Control', 'private, no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  return reply.send(res.rawPayload);
});

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

// Tras el corte (estado `new`) el listado que alimenta el resumen y las fichas mezcla la historia anterior a septiembre de 2026
// (archivo del sistema anterior) con las facturas nuevas, con la MISMA forma que las viejas para que las pantallas no cambien.
async function newBillingInvoicesAsLegacy(ownerId: string) {
  const rows = await sql`
    SELECT i.id::text AS id, i.payer_client_id::text AS client_id, i.number, i.kind, i.origin, i.cycle_start::text AS cycle_start, i.cycle_end::text AS cycle_end,
      i.issued_on::text AS issued_on, i.due_on::text AS due_on, i.total::text AS total, i.status, i.notes, i.created_at, p.full_name,
      COALESCE((SELECT sum(a.amount) FROM billing_payment_applications a WHERE a.invoice_id = i.id AND a.reversed_at IS NULL), 0)::text AS paid,
      (SELECT pm.method FROM billing_payment_applications a JOIN billing_payments pm ON pm.id = a.payment_id WHERE a.invoice_id = i.id AND a.reversed_at IS NULL ORDER BY a.created_at DESC LIMIT 1) AS method
    FROM billing_invoices i JOIN clients p ON p.id = i.payer_client_id
    WHERE i.owner_id = ${ownerId} AND i.status <> 'anulada' ORDER BY i.created_at DESC`;
  return rows.map(row => {
    const total = Number(row.total); const paid = Number(row.paid); const balance = desdeCentavos(centavos(total) - centavos(paid));
    return {
      id: row.id, client_id: row.client_id, package_id: null, concept: `${billingKindText[row.kind as string] || row.kind} · ${dmy(row.cycle_start)} → ${dmy(row.cycle_end)}`,
      amount: total, currency: 'USD', due_on: row.due_on, status: row.status === 'pagada' ? 'confirmed' : 'pending', payment_method: row.method ?? null, payment_reference: null,
      confirmed_at: null, created_at: row.created_at, source_system: 'billing_new', external_id: null, invoice_number: billingCode(row.number), issued_on: row.issued_on,
      subtotal: total, tax_total: 0, balance, line_items: [], external_status: null, notes: row.notes ?? null, billing_period: null, auto_generated: row.origin === 'auto',
      billed_for_client_id: null, full_name: row.full_name, billed_for_name: null, credit_invoice: row.kind === 'credito', coverage_applied: 0,
      paid_amount: paid, balance_amount: balance, coverage_start: row.issued_on
    };
  });
}

app.get('/api/invoices', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  if (billingEngine.state === 'new') {
    const history = await sql`
      SELECT i.id, i.client_id, i.package_id, i.concept, i.amount, i.currency, i.due_on, i.status, i.payment_method, i.payment_reference, i.confirmed_at, i.created_at, i.source_system,
        i.external_id, i.invoice_number, i.issued_on, i.subtotal, i.tax_total, i.balance, i.line_items, i.external_status, i.notes, i.external_updated_at, i.billing_period, i.auto_generated,
        i.billed_for_client_id, c.full_name, beneficiario.full_name AS billed_for_name, false AS credit_invoice, 0 AS coverage_applied,
        CASE WHEN i.source_system = 'zoho_invoice' THEN GREATEST(i.amount - i.balance, 0)
          ELSE COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END) END AS paid_amount,
        CASE WHEN i.source_system = 'zoho_invoice' THEN i.balance
          ELSE GREATEST(i.amount - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END), 0) END AS balance_amount,
        COALESCE(i.issued_on, i.due_on) AS coverage_start
      FROM invoices i JOIN clients c ON c.id = i.client_id LEFT JOIN clients beneficiario ON beneficiario.id = COALESCE(i.billed_for_client_id, i.client_id)
      WHERE c.owner_id = ${auth.sub} AND COALESCE(i.issued_on, i.due_on, i.created_at::date) < ${NEW_BILLING_CLEAN_START}::date ORDER BY i.created_at DESC`;
    return [...(await newBillingInvoicesAsLegacy(auth.sub)), ...history];
  }
  // Sin source_payload: es el JSON crudo que devolvió Zoho por cada factura y
  // no se necesita para la lista. line_items sí se devuelve: las facturas a
  // crédito deben mostrar qué sesiones y qué cancelaciones se cobraron.
  return sql`
    SELECT i.id, i.client_id, i.package_id, i.concept, i.amount, i.currency, i.due_on, i.status,
      i.payment_method, i.payment_reference, i.confirmed_at, i.created_at, i.source_system,
      i.external_id, i.invoice_number, i.issued_on, i.subtotal, i.tax_total, i.balance, i.line_items,
      i.external_status, i.notes, i.external_updated_at, i.billing_period, i.auto_generated,
      i.billed_for_client_id, c.full_name,
      beneficiario.full_name AS billed_for_name,
      (i.source_system IS NULL AND COALESCE(beneficiario.payment_mode, c.payment_mode) = 'no_anticipado'
        AND COALESCE(beneficiario.billing_model, c.billing_model) = 'monthly') AS credit_invoice,
      (SELECT count(*)::int FROM invoice_coverage cov WHERE cov.invoice_id = i.id) AS coverage_applied,
      CASE WHEN i.source_system = 'zoho_invoice' THEN GREATEST(i.amount - i.balance, 0)
        ELSE COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END) END AS paid_amount,
      CASE WHEN i.source_system = 'zoho_invoice' THEN i.balance
        ELSE GREATEST(i.amount - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END), 0) END AS balance_amount,
      -- La fecha desde la que corre la validez de un paquete: el pago real, no la
      -- emisión. Un cobro de Zoho no tiene confirmed_at pero sí un pago en
      -- invoice_payments, y anclar a la emisión dejaba el tope de 6 semanas en el
      -- pasado. Misma fórmula que usa la cobertura para no separarse.
      COALESCE((SELECT min(ip.paid_on) FROM payment_allocations pa JOIN invoice_payments ip ON ip.id = pa.payment_id WHERE pa.invoice_id = i.id), i.issued_on, i.due_on) AS coverage_start
    FROM invoices i
    JOIN clients c ON c.id = i.client_id
    LEFT JOIN clients beneficiario ON beneficiario.id = COALESCE(i.billed_for_client_id, i.client_id)
    WHERE c.owner_id = ${auth.sub} ORDER BY i.created_at DESC
  `;
});


// Cobros sin saldo de sesiones vinculado, para cerrar la migración.

// Archivo (solo lectura): SOLO el historial de Zoho anterior al inicio en limpio (01-09-2026) (J-069: lo hecho en la app antes de septiembre no se muestra).
// No escribe nada. Desde septiembre todo vive en Facturas y Cobros; lo que se haya olvidado se ingresa a mano allí.
app.get('/api/billing/archive', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const query = z.object({
    clientId: z.string().uuid().optional(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
    status: z.enum(['pagada', 'pendiente', 'anulada']).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(500)
  }).parse(request.query);
  const rows = await sql`
    SELECT i.id::text AS id, i.invoice_number, c.full_name AS client, i.client_id::text AS client_id, i.concept, i.status, i.source_system,
      COALESCE(i.issued_on, i.due_on, i.created_at::date)::text AS issued_on, i.due_on::text AS due_on, i.amount::text AS amount,
      CASE WHEN i.source_system = 'zoho_invoice' THEN GREATEST(i.amount - i.balance, 0)
        ELSE COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END) END::text AS paid,
      i.payment_method, i.confirmed_at::date::text AS confirmed_on
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE c.owner_id = ${auth.sub} AND i.source_system = 'zoho_invoice' AND COALESCE(i.issued_on, i.due_on, i.created_at::date) < ${NEW_BILLING_CLEAN_START}::date
      AND (${query.clientId ?? null}::uuid IS NULL OR i.client_id = ${query.clientId ?? null} OR i.billed_for_client_id = ${query.clientId ?? null})
      AND (${query.month ?? null}::text IS NULL OR to_char(COALESCE(i.issued_on, i.due_on, i.created_at::date), 'YYYY-MM') = ${query.month ?? null})
      AND (${query.status ?? null}::text IS NULL OR (${query.status ?? null} = 'pagada' AND i.status = 'confirmed') OR (${query.status ?? null} = 'pendiente' AND i.status = 'pending') OR (${query.status ?? null} = 'anulada' AND i.status = 'void'))
    ORDER BY COALESCE(i.issued_on, i.due_on, i.created_at::date) DESC, i.created_at DESC LIMIT ${query.limit}`;
  const ids = rows.map(row => row.id as string);
  const payments = ids.length ? await sql`
    SELECT pa.invoice_id::text AS invoice_id, ip.paid_on::text AS paid_on, ip.method, pa.amount::text AS amount
    FROM payment_allocations pa JOIN invoice_payments ip ON ip.id = pa.payment_id
    WHERE pa.invoice_id IN ${sql(ids)} ORDER BY ip.paid_on` : [];
  const statusLabel: Record<string, string> = { confirmed: 'pagada', pending: 'pendiente', void: 'anulada' };
  const invoices = rows.map(row => {
    const amount = Number(row.amount); const paid = Number(row.paid);
    const own = payments.filter(item => item.invoice_id === row.id).map(item => ({ paidOn: item.paid_on as string, method: (item.method as string | null) ?? null, amount: Number(item.amount) }));
    // Sin cobros ligados (facturas del sistema viejo confirmadas a mano): se muestra el método y la fecha de confirmación.
    const shown = own.length ? own : (row.status === 'confirmed' && row.confirmed_on ? [{ paidOn: row.confirmed_on as string, method: (row.payment_method as string | null) ?? null, amount }] : []);
    return {
      id: row.id as string, number: (row.invoice_number as string | null) ?? null, clientId: row.client_id as string, client: row.client as string, concept: row.concept as string,
      issuedOn: row.issued_on as string, dueOn: (row.due_on as string | null) ?? null, amount, paid, balance: row.status === 'void' ? 0 : Math.max(0, amount - paid),
      status: statusLabel[row.status as string] ?? (row.status as string), source: row.source_system === 'zoho_invoice' ? 'zoho' : 'sistema', payments: shown
    };
  });
  const live = invoices.filter(invoice => invoice.status !== 'anulada');
  const [meta] = await sql`
    SELECT COALESCE(array_agg(DISTINCT to_char(COALESCE(i.issued_on, i.due_on, i.created_at::date), 'YYYY-MM')), '{}') AS months
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE c.owner_id = ${auth.sub} AND i.source_system = 'zoho_invoice' AND COALESCE(i.issued_on, i.due_on, i.created_at::date) < ${NEW_BILLING_CLEAN_START}::date`;
  return {
    cleanStart: NEW_BILLING_CLEAN_START, invoices,
    summary: { count: invoices.length, total: desdeCentavos(live.reduce((sum, item) => sum + centavos(item.amount), 0)), paid: desdeCentavos(live.reduce((sum, item) => sum + centavos(item.paid), 0)), balance: desdeCentavos(live.reduce((sum, item) => sum + centavos(item.balance), 0)) },
    meta: { months: (meta.months as string[]).slice().sort().reverse() }
  };
});

app.get('/api/billing/analytics', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const { year } = z.object({ year: z.coerce.number().int().min(2000).max(2100) }).parse(request.query);
  const start = `${year}-01-01`; const end = `${year + 1}-01-01`;
  const [monthlyRows, topClientRows] = await Promise.all([
    // Cobrado por mes = dinero recibido (pagos por fecha de pago), no facturas
    // emitidas. Los pagos de Zoho migrados ya están en invoice_payments, así que
    // basta sumarlos: incluir además las facturas los contaría dos veces.
    sql`
      SELECT EXTRACT(month FROM p.paid_on)::integer AS month,
        count(*)::integer AS invoice_count, COALESCE(sum(p.amount), 0)::numeric AS amount
      FROM ${incomePaymentsSource(auth.sub)} p
      WHERE p.paid_on >= ${start}::date AND p.paid_on < ${end}::date
      GROUP BY 1 ORDER BY 1
    `,
    sql`
      WITH received_payments AS (
        SELECT p.client_id, p.amount, p.paid_on
        FROM ${incomePaymentsSource(auth.sub)} p
        WHERE p.paid_on >= ${start}::date AND p.paid_on < ${end}::date
        UNION ALL
        SELECT i.client_id, i.amount, COALESCE(i.confirmed_at::date, i.issued_on, i.due_on) AS paid_on
        FROM invoices i JOIN clients c ON c.id = i.client_id
        WHERE c.owner_id = ${auth.sub} AND i.status = 'confirmed' AND i.source_system IS DISTINCT FROM 'zoho_invoice'
          AND ${billingEngine.state === 'new' ? sql`false` : sql`true`}
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
      CASE WHEN i.source_system = 'zoho_invoice' THEN GREATEST(i.amount - i.balance, 0)
        ELSE COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END) END AS paid_amount,
      CASE WHEN i.source_system = 'zoho_invoice' THEN i.balance
        ELSE GREATEST(i.amount - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END), 0) END AS balance_amount
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
const invoiceRecalculateSchema = z.object({ apply: z.boolean().default(false) });

// Las facturas de crédito cerradas se congelan para que la reconciliación
// automática nunca cambie un importe ya cobrado. Esta ruta es la excepción
// explícita de Eileen: primero devuelve una vista previa y sólo con apply=true
// modifica la factura. Si el nuevo importe sube, queda pendiente por el saldo;
// si baja, permanece confirmada y no genera devoluciones automáticas.
app.post('/api/invoices/:id/recalculate', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = invoiceRecalculateSchema.parse(request.body || {});
  const [factura] = await sql`
    SELECT i.id, i.client_id, i.billed_for_client_id, i.due_on, i.status, i.amount,
      COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id),
        CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END, 0)::numeric AS paid_amount,
      c.standard_price, c.credit_session_price, c.billing_cutoff_day,
      COALESCE(c.monthly_session_target, p.sessions_included, 0)::integer AS target_sessions
    FROM invoices i
    JOIN clients owner_client ON owner_client.id = i.client_id
    JOIN clients c ON c.id = COALESCE(i.billed_for_client_id, i.client_id)
    LEFT JOIN service_plans p ON p.id = c.plan_id
    WHERE i.id = ${id} AND owner_client.owner_id = ${auth.sub}
      AND i.source_system IS NULL AND i.status <> 'void'
      AND c.payment_mode = 'no_anticipado' AND c.billing_model = 'monthly'
  ` as unknown as FacturaCredito[];
  if (!factura) return reply.code(404).send({ error: 'Factura de crédito local no encontrada' });
  const calculation = await calcularFacturaCredito(factura);
  if (!calculation) return reply.code(409).send({ error: 'La factura no tiene una tarifa de crédito válida' });
  const previousAmount = Number(factura.amount || 0);
  const difference = Number((calculation.amount - previousAmount).toFixed(2));
  const result = {
    invoiceId: factura.id,
    preview: !input.apply,
    applied: Boolean(input.apply),
    previousAmount,
    newAmount: calculation.amount,
    difference,
    previousStatus: factura.status,
    newStatus: calculation.status,
    paidAmount: calculation.paidAmount,
    balance: Math.max(0, Number((calculation.amount - calculation.paidAmount).toFixed(2))),
    cycle: calculation.cycle,
    lineItems: calculation.lineItems
  };
  if (!input.apply) return result;

  await sql.begin(async transaction => {
      await transaction`
        UPDATE invoices SET amount = ${calculation.amount}, subtotal = ${calculation.amount},
          concept = ${calculation.concept}, line_items = ${transaction.json(calculation.lineItems)},
          balance = ${result.balance}, status = ${calculation.status},
          confirmed_at = CASE WHEN ${calculation.status} = 'pending' THEN NULL ELSE confirmed_at END
        WHERE id = ${factura.id} AND status <> 'void'
      `;
      await transaction`
        INSERT INTO audit_log (user_id, user_email, action, route, target_id, detail, ip)
        VALUES (${auth.sub}, ${auth.email || null}, 'RECALCULATE_CREDIT_INVOICE',
          ${request.routeOptions?.url || request.url}, ${factura.id},
          ${transaction.json({ previousAmount, newAmount: calculation.amount, difference, previousStatus: factura.status, newStatus: calculation.status, paidAmount: calculation.paidAmount, cycle: calculation.cycle })},
          ${request.ip || null})
      `;
    });
  return result;
});


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
  // El ciclo va del cobro al corte siguiente, así que casi siempre pisa dos
  // meses. Se etiqueta con aquel donde cae la mayor parte: se mira el punto
  // medio, quince días después del cobro.
  //
  // Suponer "el mes que viene" era cierto sólo para los cortes de fin de mes.
  // Con corte el día 1, un pago del 1 de septiembre cubre septiembre —hasta el
  // 1 de octubre—, y la aplicación proponía octubre.
  const dia = mediodiaEnPanama(dueOn);
  const medio = new Date(dia);
  medio.setUTCDate(medio.getUTCDate() + 15);
  return new Date(Date.UTC(medio.getUTCFullYear(), medio.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

// Del corte al corte siguiente. Es el período que de verdad cubre un cobro
// mensual, y el que hay que enseñar: decir "octubre" cuando se cubre del 1 de
// octubre al 1 de noviembre es cierto a medias, y con corte el día 1 no es
// cierto en absoluto.
function rangoDelCiclo(inicio: Date | string, fin: Date | string): string {
  // dd-mm-yyyy para mostrar, consistente con el resto de la aplicación.
  const formato = (fecha: Date | string) => {
    const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Panama', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(mediodiaEnPanama(fecha)).split('-');
    return `${d}-${m}-${y}`;
  };
  return `${formato(inicio)} – ${formato(fin)}`;
}

// El corte que cierra el ciclo abierto en `inicio`: el del mismo mes si aún no
// ha llegado, y si no el del siguiente.
function corteSiguiente(inicio: Date, diaDeCorte: number): Date {
  const enMes = (anio: number, mes: number) => {
    const ultimo = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
    return new Date(Date.UTC(anio, mes, Math.min(diaDeCorte || 1, ultimo), 12));
  };
  let corte = enMes(inicio.getUTCFullYear(), inicio.getUTCMonth());
  if (corte <= inicio) corte = enMes(inicio.getUTCFullYear(), inicio.getUTCMonth() + 1);
  return corte;
}

// El día en que se cierra el ciclo cubierto: el corte del cliente dentro del
// mes que cubre. Sin esto el saldo no vencería nunca y las sesiones no dadas
// se acumularían mes tras mes.
function cierreDelCiclo(periodo: string, diaDeCorte: number): string {
  // El corte que viene DESPUÉS de que empiece el período. Antes se tomaba el
  // corte del mismo mes sin más, y con corte el día 1 un ciclo que empezaba el
  // 1 de octubre vencía el 1 de octubre: el saldo nacía muerto.
  return corteSiguiente(mediodiaEnPanama(periodo), diaDeCorte).toISOString().slice(0, 10);
}

// El corte que cierra el ciclo en curso en `inicio`: el del mismo mes si ya
// pasó (o es hoy), y si no el del mes anterior. Es el gemelo de corteSiguiente.
function corteAnterior(inicio: Date, diaDeCorte: number): Date {
  const enMes = (anio: number, mes: number) => {
    const ultimo = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
    return new Date(Date.UTC(anio, mes, Math.min(diaDeCorte || 1, ultimo), 12));
  };
  let corte = enMes(inicio.getUTCFullYear(), inicio.getUTCMonth());
  if (corte > inicio) corte = enMes(inicio.getUTCFullYear(), inicio.getUTCMonth() - 1);
  return corte;
}

// El ciclo mensual que CONTIENE la fecha de referencia, anclado al día de corte
// del cliente. El pago NO mueve las fechas: un pago del 17 con corte 15 cae en
// el ciclo 15→15, no 17→17. El corte manda —está en la configuración del
// cliente— y el pago sólo lo salda. Devuelve inicio (corte anterior) y vence
// (corte siguiente).
function cicloDelCorte(referencia: string | Date, diaDeCorte: number): { inicio: string; vence: string } {
  const ref = mediodiaEnPanama(referencia);
  const inicio = corteAnterior(ref, diaDeCorte);
  const vence = corteSiguiente(ref, diaDeCorte);
  return { inicio: inicio.toISOString().slice(0, 10), vence: vence.toISOString().slice(0, 10) };
}

// Permite consultar ciclos anteriores sin restar una cantidad fija de días;
// eso conserva correctamente los cortes 28/30/31 y el ajuste de febrero.
function cicloDelCorteDesplazado(referencia: string | Date, diaDeCorte: number, desplazamiento: number): { inicio: string; vence: string } {
  let ciclo = cicloDelCorte(referencia, diaDeCorte);
  for (let i = 0; i < desplazamiento; i += 1) {
    const referenciaAnterior = mediodiaEnPanama(ciclo.inicio);
    referenciaAnterior.setUTCDate(referenciaAnterior.getUTCDate() - 1);
    ciclo = cicloDelCorte(referenciaAnterior, diaDeCorte);
  }
  return ciclo;
}

async function coberturaDeCobro(ownerId: string, invoiceId: string) {
  const [invoice] = await sql`
    SELECT i.id, i.client_id, i.billed_for_client_id, i.concept, i.amount, i.due_on, i.billing_period, i.status,
      i.source_system, i.issued_on, c.full_name,
      COALESCE((SELECT min(ip.paid_on) FROM payment_allocations pa JOIN invoice_payments ip ON ip.id = pa.payment_id WHERE pa.invoice_id = i.id), i.issued_on, i.due_on) AS coverage_start
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.id = ${invoiceId} AND c.owner_id = ${ownerId}
  `;
  if (!invoice) return null;
  // El titular del cobro y todas las personas a su cargo. Quien paga suele
  // entrenar también, así que entra en la lista como uno más.
  const candidates = await sql`
    SELECT c.id, c.full_name, c.status, c.billing_cutoff_day,
      COALESCE(p.price, c.standard_price, 0) AS suggested_amount,
      -- Autocompletar sesiones: la meta del perfil, el plan, y de último el saldo
      -- mensual vigente del cliente (así los que vienen de Zoho sin meta ni plan
      -- también autocompletan, con lo que de verdad tienen abierto).
      COALESCE(c.monthly_session_target, p.sessions_included,
        (SELECT sp.total_sessions FROM session_packages sp
          WHERE sp.client_id = c.id AND sp.kind = 'monthly' AND sp.status = 'active'
          ORDER BY sp.expires_on DESC NULLS LAST, sp.created_at DESC LIMIT 1),
        0)::integer AS suggested_sessions,
      p.name AS plan_name
    FROM clients c
    LEFT JOIN service_plans p ON p.id = c.plan_id
    WHERE c.owner_id = ${ownerId}
      AND (c.id = ${invoice.client_id} OR c.billing_responsible_client_id = ${invoice.client_id})
      -- Sólo mensuales: un cliente de clase suelta no se cubre con mensualidad
      -- aunque lo pague un titular mensual.
      AND c.billing_model = 'monthly'
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
  const periodoSugerido = mesCubiertoPorDefecto(invoice.billing_period || invoice.due_on);
  return { invoice, candidates, applied, suggestedPeriod: periodoSugerido, coverageStart: invoice.coverage_start };
}

// El período exacto que cubriría un mes elegido, para un corte dado. Lo usa la
// pantalla de cobertura: enseñar "octubre" sin decir hasta cuándo es lo que
// llevó a pensar que un pago del 1 de septiembre cubría octubre.
app.get('/api/billing/cycle', { preHandler: requireStaff }, async request => {
  const query = z.object({ from: z.string().date(), cutoffDay: z.coerce.number().int().min(1).max(31) }).parse(request.query);
  const inicio = mediodiaEnPanama(query.from);
  const fin = corteSiguiente(inicio, query.cutoffDay);
  return { from: inicio.toISOString().slice(0, 10), to: fin.toISOString().slice(0, 10), label: rangoDelCiclo(inicio, fin) };
});

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

// Abre el saldo mensual de cada entrada y anota la cobertura del cobro. Lo
// comparten el botón "Aplicar a mensualidades" y la apertura automática al
// confirmar el pago de una mensualidad, para que los dos abran el saldo con la
// misma regla y no se separen con el tiempo.
async function abrirCobertura(
  transaction: TransactionSql,
  ownerId: string,
  invoice: { id: string; client_id: string; coverage_start: string | Date | null; due_on?: string | Date | null },
  periodo: string,
  entries: { clientId: string; amount: number; sessions: number }[]
): Promise<{ abiertos: { clientId: string; fullName: string; sessions: number; packageId: string | null }[] } | { error: string; code: number }> {
  const abiertos: { clientId: string; fullName: string; sessions: number; packageId: string | null }[] = [];
  for (const entry of entries) {
    await lockBillingClient(transaction, entry.clientId);
    const [cliente] = await transaction`
      SELECT c.id, c.full_name, c.billing_cutoff_day, c.billing_model
      FROM clients c
      WHERE c.id = ${entry.clientId} AND c.owner_id = ${ownerId}
        AND (c.id = ${invoice.client_id} OR c.billing_responsible_client_id = ${invoice.client_id})
    `;
    // Sólo el titular del cobro y su gente: cubrir a un tercero desde aquí
    // sería mover dinero de un expediente a otro sin dejar rastro.
    if (!cliente) return { error: 'Esa persona no depende de quien paga este cobro', code: 400 };
    // Salvaguarda: un cliente que no es mensual NUNCA recibe saldo de
    // mensualidad, aunque lo cubra un pagador mensual. Las clases sueltas no
    // salen de una bolsa —la entrenadora cobra cada clase aparte y el
    // cumplimiento se marca a mano—, así que abrirles una mensualidad las
    // convertiría en algo que no son. Se salta sin dejar rastro.
    if (cliente.billing_model !== 'monthly') continue;

    let packageId: string | null = null;
    let creado = false;
    if (entry.sessions > 0) {
      // El ciclo se ancla al día de corte del cliente, no a la fecha del pago:
      // un pago del 17 con corte 15 cae en el ciclo 15→15, no 17→17. Se toma la
      // fecha real del pago para saber en qué ciclo cae, y el corte fija las
      // fronteras.
      // El ciclo lo fija el corte de la factura, no el día en que se registró
      // el pago. Un pago anticipado del día 2 para un corte 28 cubre 28→28,
      // no 2→28 del mes siguiente.
      const referencia = invoice.due_on || invoice.coverage_start || periodo;
      const { inicio: inicioCiclo, vence } = cicloDelCorte(referencia, Number(cliente.billing_cutoff_day) || 1);
      // Si esta persona ya tiene un saldo mensual vigente del ciclo (abierto al
      // asignar el plan o por la generación), no se abre otro: se reusa y se le
      // enlaza este cobro. Así el cobro de grupo no le duplica el saldo al
      // titular que ya lo tenía por su plan.
      const [vigente] = await transaction`
        SELECT id FROM session_packages
        WHERE client_id = ${cliente.id} AND kind = 'monthly' AND status = 'active'
          AND expires_on IS NOT NULL AND expires_on > ${inicioCiclo}::date
          -- No se reusa el saldo de OTRO cobro (p. ej. unas clases que la persona
          -- pagó aparte): ése es suyo y este cobro de grupo debe abrir su
          -- mensualidad familiar en paralelo. Sólo se reusa el del plan o la
          -- generación (sin origen) o el de este mismo cobro.
          AND (origin_invoice_id IS NULL OR origin_invoice_id = ${invoice.id})
        ORDER BY expires_on DESC LIMIT 1
      `;
      if (vigente) {
        packageId = vigente.id;
        await transaction`
          UPDATE session_packages SET origin_invoice_id = COALESCE(origin_invoice_id, ${invoice.id})
          WHERE id = ${vigente.id}
        `;
      } else {
        const [pack] = await transaction`
          INSERT INTO session_packages (client_id, label, total_sessions, amount, expires_on, kind, purchased_on, origin_invoice_id, status)
          VALUES (${cliente.id},
            ${'Mensualidad · ' + rangoDelCiclo(inicioCiclo, vence)},
            ${entry.sessions}, ${entry.amount}, ${vence}::date, 'monthly', ${inicioCiclo}::date, ${invoice.id}, 'active')
          RETURNING id
        `;
        packageId = pack.id;
        creado = true;
        await cobrarClasesYaDadas(transaction, pack.id, cliente.id, vence, entry.sessions);
      }
    }
    // El índice único de (cliente, período) es lo que hace inofensivo pulsar
    // dos veces: la segunda no abre otro saldo, la deja como estaba.
    const [cov] = await transaction`
      INSERT INTO invoice_coverage (invoice_id, client_id, package_id, amount, billing_period)
      VALUES (${invoice.id}, ${cliente.id}, ${packageId}, ${entry.amount}, ${periodo}::date)
      ON CONFLICT (client_id, billing_period) DO NOTHING
      RETURNING id
    `;
    if (!cov) {
      // Ya hay una cobertura de (cliente, período). Puede ser de tres formas:
      const [otra] = await transaction`
        SELECT id, invoice_id, package_id FROM invoice_coverage
        WHERE client_id = ${cliente.id} AND billing_period = ${periodo}::date
      `;
      const [vivo] = otra?.package_id
        ? await transaction`SELECT id FROM session_packages WHERE id = ${otra.package_id} AND status <> 'cancelled'`
        : [];
      if (otra && String(otra.invoice_id) === String(invoice.id)) {
        // (a) De ESTE mismo cobro: es un reintento. Si su saldo sigue vivo, el
        // que acabamos de abrir sobra y se deshace. Si el saldo se había perdido
        // (cobertura huérfana), se re-enlaza el nuevo para no dejarla sin saldo.
        if (vivo) {
          if (packageId && creado) await transaction`DELETE FROM session_packages WHERE id = ${packageId}`;
          continue;
        }
        await transaction`UPDATE invoice_coverage SET package_id = ${packageId} WHERE id = ${otra.id}`;
      }
      // (b) De OTRO cobro (unas clases que pagó aparte): su mensualidad familiar
      // es un saldo legítimo en paralelo y se conserva; el índice sólo impide
      // registrar una segunda cobertura del período, no abrir el saldo.
      abiertos.push({ clientId: cliente.id, fullName: cliente.full_name as string, sessions: entry.sessions, packageId });
      continue;
    }
    abiertos.push({ clientId: cliente.id, fullName: cliente.full_name as string, sessions: entry.sessions, packageId });
  }
  return { abiertos };
}

app.post('/api/invoices/:id/coverage', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = coverageSchema.parse(request.body);
  const [invoice] = await sql`
    SELECT i.id, i.client_id, i.billed_for_client_id, i.auto_generated, i.amount, i.status, i.source_system, i.due_on,
      COALESCE((SELECT min(ip.paid_on) FROM payment_allocations pa JOIN invoice_payments ip ON ip.id = pa.payment_id WHERE pa.invoice_id = i.id), i.issued_on, i.due_on) AS coverage_start
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.id = ${id} AND c.owner_id = ${auth.sub} AND i.status <> 'void'
  `;
  if (!invoice) return reply.code(404).send({ error: 'Cobro no encontrado' });
  if (invoice.auto_generated && invoice.billed_for_client_id && (input.entries.length !== 1
    || input.entries[0].clientId !== invoice.billed_for_client_id
    || Math.abs(Number(input.entries[0].amount) - Number(invoice.amount)) > 0.01)) {
    return reply.code(400).send({ error: 'Esta línea corresponde a una sola persona y debe aplicarse por el importe completo de la línea.' });
  }
  // El mes se guarda siempre por su día uno: es la unidad con la que compara
  // la generación, y un día suelto la haría fallar por un día de diferencia.
  const periodo = input.billingPeriod.slice(0, 8) + '01';

  // Zoho sólo cubre septiembre. Es el puente de la migración: los pagos que
  // entraron en agosto (que viven en Zoho) cubren la mensualidad de septiembre,
  // y de ahí en adelante Zoho es sólo consulta. Octubre y los meses que siguen
  // se cobran por la vía normal de la app —el cobro se emite en el corte y se
  // confirma con el pago recibido aquí—. Cubrir octubre con un pago de Zoho
  // dejaría ese mes "ya cubierto" y la generación no lo emitiría: la clienta se
  // quedaría sin cobrar. Por eso se corta de plano.
  if (invoice.source_system === 'zoho_invoice' && periodo > '2026-09-01') {
    return reply.code(400).send({ error: 'Los cobros de Zoho solo cubren hasta septiembre 2026. Para octubre en adelante, el cobro se emite y se confirma con el pago recibido en la app.' });
  }

  const resultado = await sql.begin(async transaction => {
    const abierta = await abrirCobertura(transaction, auth.sub, { id: invoice.id, client_id: invoice.client_id, coverage_start: invoice.coverage_start, due_on: invoice.due_on }, periodo, input.entries);
    // Aplicar una mensualidad a un cobro de Zoho pendiente lo salda también, igual
    // que en paquetes: cierra la deuda congelada de la migración sin paso extra.
    if (!('error' in abierta)) await saldarCobroZohoPendiente(transaction, { id: invoice.id as string, source_system: invoice.source_system as string | null, status: invoice.status as string, coverage_start: invoice.coverage_start as string | Date | null });
    return abierta;
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

// Zoho ya no sincroniza: un cobro suyo que se pagó DESPUÉS de la migración quedó
// congelado en 'pendiente', y un cobro de Zoho no tiene "Confirmar pago" (mientras
// vivió Zoho, sobre eso mandaba Zoho). Aplicarlo a un paquete o mensualidad es la
// señal de que el dinero entró, así que se salda aquí mismo —transparente para la
// entrenadora, sin un paso extra—. Sólo cobros de Zoho pendientes; los locales
// tienen su propio "Confirmar pago". No toca el ingreso en finanzas: ese ya vino
// con la migración (invoice_payments), y aquí sólo se cierra la deuda.
// Postgres devuelve las fechas como Date, y String(Date) da "Thu Sep 24 2026…",
// no ISO: al recortar a 10 caracteres queda "Thu Sep 24" (sin año) y Postgres lo
// malinterpreta —de ahí paquetes "comprados en 2001". Se formatea sin ambigüedad.
function soloFecha(valor: string | Date | null): string | null {
  if (valor == null) return null;
  return valor instanceof Date ? valor.toISOString().slice(0, 10) : String(valor).slice(0, 10);
}

async function saldarCobroZohoPendiente(transaction: TransactionSql, invoice: { id: string; source_system: string | null; status: string; coverage_start: string | Date | null }) {
  if (invoice.source_system !== 'zoho_invoice' || invoice.status !== 'pending') return false;
  await transaction`
    UPDATE invoices SET status = 'confirmed', balance = 0,
      confirmed_at = COALESCE(confirmed_at, ${`${soloFecha(invoice.coverage_start)}T12:00:00-05:00`}::timestamptz)
    WHERE id = ${invoice.id}
  `;
  return true;
}

// Aplicar un cobro ya pagado a un paquete de clases. La cobertura mensual abre
// saldos de mensualidad; esto abre uno de tipo 'package' —N clases con su propia
// validez— sin emitir una factura nueva, para el caso de un pago que entró por
// Zoho o a mano y que no es una mensualidad. Se liga por invoice.package_id: así
// no se cobra de nuevo (el ingreso sigue siendo el del cobro) y no se puede
// aplicar dos veces al mismo cobro.
//
// Regla de validez: un paquete no dura más de 6 semanas desde el pago; el
// frontend avisa si se pasa del mes, y aquí se corta de plano lo que pase de las
// 6 semanas, que es lo que no debe ocurrir de ninguna manera.
const SEIS_SEMANAS_DIAS = 42;
const packageFromInvoiceSchema = z.object({
  totalSessions: z.coerce.number().int().positive(),
  expiresOn: z.string().date()
});
app.post('/api/invoices/:id/package', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = packageFromInvoiceSchema.parse(request.body);
  const resultado = await sql.begin(async transaction => {
    const [invoice] = await transaction`
      SELECT i.id, i.client_id, COALESCE(i.billed_for_client_id, i.client_id) AS billed_for_client_id,
        i.amount, i.package_id, i.status, i.source_system,
        beneficiario.billing_model, c.payment_mode,
        COALESCE((SELECT min(ip.paid_on) FROM payment_allocations pa JOIN invoice_payments ip ON ip.id = pa.payment_id WHERE pa.invoice_id = i.id), i.issued_on, i.due_on) AS coverage_start
      FROM invoices i
      JOIN clients c ON c.id = i.client_id
      JOIN clients beneficiario ON beneficiario.id = COALESCE(i.billed_for_client_id, i.client_id)
      WHERE i.id = ${id} AND c.owner_id = ${auth.sub} AND i.status <> 'void'
      FOR UPDATE OF i
    `;
    if (!invoice) return { error: 'Cobro no encontrado', code: 404 };
    if (invoice.package_id) return { error: 'Este cobro ya tiene un paquete ligado.', code: 409 };
    if (invoice.billing_model !== 'package') {
      return { error: 'Este cobro no corresponde a un plan de paquete.', code: 409 };
    }
    const destinatarioId = invoice.billed_for_client_id as string;
    await lockBillingClient(transaction, destinatarioId);
    // Las clases del paquete cuelgan del día del pago: es cuando el cliente lo
    // compró, y desde ahí corre su validez.
    const inicio = mediodiaEnPanama(invoice.coverage_start || new Date());
    const expira = mediodiaEnPanama(input.expiresOn);
    if (expira < inicio) return { error: 'La validez no puede ser anterior a la fecha del pago.', code: 400 };
    const tope = new Date(inicio); tope.setDate(tope.getDate() + SEIS_SEMANAS_DIAS);
    if (expira > tope) return { error: 'Un paquete de clases no puede durar más de 6 semanas desde el pago.', code: 400 };
    const [pack] = await transaction`
      INSERT INTO session_packages (client_id, label, total_sessions, amount, expires_on, kind, purchased_on, origin_invoice_id, status)
      VALUES (${destinatarioId}, ${`Paquete ${input.totalSessions} sesiones`}, ${input.totalSessions}, ${invoice.amount},
        ${input.expiresOn}::date, 'package', ${soloFecha(invoice.coverage_start)}::date, ${id}, 'active')
      RETURNING id, total_sessions, expires_on
    `;
    await transaction`UPDATE invoices SET package_id = ${pack.id} WHERE id = ${id}`;
    const saldado = await saldarCobroZohoPendiente(transaction, { id: invoice.id as string, source_system: invoice.source_system as string | null, status: invoice.status as string, coverage_start: invoice.coverage_start as string | Date | null });
    return { package: pack, saldado };
  });
  if ('error' in resultado) return reply.code(resultado.code || 400).send({ error: resultado.error });
  return reply.code(201).send(resultado);
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

const paymentSchema = z.object({ method: z.enum(['Efectivo', 'Yappy', 'Transferencia bancaria', 'Tarjeta', 'Otro']), reference: z.string().max(160).optional(), paidOn: z.string().date(), amount: z.coerce.number().min(0).optional() });
async function saveNativeInvoicePayment(ownerId: string, id: string, input: z.infer<typeof paymentSchema>) {
  return sql.begin(async transaction => {
    // El estado antes de cobrar: la apertura automática del saldo mensual sólo
    // corre cuando el cobro pasa de pendiente a pagado, no al editar un pago
    // que ya estaba registrado (ahí ella ya pudo haber ajustado la cobertura).
    const [previo] = await transaction`
      SELECT i.status, i.package_id, i.billing_period, i.due_on, i.amount,
        COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), 0) AS paid_amount,
        COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa JOIN invoice_payments ip ON ip.id = pa.payment_id
          WHERE pa.invoice_id = i.id AND ip.source_system = 'eileen'), 0) AS native_paid_amount,
        c.billing_model
      FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.id = ${id} AND c.owner_id = ${ownerId} AND i.source_system IS DISTINCT FROM 'zoho_invoice'
      FOR UPDATE OF i
    `;
    if (!previo) return null;
    const invoiceAmount = Number(previo.amount);
    const paidAmount = input.amount === undefined
      ? (Number(previo.native_paid_amount) > 0 ? Number(previo.native_paid_amount) : invoiceAmount)
      : Number(input.amount);
    if (paidAmount > invoiceAmount + 0.01) throw new Error('El pago no puede superar el monto de la factura');
    const complete = paidAmount >= invoiceAmount - 0.01;
    const remaining = complete ? 0 : Math.max(0, invoiceAmount - paidAmount);
    const [invoice] = await transaction`
      UPDATE invoices i SET status = ${complete ? 'confirmed' : 'pending'}, payment_method = ${input.method}, payment_reference = ${input.reference || null},
        confirmed_at = ${complete ? `${input.paidOn}T12:00:00-05:00` : null}, balance = ${remaining}
      FROM clients c WHERE i.id = ${id} AND c.id = i.client_id AND c.owner_id = ${ownerId} AND i.source_system IS DISTINCT FROM 'zoho_invoice'
      RETURNING i.*
    `;
    if (!invoice) return null;
    const externalId = `eileen-payment:${id}`;
    const [payment] = await transaction`
      INSERT INTO invoice_payments (client_id, source_system, external_id, payment_number, amount, paid_on, method, reference)
      VALUES (${invoice.client_id}, 'eileen', ${externalId}, ${invoice.invoice_number || null}, ${paidAmount}, ${input.paidOn}, ${input.method}, ${input.reference || null})
      ON CONFLICT (source_system, external_id) DO UPDATE SET amount = EXCLUDED.amount, paid_on = EXCLUDED.paid_on, method = EXCLUDED.method, reference = EXCLUDED.reference, updated_at = now()
      RETURNING *
    `;
    await transaction`INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (${payment.id}, ${invoice.id}, ${paidAmount}) ON CONFLICT (payment_id, invoice_id) DO UPDATE SET amount = EXCLUDED.amount`;
    // Un paquete ligado nace dormido y el pago lo despierta. Se devuelve lo que
    // de verdad se activó —sólo si estaba pendiente, no al reconfirmar— para
    // avisar a la entrenadora de que sus sesiones ya están disponibles.
    let paqueteActivado: { kind: string; sessions: number } | null = null;
    if (invoice.package_id) {
      // Un paquete de clases empieza a correr su validez DESDE el pago: se
      // reinicia el reloj a la fecha del pago + los días de validez del plan del
      // cliente (si no hay plan, el tope de uso). Así, si un paquete se agota o
      // vence y el cliente vuelve a pagar, sus semanas arrancan de cero desde ese
      // nuevo pago. La mensualidad no se toca aquí: su ciclo lo fija el corte.
      const [activado] = await transaction`
        UPDATE session_packages sp SET status = 'active',
          purchased_on = CASE WHEN sp.kind = 'package' THEN ${input.paidOn}::date ELSE sp.purchased_on END,
          expires_on = CASE WHEN sp.kind = 'package'
            THEN ${input.paidOn}::date + COALESCE(
              (SELECT pl.validity_days FROM clients c LEFT JOIN service_plans pl ON pl.id = c.plan_id WHERE c.id = sp.client_id),
              ${DIAS_USO_PAQUETE})::int
            ELSE sp.expires_on END
        WHERE sp.id = ${invoice.package_id} AND sp.status = 'pending'
        RETURNING kind, total_sessions`;
      if (activado) paqueteActivado = { kind: activado.kind as string, sessions: Number(activado.total_sessions) };
    }

    // Confirmar el pago de una mensualidad abre solo el saldo del ciclo, para
    // el titular y su gente, con las sesiones del plan de cada uno: el paso que
    // antes había que dar aparte en "Aplicar a mensualidades". Sólo mensualidad
    // (cliente mensual y cobro sin paquete por sesiones ligado). Idempotente por
    // el índice (cliente, período), así que no duplica lo ya cubierto. Se
    // devuelve lo abierto para avisar a la entrenadora, que puede ajustarlo.
    let coberturaAutomatica: { clientId: string; fullName: string; sessions: number; packageId: string | null }[] = [];
    if (previo.status === 'pending' && previo.billing_model === 'monthly' && !previo.package_id) {
      const periodo = String(mesCubiertoPorDefecto(previo.billing_period || previo.due_on)).slice(0, 8) + '01';
      const candidatos = await transaction`
        SELECT c.id,
          COALESCE(p.price, c.standard_price, 0) AS suggested_amount,
          COALESCE(c.monthly_session_target, p.sessions_included, 0)::integer AS suggested_sessions
        FROM clients c LEFT JOIN service_plans p ON p.id = c.plan_id
        WHERE c.owner_id = ${ownerId}
          AND (c.id = ${invoice.client_id} OR c.billing_responsible_client_id = ${invoice.client_id})
          -- Sólo mensuales: un dependiente de clase suelta no recibe mensualidad.
          AND c.billing_model = 'monthly'
          -- Ni a quien ya tiene el saldo del ciclo: la generación recurrente
          -- abre el saldo mensual sin dejar fila en invoice_coverage, así que
          -- el índice (cliente, período) no lo frenaría y saldría doble. Se
          -- usa el mismo guard que la generación: un paquete mensual vigente.
          AND NOT EXISTS (
            SELECT 1 FROM session_packages sp
            WHERE sp.client_id = c.id AND sp.kind = 'monthly' AND sp.status = 'active'
              -- Estricto (>): un saldo que vence justo el día del pago (fin del
              -- ciclo anterior) no bloquea el del ciclo nuevo. Mismo criterio que
              -- la generación y la asignación de plan.
              AND sp.expires_on IS NOT NULL AND sp.expires_on > ${input.paidOn}::date
              -- Sólo cuenta como "ya cubierto" el saldo del plan/generación (sin
              -- origen), el de este mismo cobro, o el de un cobro AUTOMÁTICO: si
              -- la generación ya le abrió el saldo del ciclo, un cobro manual que
              -- alguien registre aparte NO debe abrir un segundo (el duplicado de
              -- Sally/Julieta). El saldo de OTRO cobro manual (clases pagadas
              -- aparte) sí puede convivir con su mensualidad familiar.
              AND (sp.origin_invoice_id IS NULL OR sp.origin_invoice_id = ${invoice.id}
                OR EXISTS (SELECT 1 FROM invoices ai WHERE ai.id = sp.origin_invoice_id AND ai.auto_generated = true))
          )
      `;
      const entries = candidatos
        .filter(fila => Number(fila.suggested_sessions) > 0)
        .map(fila => ({ clientId: fila.id as string, amount: Number(fila.suggested_amount), sessions: Number(fila.suggested_sessions) }));
      if (entries.length) {
        const res = await abrirCobertura(transaction, ownerId, { id: invoice.id, client_id: invoice.client_id, coverage_start: input.paidOn, due_on: invoice.due_on }, periodo, entries);
        if (!('error' in res)) coberturaAutomatica = res.abiertos;
      }
    }
    return { invoice, payment, coberturaAutomatica, paqueteActivado };
  });
}
app.post('/api/invoices/:id/confirm', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id); const input = paymentSchema.parse(request.body);
  const result = await saveNativeInvoicePayment(auth.sub, id, input);
  if (!result) return reply.code(404).send({ error: 'Cobro local no encontrado' });
  return { ...result.invoice, coberturaAutomatica: result.coberturaAutomatica, paqueteActivado: result.paqueteActivado };
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
        COALESCE((SELECT min(p.paid_on) FROM ${incomePaymentsSource(auth.sub)} p), current_date),
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
      FROM ${incomePaymentsSource(auth.sub)} p
      WHERE p.paid_on >= ${inicio}::date
        AND (${fin}::date IS NULL OR p.paid_on <= ${fin}::date)
      GROUP BY 1
    `,
    sql`
      SELECT to_char(date_trunc('month', e.spent_on), 'YYYY-MM') AS month,
        COALESCE(sum(e.amount), 0)::numeric AS total, count(*)::int AS cantidad,
        COALESCE(sum(e.amount) FILTER (WHERE c.ambito = 'negocio'), 0)::numeric AS negocio,
        -- Todo lo que no es negocio es personal, incluido lo que no tiene ámbito
        -- ni categoría: la regla es que solo los operativos son del negocio, y no
        -- existe un estado intermedio "sin clasificar".
        COALESCE(sum(e.amount) FILTER (WHERE c.ambito IS DISTINCT FROM 'negocio'), 0)::numeric AS personal,
        0::numeric AS sin_clasificar
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

// Informe mensual: cobros, gastos y resumen de un mes, con filtro opcional por
// categoría de gasto. Se ve en pantalla y se descarga en CSV (Excel) o PDF.
const informeMensualSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Mes inválido'),
  categoryId: z.string().uuid().optional()
});
async function monthlyFinanceData(ownerId: string, month: string, categoryId?: string) {
  const from = `${month}-01`;
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const [cobros, gastos, porCategoria] = await Promise.all([
    sql`
      SELECT p.paid_on AS fecha, c.full_name AS cliente, p.method AS metodo, p.reference AS referencia,
        p.amount::numeric AS monto,
        COALESCE((SELECT i.concept FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id
          WHERE pa.payment_id = p.id ORDER BY pa.amount DESC LIMIT 1),
          (SELECT string_agg(DISTINCT 'FAC-' || lpad(bi.number::text, 4, '0'), ', ') FROM billing_payment_applications bpa JOIN billing_invoices bi ON bi.id = bpa.invoice_id
            WHERE bpa.payment_id = p.id AND bpa.reversed_at IS NULL)) AS concepto
      FROM ${incomePaymentsSource(ownerId)} p JOIN clients c ON c.id = p.client_id
      WHERE p.paid_on >= ${from}::date AND p.paid_on <= ${to}::date
      ORDER BY p.paid_on
    `,
    sql`
      SELECT e.spent_on AS fecha, e.description AS descripcion, e.payment_method AS metodo,
        e.amount::numeric AS monto, COALESCE(cat.name, 'Sin categoría') AS categoria, cat.ambito
      FROM expenses e LEFT JOIN expense_categories cat ON cat.id = e.category_id
      WHERE e.owner_id = ${ownerId} AND e.spent_on >= ${from}::date AND e.spent_on <= ${to}::date
        AND (${categoryId || null}::uuid IS NULL OR e.category_id = ${categoryId || null}::uuid)
      ORDER BY e.spent_on
    `,
    sql`
      SELECT COALESCE(cat.name, 'Sin categoría') AS categoria, cat.ambito,
        sum(e.amount)::numeric AS total, count(*)::int AS cantidad
      FROM expenses e LEFT JOIN expense_categories cat ON cat.id = e.category_id
      WHERE e.owner_id = ${ownerId} AND e.spent_on >= ${from}::date AND e.spent_on <= ${to}::date
        AND (${categoryId || null}::uuid IS NULL OR e.category_id = ${categoryId || null}::uuid)
      GROUP BY 1, 2 ORDER BY total DESC
    `
  ]);
  const ingresos = cobros.reduce((s, r) => s + Number(r.monto), 0);
  const totalGastos = gastos.reduce((s, r) => s + Number(r.monto), 0);
  const negocio = gastos.filter(r => r.ambito === 'negocio').reduce((s, r) => s + Number(r.monto), 0);
  return {
    month, from, to, cobros, gastos, porCategoria,
    resumen: { ingresos, gastos: totalGastos, negocio, personal: totalGastos - negocio, margen: ingresos - totalGastos }
  };
}
app.get('/api/finance/monthly', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser; const q = informeMensualSchema.parse(request.query);
  return monthlyFinanceData(auth.sub, q.month, q.categoryId);
});
app.get('/api/finance/monthly.csv', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const q = informeMensualSchema.parse(request.query);
  const d = await monthlyFinanceData(auth.sub, q.month, q.categoryId);
  const lines: string[] = [];
  lines.push(['Informe mensual', d.month].map(csvCell).join(','));
  lines.push('');
  lines.push('Resumen');
  lines.push(['Ingresos', d.resumen.ingresos.toFixed(2)].map(csvCell).join(','));
  lines.push(['Gastos', d.resumen.gastos.toFixed(2)].map(csvCell).join(','));
  lines.push(['  del negocio', d.resumen.negocio.toFixed(2)].map(csvCell).join(','));
  lines.push(['  personal', d.resumen.personal.toFixed(2)].map(csvCell).join(','));
  lines.push(['Margen', d.resumen.margen.toFixed(2)].map(csvCell).join(','));
  lines.push('');
  lines.push('Cobros recibidos');
  lines.push(['Fecha', 'Cliente', 'Concepto', 'Método', 'Monto USD'].map(csvCell).join(','));
  d.cobros.forEach(r => lines.push([csvDate(r.fecha), r.cliente, r.concepto, r.metodo, Number(r.monto).toFixed(2)].map(csvCell).join(',')));
  lines.push('');
  lines.push('Gastos');
  lines.push(['Fecha', 'Descripción', 'Categoría', 'Ámbito', 'Método', 'Monto USD'].map(csvCell).join(','));
  d.gastos.forEach(r => lines.push([csvDate(r.fecha), r.descripcion, r.categoria, r.ambito === 'negocio' ? 'Negocio' : 'Personal', r.metodo, Number(r.monto).toFixed(2)].map(csvCell).join(',')));
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="informe-${d.month}.csv"`);
  return `﻿${lines.join('\n')}`;
});
app.get('/api/finance/monthly.pdf', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const q = informeMensualSchema.parse(request.query);
  const d = await monthlyFinanceData(auth.sub, q.month, q.categoryId);
  const catName = q.categoryId ? (d.porCategoria[0]?.categoria as string ?? null) : null;
  return sendPdf(reply, await monthlyFinancePdf(d, catName), `informe-${d.month}.pdf`);
});

// Cumplimiento por cliente de un mes: para cada cliente con clases en el mes,
// cuántas cumplió y su porcentaje. Misma definición que el resto del sistema
// (canceladas por él y no repuestas cuentan como incumplidas; las que canceló
// la entrenadora o están en pausa no cuentan).
app.get('/api/compliance/by-month', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(request.query);
  const from = `${month}-01`;
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const clients = await sql`
    SELECT c.id AS client_id, c.full_name AS name,
      count(*)::int AS total,
      count(*) FILTER (WHERE s.status = 'completed')::int AS completadas,
      COALESCE(round(avg(${complianceCompletionExpression()})), 0)::int AS percent
    FROM sessions s JOIN clients c ON c.id = s.client_id
    WHERE c.owner_id = ${auth.sub}
      AND s.starts_at >= ${from}::date AND s.starts_at < (${to}::date + interval '1 day')
      AND ${complianceSessionCondition()}
    GROUP BY 1, 2
  `;
  return { month, clients };
});

// Resumen mensual de agenda y cumplimiento para toda la clientela. La agenda
// cuenta todas las sesiones que existen en el calendario, sin importar si son
// mensualidad, paquete, crédito o sesión individual. El porcentaje sólo usa
// sesiones resueltas: una sesión pasada todavía programada queda como
// pendiente de marcar, no se convierte automáticamente en incumplimiento.
app.get('/api/attendance/monthly', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const query = z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    cutoffClientId: z.string().uuid().optional(),
    cutoffOffset: z.coerce.number().int().min(0).max(120).default(0)
  }).superRefine((value, context) => {
    const customRange = value.from !== undefined || value.to !== undefined;
    if (customRange && (!value.from || !value.to)) {
      context.addIssue({ code: 'custom', path: ['from'], message: 'El rango requiere fecha inicial y final' });
    }
    if (!customRange && !value.month && !value.cutoffClientId) {
      context.addIssue({ code: 'custom', path: ['month'], message: 'Indica un mes o un rango de fechas' });
    }
    if (value.from && value.to && value.from > value.to) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'La fecha final no puede ser anterior a la inicial' });
    }
  }).parse(request.query);
  const customRange = Boolean(query.from && query.to);
  const month = query.month || null;
  let cutoffCycle: { clientId: string; day: number; offset: number; from: string; to: string } | null = null;
  if (query.cutoffClientId) {
    const [cutoffClient] = await sql`
      SELECT id, billing_cutoff_day
      FROM clients
      WHERE id = ${query.cutoffClientId} AND owner_id = ${auth.sub}
    `;
    if (!cutoffClient) return reply.code(404).send({ error: 'Cliente no encontrado' });
    const day = Number(cutoffClient.billing_cutoff_day) || 1;
    const ciclo = cicloDelCorteDesplazado(new Date(), day, query.cutoffOffset);
    cutoffCycle = { clientId: cutoffClient.id, day, offset: query.cutoffOffset, from: ciclo.inicio, to: ciclo.vence };
  }
  const from = cutoffCycle?.from || (customRange ? query.from! : `${month}-01`);
  const toInclusive = cutoffCycle?.to || (customRange
    ? query.to!
    : (() => {
        const [year, monthNumber] = month!.split('-').map(Number);
        return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
      })());
  const toExclusive = new Date(`${toInclusive}T00:00:00Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  const to = toExclusive.toISOString().slice(0, 10);
  const periodKey = cutoffCycle
    ? `cutoff:${cutoffCycle.clientId}:${cutoffCycle.offset}`
    : customRange ? `range:${from}:${toInclusive}` : `month:${month}`;
  const rows = await sql`
    WITH scoped AS (
      SELECT c.id AS client_id,
        s.status AS session_status, s.cancellation_kind, s.cancelled_by,
        ${complianceCompletionExpression()} AS completion_percent,
        (s.starts_at AT TIME ZONE 'America/Panama')::date AS session_day,
        (
          EXISTS (
            SELECT 1 FROM session_reschedules sr WHERE sr.session_id = s.id AND sr.origin = 'moved'
          ) OR (
            s.status = 'cancelled' AND s.cancellation_kind = 'rescheduled'
            AND COALESCE(s.cancelled_by, 'client') = 'client'
          )
        ) AS reprogramada,
        (
          COALESCE(s.paused_hold, false)
          OR (s.status = 'scheduled' AND c.status = 'paused')
          OR EXISTS (
            SELECT 1 FROM client_package_pauses pp
            WHERE pp.client_id = c.id
              AND (s.starts_at AT TIME ZONE 'America/Panama')::date >= pp.starts_on
              AND (pp.resumed_on IS NULL OR (s.starts_at AT TIME ZONE 'America/Panama')::date < pp.resumed_on)
          )
        ) AS pausada
        ,${complianceSessionCondition()} AS medible
      FROM clients c
      LEFT JOIN sessions s ON s.client_id = c.id
        AND ${cutoffCycle
          ? sql`(s.starts_at AT TIME ZONE 'America/Panama')::date > ${from}::date
              AND (s.starts_at AT TIME ZONE 'America/Panama')::date <= ${toInclusive}::date`
          : sql`s.starts_at >= ${from}::date AT TIME ZONE 'America/Panama'
              AND s.starts_at < ${to}::date AT TIME ZONE 'America/Panama'`}
      WHERE c.owner_id = ${auth.sub}
        AND (${cutoffCycle?.clientId ?? null}::uuid IS NULL OR c.id = ${cutoffCycle?.clientId ?? null}::uuid)
    ), rollup AS (
      SELECT client_id,
        count(*) FILTER (WHERE session_status IS NOT NULL)::int AS agendadas,
        count(*) FILTER (WHERE session_status = 'scheduled' AND NOT pausada AND session_day <= current_date)::int AS pendientes,
        count(*) FILTER (WHERE session_status = 'scheduled' AND NOT pausada AND session_day > current_date)::int AS futuras,
        count(*) FILTER (WHERE session_status = 'completed' AND medible)::int AS completadas,
        count(*) FILTER (WHERE session_status = 'no_show' AND medible)::int AS no_show,
        count(*) FILTER (WHERE session_status = 'cancelled' AND cancellation_kind = 'not_rescheduled'
          AND COALESCE(cancelled_by, 'client') = 'client' AND medible)::int AS canceladas_cliente,
        count(*) FILTER (WHERE reprogramada)::int AS reprogramadas,
        count(*) FILTER (WHERE session_status = 'cancelled' AND cancelled_by = 'trainer')::int AS canceladas_entrenadora,
        count(*) FILTER (WHERE pausada)::int AS pausadas,
        count(*) FILTER (WHERE medible)::int AS medibles,
        COALESCE(sum(CASE WHEN medible THEN completion_percent ELSE 0 END), 0)::int AS puntos_cumplimiento
      FROM scoped
      GROUP BY client_id
    )
    SELECT c.id AS client_id, c.full_name AS name, c.status, c.billing_model,
      COALESCE(r.agendadas, 0)::int AS agendadas,
      COALESCE(r.pendientes, 0)::int AS pendientes,
      COALESCE(r.futuras, 0)::int AS futuras,
      COALESCE(r.completadas, 0)::int AS completadas,
      COALESCE(r.no_show, 0)::int AS no_show,
      COALESCE(r.canceladas_cliente, 0)::int AS canceladas_cliente,
      COALESCE(r.reprogramadas, 0)::int AS reprogramadas,
      COALESCE(r.canceladas_entrenadora, 0)::int AS canceladas_entrenadora,
      COALESCE(r.pausadas, 0)::int AS pausadas,
      COALESCE(r.medibles, 0)::int AS medibles,
      COALESCE(r.puntos_cumplimiento, 0)::int AS puntos_cumplimiento
    FROM clients c LEFT JOIN rollup r ON r.client_id = c.id
    WHERE c.owner_id = ${auth.sub}
      AND (${cutoffCycle?.clientId ?? null}::uuid IS NULL OR c.id = ${cutoffCycle?.clientId ?? null}::uuid)
    ORDER BY c.full_name
  `;
  const clients = rows.map(row => {
    const medibles = Number(row.medibles);
    return {
      clientId: row.client_id,
      name: row.name,
      status: row.status,
      billingModel: row.billing_model,
      agendadas: Number(row.agendadas),
      pendientes: Number(row.pendientes),
      futuras: Number(row.futuras),
      completadas: Number(row.completadas),
      noShow: Number(row.no_show),
      canceladasCliente: Number(row.canceladas_cliente),
      reprogramadas: Number(row.reprogramadas),
      canceladasEntrenadora: Number(row.canceladas_entrenadora),
      pausadas: Number(row.pausadas),
      medibles,
      puntosCumplimiento: Number(row.puntos_cumplimiento),
      compliancePercent: medibles ? Math.round(Number(row.puntos_cumplimiento) / medibles) : null
    };
  });
  const sum = (key: 'agendadas' | 'pendientes' | 'futuras' | 'completadas' | 'noShow' | 'canceladasCliente' | 'reprogramadas' | 'canceladasEntrenadora' | 'pausadas' | 'medibles') => clients.reduce((total, client) => total + client[key], 0);
  const medibles = sum('medibles');
  const puntos = clients.reduce((total, client) => total + client.puntosCumplimiento, 0);
  return {
    month,
    cutoff: cutoffCycle ? { clientId: cutoffCycle.clientId, day: cutoffCycle.day, offset: cutoffCycle.offset } : null,
    period: { from, to: toInclusive },
    periodKey,
    clients,
    totals: {
      agendadas: sum('agendadas'), pendientes: sum('pendientes'), futuras: sum('futuras'),
      completadas: sum('completadas'), noShow: sum('noShow'), canceladasCliente: sum('canceladasCliente'),
      reprogramadas: sum('reprogramadas'), canceladasEntrenadora: sum('canceladasEntrenadora'),
      pausadas: sum('pausadas'), medibles, compliancePercent: medibles ? Math.round(puntos / medibles) : null
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
    VALUES (${auth.sub}, ${input.name}, ${input.ambito ?? 'personal'}, ${input.description || null})
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
    SELECT c.id AS client_id, c.full_name, s.starts_at AS occurred_at, 'Sesión'::text AS source,
      COALESCE(r.title, CASE WHEN s.quick_logged THEN 'Entrenamiento presencial' ELSE 'Evaluación / seguimiento' END) AS activity,
      CASE WHEN s.status IN ('cancelled', 'no_show') THEN 'missed' ELSE s.status END AS status,
      ${complianceCompletionExpression()} AS completion_percent
    FROM sessions s
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN routines r ON r.id = s.routine_id
    WHERE c.owner_id = ${ownerId}
      AND s.starts_at >= ${start}
      AND (${clientId || null}::uuid IS NULL OR c.id = ${clientId || null})
      AND ${complianceSessionCondition()}
    ORDER BY occurred_at DESC, c.full_name
  `;
}

app.get('/api/compliance/summary', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser; const query = z.object({ period: reportPeriodSchema.default('week') }).parse(request.query);
  const rows = await complianceRows(auth.sub, query.period);
  const clients = new Map<string, { clientId: string; name: string; total: number; sum: number; completed: number; missed: number }>();
  for (const row of rows) {
    const current = clients.get(row.client_id) || { clientId: row.client_id, name: row.full_name, total: 0, sum: 0, completed: 0, missed: 0 };
    current.total += 1; current.sum += Number(row.completion_percent);
    if (Number(row.completion_percent) > 0) current.completed += 1;
    if (row.status === 'missed') current.missed += 1;
    clients.set(row.client_id, current);
  }
  const clientSummaries = [...clients.values()].map(item => ({
    clientId: item.clientId, name: item.name, activities: item.total, completed: item.completed,
    missed: item.missed,
    compliancePercent: item.total ? Math.round(item.sum / item.total) : 0
  })).sort((a, b) => b.compliancePercent - a.compliancePercent || a.name.localeCompare(b.name));
  return {
    period: query.period, activities: rows.length,
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

  const porMes = new Map<string, { month: string; activities: number; completed: number; missed: number; suma: number }>();
  for (let i = 0; i < months; i += 1) {
    const fecha = new Date(Date.UTC(desde.getUTCFullYear(), desde.getUTCMonth() + i, 1));
    const clave = `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, '0')}`;
    porMes.set(clave, { month: clave, activities: 0, completed: 0, missed: 0, suma: 0 });
  }
  for (const fila of filas) {
    const fecha = new Date(fila.occurred_at as string);
    const clave = `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, '0')}`;
    const mes = porMes.get(clave);
    if (!mes) continue;
    mes.activities += 1; mes.suma += Number(fila.completion_percent);
    if (Number(fila.completion_percent) > 0) mes.completed += 1;
    if (fila.status === 'missed') mes.missed += 1;
  }
  // Un mes sin actividad devuelve null, no 0%: no es lo mismo "no entrenó
  // nada" que "no había nada que medir", y pintar un cero hundiría la gráfica
  // por meses en los que el cliente ni siquiera estaba activo.
  return [...porMes.values()].map(mes => ({
    month: mes.month, activities: mes.activities, completed: mes.completed, missed: mes.missed,
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
    totalIncumplidas: timeline.reduce((suma, mes) => suma + mes.missed, 0)
  };
});

// Informe de asistencia flexible: 1 a 4 clientes (o todos), por rango de fechas
// propio o por el ciclo de facturación vigente de cada cliente. Devuelve una
// comparativa (un resumen por cliente) y el detalle mes a mes de cada uno.
type FilaCumplimiento = { client_id: unknown; occurred_at: unknown; completion_percent: unknown; status: unknown };
function resumenCumplimiento(filas: FilaCumplimiento[]) {
  let activities = 0, completed = 0, missed = 0, suma = 0;
  for (const f of filas) {
    activities += 1; suma += Number(f.completion_percent);
    if (Number(f.completion_percent) > 0) completed += 1;
    if (f.status === 'missed') missed += 1;
  }
  return { activities, completed, missed, compliancePercent: activities ? Math.round(suma / activities) : null };
}
function cumplimientoPorMes(filas: FilaCumplimiento[]) {
  const meses = new Map<string, FilaCumplimiento[]>();
  for (const f of filas) {
    const d = new Date(f.occurred_at as string);
    const clave = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!meses.has(clave)) meses.set(clave, []);
    meses.get(clave)!.push(f);
  }
  return [...meses.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([month, fs]) => ({ month, ...resumenCumplimiento(fs) }));
}
const reportRangeSchema = z.object({
  clientIds: z.string().trim().optional(),
  mode: z.enum(['range', 'cycle']).default('range'),
  from: z.string().date().optional(),
  to: z.string().date().optional()
});
app.get('/api/compliance/report', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const q = reportRangeSchema.parse(request.query);
  const ids = (q.clientIds || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length > 4) return reply.code(400).send({ error: 'Máximo 4 clientes por informe' });
  for (const id of ids) if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ error: 'Cliente inválido' });
  const hoy = diaEnPanama(new Date());
  if (q.mode === 'range') {
    if (!q.from || !q.to) return reply.code(400).send({ error: 'Indica la fecha desde y hasta' });
    if (q.from > q.to) return reply.code(400).send({ error: 'La fecha inicial no puede ser mayor que la final' });
  }
  const clientes = ids.length
    ? await sql`SELECT id, full_name, billing_cutoff_day, inicio_ciclo(billing_cutoff_day)::text AS ciclo_inicio FROM clients WHERE owner_id = ${auth.sub} AND id = ANY(${ids}) ORDER BY full_name`
    : await sql`SELECT id, full_name, billing_cutoff_day, inicio_ciclo(billing_cutoff_day)::text AS ciclo_inicio FROM clients WHERE owner_id = ${auth.sub} AND status = 'active' ORDER BY full_name`;
  if (!clientes.length) return reply.code(404).send({ error: 'No hay clientes para el informe' });
  const ventana = new Map<string, { start: string; end: string }>();
  for (const c of clientes) {
    if (q.mode === 'cycle') ventana.set(c.id as string, { start: String(c.ciclo_inicio).slice(0, 10), end: hoy });
    else ventana.set(c.id as string, { start: q.from!, end: (q.to! > hoy ? hoy : q.to!) });
  }
  const desde = [...ventana.values()].reduce((min, w) => (w.start < min ? w.start : min), hoy);
  const filas = await complianceRows(auth.sub, 'year', undefined, `${desde}T00:00:00`) as unknown as (FilaCumplimiento & { full_name: unknown })[];
  const porCliente = clientes.map(c => {
    const w = ventana.get(c.id as string)!;
    const suyas = filas.filter(f => f.client_id === c.id && diaEnPanama(f.occurred_at as string) >= w.start && diaEnPanama(f.occurred_at as string) <= w.end);
    return { clientId: c.id, name: c.full_name, from: w.start, to: w.end, ...resumenCumplimiento(suyas), monthly: cumplimientoPorMes(suyas) };
  });
  return { mode: q.mode, generatedAt: hoy, clients: porCliente };
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

// Avisos de pago desde la fuente nueva (estado `new`): facturas abiertas del PAGADOR, con la forma que ya usan las notificaciones.
async function openNewInvoiceNotices(ownerId: string, paymentDays: number, clientId?: string) {
  const rows = await sql`
    SELECT i.due_on::text AS due_on, i.total::text AS amount, i.number, i.kind, i.cycle_start::text AS cycle_start, i.cycle_end::text AS cycle_end, p.full_name,
      GREATEST(i.total - COALESCE((SELECT sum(a.amount) FROM billing_payment_applications a WHERE a.invoice_id = i.id AND a.reversed_at IS NULL), 0), 0)::text AS balance,
      (i.due_on < current_date) AS atrasada, (current_date - i.due_on) AS dias_atraso
    FROM billing_invoices i JOIN clients p ON p.id = i.payer_client_id
    WHERE i.owner_id = ${ownerId} AND i.status IN ('pendiente', 'parcial') AND p.status <> 'paused'
      AND (${clientId ?? null}::uuid IS NULL OR i.payer_client_id = ${clientId ?? null}::uuid)
      AND i.due_on <= current_date + (${paymentDays})::integer ORDER BY i.due_on`;
  return rows.map(row => ({ due_on: row.due_on, amount: row.amount, balance: row.balance, full_name: row.full_name, atrasada: row.atrasada, dias_atraso: row.dias_atraso,
    concept: `${billingCode(row.number)} · ${billingKindText[row.kind as string] || row.kind} ${dmy(row.cycle_start)} → ${dmy(row.cycle_end)}` }));
}

app.get('/api/notifications', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const [preference] = await sql`SELECT * FROM notification_preferences WHERE user_id = ${auth.sub}`;
  const sessionHours = Number(preference?.session_reminder_hours || 1); const paymentDays = Number(preference?.payment_reminder_days || 3);
  if (auth.role === 'client') {
    const [client] = await sql`SELECT * FROM clients WHERE portal_user_id = ${auth.sub}`;
    if (!client) return reply.code(404).send({ error: 'Portal de cliente no encontrado' });
    const sessions = await sql`SELECT starts_at, duration_minutes FROM sessions WHERE client_id = ${client.id} AND status = 'scheduled' AND NOT COALESCE(paused_hold, false) AND starts_at BETWEEN now() AND now() + ${`${sessionHours} hours`}::interval ORDER BY starts_at`;
    const invoices = billingEngine.state === 'new'
      ? await openNewInvoiceNotices(client.owner_id as string, paymentDays, client.id as string)
      : await sql`SELECT due_on, amount, concept,
      GREATEST(amount - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = invoices.id), CASE WHEN status = 'confirmed' THEN amount ELSE 0 END), 0) AS balance
      FROM invoices WHERE client_id = ${client.id} AND status = 'pending' AND source_system IS DISTINCT FROM 'zoho_invoice' AND due_on <= current_date + (${paymentDays})::integer ORDER BY due_on`;
    return [
      ...sessions.map(session => ({ type: 'session', title: 'Próximo entrenamiento', body: `Tienes una sesión el ${new Date(session.starts_at).toLocaleString('es-PA', { timeZone: 'America/Panama' })}.`, scheduledFor: session.starts_at })),
      ...invoices.map(invoice => ({ type: 'payment', title: 'Recordatorio de pago', body: `${invoice.concept}: $${Number(invoice.balance).toFixed(2)} pendientes de $${Number(invoice.amount).toFixed(2)} · vence ${invoice.due_on}.`, scheduledFor: invoice.due_on }))
    ];
  }
  const sessions = await sql`
    SELECT s.starts_at, c.full_name FROM sessions s JOIN clients c ON c.id = s.client_id
    WHERE c.owner_id = ${auth.sub} AND s.status = 'scheduled' AND NOT COALESCE(s.paused_hold, false) AND s.starts_at BETWEEN now() AND now() + ${`${sessionHours} hours`}::interval ORDER BY s.starts_at
  `;
  const invoices = billingEngine.state === 'new' ? await openNewInvoiceNotices(auth.sub, paymentDays) : await sql`
    SELECT i.due_on, i.amount, i.concept, c.full_name,
      GREATEST(i.amount - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END), 0) AS balance,
      (i.due_on < current_date) AS atrasada,
      (current_date - i.due_on) AS dias_atraso
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE c.owner_id = ${auth.sub} AND i.status = 'pending'
      -- Un cliente en pausa no debe generar aviso de pago: no está entrenando.
      AND c.status <> 'paused'
      -- Las facturas de Zoho son sólo consulta de la migración: no se cobran por
      -- la app, así que no deben generar avisos de pago.
      AND i.source_system IS DISTINCT FROM 'zoho_invoice'
      AND i.due_on <= current_date + (${paymentDays})::integer ORDER BY i.due_on
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
      -- Una sesión con el paquete en pausa está congelada: no se dio ni se
      -- perdió, así que no hay nada que marcar y no debe pedir confirmación.
      -- Se excluye tanto la marcada (paused_hold) como cualquiera de un cliente
      -- actualmente en pausa, por si quedó sin la marca.
      AND NOT COALESCE(s.paused_hold, false) AND c.status <> 'paused'
      AND s.starts_at + make_interval(mins => s.duration_minutes) <= now()
      AND s.starts_at >= now() - interval '7 days'
    ORDER BY s.starts_at DESC
  `;
  // Viajes que empiezan pronto (o ya empezaron) sin ninguna rutina enviada: sin enlace, el cliente no puede confirmar nada y Eileen tiene que decidir sus clases a mano.
  const viajesSinRutina = await sql`
    SELECT t.id, t.client_id, t.starts_on::text AS starts_on, t.ends_on::text AS ends_on, c.full_name
    FROM client_travel t JOIN clients c ON c.id = t.client_id
    WHERE c.owner_id = ${auth.sub} AND c.status = 'active'
      AND t.starts_on <= (now() AT TIME ZONE 'America/Panama')::date + 1
      AND COALESCE(t.ends_on, DATE '9999-12-31') >= (now() AT TIME ZONE 'America/Panama')::date
      AND NOT EXISTS (SELECT 1 FROM routine_share_links l WHERE l.client_id = t.client_id AND l.revoked_at IS NULL AND l.expires_at > now())
    ORDER BY t.starts_on`;
  // Rutinas que los clientes cumplieron en las últimas 24 horas (con o sin clase de por medio).
  const rutinasCumplidas = await sql`
    SELECT rc.id, rc.completion_percent, rc.duration_seconds, rc.updated_at, c.full_name, r.title
    FROM routine_completions rc JOIN clients c ON c.id = rc.client_id JOIN routines r ON r.id = rc.routine_id
    WHERE c.owner_id = ${auth.sub} AND rc.completion_percent > 0 AND (rc.marked_by_user_id = c.portal_user_id OR rc.via_link)
      AND rc.updated_at >= now() - interval '24 hours'
    ORDER BY rc.updated_at DESC LIMIT 20`;
  return [
    ...viajesSinRutina.map(viaje => {
      const [a, m, d] = String(viaje.starts_on).split('-'); const [a2, m2, d2] = viaje.ends_on ? String(viaje.ends_on).split('-') : [];
      return {
        type: 'travel', clientId: viaje.client_id, travelId: viaje.id,
        title: `${viaje.full_name} viaja${viaje.starts_on > new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10) ? ' pronto' : ': está de viaje'}`,
        body: `${d}-${m}-${a}${viaje.ends_on ? ` al ${d2}-${m2}-${a2}` : ' (regreso sin definir)'}. No tiene una rutina enviada. Si no recibe y confirma una rutina, sus clases de esos días se cancelan solas. ¿Se la ofreces?`,
        scheduledFor: viaje.starts_on
      };
    }),
    ...rutinasCumplidas.map(item => ({
      type: 'routine', title: `Rutina cumplida: ${item.full_name}`,
      body: `«${item.title}»${duracionTexto(item.duration_seconds === null ? null : Number(item.duration_seconds))} · ${item.completion_percent}%`,
      scheduledFor: item.updated_at
    })),
    ...pendientes.map(session => ({
      type: 'pending', sessionId: session.id,
      title: `Falta marcar: ${session.full_name}`,
      body: `${new Date(session.starts_at).toLocaleString('es-PA', { timeZone: 'America/Panama', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} · ya terminó y sigue sin marcar.`,
      scheduledFor: session.starts_at
    })),
    ...sessions.map(session => ({ type: 'session', title: `Sesión con ${session.full_name}`, body: new Date(session.starts_at).toLocaleString('es-PA', { timeZone: 'America/Panama' }), scheduledFor: session.starts_at })),
    // El pago atrasado se separa del recordatorio: es un aviso, no un bloqueo.
    // Las clases siguen —hay clientes que pagan unos días tarde por temas
    // personales—, pero la entrenadora ve que ese cobro ya venció.
    ...invoices.map(invoice => invoice.atrasada
      ? ({ type: 'overdue', title: `Pago atrasado: ${invoice.full_name}`, body: `${invoice.concept}: $${Number(invoice.balance).toFixed(2)} pendientes de $${Number(invoice.amount).toFixed(2)} · venció ${invoice.due_on}${Number(invoice.dias_atraso) > 0 ? ` (${invoice.dias_atraso} día${Number(invoice.dias_atraso) === 1 ? '' : 's'})` : ''}. Las clases siguen; sólo falta el pago.`, scheduledFor: invoice.due_on })
      : ({ type: 'payment', title: `Pago de ${invoice.full_name}`, body: `${invoice.concept}: $${Number(invoice.balance).toFixed(2)} pendientes de $${Number(invoice.amount).toFixed(2)} · vence ${invoice.due_on}.`, scheduledFor: invoice.due_on }))
  ];
});

type ReminderCandidate = {
  user_id: string;
  kind: 'session' | 'payment' | 'pending' | 'pause';
  reference_id: string;
  role: AuthUser['role'];
  full_name: string;
  starts_at?: string;
  due_on?: string;
  amount?: number | string;
  balance?: number | string;
  concept?: string;
  ends_on?: string;
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

async function sendPushToUser(userId: string, payload: { title: string; body: string; url: string; sound?: boolean; tag?: string }) {
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
  const [sessionRows, paymentRows, pauseRows] = await Promise.all([
    sql<ReminderCandidate[]>`
      SELECT u.id AS user_id, 'session' AS kind, s.id AS reference_id, u.role, c.full_name, s.starts_at
      FROM notification_preferences np
      JOIN users u ON u.id = np.user_id AND u.active = true
      JOIN clients c ON (u.role = 'client' AND c.portal_user_id = u.id)
        OR (u.role IN ('admin', 'trainer') AND c.owner_id = u.id)
      JOIN sessions s ON s.client_id = c.id
      WHERE np.browser_enabled = true AND s.status = 'scheduled' AND NOT COALESCE(s.paused_hold, false)
        AND s.starts_at BETWEEN now() AND now() + make_interval(hours => np.session_reminder_hours)
        AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id AND ps.active = true)
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.user_id = u.id AND nd.kind = 'session' AND nd.reference_id = s.id
        )
    `,
    sql<ReminderCandidate[]>`
      SELECT u.id AS user_id, 'payment' AS kind, i.id AS reference_id, u.role, c.full_name,
        i.due_on, i.amount, i.concept,
        GREATEST(i.amount - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id), CASE WHEN i.status = 'confirmed' THEN i.amount ELSE 0 END), 0) AS balance
      FROM notification_preferences np
      JOIN users u ON u.id = np.user_id AND u.active = true
      JOIN clients c ON (u.role = 'client' AND c.portal_user_id = u.id)
        OR (u.role IN ('admin', 'trainer') AND c.owner_id = u.id)
      JOIN invoices i ON i.client_id = c.id
      WHERE np.browser_enabled = true AND i.status = 'pending'
        -- Tras el corte (estado new) las facturas del sistema anterior ya no generan recordatorios: lo hacen las nuevas (consulta siguiente).
        AND ${billingEngine.state === 'new' ? sql`false` : sql`true`}
        AND i.due_on BETWEEN current_date - 30 AND current_date + np.payment_reminder_days
        AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id AND ps.active = true)
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.user_id = u.id AND nd.kind = 'payment' AND nd.reference_id = i.id
      )
    `,
    sql<ReminderCandidate[]>`
      SELECT u.id AS user_id, 'payment' AS kind, i.id AS reference_id, u.role, c.full_name,
        i.due_on, i.total AS amount, ('FAC-' || lpad(i.number::text, 4, '0')) AS concept,
        GREATEST(i.total - COALESCE((SELECT sum(a.amount) FROM billing_payment_applications a WHERE a.invoice_id = i.id AND a.reversed_at IS NULL), 0), 0) AS balance
      FROM notification_preferences np
      JOIN users u ON u.id = np.user_id AND u.active = true
      JOIN clients c ON (u.role = 'client' AND c.portal_user_id = u.id)
        OR (u.role IN ('admin', 'trainer') AND c.owner_id = u.id)
      JOIN billing_invoices i ON i.payer_client_id = c.id
      WHERE ${billingEngine.state === 'new' ? sql`true` : sql`false`} AND np.browser_enabled = true AND i.status IN ('pendiente', 'parcial') AND c.status <> 'paused'
        AND i.due_on BETWEEN current_date - 30 AND current_date + np.payment_reminder_days
        AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id AND ps.active = true)
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.user_id = u.id AND nd.kind = 'payment' AND nd.reference_id = i.id
      )
    `,
    sql<ReminderCandidate[]>`
      SELECT u.id AS user_id, 'pause' AS kind, pp.id AS reference_id, u.role, c.full_name, pp.ends_on
      FROM client_package_pauses pp
      JOIN clients c ON c.id = pp.client_id
      JOIN users u ON u.id = c.owner_id AND u.active = true AND u.role IN ('admin', 'trainer')
      JOIN notification_preferences np ON np.user_id = u.id
      WHERE pp.status = 'active' AND pp.ends_on = ((now() AT TIME ZONE 'America/Panama')::date + 2)
        AND np.browser_enabled = true
        AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id AND ps.active = true)
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries nd
          WHERE nd.user_id = u.id AND nd.kind = 'pause' AND nd.reference_id = pp.id
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

  for (const reminder of [...pendingRows, ...sessionRows, ...paymentRows, ...pauseRows]) {
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
      : reminder.kind === 'payment'
      ? {
          title: isClient ? 'Recordatorio de pago' : `Pago de ${reminder.full_name}`,
          body: `${reminder.concept}: $${Number(reminder.balance).toFixed(2)} pendientes de $${Number(reminder.amount).toFixed(2)} · vence ${reminder.due_on}.`,
          url: new URL(isClient ? '/#portal-billing' : '/#billing', config.APP_URL).toString()
        }
      : {
          title: `Pausa por finalizar · ${reminder.full_name}`,
          body: `La pausa del paquete termina el ${reminder.ends_on}. Revisa si debes reactivar su agenda.`,
          url: new URL('/#clients', config.APP_URL).toString()
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

// Portal con la fuente nueva (solo en estado `new`): el PAGADOR ve sus facturas con la misma forma que las del sistema anterior (el portal
// no cambia) y el BENEFICIARIO que no paga solo ve uno de dos avisos, sin montos, sin saldos y sin el nombre del pagador.
async function portalBillingFromNewSource(clientId: string, ownerId: string) {
  const invoices = await sql`
    SELECT i.id::text AS id, i.number, i.kind, i.cycle_start::text AS cycle_start, i.cycle_end::text AS cycle_end, i.issued_on::text AS issued_on, i.due_on::text AS due_on,
      i.total::text AS total, i.status,
      COALESCE((SELECT sum(a.amount) FROM billing_payment_applications a WHERE a.invoice_id = i.id AND a.reversed_at IS NULL), 0)::text AS paid,
      (SELECT p.method FROM billing_payment_applications a JOIN billing_payments p ON p.id = a.payment_id WHERE a.invoice_id = i.id AND a.reversed_at IS NULL ORDER BY a.created_at DESC LIMIT 1) AS method
    FROM billing_invoices i WHERE i.owner_id = ${ownerId} AND i.payer_client_id = ${clientId} AND i.status <> 'anulada' ORDER BY i.issued_on DESC, i.number DESC`;
  const lines = invoices.length ? await sql`
    SELECT l.invoice_id::text AS invoice_id, b.full_name, l.description, l.quantity::text AS quantity, l.unit_amount::text AS unit_amount, l.amount::text AS amount
    FROM billing_invoice_lines l JOIN clients b ON b.id = l.beneficiary_client_id WHERE l.invoice_id IN ${sql(invoices.map(row => row.id as string))} ORDER BY b.full_name` : [];
  const asLegacy = invoices.map(row => {
    const total = Number(row.total); const paid = Number(row.paid);
    return {
      id: row.id, concept: `${billingKindText[row.kind as string] || row.kind} · ${dmy(row.cycle_start)} → ${dmy(row.cycle_end)}`, amount: total, currency: 'USD', due_on: row.due_on,
      status: row.status === 'pagada' ? 'confirmed' : 'pending', payment_method: row.method ?? null, invoice_number: billingCode(row.number), issued_on: row.issued_on,
      line_items: lines.filter(line => line.invoice_id === row.id).map(line => ({ name: `${line.full_name} · ${line.description}`, quantity: Number(line.quantity), rate: Number(line.unit_amount), item_total: Number(line.amount) })),
      balance: desdeCentavos(centavos(total) - centavos(paid))
    };
  });
  // Aviso al beneficiario: cubierto por OTRO pagador; "pago pendiente" desde el DÍA SIGUIENTE al vencimiento, sin gracia (O-1).
  const today = fechaDeNegocioPanama();
  const covered = await sql`
    SELECT 1 FROM billing_subscriptions s WHERE s.owner_id = ${ownerId} AND s.beneficiary_client_id = ${clientId} AND s.payer_client_id <> ${clientId}
      AND s.starts_on <= ${today}::date AND (s.ends_on IS NULL OR s.ends_on >= ${today}::date) LIMIT 1`;
  let notice: { kind: 'cubierta' | 'pago_pendiente'; message: string } | null = null;
  if (covered.length) {
    const [overdue] = await sql`
      SELECT 1 FROM billing_invoices i JOIN billing_invoice_lines l ON l.invoice_id = i.id
      WHERE i.owner_id = ${ownerId} AND l.beneficiary_client_id = ${clientId} AND i.payer_client_id <> ${clientId} AND l.line_type = 'plan'
        AND i.status IN ('pendiente', 'parcial') AND i.due_on < ${today}::date LIMIT 1`;
    notice = overdue ? { kind: 'pago_pendiente', message: 'La cuenta de quien paga tu plan tiene un pago pendiente.' } : { kind: 'cubierta', message: 'Tu mensualidad está cubierta.' };
  }
  return { invoices: asLegacy, notice };
}

app.get('/api/portal/summary', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser;
  if (auth.role !== 'client') return reply.code(403).send({ error: 'Acceso exclusivo para clientes' });
  const client = await portalClient(auth.sub); if (!client) return reply.code(404).send({ error: 'Portal de cliente no encontrado' });
  const [invoices, routines, sessions, complianceSessions, busySlots, assessments, completions, exercises, packages, credits, weightLogs] = await Promise.all([
    sql`
      SELECT id, concept, amount, currency, due_on, status, payment_method, invoice_number, issued_on, line_items,
        -- Lo que de verdad falta por pagar. La columna balance sólo la mantiene
        -- Zoho; en un cobro nacido aquí vale 0 por omisión, y el portal la
        -- sumaba tal cual: un cliente con su mensualidad sin pagar veía
        -- "Saldo pendiente $0.00" y se quedaba tan tranquilo.
        CASE
          WHEN source_system = 'zoho_invoice' THEN balance
          ELSE GREATEST(amount - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = invoices.id), CASE WHEN status = 'confirmed' THEN amount ELSE 0 END), 0)
        END::numeric(12,2) AS balance
      FROM invoices WHERE client_id = ${client.id} ORDER BY COALESCE(issued_on, due_on) DESC
    `,
    sql`SELECT ra.id AS assignment_id, ra.due_on, r.id, r.title, r.description, r.sessions_per_week, r.exercises FROM routine_assignments ra JOIN routines r ON r.id = ra.routine_id WHERE ra.client_id = ${client.id} AND ra.active = true AND (ra.ends_on IS NULL OR ra.ends_on >= current_date) ORDER BY ra.starts_on DESC`,
    sql`SELECT s.id, s.routine_id, s.starts_at, s.duration_minutes, s.mode, s.status, s.cancellation_kind, s.cancelled_by, s.credit_charge, s.completion_percent,
      r.title AS routine_title,
      (EXISTS (SELECT 1 FROM session_reschedules sr WHERE sr.session_id = s.id AND sr.origin = 'moved')
        OR (s.status = 'cancelled' AND s.cancellation_kind = 'rescheduled' AND COALESCE(s.cancelled_by, 'client') = 'client')) AS reprogramada
      FROM sessions s LEFT JOIN routines r ON r.id = s.routine_id
      WHERE s.client_id = ${client.id} AND s.starts_at >= now() - interval '1 year' ORDER BY s.starts_at`,
    sql`SELECT s.id, s.starts_at, s.status, s.cancellation_kind, s.cancelled_by, s.completion_percent,
      COALESCE(r.title, 'Entrenamiento') AS routine_title
      FROM sessions s JOIN clients c ON c.id = s.client_id LEFT JOIN routines r ON r.id = s.routine_id
      WHERE c.id = ${client.id} AND s.starts_at >= now() - interval '1 year'
        AND ${complianceSessionCondition()}
      ORDER BY s.starts_at`,
    sql`SELECT s.id, s.starts_at, s.duration_minutes, (s.client_id = ${client.id}) AS is_mine FROM sessions s JOIN clients c ON c.id = s.client_id WHERE c.owner_id = ${client.owner_id} AND s.status <> 'cancelled' AND s.starts_at BETWEEN now() - interval '60 days' AND now() + interval '90 days' ORDER BY s.starts_at`,
    sql`SELECT tested_at, values FROM inbody_assessments WHERE client_id = ${client.id} AND extraction_status = 'ready' ORDER BY tested_at`,
    sql`SELECT routine_id, completed_on, completion_percent, duration_seconds FROM routine_completions WHERE client_id = ${client.id} AND completed_on >= current_date - interval '1 year' ORDER BY completed_on`,
    // El catálogo entero, no sólo lo asignado: la rutina guarda los ejercicios
    // como copia en JSON, y es por catalogId que el portal sabe cuáles tienen
    // video que mostrar. La URL firmada se pide aparte, al darle reproducir.
    sql`
      SELECT id, slug, name, english, section, level, machine, free_weight, cues,
             video_duration_seconds,
             (video_object_key IS NOT NULL OR EXISTS (SELECT 1 FROM exercise_videos ev WHERE ev.exercise_id = exercises.id)) AS has_video,
             (SELECT count(*)::int FROM exercise_videos ev WHERE ev.exercise_id = exercises.id) AS video_count
      FROM exercises WHERE owner_id = ${client.owner_id} AND archived = false
    `,
    // Su saldo de clases: es lo primero que quiere saber quien entrena y no
    // estaba en ninguna parte del portal.
    sql`
      SELECT id, label, kind, total_sessions, used_sessions, expires_on, purchased_on, status
      FROM session_packages
      WHERE client_id = ${client.id} AND status <> 'cancelled'
        AND NOT (${client.payment_mode} = 'no_anticipado' AND kind = 'monthly')
      ORDER BY purchased_on DESC, expires_on DESC NULLS LAST
      LIMIT 120
    `,
    sql`
      SELECT concept, amount FROM billing_credits
      WHERE client_id = ${client.id} AND applied_invoice_id IS NULL ORDER BY created_at
    `,
    sql`
      SELECT id, weight_kg, weight_value, unit, measured_at, note
      FROM client_weight_logs WHERE client_id = ${client.id} ORDER BY measured_at DESC LIMIT 500
    `
  ]);
  const profile = {
    id: client.id, full_name: client.full_name, email: client.email, goal: client.goal, status: client.status,
    billing_model: client.billing_model, standard_price: client.standard_price, billing_cutoff_day: client.billing_cutoff_day,
    payment_mode: client.payment_mode, credit_session_price: client.credit_session_price,
    plan_name: client.plan_name, sessions_included: client.sessions_included, validity_days: client.validity_days
  };
  // El portal necesita conocer los intervalos ocupados para que el cliente
  // pueda elegir un horario libre, pero nunca necesita saber quién ocupa el
  // intervalo. Para terceros se devuelve deliberadamente sólo fecha/hora,
  // duración y la marca is_mine; no se filtran id, client_id ni nombres.
  const privateBusySlots = busySlots.map(slot => slot.is_mine
    ? { id: slot.id, starts_at: slot.starts_at, duration_minutes: slot.duration_minutes, is_mine: true }
    : { starts_at: slot.starts_at, duration_minutes: slot.duration_minutes, is_mine: false });
  // Tras el corte (estado `new`) el portal lee la facturación nueva y ya no muestra saldos de clases (D-14).
  if (billingEngine.state === 'new') {
    const fromNew = await portalBillingFromNewSource(client.id as string, client.owner_id as string);
    return { client: profile, invoices: fromNew.invoices, billingNotice: fromNew.notice, routines, sessions, complianceSessions, busySlots: privateBusySlots, assessments, routineCompletions: completions, exercises, packages: [], credits: [], weightLogs };
  }
  return { client: profile, invoices, billingNotice: null, routines, sessions, complianceSessions, busySlots: privateBusySlots, assessments, routineCompletions: completions, exercises, packages, credits, weightLogs };
});

const clientWeightLogSchema = z.object({
  weight: z.coerce.number().finite().positive().max(1100),
  unit: z.enum(['kg', 'lb']).default('kg'),
  measuredAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(300).optional()
});

// La entrenadora ve estos registros separados de los InBody: son útiles para
// tendencia, pero no representan una evaluación de composición corporal.
app.get('/api/clients/:clientId/weight-logs', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const clientId = z.string().uuid().parse((request.params as { clientId: string }).clientId);
  const [owned] = await sql`SELECT id FROM clients WHERE id = ${clientId} AND owner_id = ${auth.sub}`;
  if (!owned) return reply.code(404).send({ error: 'Cliente no encontrado' });
  return sql`SELECT id, weight_kg, weight_value, unit, measured_at, note FROM client_weight_logs WHERE client_id = ${clientId} ORDER BY measured_at DESC`;
});

app.post('/api/portal/weight-logs', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser;
  if (auth.role !== 'client') return reply.code(403).send({ error: 'Acceso exclusivo para clientes' });
  const input = clientWeightLogSchema.parse(request.body);
  const client = await portalClient(auth.sub);
  if (!client) return reply.code(404).send({ error: 'Portal de cliente no encontrado' });
  const weightKg = input.unit === 'lb' ? input.weight * 0.45359237 : input.weight;
  if (weightKg > 500) return reply.code(400).send({ error: 'El peso está fuera del rango permitido' });
  const [entry] = await sql`
    INSERT INTO client_weight_logs (client_id, weight_kg, weight_value, unit, measured_at, note)
    VALUES (${client.id}, ${weightKg.toFixed(3)}, ${input.weight.toFixed(3)}, ${input.unit}, ${input.measuredAt ? new Date(input.measuredAt) : new Date()}, ${input.note || null})
    RETURNING id, weight_kg, weight_value, unit, measured_at, note
  `;
  await sendPushToUser(client.owner_id, {
    title: 'Nuevo registro de peso',
    body: `${client.full_name} registró ${Number(input.weight).toFixed(1)} ${input.unit === 'lb' ? 'lb' : 'kg'}.`,
    url: new URL('/#clients', config.APP_URL).toString()
  });
  return reply.code(201).send(entry);
});

app.patch('/api/portal/weight-logs/:id', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser;
  if (auth.role !== 'client') return reply.code(403).send({ error: 'Acceso exclusivo para clientes' });
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = clientWeightLogSchema.parse(request.body);
  const client = await portalClient(auth.sub);
  if (!client) return reply.code(404).send({ error: 'Portal de cliente no encontrado' });
  const weightKg = input.unit === 'lb' ? input.weight * 0.45359237 : input.weight;
  const [entry] = await sql`
    UPDATE client_weight_logs SET weight_kg = ${weightKg.toFixed(3)}, weight_value = ${input.weight.toFixed(3)}, unit = ${input.unit}, measured_at = ${input.measuredAt ? new Date(input.measuredAt) : new Date()}, note = ${input.note || null}, updated_at = now()
    WHERE id = ${id} AND client_id = ${client.id}
    RETURNING id, weight_kg, weight_value, unit, measured_at, note
  `;
  if (!entry) return reply.code(404).send({ error: 'Registro no encontrado' });
  return entry;
});

app.delete('/api/portal/weight-logs/:id', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser;
  if (auth.role !== 'client') return reply.code(403).send({ error: 'Acceso exclusivo para clientes' });
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const client = await portalClient(auth.sub);
  if (!client) return reply.code(404).send({ error: 'Portal de cliente no encontrado' });
  const [entry] = await sql`DELETE FROM client_weight_logs WHERE id = ${id} AND client_id = ${client.id} RETURNING id`;
  if (!entry) return reply.code(404).send({ error: 'Registro no encontrado' });
  return { deleted: true };
});

// Informes que el cliente puede descargarse solo. Se calculan con su propio
// identificador —el del token—, nunca con uno que venga en la petición: los de
// la entrenadora reciben el cliente por parámetro, y aquí eso permitiría pedir
// el estado de cuenta de cualquiera.
app.get('/api/portal/reports/account-statement.pdf', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser;
  if (auth.role !== 'client') return reply.code(403).send({ error: 'Acceso exclusivo para clientes' });
  const client = await portalClient(auth.sub);
  if (!client) return reply.code(404).send({ error: 'Portal de cliente no encontrado' });
  const rango = z.object({
    from: z.string().date().default(() => fechaPanamaDiasAtras(180)),
    to: z.string().date().default(() => fechaDeNegocioPanama())
  }).parse(request.query);
  const report = billingEngine.state === 'new'
    ? await newAccountStatementData(client.owner_id as string, client.id as string, rango.from, rango.to)
    : await accountStatementData(client.owner_id as string, { clientId: client.id as string, ...rango });
  if (!report) return reply.code(404).send({ error: 'Cliente no encontrado' });
  return sendPdf(reply, await accountStatementPdf(report.client, report.rows, rango.from, rango.to), `estado-de-cuenta-${rango.from}-${rango.to}.pdf`);
});

app.get('/api/portal/reports/compliance.pdf', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser;
  if (auth.role !== 'client') return reply.code(403).send({ error: 'Acceso exclusivo para clientes' });
  const client = await portalClient(auth.sub);
  if (!client) return reply.code(404).send({ error: 'Portal de cliente no encontrado' });
  const meses = z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }).parse(request.query).months;
  const timeline = await complianceMonthly(client.owner_id as string, client.id as string, meses);
  const conDatos = timeline.filter(mes => mes.compliancePercent !== null);
  const resumen = {
    meses: conDatos.length,
    promedio: conDatos.length ? Math.round(conDatos.reduce((suma, mes) => suma + (mes.compliancePercent || 0), 0) / conDatos.length) : null,
    mejor: conDatos.length ? conDatos.reduce((mejor, mes) => (mes.compliancePercent || 0) > (mejor.compliancePercent || 0) ? mes : mejor) : null,
    peor: conDatos.length ? conDatos.reduce((peor, mes) => (mes.compliancePercent || 0) < (peor.compliancePercent || 0) ? mes : peor) : null
  };
  return sendPdf(reply, await compliancePdf({ id: client.id, full_name: client.full_name, email: client.email }, resumen, timeline), `cumplimiento-${String(client.full_name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`);
});

const routineCompletionSchema = z.object({ routineId: z.string().uuid(), completedOn: z.string().date(), completionPercent: z.coerce.number().int().min(0).max(100), notes: z.string().max(300).optional(), durationSeconds: z.coerce.number().int().min(1).max(21600).optional() });
app.post('/api/portal/routine-completions', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser; if (auth.role !== 'client') return reply.code(403).send({ error: 'Acceso exclusivo para clientes' });
  const input = routineCompletionSchema.parse(request.body); const client = await portalClient(auth.sub); if (!client) return reply.code(404).send({ error: 'Portal de cliente no encontrado' });
  const [assignment] = await sql`SELECT id FROM routine_assignments WHERE routine_id = ${input.routineId} AND client_id = ${client.id} AND active = true`;
  if (!assignment) return reply.code(404).send({ error: 'La rutina no está asignada a este cliente' });
  const [completion] = await sql`
    INSERT INTO routine_completions (routine_id, client_id, completed_on, completion_percent, marked_by_user_id, notes, duration_seconds)
    VALUES (${input.routineId}, ${client.id}, ${input.completedOn}, ${input.completionPercent}, ${auth.sub}, ${input.notes || null}, ${input.durationSeconds ?? null})
    ON CONFLICT (routine_id, client_id, completed_on) DO UPDATE SET completion_percent = EXCLUDED.completion_percent,
      marked_by_user_id = EXCLUDED.marked_by_user_id, notes = EXCLUDED.notes, duration_seconds = COALESCE(EXCLUDED.duration_seconds, routine_completions.duration_seconds), updated_at = now()
    RETURNING *
  `;
  if (input.completionPercent > 0) {
    const [rutina] = await sql`SELECT title FROM routines WHERE id = ${input.routineId}`;
    await avisarRutinaCumplida(client, String(rutina?.title ?? 'su rutina'), input.completionPercent, input.durationSeconds ?? null, false);
  }
  return reply.code(201).send(completion);
});

// ── Rutina ofrecida en lugar de la clase ───────────────────────────────────
// Eileen puede ofrecerle al cliente una rutina para hacer por su cuenta en lugar de la clase (J-102/J-103/J-104) en dos casos, y SOLO VALE EL DÍA DE ESA CLASE (hora de Panamá):
//  · origin 'trainer': ella no puede atender la clase. Si el cliente no la cumple, la clase sigue pendiente y ella decide (el cliente no tiene culpa).
//  · origin 'client': el cliente canceló. Si no la cumple ese día, la clase SE DA POR PERDIDA (cancelación del cliente sin reprogramar), automáticamente. La clase NO se cancela: queda programada con la rutina ligada, y si el cliente
// la cumple en el portal pasa a "realizada" (cuenta como su clase del día y descuenta de su saldo como cualquier clase dada). Si no la cumple, la clase sigue
// apareciendo entre las que faltan por marcar y Eileen decide cómo cerrarla.
const duracionTexto = (segundos: number | null) => {
  if (!segundos) return '';
  const minutos = Math.round(segundos / 60);
  return minutos < 1 ? ` en ${segundos} s` : ` en ${minutos} min`;
};

async function avisarRutinaCumplida(cliente: Record<string, unknown>, rutina: string, porcentaje: number, duracion: number | null, enLugarDeClase: boolean) {
  const client = cliente as { id: string; owner_id: string; full_name: string };
  await sendPushToUser(client.owner_id, {
    title: `Rutina cumplida · ${client.full_name}`,
    body: `«${rutina}»${duracionTexto(duracion)} · ${porcentaje}%${enLugarDeClase ? '. Cuenta como su clase de hoy.' : '.'}`,
    url: new URL('/#calendar', config.APP_URL).toString(),
    sound: true, tag: `rutina-${client.id}`
  });
}

app.post('/api/sessions/:id/routine-offer', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = z.object({ routineId: z.string().uuid(), origin: z.enum(['trainer', 'client']).default('trainer') }).parse(request.body);
  const [sesion] = await sql`
    SELECT s.id, s.status, s.client_id, s.starts_at, s.duration_minutes, s.notes, c.full_name, c.portal_user_id,
      ((s.starts_at AT TIME ZONE 'America/Panama')::date >= (now() AT TIME ZONE 'America/Panama')::date) AS dia_vigente,
      ((s.starts_at AT TIME ZONE 'America/Panama')::date = (now() AT TIME ZONE 'America/Panama')::date) AS es_hoy,
      to_char(s.starts_at AT TIME ZONE 'America/Panama', 'DD-MM-YYYY') AS dia_texto
    FROM sessions s JOIN clients c ON c.id = s.client_id WHERE s.id = ${id} AND c.owner_id = ${auth.sub}`;
  if (!sesion) return reply.code(404).send({ error: 'Sesión no encontrada' });
  if (sesion.status !== 'scheduled') return reply.code(409).send({ error: 'Solo se puede ofrecer una rutina en lugar de una clase programada.' });
  if (!sesion.dia_vigente) return reply.code(409).send({ error: `La rutina solo vale el día de la clase (${sesion.dia_texto}) y ese día ya pasó.` });
  const [rutina] = await sql`
    SELECT r.id, r.title FROM routines r JOIN routine_assignments ra ON ra.routine_id = r.id AND ra.active = true AND ra.client_id = ${sesion.client_id}
    WHERE r.id = ${input.routineId} AND r.owner_id = ${auth.sub}`;
  if (!rutina) return reply.code(409).send({ error: 'La rutina debe estar asignada a este cliente.' });
  const [previa] = await sql`SELECT status FROM session_routine_offers WHERE session_id = ${id}`;
  if (previa?.status === 'completed') return reply.code(409).send({ error: 'El cliente ya cumplió una rutina en lugar de esta clase.' });

  const [oferta] = await sql.begin(async transaction => {
    const filas = await transaction`
      INSERT INTO session_routine_offers (session_id, routine_id, client_id, offered_by_user_id, origin)
      VALUES (${id}, ${rutina.id}, ${sesion.client_id}, ${auth.sub}, ${input.origin})
      ON CONFLICT (session_id) DO UPDATE SET routine_id = EXCLUDED.routine_id, status = 'offered', offered_at = now(), offered_by_user_id = EXCLUDED.offered_by_user_id,
        origin = EXCLUDED.origin, completed_at = NULL, completion_percent = NULL, duration_seconds = NULL
      RETURNING *`;
    const nota = input.origin === 'client'
      ? 'Rutina ofrecida en lugar de la clase (cancelación del cliente). Solo vale el día de la clase; si no la cumple, la clase se da por perdida.'
      : 'Rutina ofrecida en lugar de la clase (Eileen no pudo atenderla). Solo vale el día de la clase.';
    await transaction`
      UPDATE sessions SET routine_id = ${rutina.id}, updated_at = now(),
        notes = CASE WHEN COALESCE(notes, '') LIKE ${'%Rutina ofrecida en lugar de la clase%'} THEN notes ELSE COALESCE(notes || E'\n', '') || ${nota} END
      WHERE id = ${id}`;
    return filas;
  });
  if (sesion.portal_user_id) {
    await sendPushToUser(String(sesion.portal_user_id), {
      title: 'Eileen te dejó una rutina', body: input.origin === 'client'
        ? `Haz «${rutina.title}» ${sesion.es_hoy ? 'hoy' : `el ${sesion.dia_texto}`}: cuenta como tu clase. Si no la cumples ese día, la clase se da por perdida.`
        : `Haz «${rutina.title}» ${sesion.es_hoy ? 'hoy' : `el ${sesion.dia_texto}`}: cuenta como tu clase. Solo vale ese día.`,
      url: new URL('/#portal-routines', config.APP_URL).toString()
    });
  }
  return reply.code(201).send(oferta);
});

app.delete('/api/sessions/:id/routine-offer', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [oferta] = await sql`
    UPDATE session_routine_offers o SET status = 'withdrawn' FROM sessions s JOIN clients c ON c.id = s.client_id
    WHERE o.session_id = s.id AND s.id = ${id} AND c.owner_id = ${auth.sub} AND o.status = 'offered' RETURNING o.id`;
  if (!oferta) return reply.code(404).send({ error: 'No hay una rutina ofrecida pendiente para esta clase.' });
  return { withdrawn: true };
});

// Lo que el portal muestra como "Eileen te dejó una rutina": ofertas pendientes de clases que siguen programadas.
app.get('/api/portal/routine-offers', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser;
  if (auth.role !== 'client') return reply.code(403).send({ error: 'Acceso exclusivo para clientes' });
  const client = await portalClient(auth.sub);
  if (!client) return reply.code(404).send({ error: 'Portal de cliente no encontrado' });
  return sql`
    SELECT o.id, o.routine_id, o.session_id, o.offered_at, o.origin, s.starts_at, s.duration_minutes, r.title AS routine_title
    FROM session_routine_offers o JOIN sessions s ON s.id = o.session_id JOIN routines r ON r.id = o.routine_id
    WHERE o.client_id = ${client.id} AND o.status = 'offered' AND s.status = 'scheduled'
      AND (s.starts_at AT TIME ZONE 'America/Panama')::date = (now() AT TIME ZONE 'America/Panama')::date
    ORDER BY s.starts_at`;
});

app.post('/api/portal/routine-offers/:id/complete', { preHandler: requireAuth }, async (request, reply) => {
  const auth = request.user as AuthUser;
  if (auth.role !== 'client') return reply.code(403).send({ error: 'Acceso exclusivo para clientes' });
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = z.object({ completionPercent: z.coerce.number().int().min(1).max(100).default(100), durationSeconds: z.coerce.number().int().min(1).max(21600).optional() }).parse(request.body ?? {});
  const client = await portalClient(auth.sub);
  if (!client) return reply.code(404).send({ error: 'Portal de cliente no encontrado' });
  const [oferta] = await sql`
    SELECT o.id, o.status, o.session_id, o.routine_id, r.title,
      ((s.starts_at AT TIME ZONE 'America/Panama')::date = (now() AT TIME ZONE 'America/Panama')::date) AS es_hoy,
      to_char(s.starts_at AT TIME ZONE 'America/Panama', 'DD-MM-YYYY') AS dia_texto
    FROM session_routine_offers o JOIN routines r ON r.id = o.routine_id JOIN sessions s ON s.id = o.session_id
    WHERE o.id = ${id} AND o.client_id = ${client.id}`;
  if (!oferta) return reply.code(404).send({ error: 'Rutina ofrecida no encontrada' });
  if (oferta.status === 'completed') return { alreadyCompleted: true };
  if (oferta.status === 'withdrawn') return reply.code(409).send({ error: 'Eileen retiró esta rutina.' });
  if (!oferta.es_hoy) return reply.code(409).send({ error: `Esta rutina solo valía el ${oferta.dia_texto}. Ya no cuenta como clase; puedes hacerla igual y se registra como rutina suelta.` });

  await sql.begin(async transaction => {
    await transaction`
      INSERT INTO routine_completions (routine_id, client_id, completed_on, completion_percent, marked_by_user_id, duration_seconds)
      VALUES (${oferta.routine_id}, ${client.id}, (now() AT TIME ZONE 'America/Panama')::date, ${input.completionPercent}, ${auth.sub}, ${input.durationSeconds ?? null})
      ON CONFLICT (routine_id, client_id, completed_on) DO UPDATE SET completion_percent = EXCLUDED.completion_percent, marked_by_user_id = EXCLUDED.marked_by_user_id,
        duration_seconds = COALESCE(EXCLUDED.duration_seconds, routine_completions.duration_seconds), updated_at = now()`;
    await transaction`
      UPDATE session_routine_offers SET status = 'completed', completed_at = now(), completion_percent = ${input.completionPercent}, duration_seconds = ${input.durationSeconds ?? null}
      WHERE id = ${id}`;
  });
  // La clase pasa a realizada. Si ya no está programada (la cancelaron o ya la marcaron), no se toca: la rutina quedó registrada igual.
  let clase: Record<string, unknown> | null = null;
  try { clase = await recordSessionCompliance(String(oferta.session_id), client.owner_id, auth.sub, 'completed', input.completionPercent, { permitirAnticipada: true }); }
  catch (error) { app.log.warn({ err: error, sessionId: oferta.session_id }, 'La rutina se cumplió pero la clase no pudo marcarse como realizada'); }
  await avisarRutinaCumplida(client, String(oferta.title), input.completionPercent, input.durationSeconds ?? null, Boolean(clase));
  return { completed: true, sessionCompleted: Boolean(clase), billing: clase?.billing ?? null };
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
// Resumen de evaluaciones para la pantalla de clientes. Evita el patrón N+1
// de pedir un endpoint separado por cada expediente al iniciar la PWA.
app.get('/api/inbody', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`SELECT ia.* FROM inbody_assessments ia JOIN clients c ON c.id = ia.client_id WHERE c.owner_id = ${auth.sub} ORDER BY ia.client_id, ia.tested_at`;
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

  const [monthly, packages, cadence, agendaCadence] = await Promise.all([
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
    `,
    sql`
      -- Clases por semana según la agenda de horarios fijos: la suma de días de
      -- cada recurrencia activa. Es la cadencia real pactada para los clientes
      -- que no llevan mensualidad ni paquete (p. ej. clase suelta con horario
      -- fijo), y sirve para medir su cumplimiento contra su propia agenda.
      SELECT COALESCE(SUM(array_length(weekdays, 1)), 0)::int AS por_semana
      FROM session_recurrences
      WHERE client_id = ${clientId} AND active = true
        AND (ends_on IS NULL OR ends_on >= current_date)
    `
  ]);

  const byMonth = new Map(monthly.map(row => [row.month as string, row]));
  const packageRows = packages as unknown as Array<{ id: string; label: string; total_sessions: number; used_sessions: number; status: string; purchased_on: string; expires_on: string | null }>;
  const sessionsPerWeek = Number(cadence[0]?.sessions_per_week) || null;
  const agendaSessionsPerWeek = Number(agendaCadence[0]?.por_semana) || null;

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
    // La agenda de horarios fijos: la cadencia real pactada. Va antes que la
    // rutina porque es cuándo entrena de verdad, no la cadencia nominal del plan.
    if (agendaSessionsPerWeek) {
      const daysInMonth = monthEnd.getUTCDate();
      return { expected: Math.round(agendaSessionsPerWeek * (daysInMonth / 7)), basis: 'agenda' as const, packageLabel: null };
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

  return { timeline, packages: packageRows, sessionsPerWeek, agendaSessionsPerWeek, billingModel: client.billing_model, monthlySessionTarget: clientTarget };
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
// El generador viejo solo corre si el estado operativo lo permite (1B-0): en
// `maintenance` y `new` no escribe, y con un conflicto de configuración tampoco.
if (billingEngine.conflict) app.log.error({ billingEngine }, billingEngine.message);
else app.log.info({ state: billingEngine.state }, 'Estado operativo de la facturación');
// El generador nuevo solo escribe en el estado `new` (1B-6); en cualquier otro estado no corre.
const firstNewBillingRun = setTimeout(() => { if (billingEngine.newWrites) runNewBillingGenerationForAll().catch(error => app.log.error(error)); }, 30_000);
// Cada 15 minutos como máximo (J-081): el día del corte hay ~96 intentos y la factura de Julio (desde las 21:00) tiene ~12 en su ventana; cada intento es idempotente.
const newBillingInterval = setInterval(() => { if (billingEngine.newWrites) runNewBillingGenerationForAll().catch(error => app.log.error(error)); }, Math.min(config.BILLING_INTERVAL_MINUTES, 15) * 60_000);
const firstBillingRun = setTimeout(() => { if (billingEngine.legacyWrites) generateRecurringInvoices().catch(error => app.log.error(error)); }, 15_000);
const billingInterval = setInterval(() => { if (billingEngine.legacyWrites) generateRecurringInvoices().catch(error => app.log.error(error)); }, config.BILLING_INTERVAL_MINUTES * 60_000);
// Los intentos de acceso viejos no sirven para nada pasada la ventana; se
// barren una vez al día para que la tabla no crezca sin fin.
const purgaIntentos = setInterval(() => purgarIntentos().catch(error => app.log.error(error)), 24 * 60 * 60_000);
purgaIntentos.unref();
// Mantiene creadas las sesiones de los horarios fijos. Corre cada seis horas:
// el horizonte es de ocho semanas, así que no hay ninguna prisa, y si el
// servicio estuvo caído un rato se pone al día en el siguiente ciclo.
// ── Viajes y rutina por enlace (J-107) ──────────────────────────────────────────────────────────────
// Un viaje es solo un MARCADOR: no pausa el plan ni mueve el corte (si viaja, la mensualidad se cobra igual). Lo que el cliente puede hacer para que su clase de un día de viaje cuente es
// confirmar la rutina que Eileen le manda por un enlace temporal; sin confirmarla ese día equivale a una cancelación suya (ver darPorPerdidasClasesDeViajeSinRutina).
const viajeSchema = z.object({
  startsOn: z.string().date(),
  endsOn: z.string().date().nullable().optional(),
  destination: z.string().trim().max(80).optional(),
  note: z.string().trim().max(300).optional()
}).refine(valor => !valor.endsOn || valor.endsOn >= valor.startsOn, { message: 'El regreso no puede ser antes de la salida' });

const viajeSelect = (where: Fragment) => sql`
  SELECT t.id, t.client_id, t.starts_on::text AS starts_on, t.ends_on::text AS ends_on, t.destination, t.note, c.full_name,
    (SELECT count(*)::int FROM sessions s WHERE s.cancelled_travel_id = t.id) AS cancelled_sessions
  FROM client_travel t JOIN clients c ON c.id = t.client_id ${where} ORDER BY t.starts_on DESC`;

app.get('/api/travel', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return viajeSelect(sql`WHERE c.owner_id = ${auth.sub} AND COALESCE(t.ends_on, DATE '9999-12-31') >= (now() AT TIME ZONE 'America/Panama')::date - 400`);
});
app.get('/api/clients/:id/travel', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [cliente] = await sql`SELECT id FROM clients WHERE id = ${id} AND owner_id = ${auth.sub}`;
  if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });
  return viajeSelect(sql`WHERE t.client_id = ${id}`);
});
async function viajeTraslapado(clientId: string, startsOn: string, endsOn: string | null | undefined, exceptId: string | null) {
  const [fila] = await sql`
    SELECT t.id FROM client_travel t
    WHERE t.client_id = ${clientId} AND (${exceptId}::uuid IS NULL OR t.id <> ${exceptId}::uuid)
      AND t.starts_on <= COALESCE(${endsOn ?? null}::date, DATE '9999-12-31') AND COALESCE(t.ends_on, DATE '9999-12-31') >= ${startsOn}::date LIMIT 1`;
  return Boolean(fila);
}
app.post('/api/clients/:id/travel', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = viajeSchema.parse(request.body);
  const [cliente] = await sql`SELECT id FROM clients WHERE id = ${id} AND owner_id = ${auth.sub}`;
  if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });
  if (await viajeTraslapado(id, input.startsOn, input.endsOn, null)) return reply.code(409).send({ error: 'Ya tiene un viaje marcado en esas fechas.' });
  const [viaje] = await sql`
    INSERT INTO client_travel (client_id, starts_on, ends_on, destination, note, created_by)
    VALUES (${id}, ${input.startsOn}, ${input.endsOn ?? null}, ${input.destination || null}, ${input.note || null}, ${auth.sub})
    RETURNING id, client_id, starts_on::text AS starts_on, ends_on::text AS ends_on, destination, note`;
  return reply.code(201).send(viaje);
});
app.patch('/api/travel/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = viajeSchema.parse(request.body);
  const [actual] = await sql`SELECT t.id, t.client_id FROM client_travel t JOIN clients c ON c.id = t.client_id WHERE t.id = ${id} AND c.owner_id = ${auth.sub}`;
  if (!actual) return reply.code(404).send({ error: 'Viaje no encontrado' });
  if (await viajeTraslapado(String(actual.client_id), input.startsOn, input.endsOn, id)) return reply.code(409).send({ error: 'Ya tiene otro viaje marcado en esas fechas.' });
  const [viaje] = await sql`
    UPDATE client_travel SET starts_on = ${input.startsOn}, ends_on = ${input.endsOn ?? null}, destination = ${input.destination || null}, note = ${input.note || null}, updated_at = now()
    WHERE id = ${id} RETURNING id, client_id, starts_on::text AS starts_on, ends_on::text AS ends_on, destination, note`;
  return viaje;
});
app.delete('/api/travel/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [viaje] = await sql`
    SELECT t.id, (SELECT count(*)::int FROM sessions s WHERE s.cancelled_travel_id = t.id) AS canceladas
    FROM client_travel t JOIN clients c ON c.id = t.client_id WHERE t.id = ${id} AND c.owner_id = ${auth.sub}`;
  if (!viaje) return reply.code(404).send({ error: 'Viaje no encontrado' });
  // El viaje es la justificación de esas cancelaciones: se conserva como registro.
  if (Number(viaje.canceladas) > 0) return reply.code(409).send({ error: `Este viaje justificó ${viaje.canceladas} ${viaje.canceladas === 1 ? 'cancelación' : 'cancelaciones'}: se conserva como registro y no se puede quitar.` });
  const [borrado] = await sql`DELETE FROM client_travel t USING clients c WHERE t.id = ${id} AND c.id = t.client_id AND c.owner_id = ${auth.sub} RETURNING t.id`;
  if (!borrado) return reply.code(404).send({ error: 'Viaje no encontrado' });
  return { deleted: true };
});

// Enlaces temporales para abrir una rutina sin cuenta. El token se muestra una sola vez; en la base solo vive su hash.
const enlaceSchema = z.object({
  clientId: z.string().uuid(),
  hours: z.coerce.number().int().min(1).max(24 * 90).optional(),
  until: z.string().date().optional(),
  travelId: z.string().uuid().optional()
}).refine(valor => Boolean(valor.hours) !== Boolean(valor.until), { message: 'Indica la vigencia en horas o hasta una fecha' });

app.post('/api/routines/:id/share-links', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = enlaceSchema.parse(request.body);
  const [rutina] = await sql`
    SELECT r.id, r.title FROM routines r JOIN routine_assignments ra ON ra.routine_id = r.id AND ra.active = true AND ra.client_id = ${input.clientId}
    WHERE r.id = ${id} AND r.owner_id = ${auth.sub}`;
  if (!rutina) return reply.code(409).send({ error: 'La rutina debe estar asignada a ese cliente.' });
  if (input.travelId) {
    const [viaje] = await sql`SELECT t.id FROM client_travel t JOIN clients c ON c.id = t.client_id WHERE t.id = ${input.travelId} AND t.client_id = ${input.clientId} AND c.owner_id = ${auth.sub}`;
    if (!viaje) return reply.code(404).send({ error: 'Viaje no encontrado' });
  }
  // "Hasta una fecha" vence a la medianoche de Panamá al terminar ese día.
  const [vence] = input.hours
    ? await sql`SELECT now() + (${input.hours}::int * interval '1 hour') AS expires_at`
    : await sql`SELECT ((${input.until!}::date + 1)::timestamp AT TIME ZONE 'America/Panama') AS expires_at`;
  const expiresAt = new Date(vence.expires_at as string);
  if (expiresAt.getTime() < Date.now() + 3600_000) return reply.code(400).send({ error: 'La vigencia debe ser de al menos una hora.' });
  if (expiresAt.getTime() > Date.now() + 90 * 86400_000) return reply.code(400).send({ error: 'La vigencia no puede pasar de 90 días.' });
  const token = randomBytes(32).toString('base64url');
  const [enlace] = await sql`
    INSERT INTO routine_share_links (owner_id, client_id, routine_id, travel_id, token_hash, expires_at, created_by)
    VALUES (${auth.sub}, ${input.clientId}, ${id}, ${input.travelId ?? null}, ${hashToken(token)}, ${expiresAt}, ${auth.sub})
    RETURNING id, expires_at`;
  return reply.code(201).send({ id: enlace.id, url: new URL(`/#rutina=${token}`, config.APP_URL).toString(), expiresAt: enlace.expires_at, routineTitle: rutina.title });
});
app.get('/api/clients/:id/share-links', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [cliente] = await sql`SELECT id FROM clients WHERE id = ${id} AND owner_id = ${auth.sub}`;
  if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });
  return sql`
    SELECT l.id, l.routine_id, r.title AS routine_title, l.travel_id, l.expires_at, l.revoked_at, l.opens, l.last_opened_at, l.created_at,
      (l.revoked_at IS NULL AND l.expires_at > now()) AS active
    FROM routine_share_links l JOIN routines r ON r.id = l.routine_id
    WHERE l.client_id = ${id} ORDER BY l.created_at DESC LIMIT 20`;
});
app.delete('/api/share-links/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [enlace] = await sql`UPDATE routine_share_links SET revoked_at = now() WHERE id = ${id} AND owner_id = ${auth.sub} AND revoked_at IS NULL RETURNING id`;
  if (!enlace) return reply.code(404).send({ error: 'Enlace no encontrado o ya revocado' });
  return { revoked: true };
});

// Páginas públicas (sin sesión). Un límite sencillo por IP frena el sondeo de tokens; el token es de 256 bits, así que adivinarlo no es viable de todos modos.
const visitasPublicas = new Map<string, { n: number; desde: number }>();
function demasiadasVisitas(request: { ip: string }) {
  const ahora = Date.now(); const previo = visitasPublicas.get(request.ip);
  if (!previo || ahora - previo.desde > 60_000) { visitasPublicas.set(request.ip, { n: 1, desde: ahora }); return false; }
  previo.n += 1;
  if (visitasPublicas.size > 5000) visitasPublicas.clear();
  return previo.n > 90;
}
async function enlaceDeRutina(token: string) {
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(token)) return { estado: 'desconocido' as const };
  const [fila] = await sql`
    SELECT l.*, r.title, r.description, r.exercises, c.full_name, c.owner_id AS client_owner_id, c.portal_user_id, c.status AS client_status
    FROM routine_share_links l JOIN routines r ON r.id = l.routine_id JOIN clients c ON c.id = l.client_id
    WHERE l.token_hash = ${hashToken(token)}`;
  if (!fila) return { estado: 'desconocido' as const };
  if (fila.revoked_at) return { estado: 'revocado' as const };
  if (new Date(fila.expires_at as string).getTime() <= Date.now()) return { estado: 'expirado' as const };
  return { estado: 'ok' as const, fila };
}
const mensajeEnlace = { desconocido: 'Este enlace no existe.', revocado: 'Eileen retiró este enlace.', expirado: 'Este enlace ya venció. Pídele uno nuevo a Eileen.' };

// Ejercicios del catálogo que aparecen en la rutina (por id o por el slug antiguo), con la marca de si tienen video.
async function ejerciciosDeLaRutina(ownerId: string, ejercicios: unknown) {
  const lista = Array.isArray(ejercicios) ? ejercicios as Array<{ catalogId?: string }> : [];
  const ids = [...new Set(lista.map(item => String(item?.catalogId ?? '')).filter(Boolean))];
  if (!ids.length) return [];
  return sql`
    SELECT e.id, e.slug, e.name, e.english, e.section, e.level, e.machine, e.free_weight, e.cues,
      (EXISTS (SELECT 1 FROM exercise_videos ev WHERE ev.exercise_id = e.id) OR e.video_object_key IS NOT NULL) AS has_video
    FROM exercises e WHERE e.owner_id = ${ownerId} AND NOT e.archived AND (e.id::text = ANY(${ids}) OR e.slug = ANY(${ids}))`;
}

app.get('/api/public/routine/:token', async (request, reply) => {
  if (demasiadasVisitas(request)) return reply.code(429).send({ error: 'Demasiados intentos. Espera un minuto.' });
  const encontrado = await enlaceDeRutina(String((request.params as { token: string }).token));
  if (encontrado.estado !== 'ok') return reply.code(encontrado.estado === 'desconocido' ? 404 : 410).send({ error: mensajeEnlace[encontrado.estado] });
  const fila = encontrado.fila;
  await sql`UPDATE routine_share_links SET opens = opens + 1, last_opened_at = now() WHERE id = ${fila.id} AND (last_opened_at IS NULL OR last_opened_at < now() - interval '1 minute')`;
  const [hoyFila] = await sql`SELECT (now() AT TIME ZONE 'America/Panama')::date::text AS hoy`;
  const hoy = String(hoyFila.hoy);
  const [hecha] = await sql`SELECT 1 AS ok FROM routine_completions WHERE client_id = ${fila.client_id} AND routine_id = ${fila.routine_id} AND completed_on = ${hoy}::date AND completion_percent > 0`;
  // Las clases de su viaje que siguen por delante (o la de hoy): le dicen qué cuenta y cuándo.
  const clases = await sql`
    SELECT to_char(s.starts_at AT TIME ZONE 'America/Panama', 'YYYY-MM-DD') AS dia, to_char(s.starts_at AT TIME ZONE 'America/Panama', 'HH24:MI') AS hora, s.status
    FROM sessions s
    WHERE s.client_id = ${fila.client_id} AND s.status IN ('scheduled', 'completed')
      AND (s.starts_at AT TIME ZONE 'America/Panama')::date BETWEEN ${hoy}::date AND ${hoy}::date + 21
      AND EXISTS (SELECT 1 FROM client_travel t WHERE t.client_id = s.client_id
        AND (s.starts_at AT TIME ZONE 'America/Panama')::date BETWEEN t.starts_on AND COALESCE(t.ends_on, DATE '9999-12-31'))
    ORDER BY s.starts_at LIMIT 12`;
  return {
    clientFirstName: String(fila.full_name).trim().split(/\s+/)[0],
    expiresAt: fila.expires_at, today: hoy, completedToday: Boolean(hecha),
    routine: { title: fila.title, description: fila.description, exercises: fila.exercises },
    exercises: await ejerciciosDeLaRutina(String(fila.owner_id), fila.exercises),
    classes: clases
  };
});

app.get('/api/public/routine/:token/exercises/:exerciseId/video-urls', async (request, reply) => {
  if (demasiadasVisitas(request)) return reply.code(429).send({ error: 'Demasiados intentos. Espera un minuto.' });
  if (!storageReady) return reply.code(503).send({ error: 'El almacenamiento de video aún no está configurado' });
  const params = request.params as { token: string; exerciseId: string };
  const encontrado = await enlaceDeRutina(params.token);
  if (encontrado.estado !== 'ok') return reply.code(encontrado.estado === 'desconocido' ? 404 : 410).send({ error: mensajeEnlace[encontrado.estado] });
  const ejercicioId = z.string().uuid().parse(params.exerciseId);
  // Solo los ejercicios de ESTA rutina: el enlace no da acceso al resto del catálogo.
  const permitidos = await ejerciciosDeLaRutina(String(encontrado.fila.owner_id), encontrado.fila.exercises);
  if (!permitidos.some(item => item.id === ejercicioId)) return reply.code(404).send({ error: 'Ejercicio no encontrado en esta rutina' });
  const [ejercicio] = await sql`SELECT id, video_object_key, video_content_type, video_size_bytes, video_duration_seconds, video_uploaded_at FROM exercises WHERE id = ${ejercicioId}`;
  const variantes = await sql`SELECT id, label, content_type, size_bytes, duration_seconds, uploaded_at, object_key FROM exercise_videos WHERE exercise_id = ${ejercicioId} ORDER BY sort_order, created_at`;
  const filas = variantes.length ? variantes : ejercicio?.video_object_key
    ? [{ id: null, label: 'Demostración', content_type: ejercicio.video_content_type, size_bytes: ejercicio.video_size_bytes, duration_seconds: ejercicio.video_duration_seconds, uploaded_at: ejercicio.video_uploaded_at, object_key: ejercicio.video_object_key }] : [];
  if (!filas.length) return reply.code(404).send({ error: 'Este ejercicio todavía no tiene video' });
  return {
    exerciseId: ejercicioId,
    videos: await Promise.all(filas.map(async video => ({
      id: video.id, label: video.label, contentType: video.content_type, sizeBytes: video.size_bytes, durationSeconds: video.duration_seconds, uploadedAt: video.uploaded_at,
      videoUrl: await createDownloadUrl(video.object_key as string)
    }))),
    expiresInSeconds: 300
  };
});

app.post('/api/public/routine/:token/complete', async (request, reply) => {
  if (demasiadasVisitas(request)) return reply.code(429).send({ error: 'Demasiados intentos. Espera un minuto.' });
  const encontrado = await enlaceDeRutina(String((request.params as { token: string }).token));
  if (encontrado.estado !== 'ok') return reply.code(encontrado.estado === 'desconocido' ? 404 : 410).send({ error: mensajeEnlace[encontrado.estado] });
  const fila = encontrado.fila;
  const input = z.object({ completionPercent: z.coerce.number().int().min(1).max(100).default(100), durationSeconds: z.coerce.number().int().min(1).max(21600).optional() }).parse(request.body ?? {});
  const [hoyFila] = await sql`SELECT (now() AT TIME ZONE 'America/Panama')::date::text AS hoy`;
  const hoy = String(hoyFila.hoy);
  // Una confirmación por rutina y día: la segunda del mismo día solo actualiza el registro y no cierra otra clase.
  const [registro] = await sql`
    INSERT INTO routine_completions (routine_id, client_id, completed_on, completion_percent, marked_by_user_id, duration_seconds, via_link)
    VALUES (${fila.routine_id}, ${fila.client_id}, ${hoy}::date, ${input.completionPercent}, NULL, ${input.durationSeconds ?? null}, true)
    ON CONFLICT (routine_id, client_id, completed_on) DO UPDATE SET completion_percent = EXCLUDED.completion_percent, via_link = true,
      duration_seconds = COALESCE(EXCLUDED.duration_seconds, routine_completions.duration_seconds), updated_at = now()
    RETURNING (xmax = 0) AS nueva`;
  // En un día de viaje, confirmar la rutina cuenta como su clase de ESE día (J-107). Solo ese día: las clases de días anteriores ya se resolvieron.
  let claseCerrada: Record<string, unknown> | null = null;
  if (registro.nueva) {
    const [clase] = await sql`
      SELECT s.id FROM sessions s
      WHERE s.client_id = ${fila.client_id} AND s.status = 'scheduled' AND NOT COALESCE(s.paused_hold, false)
        AND (s.starts_at AT TIME ZONE 'America/Panama')::date = ${hoy}::date
        AND EXISTS (SELECT 1 FROM client_travel t WHERE t.client_id = s.client_id AND ${hoy}::date BETWEEN t.starts_on AND COALESCE(t.ends_on, DATE '9999-12-31'))
      ORDER BY s.starts_at LIMIT 1`;
    if (clase) {
      try { claseCerrada = await recordSessionCompliance(String(clase.id), String(fila.owner_id), String(fila.portal_user_id ?? fila.owner_id), 'completed', input.completionPercent, { permitirAnticipada: true }); }
      catch (error) { app.log.warn({ err: error, sessionId: clase.id }, 'La rutina por enlace se cumplió pero la clase no pudo marcarse como realizada'); }
    }
  }
  await avisarRutinaCumplida({ id: fila.client_id, owner_id: fila.owner_id, full_name: fila.full_name }, String(fila.title), input.completionPercent, input.durationSeconds ?? null, Boolean(claseCerrada));
  return { completed: true, sessionCompleted: Boolean(claseCerrada) };
});

// Dar por perdida una clase programada (J-104/J-107): es la consecuencia de "cancela el cliente y no reprograma": cuenta como incumplida y consume la clase del plan; a quien entrena
// a crédito no se le cobra nada solo (cobrar una cancelación la decide Eileen). Se usa para (a) la rutina ofrecida por cancelación del cliente que no se cumplió ese día y
// (b) la clase de un día de viaje sin rutina confirmada. Devuelve true si la clase seguía programada y se cerró.
async function cancelarComoPerdidaPorElCliente(sessionId: string, despues?: (transaction: typeof sql) => Promise<void>) {
  return sql.begin(async transaction => {
    const [actual] = await transaction`
      SELECT s.*, c.payment_mode FROM sessions s JOIN clients c ON c.id = s.client_id
      WHERE s.id = ${sessionId} AND s.status = 'scheduled' FOR UPDATE`;
    if (!actual) return false;
    const esCredito = actual.payment_mode === 'no_anticipado';
    await transaction`
      UPDATE sessions SET status = 'cancelled', cancellation_kind = 'not_rescheduled', cancelled_by = 'client',
        cancellation_resolution = ${esCredito ? 'none' : 'debit'}, credit_charge = false, updated_at = now()
      WHERE id = ${sessionId}`;
    if (!esCredito && !actual.package_debited) {
      const pack = await seleccionarSaldoParaSesion(transaction, actual.client_id as string, actual.starts_at as Date | string);
      if (pack) {
        const siguiente = Number(pack.used_sessions) + 1;
        await transaction`UPDATE session_packages SET used_sessions = ${siguiente}, status = CASE WHEN ${siguiente} >= total_sessions THEN 'exhausted' ELSE 'active' END WHERE id = ${pack.id}`;
        await transaction`UPDATE sessions SET package_id = ${pack.id}, package_debited = true, debited_group_id = ${actual.client_id}, updated_at = now() WHERE id = ${sessionId}`;
      }
    }
    if (despues) await despues(transaction as unknown as typeof sql);
    return true;
  });
}

// Ofertas de rutina por cancelación DEL CLIENTE cuyo día ya pasó sin cumplirse: la clase se da por perdida. Las ofertas por cancelación de Eileen NO vencen así: el cliente no tiene
// la culpa y la clase queda pendiente para que ella decida.
async function darPorPerdidasClasesConRutinaVencida(ownerId?: string) {
  const vencidas = await sql`
    SELECT o.id AS offer_id, o.session_id
    FROM session_routine_offers o JOIN sessions s ON s.id = o.session_id JOIN clients c ON c.id = s.client_id
    WHERE o.origin = 'client' AND o.status = 'offered' AND s.status = 'scheduled'
      AND (s.starts_at AT TIME ZONE 'America/Panama')::date < (now() AT TIME ZONE 'America/Panama')::date
      AND (${ownerId ?? null}::uuid IS NULL OR c.owner_id = ${ownerId ?? null}::uuid)`;
  let perdidas = 0;
  for (const fila of vencidas) {
    try {
      const cerrada = await cancelarComoPerdidaPorElCliente(String(fila.session_id), async transaction => {
        await transaction`UPDATE session_routine_offers SET status = 'expired' WHERE id = ${fila.offer_id}`;
        await transaction`UPDATE sessions SET cancellation_reason = 'Cancelación del cliente: no cumplió la rutina que se le ofreció en lugar de la clase.' WHERE id = ${fila.session_id}`;
      });
      if (cerrada) perdidas += 1;
    } catch (error) { app.log.warn({ err: error, sessionId: fila.session_id }, 'No se pudo dar por perdida una clase con rutina vencida'); }
  }
  return perdidas;
}

// Clases de un día de VIAJE sin rutina confirmada ese día: se CANCELAN SOLAS como cancelación del cliente (J-107/J-108). El viaje no pausa el plan ni el cobro; lo que el cliente puede
// hacer para que la clase cuente es aceptar y confirmar la rutina que Eileen le manda por enlace. Si no hay acción (no se le envió rutina, no la aceptó o no la confirmó), la clase se
// cancela al terminar su día, y la cancelación queda JUSTIFICADA con el viaje (cancelled_travel_id + cancellation_reason). Salvaguarda: nunca hacia atrás — solo clases de días desde que se
// registró el viaje, para que registrar un viaje tarde no cancele clases ya pasadas.
async function darPorPerdidasClasesDeViajeSinRutina(ownerId?: string) {
  const candidatas = await sql`
    SELECT DISTINCT ON (s.id) s.id AS session_id, t.id AS travel_id,
      to_char(t.starts_on, 'DD-MM-YYYY') AS desde, to_char(t.ends_on, 'DD-MM-YYYY') AS hasta, t.destination
    FROM sessions s
    JOIN clients c ON c.id = s.client_id
    JOIN client_travel t ON t.client_id = s.client_id
      AND (s.starts_at AT TIME ZONE 'America/Panama')::date BETWEEN t.starts_on AND COALESCE(t.ends_on, DATE '9999-12-31')
      AND (s.starts_at AT TIME ZONE 'America/Panama')::date >= (t.created_at AT TIME ZONE 'America/Panama')::date
    WHERE s.status = 'scheduled' AND NOT COALESCE(s.paused_hold, false) AND c.status = 'active'
      AND (s.starts_at AT TIME ZONE 'America/Panama')::date < (now() AT TIME ZONE 'America/Panama')::date
      AND (${ownerId ?? null}::uuid IS NULL OR c.owner_id = ${ownerId ?? null}::uuid)
      AND NOT EXISTS (
        SELECT 1 FROM routine_completions rc
        WHERE rc.client_id = s.client_id AND rc.via_link AND rc.completion_percent > 0
          AND rc.completed_on = (s.starts_at AT TIME ZONE 'America/Panama')::date)
    ORDER BY s.id, t.starts_on`;
  let perdidas = 0;
  for (const fila of candidatas) {
    try {
      const razon = `Cancelación del cliente: de viaje del ${fila.desde} ${fila.hasta ? `al ${fila.hasta}` : '(regreso sin definir)'}${fila.destination ? ` · ${fila.destination}` : ''}. No confirmó una rutina ese día.`;
      const cerrada = await cancelarComoPerdidaPorElCliente(String(fila.session_id), async transaction => {
        await transaction`
          UPDATE sessions SET cancelled_travel_id = ${fila.travel_id}, cancellation_reason = ${razon},
            notes = CASE WHEN COALESCE(notes, '') LIKE '%Cancelada automáticamente por viaje del cliente%' THEN notes ELSE COALESCE(notes || E'\n', '') || 'Cancelada automáticamente por viaje del cliente.' END
          WHERE id = ${fila.session_id}`;
      });
      if (cerrada) perdidas += 1;
    } catch (error) { app.log.warn({ err: error, sessionId: fila.session_id }, 'No se pudo cancelar una clase de viaje sin rutina'); }
  }
  return perdidas;
}
async function vigilarClasesSinCumplir(ownerId?: string) {
  const [rutinaVencida, viaje] = await Promise.all([darPorPerdidasClasesConRutinaVencida(ownerId), darPorPerdidasClasesDeViajeSinRutina(ownerId)]);
  return { perdidas: rutinaVencida + viaje, porRutinaVencida: rutinaVencida, porViaje: viaje };
}
app.post('/api/maintenance/vencer-ofertas-rutina', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return vigilarClasesSinCumplir(auth.sub);
});
const primeraVigilanciaRutinas = setTimeout(() => vigilarClasesSinCumplir().catch(error => app.log.error(error)), 30_000);
const vigilanciaRutinas = setInterval(() => vigilarClasesSinCumplir().catch(error => app.log.error(error)), 15 * 60_000);
primeraVigilanciaRutinas.unref();
vigilanciaRutinas.unref();
const primeraExtension = setTimeout(() => extenderRecurrencias().catch(error => app.log.error(error)), 20_000);
const extensionRecurrencias = setInterval(() => extenderRecurrencias().catch(error => app.log.error(error)), 6 * 60 * 60_000);
primeraExtension.unref();
extensionRecurrencias.unref();
// Un paquete de clases vive 6 semanas. Pasado el tope, lo que no se tomó se
// pierde: se marca 'expired' para que esas clases dejen de contar en el saldo
// (agendar ya las excluía por fecha; esto alinea el número que se ve). Sólo
// paquetes —la mensualidad tiene su propio ciclo—. Corre al arrancar y a diario.
async function expirarPaquetesVencidos() {
  await sql`
    UPDATE session_packages SET status = 'expired'
    WHERE kind = 'package' AND status = 'active'
      AND expires_on IS NOT NULL AND expires_on < current_date`;
}
const primeraExpiracion = setTimeout(() => expirarPaquetesVencidos().catch(error => app.log.error(error)), 25_000);
const expiracionPaquetes = setInterval(() => expirarPaquetesVencidos().catch(error => app.log.error(error)), 24 * 60 * 60_000);
primeraExpiracion.unref();
expiracionPaquetes.unref();

// Reconciliación diaria: recupera las clases realizadas que quedaron sin
// descontar. Una clase marcada cuando aún no había un saldo activo que la
// recibiera se completaba sin mover el saldo, y nadie la recogía después. Esto
// pasa una vez al día por cada saldo activo con cupo y descuenta las clases de
// SU ventana que sigan sin descontar, hasta llenar su cupo. Es la misma lógica
// que corre al renovar (cobrarClasesYaDadas), sólo que proactiva: así el "marqué
// la clase y el saldo no bajó" se cura solo en menos de 24 h. No toca el pasado
// cerrado (sólo la ventana del propio saldo) ni gasta más de lo que el saldo
// tiene.
async function reconciliarSaldos(ownerId?: string) {
  const saldos = await sql`
    SELECT sp.id, sp.client_id, sp.expires_on, sp.total_sessions, sp.used_sessions
    FROM session_packages sp JOIN clients c ON c.id = sp.client_id
    WHERE sp.status = 'active' AND sp.used_sessions < sp.total_sessions AND sp.expires_on IS NOT NULL
      AND (${ownerId ?? null}::uuid IS NULL OR c.owner_id = ${ownerId ?? null}::uuid)
    ORDER BY sp.expires_on ASC`;
  let descontadas = 0;
  for (const saldo of saldos) {
    descontadas += await sql.begin(async transaction => {
      await lockBillingClient(transaction, saldo.client_id as string);
      const [actual] = await transaction`
        SELECT id, client_id, expires_on, total_sessions, used_sessions
        FROM session_packages
        WHERE id = ${saldo.id} AND status = 'active' AND used_sessions < total_sessions
        FOR UPDATE
      `;
      if (!actual) return 0;
      const cupo = Number(actual.total_sessions) - Number(actual.used_sessions);
      if (cupo <= 0) return 0;
      return cobrarClasesYaDadas(transaction, actual.id as string, actual.client_id as string, soloFecha(actual.expires_on)!, cupo);
    });
  }
  return descontadas;
}
const primeraReconciliacion = setTimeout(() => reconciliarSaldos().catch(error => app.log.error(error)), 30_000);
const reconciliacionSaldos = setInterval(() => reconciliarSaldos().catch(error => app.log.error(error)), 24 * 60 * 60_000);
primeraReconciliacion.unref();
reconciliacionSaldos.unref();
firstReminderRun.unref();
reminderInterval.unref();
firstBillingRun.unref();
billingInterval.unref();

app.addHook('onClose', async () => {
  clearTimeout(firstReminderRun);
  clearInterval(reminderInterval);
  clearTimeout(firstBillingRun);
  clearInterval(billingInterval);
  clearTimeout(firstNewBillingRun);
  clearInterval(newBillingInterval);
  await sql.end();
});
await app.listen({ port: config.PORT, host: '::' });
