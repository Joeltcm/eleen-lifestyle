import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { sql } from './db.js';

const provider = 'zoho_invoice';
const sourceSystem = 'zoho_invoice';
const scopes = [
  'ZohoInvoice.settings.READ',
  'ZohoInvoice.contacts.READ',
  'ZohoInvoice.invoices.READ',
  'ZohoInvoice.customerpayments.READ',
  'ZohoInvoice.creditnotes.READ'
].join(',');
const encryptionKey = createHash('sha256').update(config.JWT_SECRET).digest();
const runningOwners = new Set<string>();

type AuthUser = { sub: string; role: 'admin' | 'trainer' | 'client'; email: string };
type ZohoRecord = Record<string, any>;
type Connection = {
  owner_id: string;
  encrypted_refresh_token: string;
  organization_id: string;
  organization_name: string;
  accounts_url: string;
  api_base_url: string;
  status: string;
  sync_enabled: boolean;
};

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

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

function decrypt(value: string) {
  const [ivValue, tagValue, encryptedValue] = value.split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('La conexión con Zoho no es válida');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

function integrationConfigured() {
  return Boolean(config.ZOHO_CLIENT_ID && config.ZOHO_CLIENT_SECRET);
}

function numeric(value: unknown) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function externalId(value: unknown) {
  return value === null || value === undefined ? '' : String(value);
}

function sourceDate(value: unknown, fallback = new Date().toISOString().slice(0, 10)) {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function rounded(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function tokenRequest(accountsUrl: string, parameters: Record<string, string>) {
  const response = await fetch(`${accountsUrl.replace(/\/$/, '')}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(parameters)
  });
  const payload = await response.json() as ZohoRecord;
  if (!response.ok || payload.error) throw new Error(payload.error_description || payload.error || 'Zoho rechazó la autorización');
  return payload;
}

async function exchangeAuthorizationCode(code: string) {
  if (!config.ZOHO_CLIENT_ID || !config.ZOHO_CLIENT_SECRET) throw new Error('Faltan las credenciales OAuth de Zoho en Railway');
  return tokenRequest(config.ZOHO_ACCOUNTS_URL, {
    code,
    client_id: config.ZOHO_CLIENT_ID,
    client_secret: config.ZOHO_CLIENT_SECRET,
    redirect_uri: config.ZOHO_REDIRECT_URI,
    grant_type: 'authorization_code'
  });
}

async function refreshAccessToken(connection: Connection) {
  if (!config.ZOHO_CLIENT_ID || !config.ZOHO_CLIENT_SECRET) throw new Error('Faltan las credenciales OAuth de Zoho en Railway');
  return tokenRequest(connection.accounts_url, {
    refresh_token: decrypt(connection.encrypted_refresh_token),
    client_id: config.ZOHO_CLIENT_ID,
    client_secret: config.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });
}

async function zohoGet(accessToken: string, apiBaseUrl: string, path: string, organizationId?: string, query: Record<string, string> = {}) {
  const url = new URL(`${apiBaseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
  const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  if (organizationId) headers['X-com-zoho-invoice-organizationid'] = organizationId;
  const response = await fetch(url, { headers });
  const payload = await response.json() as ZohoRecord;
  if (!response.ok || (payload.code !== undefined && Number(payload.code) !== 0)) {
    if (response.status === 429 && Number(payload.code) === 45) {
      throw new Error('Zoho agotó el límite diario de 1,000 llamadas. La importación optimizada podrá continuar cuando Zoho restablezca el cupo.');
    }
    throw new Error(payload.message || `Zoho respondió ${response.status}`);
  }
  return payload;
}

async function fetchAllPages(accessToken: string, connection: Connection, path: string, keys: string[]) {
  const records: ZohoRecord[] = [];
  for (let page = 1; page <= 1000; page += 1) {
    const payload = await zohoGet(accessToken, connection.api_base_url, path, connection.organization_id, { page: String(page), per_page: '200' });
    const current = keys.map(key => payload[key]).find(Array.isArray) || [];
    records.push(...current);
    const hasMore = payload.page_context?.has_more_page;
    if (hasMore === false || (hasMore === undefined && current.length < 200)) break;
  }
  return records;
}

function invoiceStatus(invoice: ZohoRecord) {
  const status = String(invoice.status || '').toLowerCase();
  if (status === 'void') return 'void';
  if (status === 'paid' || (numeric(invoice.total) > 0 && numeric(invoice.balance) === 0)) return 'confirmed';
  return 'pending';
}

function primaryContact(contact: ZohoRecord) {
  return (contact.contact_persons || []).find((person: ZohoRecord) => person.is_primary_contact) || (contact.contact_persons || [])[0] || {};
}

function contactDetails(contact: ZohoRecord) {
  const person = primaryContact(contact);
  return {
    name: String(contact.contact_name || contact.company_name || [person.first_name, person.last_name].filter(Boolean).join(' ') || 'Cliente Zoho').trim(),
    email: String(contact.email || person.email || '').trim().toLowerCase(),
    phone: String(contact.phone || contact.mobile || person.mobile || person.phone || contact.billing_address?.phone || '').trim()
  };
}

function invoiceConcept(invoice: ZohoRecord) {
  const concepts = (invoice.line_items || []).map((item: ZohoRecord) => item.name || item.description).filter(Boolean);
  return concepts.length ? concepts.join(' · ').slice(0, 300) : `Factura ${invoice.invoice_number || invoice.reference_number || 'Zoho'}`;
}

async function localSummary(ownerId: string) {
  const [summary] = await sql`
    SELECT
      (SELECT count(*)::integer FROM clients WHERE owner_id = ${ownerId} AND source_system = ${sourceSystem}) AS clients,
      (SELECT count(*)::integer FROM invoices i JOIN clients c ON c.id = i.client_id WHERE c.owner_id = ${ownerId} AND i.source_system = ${sourceSystem}) AS invoices,
      (SELECT count(*)::integer FROM invoice_payments p JOIN clients c ON c.id = p.client_id WHERE c.owner_id = ${ownerId} AND p.source_system = ${sourceSystem}) AS payments,
      (SELECT count(*)::integer FROM memberships m JOIN clients c ON c.id = m.client_id WHERE c.owner_id = ${ownerId} AND m.source_system = ${sourceSystem}) AS recurring,
      (SELECT count(*)::integer FROM credit_notes n JOIN clients c ON c.id = n.client_id WHERE c.owner_id = ${ownerId} AND n.source_system = ${sourceSystem}) AS credits,
      (SELECT COALESCE(sum(i.amount), 0)::numeric FROM invoices i JOIN clients c ON c.id = i.client_id WHERE c.owner_id = ${ownerId} AND i.source_system = ${sourceSystem}) AS total_invoiced,
      (SELECT COALESCE(sum(p.amount), 0)::numeric FROM invoice_payments p JOIN clients c ON c.id = p.client_id WHERE c.owner_id = ${ownerId} AND p.source_system = ${sourceSystem}) AS total_paid,
      (SELECT COALESCE(sum(n.amount), 0)::numeric FROM credit_notes n JOIN clients c ON c.id = n.client_id WHERE c.owner_id = ${ownerId} AND n.source_system = ${sourceSystem}) AS total_credits
  `;
  return {
    clients: Number(summary.clients), invoices: Number(summary.invoices), payments: Number(summary.payments), recurring: Number(summary.recurring), credits: Number(summary.credits),
    totalInvoiced: rounded(Number(summary.total_invoiced)), totalPaid: rounded(Number(summary.total_paid)), totalCredits: rounded(Number(summary.total_credits))
  };
}

function billingPeriodBounds(year: number | 'all', month: number | 'all') {
  if (year === 'all') return { start: '1900-01-01', end: '2101-01-01' };
  const startMonth = month === 'all' ? 0 : month - 1;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = month === 'all' ? new Date(Date.UTC(year + 1, 0, 1)) : new Date(Date.UTC(year, startMonth + 1, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

async function localPeriodSummary(ownerId: string, year: number | 'all', month: number | 'all') {
  const { start, end } = billingPeriodBounds(year, month);
  const [summary] = await sql`
    SELECT
      (SELECT count(DISTINCT i.client_id)::integer FROM invoices i JOIN clients c ON c.id = i.client_id
        WHERE c.owner_id = ${ownerId} AND i.source_system = ${sourceSystem} AND i.status <> 'void'
          AND COALESCE(i.issued_on, i.due_on) >= ${start}::date AND COALESCE(i.issued_on, i.due_on) < ${end}::date) AS clients,
      (SELECT count(*)::integer FROM invoices i JOIN clients c ON c.id = i.client_id
        WHERE c.owner_id = ${ownerId} AND i.source_system = ${sourceSystem} AND i.status <> 'void'
          AND COALESCE(i.issued_on, i.due_on) >= ${start}::date AND COALESCE(i.issued_on, i.due_on) < ${end}::date) AS invoices,
      (SELECT count(*)::integer FROM invoice_payments p JOIN clients c ON c.id = p.client_id
        WHERE c.owner_id = ${ownerId} AND p.source_system = ${sourceSystem}
          AND p.paid_on >= ${start}::date AND p.paid_on < ${end}::date) AS payments,
      (SELECT count(*)::integer FROM memberships m JOIN clients c ON c.id = m.client_id
        WHERE c.owner_id = ${ownerId} AND m.source_system = ${sourceSystem}
          AND m.starts_on < ${end}::date AND (m.ends_on IS NULL OR m.ends_on >= ${start}::date)) AS recurring,
      (SELECT count(*)::integer FROM credit_notes n JOIN clients c ON c.id = n.client_id
        WHERE c.owner_id = ${ownerId} AND n.source_system = ${sourceSystem}
          AND n.issued_on >= ${start}::date AND n.issued_on < ${end}::date) AS credits,
      (SELECT COALESCE(sum(i.amount), 0)::numeric FROM invoices i JOIN clients c ON c.id = i.client_id
        WHERE c.owner_id = ${ownerId} AND i.source_system = ${sourceSystem} AND i.status <> 'void'
          AND COALESCE(i.issued_on, i.due_on) >= ${start}::date AND COALESCE(i.issued_on, i.due_on) < ${end}::date) AS total_invoiced,
      (SELECT COALESCE(sum(p.amount), 0)::numeric FROM invoice_payments p JOIN clients c ON c.id = p.client_id
        WHERE c.owner_id = ${ownerId} AND p.source_system = ${sourceSystem}
          AND p.paid_on >= ${start}::date AND p.paid_on < ${end}::date) AS total_paid,
      (SELECT COALESCE(sum(n.amount), 0)::numeric FROM credit_notes n JOIN clients c ON c.id = n.client_id
        WHERE c.owner_id = ${ownerId} AND n.source_system = ${sourceSystem}
          AND n.issued_on >= ${start}::date AND n.issued_on < ${end}::date) AS total_credits
  `;
  return {
    year, month, start, end,
    clients: Number(summary.clients), invoices: Number(summary.invoices), payments: Number(summary.payments), recurring: Number(summary.recurring), credits: Number(summary.credits),
    totalInvoiced: rounded(Number(summary.total_invoiced)), totalPaid: rounded(Number(summary.total_paid)), totalCredits: rounded(Number(summary.total_credits))
  };
}

function reconciled(source: ZohoRecord, local: ZohoRecord) {
  return ['clients', 'invoices', 'payments', 'recurring', 'credits'].every(key => Number(source[key]) === Number(local[key]))
    && ['totalInvoiced', 'totalPaid', 'totalCredits'].every(key => Math.abs(numeric(source[key]) - numeric(local[key])) < 0.01)
    && numeric(source.skippedInvoices) === 0;
}

async function runSync(ownerId: string) {
  if (runningOwners.has(ownerId)) throw new Error('Ya hay una sincronización de Zoho en curso');
  const [connection] = await sql`SELECT * FROM integration_connections WHERE owner_id = ${ownerId} AND provider = ${provider}` as unknown as Connection[];
  if (!connection?.encrypted_refresh_token || connection.status === 'completed') throw new Error('Zoho no está conectado o la migración ya fue cerrada');
  runningOwners.add(ownerId);
  const [run] = await sql`INSERT INTO integration_sync_runs (owner_id, provider, status) VALUES (${ownerId}, ${provider}, 'running') RETURNING id`;
  await sql`UPDATE integration_connections SET status = 'syncing', last_error = NULL, updated_at = now() WHERE owner_id = ${ownerId} AND provider = ${provider}`;
  try {
    const token = await refreshAccessToken(connection);
    const accessToken = String(token.access_token);
    const contacts = (await fetchAllPages(accessToken, connection, '/contacts', ['contacts'])).filter(contact => !contact.contact_type || contact.contact_type === 'customer');
    const invoices = await fetchAllPages(accessToken, connection, '/invoices', ['invoices']);
    const payments = await fetchAllPages(accessToken, connection, '/customerpayments', ['customerpayments', 'customer_payments']);
    const recurring = await fetchAllPages(accessToken, connection, '/recurringinvoices', ['recurring_invoices', 'recurringinvoices']);
    const credits = await fetchAllPages(accessToken, connection, '/creditnotes', ['creditnotes', 'credit_notes']);
    const clientMap = new Map<string, string>();
    const invoiceMap = new Map<string, string>();
    let skippedInvoices = 0;

    await sql.begin(async transaction => {
      for (const contact of contacts) {
        const zohoId = externalId(contact.contact_id);
        if (!zohoId) continue;
        const details = contactDetails(contact);
        let [client] = await transaction`SELECT id FROM clients WHERE owner_id = ${ownerId} AND source_system = ${sourceSystem} AND external_id = ${zohoId}`;
        if (!client && details.email) [client] = await transaction`SELECT id FROM clients WHERE owner_id = ${ownerId} AND lower(email) = ${details.email} ORDER BY created_at LIMIT 1`;
        if (client) {
          [client] = await transaction`
            UPDATE clients SET full_name = ${details.name}, email = ${details.email || null}, phone = ${details.phone || null},
              status = ${contact.status === 'inactive' ? 'inactive' : 'active'}, source_system = ${sourceSystem}, external_id = ${zohoId},
              external_updated_at = ${contact.last_modified_time || null}, source_payload = ${transaction.json(contact)}, updated_at = now()
            WHERE id = ${client.id} RETURNING id
          `;
        } else {
          [client] = await transaction`
            INSERT INTO clients (owner_id, full_name, email, phone, notes, status, billing_model, standard_price, source_system, external_id, external_updated_at, source_payload)
            VALUES (${ownerId}, ${details.name}, ${details.email || null}, ${details.phone || null}, ${contact.notes || null},
              ${contact.status === 'inactive' ? 'inactive' : 'active'}, 'monthly', 0, ${sourceSystem}, ${zohoId}, ${contact.last_modified_time || null}, ${transaction.json(contact)})
            RETURNING id
          `;
        }
        clientMap.set(zohoId, client.id);
      }

      for (const invoice of invoices) {
        const zohoId = externalId(invoice.invoice_id); const clientId = clientMap.get(externalId(invoice.customer_id));
        if (!zohoId || !clientId) { skippedInvoices += 1; continue; }
        const amount = numeric(invoice.total); const balance = numeric(invoice.balance); const issuedOn = sourceDate(invoice.date || invoice.created_time); const dueOn = sourceDate(invoice.due_date, issuedOn);
        const [saved] = await transaction`
          INSERT INTO invoices (client_id, concept, amount, currency, due_on, status, source_system, external_id, invoice_number, issued_on, subtotal, tax_total, balance, external_status, line_items, notes, external_updated_at, source_payload)
          VALUES (${clientId}, ${invoiceConcept(invoice)}, ${amount}, ${String(invoice.currency_code || 'USD').slice(0, 3)}, ${dueOn}, ${invoiceStatus(invoice)},
            ${sourceSystem}, ${zohoId}, ${invoice.invoice_number || null}, ${issuedOn}, ${numeric(invoice.sub_total ?? invoice.subtotal ?? amount)},
            ${numeric(invoice.tax_total ?? invoice.total_tax_amount)}, ${balance}, ${invoice.status || null}, ${transaction.json(invoice.line_items || [])},
            ${invoice.notes || null}, ${invoice.last_modified_time || null}, ${transaction.json(invoice)})
          ON CONFLICT (source_system, external_id) DO UPDATE SET
            client_id = EXCLUDED.client_id, concept = EXCLUDED.concept, amount = EXCLUDED.amount, currency = EXCLUDED.currency,
            due_on = EXCLUDED.due_on, status = EXCLUDED.status, invoice_number = EXCLUDED.invoice_number, issued_on = EXCLUDED.issued_on,
            subtotal = EXCLUDED.subtotal, tax_total = EXCLUDED.tax_total, balance = EXCLUDED.balance, external_status = EXCLUDED.external_status,
            line_items = EXCLUDED.line_items, notes = EXCLUDED.notes, external_updated_at = EXCLUDED.external_updated_at, source_payload = EXCLUDED.source_payload
          RETURNING id
        `;
        invoiceMap.set(zohoId, saved.id);
      }

      for (const payment of payments) {
        const zohoId = externalId(payment.payment_id); const clientId = clientMap.get(externalId(payment.customer_id));
        if (!zohoId || !clientId) continue;
        const paidOn = sourceDate(payment.date || payment.created_time);
        const [saved] = await transaction`
          INSERT INTO invoice_payments (client_id, source_system, external_id, payment_number, amount, currency, paid_on, method, reference, source_payload)
          VALUES (${clientId}, ${sourceSystem}, ${zohoId}, ${payment.payment_number || null}, ${numeric(payment.amount)},
            ${String(payment.currency_code || 'USD').slice(0, 3)}, ${paidOn}, ${payment.payment_mode || payment.method || null},
            ${payment.reference_number || null}, ${transaction.json(payment)})
          ON CONFLICT (source_system, external_id) DO UPDATE SET client_id = EXCLUDED.client_id, payment_number = EXCLUDED.payment_number,
            amount = EXCLUDED.amount, currency = EXCLUDED.currency, paid_on = EXCLUDED.paid_on, method = EXCLUDED.method,
            reference = EXCLUDED.reference, source_payload = EXCLUDED.source_payload, updated_at = now()
          RETURNING id
        `;
        await transaction`DELETE FROM payment_allocations WHERE payment_id = ${saved.id}`;
        for (const allocation of payment.invoices || []) {
          const invoiceId = invoiceMap.get(externalId(allocation.invoice_id));
          if (!invoiceId) continue;
          await transaction`INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (${saved.id}, ${invoiceId}, ${numeric(allocation.amount_applied ?? allocation.amount)}) ON CONFLICT (payment_id, invoice_id) DO UPDATE SET amount = EXCLUDED.amount`;
          await transaction`UPDATE invoices SET payment_method = ${payment.payment_mode || payment.method || null}, payment_reference = ${payment.reference_number || null}, confirmed_at = CASE WHEN status = 'confirmed' THEN COALESCE(confirmed_at, ${paidOn}::date::timestamptz) ELSE confirmed_at END WHERE id = ${invoiceId}`;
        }
      }

      for (const profile of recurring) {
        const zohoId = externalId(profile.recurring_invoice_id); const clientId = clientMap.get(externalId(profile.customer_id));
        if (!zohoId || !clientId) continue;
        const amount = numeric(profile.total) || (profile.line_items || []).reduce((sum: number, item: ZohoRecord) => sum + numeric(item.item_total), 0);
        const nextDate = profile.next_invoice_date ? sourceDate(profile.next_invoice_date) : null;
        const membershipStatus = profile.status === 'active' ? 'active' : profile.status === 'stopped' ? 'paused' : 'cancelled';
        await transaction`
          INSERT INTO memberships (client_id, amount, renewal_day, status, starts_on, ends_on, source_system, external_id, recurrence_name, recurrence_interval, next_invoice_on, source_payload)
          VALUES (${clientId}, ${amount}, ${nextDate ? Number(nextDate.slice(8, 10)) : null}, ${membershipStatus}, ${sourceDate(profile.start_date)},
            ${profile.end_date ? sourceDate(profile.end_date) : null}, ${sourceSystem}, ${zohoId}, ${profile.recurrence_name || null},
            ${String(profile.recurrence_frequency || profile.repeat_every || 'monthly')}, ${nextDate}, ${transaction.json(profile)})
          ON CONFLICT (source_system, external_id) DO UPDATE SET client_id = EXCLUDED.client_id, amount = EXCLUDED.amount,
            renewal_day = EXCLUDED.renewal_day, status = EXCLUDED.status, starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on,
            recurrence_name = EXCLUDED.recurrence_name, recurrence_interval = EXCLUDED.recurrence_interval,
            next_invoice_on = EXCLUDED.next_invoice_on, source_payload = EXCLUDED.source_payload
        `;
        if (amount > 0) await transaction`UPDATE clients SET billing_model = 'monthly', standard_price = ${amount}, updated_at = now() WHERE id = ${clientId}`;
      }

      for (const credit of credits) {
        const zohoId = externalId(credit.creditnote_id); const clientId = clientMap.get(externalId(credit.customer_id));
        if (!zohoId || !clientId) continue;
        await transaction`
          INSERT INTO credit_notes (client_id, source_system, external_id, credit_note_number, issued_on, amount, balance, currency, status, reference, source_payload)
          VALUES (${clientId}, ${sourceSystem}, ${zohoId}, ${credit.creditnote_number || null}, ${sourceDate(credit.date)}, ${numeric(credit.total)},
            ${numeric(credit.balance)}, ${String(credit.currency_code || 'USD').slice(0, 3)}, ${credit.status || 'open'}, ${credit.reference_number || null}, ${transaction.json(credit)})
          ON CONFLICT (source_system, external_id) DO UPDATE SET client_id = EXCLUDED.client_id, credit_note_number = EXCLUDED.credit_note_number,
            issued_on = EXCLUDED.issued_on, amount = EXCLUDED.amount, balance = EXCLUDED.balance, currency = EXCLUDED.currency,
            status = EXCLUDED.status, reference = EXCLUDED.reference, source_payload = EXCLUDED.source_payload, updated_at = now()
        `;
      }
    });

    const sourceSummary = {
      clients: contacts.length, invoices: invoices.length - skippedInvoices, payments: payments.length, recurring: recurring.length, credits: credits.length,
      totalInvoiced: rounded(invoices.reduce((sum, invoice) => sum + numeric(invoice.total), 0)),
      totalPaid: rounded(payments.reduce((sum, payment) => sum + numeric(payment.amount), 0)),
      totalCredits: rounded(credits.reduce((sum, credit) => sum + numeric(credit.total), 0)), skippedInvoices
    };
    const importedSummary = await localSummary(ownerId);
    const isReconciled = reconciled(sourceSummary, importedSummary);
    await sql`
      UPDATE integration_connections SET status = ${isReconciled ? 'ready' : 'connected'}, last_sync_at = now(), last_error = NULL,
        source_summary = ${sql.json(sourceSummary)}, local_summary = ${sql.json(importedSummary)}, updated_at = now()
      WHERE owner_id = ${ownerId} AND provider = ${provider}
    `;
    await sql`UPDATE integration_sync_runs SET status = 'completed', source_summary = ${sql.json(sourceSummary)}, local_summary = ${sql.json(importedSummary)}, reconciled = ${isReconciled}, completed_at = now() WHERE id = ${run.id}`;
    return { source: sourceSummary, local: importedSummary, reconciled: isReconciled };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido durante la sincronización';
    await sql`UPDATE integration_connections SET status = 'error', last_error = ${message}, updated_at = now() WHERE owner_id = ${ownerId} AND provider = ${provider}`;
    await sql`UPDATE integration_sync_runs SET status = 'failed', error_message = ${message}, completed_at = now() WHERE id = ${run.id}`;
    throw error;
  } finally {
    runningOwners.delete(ownerId);
  }
}

export async function registerZohoRoutes(app: FastifyInstance) {
  app.get('/api/integrations/zoho/status', { preHandler: requireStaff }, async request => {
    const auth = request.user as AuthUser;
    const now = new Date();
    const query = z.object({
      year: z.union([z.literal('all'), z.coerce.number().int().min(2000).max(2100)]).default(now.getFullYear()),
      month: z.union([z.literal('all'), z.coerce.number().int().min(1).max(12)]).default(now.getMonth() + 1)
    }).parse(request.query);
    const [connection] = await sql`
      SELECT organization_id, organization_name, status, sync_enabled, last_sync_at, cutover_at, last_error, source_summary, local_summary
      FROM integration_connections WHERE owner_id = ${auth.sub} AND provider = ${provider}
    `;
    const [lastRun] = await sql`SELECT status, reconciled, started_at, completed_at, error_message FROM integration_sync_runs WHERE owner_id = ${auth.sub} AND provider = ${provider} ORDER BY started_at DESC LIMIT 1`;
    const periodSummary = connection ? await localPeriodSummary(auth.sub, query.year, query.month) : null;
    return { configured: integrationConfigured(), connected: Boolean(connection), connection: connection || null, lastRun: lastRun || null, periodSummary, syncInProgress: runningOwners.has(auth.sub) };
  });

  app.get('/api/integrations/zoho/authorize', { preHandler: requireStaff }, async (request, reply) => {
    if (!integrationConfigured()) return reply.code(503).send({ error: 'Primero agrega ZOHO_CLIENT_ID y ZOHO_CLIENT_SECRET en Railway' });
    const auth = request.user as AuthUser;
    const state = app.jwt.sign({ sub: auth.sub, purpose: 'zoho_oauth' }, { expiresIn: '10m' });
    const url = new URL(`${config.ZOHO_ACCOUNTS_URL.replace(/\/$/, '')}/oauth/v2/auth`);
    url.search = new URLSearchParams({ scope: scopes, client_id: config.ZOHO_CLIENT_ID!, state, response_type: 'code', redirect_uri: config.ZOHO_REDIRECT_URI, access_type: 'offline', prompt: 'consent' }).toString();
    return { authorizationUrl: url.toString() };
  });

  app.get('/api/integrations/zoho/callback', async (request, reply) => {
    const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(request.query);
    const state = app.jwt.verify<{ sub: string; purpose: string }>(query.state);
    if (state.purpose !== 'zoho_oauth') return reply.code(400).send({ error: 'Estado OAuth inválido' });
    const token = await exchangeAuthorizationCode(query.code);
    if (!token.refresh_token) return reply.code(400).send({ error: 'Zoho no entregó un refresh token. Vuelve a conectar y acepta el consentimiento.' });
    const apiBaseUrl = `${String(token.api_domain || 'https://www.zohoapis.com').replace(/\/$/, '')}/invoice/v3`;
    const organizations = await zohoGet(String(token.access_token), apiBaseUrl, '/organizations');
    const organization = (organizations.organizations || []).find((item: ZohoRecord) => item.is_default_org) || (organizations.organizations || [])[0];
    if (!organization) return reply.code(400).send({ error: 'No se encontró una organización de Zoho Invoice' });
    await sql`
      INSERT INTO integration_connections (owner_id, provider, encrypted_refresh_token, organization_id, organization_name, accounts_url, api_base_url, status, sync_enabled)
      VALUES (${state.sub}, ${provider}, ${encrypt(String(token.refresh_token))}, ${externalId(organization.organization_id)}, ${organization.name || 'Zoho Invoice'},
        ${config.ZOHO_ACCOUNTS_URL}, ${apiBaseUrl}, 'connected', true)
      ON CONFLICT (owner_id, provider) DO UPDATE SET encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
        organization_id = EXCLUDED.organization_id, organization_name = EXCLUDED.organization_name, accounts_url = EXCLUDED.accounts_url,
        api_base_url = EXCLUDED.api_base_url, status = 'connected', sync_enabled = true, cutover_at = NULL, last_error = NULL, updated_at = now()
    `;
    return reply.redirect(`${config.APP_URL.replace(/\/$/, '')}/?zoho=connected#billing`);
  });

  app.post('/api/integrations/zoho/sync', { preHandler: requireStaff }, async request => {
    const auth = request.user as AuthUser;
    return runSync(auth.sub);
  });

  app.post('/api/integrations/zoho/cutover', { preHandler: requireStaff }, async (request, reply) => {
    const auth = request.user as AuthUser;
    const input = z.object({ confirmation: z.literal('MIGRAR A EILEEN') }).parse(request.body);
    void input;
    const [connection] = await sql`SELECT status, last_sync_at FROM integration_connections WHERE owner_id = ${auth.sub} AND provider = ${provider}`;
    if (!connection) return reply.code(404).send({ error: 'Zoho no está conectado' });
    if (connection.status !== 'ready') return reply.code(409).send({ error: 'Los datos todavía no están conciliados' });
    if (!connection.last_sync_at || Date.now() - new Date(connection.last_sync_at).getTime() > 24 * 60 * 60 * 1000) return reply.code(409).send({ error: 'Ejecuta una sincronización final antes del corte' });
    await sql`UPDATE integration_connections SET status = 'completed', sync_enabled = false, encrypted_refresh_token = NULL, cutover_at = now(), updated_at = now() WHERE owner_id = ${auth.sub} AND provider = ${provider}`;
    return { completed: true };
  });

  const syncTimer = setInterval(() => {
    void (async () => {
      const connections = await sql`
        SELECT owner_id FROM integration_connections
        WHERE provider = ${provider} AND sync_enabled = true AND status NOT IN ('completed', 'syncing')
          AND (
            (status = 'error' AND updated_at < now() - interval '6 hours')
            OR (status <> 'error' AND (last_sync_at IS NULL OR last_sync_at < now() - interval '6 hours'))
          )
      `;
      for (const connection of connections) runSync(connection.owner_id).catch(error => app.log.error(error));
    })().catch(error => app.log.error(error));
  }, 30 * 60 * 1000);
  syncTimer.unref();
}
