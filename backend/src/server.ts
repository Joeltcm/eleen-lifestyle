import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import { sql } from './db.js';
import { createDownloadUrl, createUploadUrl, storageReady, verifyUpload } from './storage.js';
import { registerZohoRoutes } from './zoho-routes.js';

type AuthUser = { sub: string; role: 'admin' | 'trainer' | 'client'; email: string };
const app = Fastify({ logger: true, trustProxy: true });

await app.register(cors, {
  origin: config.CORS_ORIGIN.split(',').map(origin => origin.trim()),
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

app.get('/health', async () => {
  const [database] = await sql`SELECT now() AS time`;
  return { status: 'ok', service: 'eileen-lifestyle-api', databaseTime: database.time, documentStorage: storageReady ? 'ready' : 'configuration_required' };
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

app.get('/api/me', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  const [user] = await sql`SELECT id, email, full_name, role FROM users WHERE id = ${auth.sub}`;
  return { user };
});

const clientSchema = z.object({
  fullName: z.string().min(2), email: z.string().email().optional().or(z.literal('')), phone: z.string().optional(),
  goal: z.string().optional(), notes: z.string().optional(), billingModel: z.enum(['monthly', 'package']).default('monthly'),
  standardPrice: z.coerce.number().min(0).default(0), packageSessions: z.coerce.number().int().positive().optional()
});
app.get('/api/clients', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`
    SELECT c.*, COALESCE((SELECT sum(total_sessions - used_sessions) FROM session_packages p WHERE p.client_id = c.id AND p.status = 'active'), 0)::integer AS available_sessions
    FROM clients c WHERE c.owner_id = ${auth.sub} ORDER BY c.full_name
  `;
});
app.post('/api/clients', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const input = clientSchema.parse(request.body);
  const result = await sql.begin(async transaction => {
    const [client] = await transaction`
      INSERT INTO clients (owner_id, full_name, email, phone, goal, notes, billing_model, standard_price)
      VALUES (${auth.sub}, ${input.fullName}, ${input.email || null}, ${input.phone || null}, ${input.goal || null}, ${input.notes || null}, ${input.billingModel}, ${input.standardPrice}) RETURNING *
    `;
    if (input.billingModel === 'monthly') {
      await transaction`INSERT INTO memberships (client_id, amount, renewal_day) VALUES (${client.id}, ${input.standardPrice}, ${new Date().getDate()})`;
    } else if (input.packageSessions) {
      const [pack] = await transaction`INSERT INTO session_packages (client_id, label, total_sessions, amount) VALUES (${client.id}, ${`Paquete ${input.packageSessions} sesiones`}, ${input.packageSessions}, ${input.standardPrice}) RETURNING id`;
      await transaction`INSERT INTO invoices (client_id, package_id, concept, amount, due_on) VALUES (${client.id}, ${pack.id}, 'Paquete de sesiones', ${input.standardPrice}, current_date)`;
    }
    return client;
  });
  return reply.code(201).send(result);
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
app.post('/api/sessions/:id/complete', { preHandler: requireStaff }, async (request, reply) => {
  const auth = request.user as AuthUser; const id = z.string().uuid().parse((request.params as { id: string }).id);
  const session = await sql.begin(async transaction => {
    const [current] = await transaction`SELECT s.* FROM sessions s JOIN clients c ON c.id = s.client_id WHERE s.id = ${id} AND c.owner_id = ${auth.sub} FOR UPDATE`;
    if (!current) return null; if (current.status === 'completed') return current;
    const [pack] = await transaction`SELECT * FROM session_packages WHERE client_id = ${current.client_id} AND status = 'active' AND used_sessions < total_sessions ORDER BY purchased_on LIMIT 1 FOR UPDATE`;
    if (pack) {
      const nextUsed = pack.used_sessions + 1;
      await transaction`UPDATE session_packages SET used_sessions = ${nextUsed}, status = ${nextUsed >= pack.total_sessions ? 'exhausted' : 'active'} WHERE id = ${pack.id}`;
      const [updated] = await transaction`UPDATE sessions SET status = 'completed', package_id = ${pack.id}, package_debited = true, updated_at = now() WHERE id = ${id} RETURNING *`;
      return updated;
    }
    const [updated] = await transaction`UPDATE sessions SET status = 'completed', updated_at = now() WHERE id = ${id} RETURNING *`;
    return updated;
  });
  if (!session) return reply.code(404).send({ error: 'Sesión no encontrada' }); return session;
});

const invoiceSchema = z.object({ clientId: z.string().uuid(), packageId: z.string().uuid().optional(), concept: z.string().min(2), amount: z.coerce.number().min(0), dueOn: z.string().date() });
app.get('/api/invoices', { preHandler: requireStaff }, async request => {
  const auth = request.user as AuthUser;
  return sql`SELECT i.*, c.full_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE c.owner_id = ${auth.sub} ORDER BY i.created_at DESC`;
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

const documentKind = z.enum(['inbody', 'contract', 'receipt', 'progress_photo', 'other']);
const uploadSchema = z.object({
  clientId: z.string().uuid(),
  kind: documentKind,
  fileName: z.string().trim().min(1).max(180),
  contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.coerce.number().int().positive().max(20 * 1024 * 1024).optional()
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

const inbodySchema = z.object({ clientId: z.string().uuid(), documentId: z.string().uuid().optional(), deviceModel: z.string().optional(), testedAt: z.string().datetime(), values: z.record(z.string(), z.union([z.number(), z.string(), z.null()])), confidence: z.record(z.string(), z.number()).default({}), extractionStatus: z.enum(['pending', 'processing', 'ready', 'review', 'failed']).default('ready') });
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

app.addHook('onClose', async () => { await sql.end(); });
await app.listen({ port: config.PORT, host: '::' });
