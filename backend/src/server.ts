import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import webpush from 'web-push';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import { sql } from './db.js';
import { createDownloadUrl, createUploadUrl, downloadObject, storageReady, uploadObject, verifyUpload } from './storage.js';
import { extractInBodyDocument, extractInBodyImage, inbodyAnalysisReady, prepareInBodyImage, validateExtraction, validateInBodyValues } from './inbody-analysis.js';
import { registerZohoRoutes } from './zoho-routes.js';
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
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
  credentials: true
});
await app.register(jwt, { secret: config.JWT_SECRET });
await registerZohoRoutes(app);

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

app.get('/health', async () => {
  const [database] = await sql`SELECT now() AS time`;
  return {
    status: 'ok', service: 'eileen-lifestyle-api', databaseTime: database.time,
    documentStorage: storageReady ? 'ready' : 'configuration_required',
    inbodyAnalysis: inbodyAnalysisReady ? 'configured' : 'configuration_required',
    webPush: webPushReady ? 'configured' : 'configuration_required'
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

const clientSchema = z.object({
  fullName: z.string().min(2), email: z.string().email().optional().or(z.literal('')), phone: z.string().optional(),
  goal: z.string().optional(), notes: z.string().optional(), billingModel: z.enum(['monthly', 'package']).default('monthly'),
  standardPrice: z.coerce.number().min(0).default(0), packageSessions: z.coerce.number().int().positive().optional(),
  planId: z.string().uuid().optional(), cutoffDay: z.coerce.number().int().min(1).max(31).default(1)
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
const routineSchema = z.object({ title: z.string().min(2), description: z.string().optional(), sessionsPerWeek: z.coerce.number().int().min(1).max(7), exercises: z.array(routineExerciseSchema).max(80).default([]), clientId: z.string().uuid().optional() });
app.get('/api/routines', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`SELECT * FROM routines WHERE owner_id = ${auth.sub} ORDER BY created_at DESC`;
});
app.post('/api/routines', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const input = routineSchema.parse(request.body);
  const routine = await sql.begin(async transaction => {
    const [created] = await transaction`INSERT INTO routines (owner_id, title, description, sessions_per_week, exercises) VALUES (${auth.sub}, ${input.title}, ${input.description || null}, ${input.sessionsPerWeek}, ${transaction.json(input.exercises)}) RETURNING *`;
    if (input.clientId) await transaction`INSERT INTO routine_assignments (routine_id, client_id) SELECT ${created.id}, id FROM clients WHERE id = ${input.clientId} AND owner_id = ${auth.sub}`;
    return created;
  });
  return reply.code(201).send(routine);
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
  return reply.code(201).send(session);
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
const confirmSchema = z.object({ method: z.enum(['Efectivo', 'Yappy', 'Transferencia bancaria', 'Tarjeta', 'Otro']), reference: z.string().optional() });
app.post('/api/invoices/:id/confirm', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id); const input = confirmSchema.parse(request.body);
  const [invoice] = await sql`UPDATE invoices i SET status = 'confirmed', payment_method = ${input.method}, payment_reference = ${input.reference || null}, confirmed_at = now() FROM clients c WHERE i.id = ${id} AND c.id = i.client_id AND c.owner_id = ${auth.sub} RETURNING i.*`;
  if (!invoice) return reply.code(404).send({ error: 'Cobro no encontrado' });
  if (invoice.package_id) await sql`UPDATE session_packages SET status = 'active' WHERE id = ${invoice.package_id} AND status = 'pending'`;
  return invoice;
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
        COALESCE(r.title, 'Evaluación / seguimiento') AS activity, s.status, s.completion_percent
      FROM sessions s JOIN clients c ON c.id = s.client_id LEFT JOIN routines r ON r.id = s.routine_id
      WHERE c.owner_id = ${ownerId} AND s.starts_at >= ${start} AND s.starts_at <= now() AND s.status <> 'cancelled'
      UNION ALL
      SELECT c.id AS client_id, c.full_name, rc.completed_on::timestamptz AS occurred_at, 'Rutina'::text AS source,
        r.title AS activity, 'completed'::text AS status, rc.completion_percent
      FROM routine_completions rc JOIN clients c ON c.id = rc.client_id JOIN routines r ON r.id = rc.routine_id
      WHERE c.owner_id = ${ownerId} AND rc.completed_on >= ${start}::date AND rc.completed_on <= current_date
    )
    SELECT * FROM activities WHERE (${clientId || null}::uuid IS NULL OR client_id = ${clientId || null}) ORDER BY occurred_at DESC, full_name
  `;
}

app.get('/api/compliance/summary', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser; const query = z.object({ period: reportPeriodSchema.default('week') }).parse(request.query);
  const rows = await complianceRows(auth.sub, query.period);
  const clients = new Map<string, { clientId: string; name: string; total: number; sum: number; completed: number }>();
  for (const row of rows) {
    const current = clients.get(row.client_id) || { clientId: row.client_id, name: row.full_name, total: 0, sum: 0, completed: 0 };
    current.total += 1; current.sum += Number(row.completion_percent); if (Number(row.completion_percent) > 0) current.completed += 1;
    clients.set(row.client_id, current);
  }
  const clientSummaries = [...clients.values()].map(item => ({
    clientId: item.clientId, name: item.name, activities: item.total, completed: item.completed,
    compliancePercent: item.total ? Math.round(item.sum / item.total) : 0
  })).sort((a, b) => b.compliancePercent - a.compliancePercent || a.name.localeCompare(b.name));
  return {
    period: query.period, activities: rows.length,
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
  const [invoices, routines, sessions, busySlots, assessments, completions] = await Promise.all([
    sql`SELECT id, concept, amount, balance, currency, due_on, status, payment_method, invoice_number, issued_on FROM invoices WHERE client_id = ${client.id} ORDER BY COALESCE(issued_on, due_on) DESC LIMIT 60`,
    sql`SELECT ra.id AS assignment_id, r.id, r.title, r.description, r.sessions_per_week, r.exercises FROM routine_assignments ra JOIN routines r ON r.id = ra.routine_id WHERE ra.client_id = ${client.id} AND ra.active = true AND (ra.ends_on IS NULL OR ra.ends_on >= current_date) ORDER BY ra.starts_on DESC`,
    sql`SELECT s.id, s.routine_id, s.starts_at, s.duration_minutes, s.mode, s.status, s.completion_percent, r.title AS routine_title FROM sessions s LEFT JOIN routines r ON r.id = s.routine_id WHERE s.client_id = ${client.id} AND s.starts_at >= now() - interval '1 year' ORDER BY s.starts_at`,
    sql`SELECT s.id, s.starts_at, s.duration_minutes, (s.client_id = ${client.id}) AS is_mine FROM sessions s JOIN clients c ON c.id = s.client_id WHERE c.owner_id = ${client.owner_id} AND s.status <> 'cancelled' AND s.starts_at BETWEEN now() AND now() + interval '90 days' ORDER BY s.starts_at`,
    sql`SELECT tested_at, values FROM inbody_assessments WHERE client_id = ${client.id} AND extraction_status = 'ready' ORDER BY tested_at`,
    sql`SELECT routine_id, completed_on, completion_percent FROM routine_completions WHERE client_id = ${client.id} AND completed_on >= current_date - interval '1 year' ORDER BY completed_on`
  ]);
  const profile = {
    id: client.id, full_name: client.full_name, email: client.email, goal: client.goal, status: client.status,
    billing_model: client.billing_model, standard_price: client.standard_price, billing_cutoff_day: client.billing_cutoff_day,
    plan_name: client.plan_name, sessions_included: client.sessions_included, validity_days: client.validity_days
  };
  const privateBusySlots = busySlots.map(slot => slot.is_mine
    ? { id: slot.id, starts_at: slot.starts_at, duration_minutes: slot.duration_minutes, is_mine: true }
    : { starts_at: slot.starts_at, duration_minutes: slot.duration_minutes, is_mine: false });
  return { client: profile, invoices, routines, sessions, busySlots: privateBusySlots, assessments, routineCompletions: completions };
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
    request.log.warn({ error, documentId: id }, 'No se encontró el archivo cargado en R2');
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

const inbodyAiFeature = 'inbody_extraction';
const nextAiQuotaReset = () => {
  const reset = new Date();
  reset.setUTCHours(24, 0, 0, 0);
  return reset.toISOString();
};
const inbodyPageNeedsAi = (name: string, contentType: string) => {
  if (contentType === 'application/pdf') return true;
  if (/result[\s_-]*interpretation/i.test(name)) return false;
  const historyPage = name.match(/body[\s_-]*history[\s_-]*(\d+)/i);
  return !historyPage || Number(historyPage[1]) < 2;
};
async function getInbodyAiQuota() {
  const [usage] = await sql`
    SELECT units FROM ai_usage_daily
    WHERE usage_date = (now() AT TIME ZONE 'UTC')::date AND feature = ${inbodyAiFeature}
  `;
  const used = Number(usage?.units || 0);
  return { limit: config.INBODY_AI_DAILY_LIMIT, used, remaining: Math.max(0, config.INBODY_AI_DAILY_LIMIT - used), resetsAt: nextAiQuotaReset() };
}
async function reserveInbodyAiQuota(units: number) {
  if (units < 1 || units > config.INBODY_AI_DAILY_LIMIT) return null;
  const [usage] = await sql`
    INSERT INTO ai_usage_daily (usage_date, feature, units)
    VALUES ((now() AT TIME ZONE 'UTC')::date, ${inbodyAiFeature}, ${units})
    ON CONFLICT (usage_date, feature) DO UPDATE
      SET units = ai_usage_daily.units + EXCLUDED.units, updated_at = now()
      WHERE ai_usage_daily.units + EXCLUDED.units <= ${config.INBODY_AI_DAILY_LIMIT}
    RETURNING units
  `;
  if (!usage) return null;
  const used = Number(usage.units);
  return { limit: config.INBODY_AI_DAILY_LIMIT, used, remaining: config.INBODY_AI_DAILY_LIMIT - used, resetsAt: nextAiQuotaReset() };
}

app.get('/api/inbody/quota', { preHandler: requireStaff }, async () => getInbodyAiQuota());

app.post('/api/inbody/analyze', { preHandler: requireStaff }, async (request, reply) => {
  if (!inbodyAnalysisReady) return reply.code(503).send({
    error: 'El análisis automático aún no está configurado',
    setup: 'Agrega a Railway un token de Cloudflare con permisos Workers AI Read y Edit.'
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
  const requestedUnits = analysisDocuments.reduce((total, document) => total + (document.content_type === 'application/pdf' ? 2 : 1), 0);
  const quota = await reserveInbodyAiQuota(requestedUnits);
  if (!quota) {
    const current = await getInbodyAiQuota();
    return reply.code(429).send({
      error: `Límite diario de análisis alcanzado para protegerte de cargos. Se habilita nuevamente después de ${new Date(current.resetsAt).toLocaleString('es-PA', { timeZone: 'America/Panama' })}.`,
      quota: current
    });
  }

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
      request.log.warn({ error, documentId: document.id }, 'Falló la extracción del reporte InBody');
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
  return { assessments, pageErrors, skippedPages, quota, requiresReview: true };
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

const firstReminderRun = setTimeout(() => dispatchReminders().catch(error => app.log.error(error)), 10_000);
const reminderInterval = setInterval(() => dispatchReminders().catch(error => app.log.error(error)), config.REMINDER_INTERVAL_MINUTES * 60_000);
firstReminderRun.unref();
reminderInterval.unref();

app.addHook('onClose', async () => {
  clearTimeout(firstReminderRun);
  clearInterval(reminderInterval);
  await sql.end();
});
await app.listen({ port: config.PORT, host: '::' });
