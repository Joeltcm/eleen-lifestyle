import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import webpush from 'web-push';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import { sql } from './db.js';
import { createDownloadUrl, createUploadUrl, deleteObject, downloadObject, storageReady, uploadObject, verifyUpload } from './storage.js';
import { extractInBodyDocument, extractInBodyImage, inbodyAnalysisReady, inbodyAnalysisSetup, prepareInBodyImage, validateExtraction, validateInBodyValues } from './inbody-analysis.js';
import { registerZohoRoutes } from './zoho-routes.js';
import { cancelSessionInGoogle, registerGoogleCalendarRoutes, syncSessionToGoogle } from './google-calendar.js';
import { accountStatementPdf, accountsReceivablePdf, invoicePdf } from './billing-reports.js';

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
  credentials: true
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
          WHERE i.client_id = s.client_id AND i.status <> 'void'
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
      SELECT c.id AS client_id, c.owner_id, c.standard_price AS amount,
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
      WHERE s.due_on <= current_date + (${config.BILLING_GENERATION_DAYS_AHEAD})::integer
        AND EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.client_id = s.client_id AND m.status = 'active' AND m.starts_on <= s.due_on
            AND (m.ends_on IS NULL OR m.ends_on >= s.billing_period)
        )
        AND NOT EXISTS (
          SELECT 1 FROM invoices i
          WHERE i.client_id = s.client_id AND i.status <> 'void'
            AND date_trunc('month', COALESCE(i.billing_period, i.issued_on, i.due_on))::date = s.billing_period
            AND (
              i.auto_generated = true OR i.source_system = 'zoho_invoice'
              OR (i.package_id IS NULL AND i.amount = s.amount)
              OR lower(i.concept) LIKE '%mensual%'
            )
        )
    )
    INSERT INTO invoices (
      client_id, concept, amount, due_on, issued_on, subtotal,
      billing_period, auto_generated
    )
    SELECT client_id, plan_name || ' · ' || to_char(billing_period, 'MM/YYYY'), amount, due_on,
      current_date, amount, billing_period, true
    FROM candidates
    ON CONFLICT (client_id, billing_period) WHERE auto_generated = true DO NOTHING
    RETURNING id, client_id, billing_period, due_on, amount
  `;
  return { generated: invoices.length, invoices };
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
  return { ...(await recurringBillingStatus(auth.sub)), generated: result.generated };
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
app.post('/api/auth/setup', async (request, reply) => {
  if (request.headers['x-setup-token'] !== config.SETUP_TOKEN) return reply.code(403).send({ error: 'Token de configuración inválido' });
  const [{ count }] = await sql`SELECT count(*)::integer AS count FROM users`;
  if (count > 0) return reply.code(409).send({ error: 'La cuenta administradora ya fue creada' });
  const input = setupSchema.parse(request.body);
  const passwordHash = await bcrypt.hash(input.password, 12);
  const [user] = await sql`
    INSERT INTO users (email, password_hash, full_name, role)
    VALUES (${input.email.toLowerCase()}, ${passwordHash}, ${input.fullName}, 'admin')
    RETURNING id, email, full_name, role
  `;
  const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role }, { expiresIn: '12h' });
  return reply.code(201).send({ user, token });
});

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
app.post('/api/auth/login', async (request, reply) => {
  const input = loginSchema.parse(request.body);
  const [user] = await sql`SELECT id, email, full_name, role, password_hash, active FROM users WHERE email = ${input.email.toLowerCase()}`;
  if (!user || !user.active || !(await bcrypt.compare(input.password, user.password_hash))) return reply.code(401).send({ error: 'Correo o contraseña incorrectos' });
  const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role }, { expiresIn: '12h' });
  return { user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role }, token };
});

const resetPasswordSchema = z.object({ email: z.string().email(), password: z.string().min(10) });
app.post('/api/auth/reset-password', async (request, reply) => {
  if (request.headers['x-setup-token'] !== config.SETUP_TOKEN) return reply.code(403).send({ error: 'Token de recuperación inválido' });
  const input = resetPasswordSchema.parse(request.body);
  const passwordHash = await bcrypt.hash(input.password, 12);
  const [user] = await sql`
    UPDATE users SET email = ${input.email.toLowerCase()}, password_hash = ${passwordHash}, updated_at = now()
    WHERE id = (SELECT id FROM users WHERE role = 'admin' AND active = true ORDER BY created_at LIMIT 1)
    RETURNING id, email, full_name, role
  `;
  if (!user) return reply.code(404).send({ error: 'No existe una cuenta administradora activa' });
  const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role }, { expiresIn: '12h' });
  return { user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role }, token };
});

app.get('/api/me', { preHandler: requireAuth }, async request => {
  const auth = request.user as AuthUser;
  const [user] = await sql`SELECT id, email, full_name, role FROM users WHERE id = ${auth.sub}`;
  return { user };
});

const planSchema = z.object({
  name: z.string().trim().min(2).max(80), description: z.string().trim().max(240).optional(),
  billingModel: z.enum(['monthly', 'package']), price: z.coerce.number().min(0),
  sessionsIncluded: z.coerce.number().int().positive().optional(), validityDays: z.coerce.number().int().positive().optional(),
  active: z.boolean().default(true)
}).superRefine((plan, context) => {
  if (plan.billingModel === 'package' && !plan.sessionsIncluded) context.addIssue({ code: 'custom', path: ['sessionsIncluded'], message: 'Indica la cantidad de sesiones' });
});

app.get('/api/plans', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`SELECT * FROM service_plans WHERE owner_id = ${auth.sub} ORDER BY active DESC, name`;
});

app.post('/api/plans', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const input = planSchema.parse(request.body);
  const [plan] = await sql`
    INSERT INTO service_plans (owner_id, name, description, billing_model, price, sessions_included, validity_days, active)
    VALUES (${auth.sub}, ${input.name}, ${input.description || null}, ${input.billingModel}, ${input.price}, ${input.billingModel === 'package' ? input.sessionsIncluded! : null}, ${input.billingModel === 'package' ? input.validityDays || 30 : null}, ${input.active})
    RETURNING *
  `;
  return reply.code(201).send(plan);
});

app.patch('/api/plans/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id); const input = planSchema.parse(request.body);
  const [plan] = await sql`
    UPDATE service_plans SET name = ${input.name}, description = ${input.description || null}, billing_model = ${input.billingModel},
      price = ${input.price}, sessions_included = ${input.billingModel === 'package' ? input.sessionsIncluded! : null},
      validity_days = ${input.billingModel === 'package' ? input.validityDays || 30 : null}, active = ${input.active}, updated_at = now()
    WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING *
  `;
  if (!plan) return reply.code(404).send({ error: 'Plan no encontrado' });
  return plan;
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
  goal: z.string().optional(), notes: z.string().optional(), billingModel: z.enum(['monthly', 'package']).default('monthly'),
  standardPrice: z.coerce.number().min(0).default(0), packageSessions: z.coerce.number().int().positive().optional(),
  planId: z.string().uuid().optional(), cutoffDay: z.coerce.number().int().min(1).max(31).default(1),
  // Vacío llega como '' desde el formulario y significa "sin meta pactada".
  monthlySessionTarget: z.union([z.literal(''), z.null(), z.coerce.number().int().min(1).max(31)]).optional()
    .transform(value => (value === '' || value === undefined ? null : value))
});
app.get('/api/clients', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`
    SELECT c.*, p.name AS plan_name, p.sessions_included, p.validity_days,
      COALESCE((SELECT sum(total_sessions - used_sessions) FROM session_packages sp WHERE sp.client_id = c.id AND sp.status = 'active'), 0)::integer AS available_sessions
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
  const input = clientSchema.pick({ fullName: true, email: true, phone: true, goal: true, notes: true, monthlySessionTarget: true }).parse(request.body);
  const [client] = await sql`UPDATE clients SET full_name = ${input.fullName}, email = ${input.email || null}, phone = ${input.phone || null}, goal = ${input.goal || null}, notes = ${input.notes || null}, monthly_session_target = ${input.monthlySessionTarget ?? null}, updated_at = now() WHERE id = ${id} AND owner_id = ${auth.sub} RETURNING *`;
  if (!client) return reply.code(404).send({ error: 'Cliente no encontrado' });
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
      await transaction`
        INSERT INTO memberships (client_id, amount, renewal_day)
        SELECT ${id}, ${plan.price}, ${input.cutoffDay}
        WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE client_id = ${id} AND status = 'active')
      `;
      await transaction`UPDATE memberships SET amount = ${plan.price}, renewal_day = ${input.cutoffDay}, status = 'active' WHERE client_id = ${id} AND status = 'active'`;
    } else {
      await transaction`UPDATE memberships SET status = 'paused' WHERE client_id = ${id} AND status = 'active'`;
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

const packageSchema = z.object({ clientId: z.string().uuid(), totalSessions: z.coerce.number().int().positive(), amount: z.coerce.number().positive(), expiresOn: z.string().date().optional() });
app.get('/api/packages', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`SELECT p.*, c.full_name FROM session_packages p JOIN clients c ON c.id = p.client_id WHERE c.owner_id = ${auth.sub} ORDER BY p.created_at DESC`;
});
app.post('/api/packages', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const input = packageSchema.parse(request.body);
  const [client] = await sql`SELECT id FROM clients WHERE id = ${input.clientId} AND owner_id = ${auth.sub}`;
  if (!client) return reply.code(404).send({ error: 'Cliente no encontrado' });
  const pack = await sql.begin(async transaction => {
    const [created] = await transaction`INSERT INTO session_packages (client_id, label, total_sessions, amount, expires_on) VALUES (${input.clientId}, ${`Paquete ${input.totalSessions} sesiones`}, ${input.totalSessions}, ${input.amount}, ${input.expiresOn || null}) RETURNING *`;
    const [invoice] = await transaction`INSERT INTO invoices (client_id, package_id, concept, amount, due_on) VALUES (${input.clientId}, ${created.id}, 'Paquete de sesiones', ${input.amount}, current_date) RETURNING id`;
    return { ...created, invoice_id: invoice.id };
  });
  return reply.code(201).send(pack);
});

const routineExerciseSchema = z.object({
  catalogId: z.string().max(80).optional(), name: z.string().min(1).max(120), english: z.string().max(120).optional(),
  category: z.string().max(80).optional(), level: z.string().max(40).optional(), machine: z.string().max(180).optional(),
  freeWeight: z.string().max(180).optional(), sets: z.coerce.number().int().min(1).max(20).optional(), reps: z.string().max(40).optional(), notes: z.string().max(300).optional()
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
  archived, sort_order, video_content_type, video_size_bytes, video_duration_seconds,
  video_uploaded_at, (video_object_key IS NOT NULL) AS has_video
`;

app.get('/api/exercises', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const query = z.object({ section: z.enum(exerciseSections).optional(), includeArchived: z.coerce.boolean().default(false) }).parse(request.query);
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
    INSERT INTO exercises (owner_id, slug, name, english, section, pattern, level, machine, free_weight, cues)
    VALUES (${auth.sub}, ${slugFrom(input.name)}, ${input.name}, ${input.english || null}, ${input.section},
            ${input.pattern || null}, ${input.level}, ${input.machine || null}, ${input.freeWeight || null}, ${input.cues || null})
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

const sessionSchema = z.object({ clientId: z.string().uuid(), routineId: z.string().uuid().optional(), startsAt: z.string().datetime(), durationMinutes: z.coerce.number().int().positive().default(60), mode: z.string().default('Presencial'), notes: z.string().optional() });
app.get('/api/sessions', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`SELECT s.*, c.full_name, r.title AS routine_title FROM sessions s JOIN clients c ON c.id = s.client_id LEFT JOIN routines r ON r.id = s.routine_id WHERE c.owner_id = ${auth.sub} ORDER BY s.starts_at`;
});
app.post('/api/sessions', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const input = sessionSchema.parse(request.body);
  const [session] = await sql`INSERT INTO sessions (client_id, routine_id, starts_at, duration_minutes, mode, notes) SELECT c.id, ${input.routineId || null}, ${input.startsAt}, ${input.durationMinutes}, ${input.mode}, ${input.notes || null} FROM clients c WHERE c.id = ${input.clientId} AND c.owner_id = ${auth.sub} RETURNING *`;
  if (!session) return reply.code(404).send({ error: 'Cliente no encontrado' });
  try { await syncSessionToGoogle(auth.sub, session.id); }
  catch (error) { app.log.warn({ err: error, sessionId: session.id }, 'Session created but Google Calendar sync failed'); }
  return reply.code(201).send(session);
});
const sessionScheduleSchema = z.object({
  startsAt: z.string().datetime(),
  durationMinutes: z.coerce.number().int().min(15).max(480),
  mode: z.string().trim().min(2).max(60),
  notes: z.string().trim().max(1000).optional()
});
app.patch('/api/sessions/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const input = sessionScheduleSchema.parse(request.body);
  const [session] = await sql`
    UPDATE sessions s SET starts_at = ${input.startsAt}, duration_minutes = ${input.durationMinutes},
      mode = ${input.mode}, notes = ${input.notes || null}, google_sync_error = NULL, updated_at = now()
    FROM clients c
    WHERE s.id = ${id} AND c.id = s.client_id AND c.owner_id = ${auth.sub} AND s.status <> 'cancelled'
    RETURNING s.*
  `;
  if (!session) return reply.code(404).send({ error: 'Sesión no encontrada o cancelada' });
  try { await syncSessionToGoogle(auth.sub, session.id); }
  catch (error) { app.log.warn({ err: error, sessionId: session.id }, 'Session updated but Google Calendar sync failed'); }
  const [updated] = await sql`SELECT * FROM sessions WHERE id = ${session.id}`;
  return updated;
});

app.delete('/api/sessions/:id', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser;
  const id = z.string().uuid().parse((request.params as { id: string }).id);
  const [session] = await sql`UPDATE sessions s SET status = 'cancelled', updated_at = now() FROM clients c WHERE s.id = ${id} AND c.id = s.client_id AND c.owner_id = ${auth.sub} AND s.status <> 'cancelled' RETURNING s.*`;
  if (!session) return reply.code(404).send({ error: 'Sesión no encontrada o ya cancelada' });
  try { await cancelSessionInGoogle(auth.sub, id); }
  catch (error) { app.log.warn({ err: error, sessionId: id }, 'Session cancelled but Google Calendar deletion failed'); }
  return { cancelled: true, session };
});
async function recordSessionCompliance(id: string, ownerId: string, markedBy: string, completed: boolean, completionPercent: number) {
  return sql.begin(async transaction => {
    const [current] = await transaction`SELECT s.* FROM sessions s JOIN clients c ON c.id = s.client_id WHERE s.id = ${id} AND c.owner_id = ${ownerId} FOR UPDATE`;
    if (!current) return null;
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
      const [pack] = await transaction`SELECT * FROM session_packages WHERE client_id = ${current.client_id} AND status = 'active' AND used_sessions < total_sessions ORDER BY purchased_on LIMIT 1 FOR UPDATE`;
      if (!pack) {
        const [updated] = await transaction`
          UPDATE sessions SET status = 'completed', completion_percent = ${completionPercent}, completed_by_user_id = ${markedBy}, completion_recorded_at = now(), updated_at = now()
          WHERE id = ${id} RETURNING *
        `;
        return updated;
      }
      const nextUsed = pack.used_sessions + 1;
      await transaction`UPDATE session_packages SET used_sessions = ${nextUsed}, status = ${nextUsed >= pack.total_sessions ? 'exhausted' : 'active'} WHERE id = ${pack.id}`;
      const [updated] = await transaction`
        UPDATE sessions SET status = 'completed', completion_percent = ${completionPercent}, package_id = ${pack.id}, package_debited = true,
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
  const session = await recordSessionCompliance(id, auth.sub, auth.sub, true, 100);
  if (!session) return reply.code(404).send({ error: 'Sesión no encontrada' }); return session;
});

const sessionComplianceSchema = z.object({ completed: z.boolean(), completionPercent: z.coerce.number().int().min(0).max(100) });
app.patch('/api/sessions/:id/compliance', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id); const input = sessionComplianceSchema.parse(request.body);
  const session = await recordSessionCompliance(id, auth.sub, auth.sub, input.completed, input.completed ? input.completionPercent : 0);
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
  for (const sessionId of result.created) await recordSessionCompliance(sessionId, auth.sub, auth.sub, true, 100);

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
  return sql`SELECT i.*, c.full_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE c.owner_id = ${auth.sub} ORDER BY i.created_at DESC`;
});
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
app.post('/api/invoices', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const input = invoiceSchema.parse(request.body);
  const [invoice] = await sql`INSERT INTO invoices (client_id, package_id, concept, amount, due_on) SELECT c.id, ${input.packageId || null}, ${input.concept}, ${input.amount}, ${input.dueOn} FROM clients c WHERE c.id = ${input.clientId} AND c.owner_id = ${auth.sub} RETURNING *`;
  if (!invoice) return reply.code(404).send({ error: 'Cliente no encontrado' }); return reply.code(201).send(invoice);
});
const invoiceEditSchema = z.object({ concept: z.string().min(2).max(180), amount: z.coerce.number().min(0), dueOn: z.string().date() });
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

async function complianceRows(ownerId: string, period: z.infer<typeof reportPeriodSchema>, clientId?: string) {
  const start = reportStart(period);
  return sql`
    WITH activities AS (
      SELECT c.id AS client_id, c.full_name, s.starts_at AS occurred_at, 'Sesión'::text AS source,
        COALESCE(r.title, CASE WHEN s.quick_logged THEN 'Entrenamiento presencial' ELSE 'Evaluación / seguimiento' END) AS activity,
        s.status, s.completion_percent, false AS late
      FROM sessions s JOIN clients c ON c.id = s.client_id LEFT JOIN routines r ON r.id = s.routine_id
      WHERE c.owner_id = ${ownerId} AND s.starts_at >= ${start} AND s.starts_at <= now() AND s.status <> 'cancelled'
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
  return [
    ...sessions.map(session => ({ type: 'session', title: `Sesión con ${session.full_name}`, body: new Date(session.starts_at).toLocaleString('es-PA', { timeZone: 'America/Panama' }), scheduledFor: session.starts_at })),
    ...invoices.map(invoice => ({ type: 'payment', title: `Pago de ${invoice.full_name}`, body: `${invoice.concept}: $${Number(invoice.amount).toFixed(2)} · vence ${invoice.due_on}.`, scheduledFor: invoice.due_on }))
  ];
});

type ReminderCandidate = {
  user_id: string;
  kind: 'session' | 'payment';
  reference_id: string;
  role: AuthUser['role'];
  full_name: string;
  starts_at?: string;
  due_on?: string;
  amount?: number | string;
  concept?: string;
};

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

  for (const reminder of [...sessionRows, ...paymentRows]) {
    const [reserved] = await sql`
      INSERT INTO notification_deliveries (user_id, kind, reference_id)
      VALUES (${reminder.user_id}, ${reminder.kind}, ${reminder.reference_id})
      ON CONFLICT DO NOTHING RETURNING user_id
    `;
    if (!reserved) continue;
    const isClient = reminder.role === 'client';
    const payload = reminder.kind === 'session'
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
    sql`SELECT s.id, s.starts_at, s.duration_minutes, (s.client_id = ${client.id}) AS is_mine FROM sessions s JOIN clients c ON c.id = s.client_id WHERE c.owner_id = ${client.owner_id} AND s.status <> 'cancelled' AND s.starts_at BETWEEN now() AND now() + interval '90 days' ORDER BY s.starts_at`,
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
  const session = await recordSessionCompliance(id, client.owner_id, auth.sub, input.completed, input.completed ? input.completionPercent : 0);
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
