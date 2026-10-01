// Cargador de la carga inicial (etapa 1B-4).
//
// Lleva al módulo nuevo lo que CUADRA del sistema anterior, sin tocarlo. Funciona en cuatro pasos,
// cada uno con su puerta:
//   1) VISTA PREVIA: a partir de un MANIFIESTO explícito (la lista aprobada por Joel: quién, ciclo,
//      líneas y cobro) y de una lectura de SOLO LECTURA de las tablas viejas, produce una fila por
//      factura y por cobro a crear, o la razón por la que una entrada NO se carga. Nada se escribe en
//      las tablas de facturación; solo queda el lote y sus filas (billing_import_*).
//   2) APROBACIÓN: Joel aprueba esa vista previa por su hash exacto.
//   3) APLICACIÓN: solo con el generador viejo apagado; vuelve a leer, comprueba que el hash, el
//      contador y los totales no cambiaron y crea todo en UNA transacción.
//   4) REVERSIÓN: solo mientras nada haya cambiado después del lote.
//
// El sistema viejo es EVIDENCIA, no fuente de verdad: si no encuentra el cobro o la factura vieja que
// respalda una entrada, la marca "revisar" y no se carga. Nada se infiere. Nunca se leen notas
// privadas, datos de salud, InBody ni contactos: solo columnas de facturación.
import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { sql } from './db.js';

// ── Tipos del manifiesto ─────────────────────────────────────────────────────
export type ImportLine = { beneficiary: string; description?: string; amount?: number; sessionsReference?: number };
export type ImportPayment = { paidOn: string | 'legacy'; method: 'Efectivo' | 'Yappy' | 'Transferencia bancaria' | 'Tarjeta' | 'Otro' | 'legacy'; amount: number; reference?: string };
export type ImportEntry = {
  key: string; label: string; payer: string;
  kind: 'mensual' | 'credito' | 'clase_suelta' | 'paquete' | 'manual';
  cycleStart: string; cycleEnd: string; cutDay?: number; issuedOn?: string; dueOn?: string;
  lines: ImportLine[];
  amountFrom?: 'legacy'; // el total sale de la factura vieja pendiente (crédito de Julio): se muestra para revalidarlo
  payment?: ImportPayment;
};
export type ImportExclusion = { key: string; label: string; reason: string };
// Clientes de clases sueltas (Susie, Reina, Sara Hidrie): cada factura vieja pagada desde `since` se carga como UNA
// factura `clase_suelta` con su cobro, tomando fecha, monto, método y referencia del cobro viejo. Si una no encaja
// (pendiente, sin cobro, con más de un cobro, de mensualidad o paquete) NO se carga y queda "revisar".
export type ImportSingleClasses = { key: string; label: string; client: string; since: string; accept?: { date: string; amount: number }[] };
export type ImportManifest = { name: string; entries: ImportEntry[]; exclusions: ImportExclusion[]; singleClasses?: ImportSingleClasses[] };

// Lista aprobada de la carga inicial (diseño 8.1 y 8.2, J-045/J-047/J-051). Al acercarse el corte hay
// que ACTUALIZARLA con los ciclos vigentes ese día; la vista previa muestra cualquier diferencia.
export const DEFAULT_IMPORT_MANIFEST: ImportManifest = {
  name: 'Carga inicial (diseño 8.1, estado del 30-09-2026)',
  entries: [
    { key: 'sandy-2026-09', label: 'Sandy Asis · septiembre', payer: 'Sandy Asis', kind: 'mensual', cycleStart: '2026-09-01', cycleEnd: '2026-10-01',
      lines: [{ beneficiary: 'Sandy Asis', description: 'Mensualidad', amount: 300 }], payment: { paidOn: '2026-09-01', method: 'Yappy', amount: 300 } },
    { key: 'sandy-2026-10', label: 'Sandy Asis · octubre', payer: 'Sandy Asis', kind: 'mensual', cycleStart: '2026-10-01', cycleEnd: '2026-11-01',
      lines: [{ beneficiary: 'Sandy Asis', description: 'Mensualidad', amount: 300 }] },
    { key: 'sally-2026-09', label: 'Sally Dayan Safdi · septiembre', payer: 'Sally Dayan Safdi', kind: 'mensual', cycleStart: '2026-09-01', cycleEnd: '2026-10-01',
      lines: [{ beneficiary: 'Sally Dayan Safdi', description: 'Mensualidad', amount: 400 }], payment: { paidOn: '2026-09-02', method: 'Transferencia bancaria', amount: 400 } },
    { key: 'sally-2026-10', label: 'Sally Dayan Safdi · octubre', payer: 'Sally Dayan Safdi', kind: 'mensual', cycleStart: '2026-10-01', cycleEnd: '2026-11-01',
      lines: [{ beneficiary: 'Sally Dayan Safdi', description: 'Mensualidad', amount: 400 }] },
    { key: 'riccardo-2026-09', label: 'Riccardo Francolini · familia (septiembre)', payer: 'Riccardo Francolini', kind: 'mensual', cycleStart: '2026-09-15', cycleEnd: '2026-10-15',
      lines: [
        { beneficiary: 'Riccardo Francolini', description: 'Riccardo (12 clases)', amount: 450, sessionsReference: 12 },
        { beneficiary: 'Iraida de Francolini', description: 'Iraida (8 clases)', amount: 300, sessionsReference: 8 },
        { beneficiary: 'Ernesto de Diego', description: 'Ernesto, plan familiar (4 clases)', amount: 150, sessionsReference: 4 }
      ], payment: { paidOn: '2026-09-16', method: 'Yappy', amount: 900 } },
    { key: 'ernesto-2026-09', label: 'Ernesto de Diego · plan propio (septiembre)', payer: 'Ernesto de Diego', kind: 'mensual', cycleStart: '2026-09-15', cycleEnd: '2026-10-15',
      lines: [{ beneficiary: 'Ernesto de Diego', description: '4 sesiones propias', amount: 120, sessionsReference: 4 }], payment: { paidOn: '2026-09-17', method: 'Yappy', amount: 120 } },
    { key: 'eduardo-2026-09', label: 'Eduardo Díaz · pareja (28-09)', payer: 'Eduardo Díaz', kind: 'mensual', cycleStart: '2026-09-28', cycleEnd: '2026-10-28',
      lines: [
        { beneficiary: 'Eduardo Díaz', description: 'Eduardo', amount: 175 },
        { beneficiary: 'Beatris Díaz', description: 'Beatris', amount: 175 }
      ], payment: { paidOn: '2026-09-28', method: 'Transferencia bancaria', amount: 350 } },
    { key: 'julieta-2026-09', label: 'Julieta Galindo · con Juan de Diego padre', payer: 'Julieta Galindo', kind: 'mensual', cycleStart: '2026-09-25', cycleEnd: '2026-10-25',
      lines: [
        { beneficiary: 'Julieta Galindo', description: 'Julieta', amount: 150 },
        { beneficiary: 'Juan de Diego padre', description: 'Juan de Diego padre', amount: 150 }
      ], payment: { paidOn: '2026-09-26', method: 'Yappy', amount: 300 } },
    // Gila pagó (J-055): la FECHA y el método se toman del cobro registrado en el sistema anterior (dentro de su ciclo).
    { key: 'gila-2026-09', label: 'Gila Falic · 28-09 (pagada el 01-10)', payer: 'Gila Falic', kind: 'mensual', cycleStart: '2026-09-28', cycleEnd: '2026-10-28',
      lines: [{ beneficiary: 'Gila Falic', description: 'Mensualidad', amount: 240 }], payment: { paidOn: 'legacy', method: 'legacy', amount: 240 } },
    { key: 'julio-2026-09', label: 'Julio Alvarez · crédito (31-08, 30-09]', payer: 'Julio Alvarez', kind: 'credito', cycleStart: '2026-08-31', cycleEnd: '2026-09-30', amountFrom: 'legacy',
      lines: [{ beneficiary: 'Julio Alvarez', description: 'Sesiones cobrables del ciclo' }] }
  ],
  exclusions: [
    { key: 'michelle', label: 'Michelle Behar', reason: 'Etiqueta, periodo y fecha de la factura no concuerdan con el ciclo confirmado: la carga Joel a mano (J-045).' },
    { key: 'milo', label: 'Milo Asís', reason: 'Falta el segundo cobro declarado del 28-09 y no se reconstruyen con seguridad ambos ciclos: la carga Joel a mano (J-045).' },
    { key: 'sara-djamous', label: 'Sara Djamous', reason: 'Fechas de ciclo, compra, vencimiento y factura pendiente no concuerdan: la carga Joel a mano (J-045).' }
  ],
  // Joel pidió incluirlas (J-056): una factura de clase suelta y su cobro por cada clase pagada desde el 01-09-2026.
  singleClasses: [
    { key: 'susie', label: 'Susie Asís (clases sueltas)', client: 'Susie Asís', since: '2026-09-01' },
    { key: 'reina', label: 'Reina Yohoros (clases sueltas)', client: 'Reina Yohoros', since: '2026-09-01' },
    { key: 'sara-hidrie', label: 'Sara Hidrie (clases sueltas)', client: 'Sara Hidrie', since: '2026-09-01' }
  ]
};

// ── Utilidades ───────────────────────────────────────────────────────────────
const dates0 = (rows: Record<string, any>[]) => [...new Set(rows.map(row => String(row.paid_on)))];
const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100);
const fromCents = (value: number) => value / 100;
const METHODS = ['Efectivo', 'Yappy', 'Transferencia bancaria', 'Tarjeta', 'Otro'];

export class ImportConflict extends Error { statusCode = 409; }
export class ImportNotFound extends Error { statusCode = 404; }

// JSON canónico (claves ordenadas) para que el hash no dependa del orden de inserción.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

type Tx = TransactionSql<Record<string, unknown>>;
type Item = {
  seq: number; kind: 'invoice' | 'exclusion'; decision: 'incluir' | 'excluir' | 'revisar' | 'ya_aplicado';
  key: string; label: string; externalId: string | null; reasons: string[]; data: Record<string, any>; sourceIds: Record<string, any>;
};
export type Preview = { items: Item[]; totals: Record<string, any>; counterBefore: number; hash: string; manifestHash: string };

type ResolvedClient = { id: string; name: string; cutDay: number | null; error?: undefined } | { error: string };
type ClientIndexRow = { id: string; name: string; norm: string; tokens: string[]; cutDay: number | null };

// Los nombres de la lista y los del sistema se comparan sin acentos, sin diferencias de mayúsculas y con los
// espacios (incluido el espacio duro) colapsados: "Sally  Dayán Safdi" y "sally dayan safdi" son la misma persona.
export const normalizeName = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s\u00a0]+/g, ' ').trim().toLowerCase();

async function loadClientIndex(tx: Tx, ownerId: string): Promise<ClientIndexRow[]> {
  const rows = await tx`SELECT id::text AS id, full_name, billing_cutoff_day FROM clients WHERE owner_id = ${ownerId}`;
  return rows.map(row => {
    const norm = normalizeName(String(row.full_name));
    return { id: row.id as string, name: row.full_name as string, norm, tokens: norm.split(' ').filter(token => token.length >= 3), cutDay: row.billing_cutoff_day as number | null };
  });
}

// Solo coincide un nombre IGUAL (normalizado). Si no hay coincidencia NO se adivina: se sugieren los clientes
// que comparten alguna palabra para que se corrija la lista a propósito.
function resolveClient(index: ClientIndexRow[], name: string): ResolvedClient {
  const target = normalizeName(name);
  const exact = index.filter(row => row.norm === target);
  if (exact.length === 1) return { id: exact[0].id, name: exact[0].name, cutDay: exact[0].cutDay };
  if (exact.length > 1) return { error: `Hay más de un cliente llamado "${name}"` };
  const words = target.split(' ').filter(token => token.length >= 3);
  const near = index.filter(row => words.some(word => row.tokens.includes(word))).slice(0, 4).map(row => `"${row.name}"`);
  return { error: `No se encontró al cliente "${name}"${near.length ? `. ¿Será ${near.join(' o ')}?` : ''}` };
}

// Evidencia del dinero en el sistema anterior: cobros de ese pagador en esa fecha.
async function legacyPayments(tx: Tx, payerId: string, paidOn: string) {
  return tx`
    SELECT DISTINCT p.id::text AS id, p.amount::text AS amount, p.method
    FROM invoice_payments p
    LEFT JOIN payment_allocations a ON a.payment_id = p.id
    LEFT JOIN invoices i ON i.id = a.invoice_id
    WHERE p.paid_on = ${paidOn}::date
      AND (p.client_id = ${payerId} OR i.client_id = ${payerId} OR i.billed_for_client_id = ${payerId})`;
}
// Cobros del pagador aplicados a facturas viejas de ese ciclo, sin fijar la fecha (para "paidOn: legacy").
async function legacyPaymentsInWindow(tx: Tx, payerId: string, cycleStart: string, cycleEnd: string) {
  return tx`
    SELECT DISTINCT p.id::text AS id, p.amount::text AS amount, p.paid_on::text AS paid_on, p.method
    FROM invoice_payments p
    JOIN payment_allocations a ON a.payment_id = p.id
    JOIN invoices i ON i.id = a.invoice_id
    WHERE (i.client_id = ${payerId} OR i.billed_for_client_id = ${payerId})
      AND i.due_on BETWEEN (${cycleStart}::date - 35) AND ${cycleEnd}::date
      AND p.paid_on BETWEEN (${cycleStart}::date - 7) AND ${cycleEnd}::date`;
}
async function legacyAllocatedInvoices(tx: Tx, paymentIds: string[]) {
  if (!paymentIds.length) return [] as string[];
  const rows = await tx`SELECT DISTINCT invoice_id::text AS id FROM payment_allocations WHERE payment_id IN ${tx(paymentIds)}`;
  return rows.map(row => row.id as string);
}
// Evidencia de una factura pendiente en el sistema anterior.
async function legacyPendingInvoices(tx: Tx, payerId: string, cycleStart: string, cycleEnd: string) {
  return tx`
    SELECT i.id::text AS id, i.amount::text AS amount
    FROM invoices i
    WHERE i.client_id = ${payerId} AND i.status = 'pending'
      AND i.due_on BETWEEN (${cycleStart}::date - 35) AND ${cycleEnd}::date`;
}

// ── Vista previa ─────────────────────────────────────────────────────────────
export async function buildImportPreview(tx: Tx, ownerId: string, manifest: ImportManifest): Promise<Preview> {
  const [counterRow] = await tx`SELECT last_number FROM billing_counters WHERE owner_id = ${ownerId} AND name = 'invoice'`;
  const counterBefore = Number(counterRow?.last_number ?? 0);
  const manifestHash = sha256(canonicalJson(manifest));
  const items: Item[] = [];
  let projected = counterBefore;
  let seq = 0;
  const clientIndex = await loadClientIndex(tx, ownerId);

  for (const entry of manifest.entries) {
    seq += 1;
    const reasons: string[] = [];
    const externalId = `import:${entry.key}`;
    const sourceIds: Record<string, any> = { payments: [], invoices: [] };

    const payer = resolveClient(clientIndex, entry.payer);
    if (payer.error !== undefined) reasons.push(payer.error);
    const lines: Record<string, any>[] = [];
    for (const line of entry.lines) {
      const beneficiary = resolveClient(clientIndex, line.beneficiary);
      if (beneficiary.error !== undefined) { reasons.push(beneficiary.error); continue; }
      lines.push({ beneficiaryId: beneficiary.id, beneficiary: beneficiary.name, description: line.description ?? 'Plan', quantity: 1,
        unitAmount: line.amount ?? null, amount: line.amount ?? null, sessionsReference: line.sessionsReference ?? null });
    }
    if (entry.cycleEnd < entry.cycleStart) reasons.push('El fin del ciclo es anterior a su inicio');
    if (new Set(entry.lines.map(line => line.beneficiary.toLowerCase().trim())).size !== entry.lines.length) reasons.push('Una persona aparece más de una vez en la factura');

    let total = cents(entry.lines.reduce((sum, line) => sum + Number(line.amount ?? 0), 0));
    let legacyAmount: number | null = null;
    let alreadyApplied = false;
    let resolvedMethod: string | null = null;
    let resolvedPaidOn: string | null = null;

    if (payer.error === undefined) {
      if (entry.payment) {
        const declared = entry.payment.paidOn;
        const found = declared === 'legacy'
          ? await legacyPaymentsInWindow(tx, payer.id, entry.cycleStart, entry.cycleEnd)
          : await legacyPayments(tx, payer.id, declared);
        let paidOn: string | null = declared === 'legacy' ? null : declared;
        if (declared === 'legacy') {
          const dates = [...new Set(found.map(row => String(row.paid_on)))];
          if (dates.length === 1) paidOn = dates[0];
          else if (dates.length > 1) reasons.push(`Hay cobros de ${entry.payer} en varias fechas (${dates.sort().join(', ')}): indique cuál es`);
        }
        const sum = found.reduce((acc, row) => acc + cents(row.amount), 0);
        sourceIds.payments = found.map(row => row.id as string).sort();
        if (!found.length) {
          reasons.push(declared === 'legacy' ? `No hay un cobro de ${entry.payer} para ese ciclo en el sistema anterior` : `No hay un cobro de ${entry.payer} del ${declared} en el sistema anterior`);
        } else {
          // El método tiene que coincidir con el registrado en el sistema anterior (si éste lo trae).
          const legacyMethods = [...new Set(found.map(row => String(row.method ?? '').trim()).filter(Boolean))];
          let method: string = entry.payment.method;
          if (entry.payment.method === 'legacy') {
            if (legacyMethods.length === 1 && METHODS.some(candidate => candidate.toLowerCase() === legacyMethods[0].toLowerCase())) method = METHODS.find(candidate => candidate.toLowerCase() === legacyMethods[0].toLowerCase())!;
            else reasons.push(legacyMethods.length ? `El método del cobro en el sistema anterior no es utilizable: ${legacyMethods.join(', ')}` : 'El cobro del sistema anterior no trae método');
          } else {
            if (!METHODS.includes(method)) reasons.push(`Método de pago no válido: ${method}`);
            if (legacyMethods.length && !legacyMethods.every(candidate => candidate.toLowerCase() === method.toLowerCase())) reasons.push(`El método del cobro no coincide: la lista dice ${method} y el sistema anterior ${legacyMethods.join(', ')}`);
          }
          resolvedMethod = method;
          if (sum !== cents(entry.payment.amount) && (declared !== 'legacy' || dates0(found).length === 1)) reasons.push(`El cobro del sistema anterior no coincide: hay ${fromCents(sum).toFixed(2)} y se esperaban ${entry.payment.amount.toFixed(2)}`);
        }
        resolvedPaidOn = paidOn;
        sourceIds.invoices = (await legacyAllocatedInvoices(tx, sourceIds.payments)).sort();
        if (cents(entry.payment.amount) > total && entry.amountFrom !== 'legacy') reasons.push('El cobro supera el total de la factura');
      } else {
        const pending = await legacyPendingInvoices(tx, payer.id, entry.cycleStart, entry.cycleEnd);
        const sum = pending.reduce((acc, row) => acc + cents(row.amount), 0);
        sourceIds.invoices = pending.map(row => row.id as string).sort();
        legacyAmount = fromCents(sum);
        if (!pending.length) reasons.push(`No hay una factura pendiente de ${entry.payer} para ese ciclo en el sistema anterior`);
        else if (entry.amountFrom === 'legacy') { total = sum; if (lines.length === 1) { lines[0].unitAmount = fromCents(sum); lines[0].amount = fromCents(sum); } }
        else if (sum !== total) reasons.push(`La factura pendiente del sistema anterior no coincide: hay ${fromCents(sum).toFixed(2)} y se esperaban ${fromCents(total).toFixed(2)}`);
      }
      // Ya existe una factura nueva de ese pagador y ciclo (que no es este mismo lote)?
      const existing = await tx`SELECT id::text AS id, external_id FROM billing_invoices
        WHERE owner_id = ${ownerId} AND payer_client_id = ${payer.id} AND cycle_start = ${entry.cycleStart}::date AND kind = ${entry.kind} AND status <> 'anulada'`;
      alreadyApplied = existing.some(row => row.external_id === externalId);
      if (existing.length && !alreadyApplied && ['mensual', 'credito', 'paquete'].includes(entry.kind)) reasons.push('Ya existe una factura nueva de este pagador para ese ciclo');
    }

    if (total <= 0) reasons.push('El total de la factura debe ser mayor que cero');
    const uniqueReasons = [...new Set(reasons)];
    reasons.splice(0, reasons.length, ...uniqueReasons);
    const decision: Item['decision'] = alreadyApplied ? 'ya_aplicado' : reasons.length ? 'revisar' : 'incluir';
    const issuedOn = entry.issuedOn ?? entry.cycleStart;
    const data: Record<string, any> = {
      payer: payer.error === undefined ? { id: payer.id, name: payer.name } : { id: null, name: entry.payer },
      kind: entry.kind, cycleStart: entry.cycleStart, cycleEnd: entry.cycleEnd,
      cutDay: entry.cutDay ?? (payer.error === undefined ? payer.cutDay : null) ?? Number(entry.cycleStart.slice(8, 10)),
      issuedOn, dueOn: entry.dueOn ?? issuedOn, lines, total: fromCents(total), legacyAmount,
      payment: entry.payment ? { paidOn: resolvedPaidOn ?? entry.payment.paidOn, method: resolvedMethod ?? entry.payment.method, amount: entry.payment.amount, reference: entry.payment.reference ?? null } : null,
      status: entry.payment && cents(entry.payment.amount) >= total ? 'pagada' : entry.payment ? 'parcial' : 'pendiente',
      projectedNumber: null
    };
    if (decision === 'incluir') { projected += 1; data.projectedNumber = projected; }
    items.push({ seq, kind: 'invoice', decision, key: entry.key, label: entry.label, externalId, reasons, data, sourceIds });
  }

  // Clases sueltas: una factura y un cobro por cada factura vieja pagada de esa persona desde `since`.
  for (const single of manifest.singleClasses ?? []) {
    const person = resolveClient(clientIndex, single.client);
    if (person.error !== undefined) {
      seq += 1;
      items.push({ seq, kind: 'invoice', decision: 'revisar', key: `${single.key}:cliente`, label: single.label, externalId: null, reasons: [person.error], data: {}, sourceIds: {} });
      continue;
    }
    const legacy = await tx`
      SELECT i.id::text AS id, i.concept, i.amount::text AS amount, i.status, i.package_id::text AS package_id
      FROM invoices i
      WHERE i.client_id = ${person.id} AND COALESCE(i.billed_for_client_id, i.client_id) = ${person.id}
        AND i.status <> 'void' AND i.due_on >= ${single.since}::date
      ORDER BY i.due_on, i.created_at, i.id`;
    const rows: { invoice: Record<string, any>; payments: Record<string, any>[] }[] = [];
    for (const invoice of legacy) {
      const payments = await tx`
        SELECT p.id::text AS id, p.amount::text AS amount, p.paid_on::text AS paid_on, p.method, p.reference
        FROM payment_allocations a JOIN invoice_payments p ON p.id = a.payment_id WHERE a.invoice_id = ${invoice.id}`;
      rows.push({ invoice, payments: payments as unknown as Record<string, any>[] });
    }
    // Primero por fecha de cobro (la fecha declarada), para que la numeración siga el orden de las clases.
    rows.sort((a, b) => String(a.payments[0]?.paid_on ?? '9999').localeCompare(String(b.payments[0]?.paid_on ?? '9999')));
    for (const { invoice, payments } of rows) {
      seq += 1;
      const reasons: string[] = [];
      const externalId = `import:single:${invoice.id}`;
      const amount = cents(invoice.amount);
      if (invoice.status !== 'confirmed') reasons.push('La clase suelta está pendiente de cobro en el sistema anterior');
      const accepted = (single.accept ?? []).some(rule => payments[0] && String(payments[0].paid_on) === rule.date && cents(rule.amount) === amount);
      if (!accepted && (/mensual|paquete/i.test(String(invoice.concept ?? '')) || invoice.package_id)) reasons.push('No parece una clase suelta (concepto de mensualidad o paquete)');
      if (payments.length !== 1) reasons.push(payments.length === 0 ? 'No tiene un cobro aplicado en el sistema anterior' : `Tiene ${payments.length} cobros aplicados: se revisa a mano`);
      const payment = payments[0];
      if (payment && cents(payment.amount) !== amount) reasons.push(`El cobro (${fromCents(cents(payment.amount)).toFixed(2)}) no coincide con la factura (${fromCents(amount).toFixed(2)})`);
      const method = payment ? METHODS.find(candidate => candidate.toLowerCase() === String(payment.method ?? '').trim().toLowerCase()) : undefined;
      if (payment && !method) reasons.push(payment.method ? `Método de pago no utilizable: ${payment.method}` : 'El cobro del sistema anterior no trae método');
      if (amount <= 0) reasons.push('El importe debe ser mayor que cero');
      const [exists] = await tx`SELECT 1 AS yes FROM billing_invoices WHERE owner_id = ${ownerId} AND external_id = ${externalId}`;
      const decision: Item['decision'] = exists ? 'ya_aplicado' : reasons.length ? 'revisar' : 'incluir';
      const paidOn = payment ? String(payment.paid_on) : null;
      const data: Record<string, any> = paidOn ? {
        payer: { id: person.id, name: person.name }, kind: 'clase_suelta', cycleStart: paidOn, cycleEnd: paidOn, cutDay: Number(paidOn.slice(8, 10)),
        issuedOn: paidOn, dueOn: paidOn,
        lines: [{ beneficiaryId: person.id, beneficiary: person.name, description: String(invoice.concept ?? 'Sesión individual') || 'Sesión individual', quantity: 1, unitAmount: fromCents(amount), amount: fromCents(amount), sessionsReference: null }],
        total: fromCents(amount), legacyAmount: null,
        payment: { paidOn, method: method ?? payment!.method, amount: fromCents(amount), reference: payment!.reference ?? null }, status: 'pagada', projectedNumber: null
      } : { payer: { id: person.id, name: person.name }, kind: 'clase_suelta', total: fromCents(amount), lines: [], payment: null, status: 'pendiente', projectedNumber: null };
      if (decision === 'incluir') { projected += 1; data.projectedNumber = projected; }
      items.push({ seq, kind: 'invoice', decision, key: `${single.key}:${invoice.id}`, label: `${single.label} · ${paidOn ?? 'sin fecha'} · ${fromCents(amount).toFixed(2)}`, externalId, reasons, data,
        sourceIds: { payments: payments.map(row => row.id as string), invoices: [invoice.id as string] } });
    }
  }

  for (const exclusion of manifest.exclusions) {
    seq += 1;
    items.push({ seq, kind: 'exclusion', decision: 'excluir', key: exclusion.key, label: exclusion.label, externalId: null, reasons: [exclusion.reason], data: {}, sourceIds: {} });
  }

  const included = items.filter(item => item.decision === 'incluir');
  const invoiceCents = included.reduce((sum, item) => sum + cents(item.data.total), 0);
  const paymentCents = included.reduce((sum, item) => sum + cents(item.data.payment?.amount ?? 0), 0);
  const totals = {
    invoices: included.length, invoicesTotal: fromCents(invoiceCents),
    payments: included.filter(item => item.data.payment).length, paymentsTotal: fromCents(paymentCents),
    openBalance: fromCents(invoiceCents - paymentCents),
    paid: included.filter(item => item.data.status === 'pagada').length, pending: included.filter(item => item.data.status === 'pendiente').length,
    review: items.filter(item => item.decision === 'revisar').length,
    alreadyApplied: items.filter(item => item.decision === 'ya_aplicado').length,
    excluded: items.filter(item => item.decision === 'excluir').length,
    firstNumber: included.length ? counterBefore + 1 : null, lastNumber: included.length ? projected : null
  };
  const hash = sha256(canonicalJson({ manifestHash, counterBefore, items: items.map(item => ({ seq: item.seq, key: item.key, decision: item.decision, externalId: item.externalId, reasons: item.reasons, data: item.data, sourceIds: item.sourceIds })) }));
  return { items, totals, counterBefore, hash, manifestHash };
}

// ── Lotes ────────────────────────────────────────────────────────────────────
// La lectura del sistema anterior se hace en una transacción de SOLO LECTURA con instantánea
// consistente: el generador viejo puede seguir escribiendo sin que la vista previa salga a medias.
export async function createPreviewBatch(ownerId: string, userId: string, manifest: ImportManifest) {
  const preview = await sql.begin('isolation level repeatable read read only', tx => buildImportPreview(tx as unknown as Tx, ownerId, manifest));
  return sql.begin(async tx => {
    await tx`UPDATE billing_import_batches SET status = 'superseded' WHERE owner_id = ${ownerId} AND status IN ('preview', 'approved')`;
    const [batch] = await tx`
      INSERT INTO billing_import_batches (owner_id, status, manifest, manifest_hash, preview_hash, source_info, totals, counter_before, created_by)
      VALUES (${ownerId}, 'preview', ${tx.json(manifest as any)}, ${preview.manifestHash}, ${preview.hash},
        ${tx.json({ source: 'tablas del sistema anterior (lectura, instantánea consistente)', generatedAt: new Date().toISOString() } as any)},
        ${tx.json(preview.totals as any)}, ${preview.counterBefore}, ${userId})
      RETURNING id::text AS id`;
    for (const item of preview.items) {
      await tx`
        INSERT INTO billing_import_items (batch_id, seq, kind, decision, key, label, external_id, reasons, data, source_ids)
        VALUES (${batch.id}, ${item.seq}, ${item.kind}, ${item.decision}, ${item.key}, ${item.label}, ${item.externalId},
          ${tx.json(item.reasons as any)}, ${tx.json(item.data as any)}, ${tx.json(item.sourceIds as any)})`;
    }
    return { id: batch.id as string, ...preview };
  });
}

export async function getBatch(ownerId: string, batchId: string) {
  const [batch] = await sql`SELECT * FROM billing_import_batches WHERE id = ${batchId} AND owner_id = ${ownerId}`;
  if (!batch) throw new ImportNotFound('Lote no encontrado');
  const items = await sql`SELECT seq, kind, decision, key, label, external_id, reasons, data, source_ids, destination_invoice_id::text AS destination_invoice_id,
    destination_payment_id::text AS destination_payment_id FROM billing_import_items WHERE batch_id = ${batchId} ORDER BY seq`;
  return { batch, items };
}

export async function listBatches(ownerId: string) {
  return sql`SELECT id::text AS id, status, preview_hash, totals, counter_before, counter_after, created_at, approved_at, applied_at, reversed_at
    FROM billing_import_batches WHERE owner_id = ${ownerId} ORDER BY created_at DESC LIMIT 20`;
}

export async function approveBatch(ownerId: string, userId: string, batchId: string, previewHash: string) {
  return sql.begin(async tx => {
    const [batch] = await tx`SELECT id, status, preview_hash FROM billing_import_batches WHERE id = ${batchId} AND owner_id = ${ownerId} FOR UPDATE`;
    if (!batch) throw new ImportNotFound('Lote no encontrado');
    if (batch.status !== 'preview') throw new ImportConflict(`El lote está en estado "${batch.status}": solo se aprueba una vista previa vigente`);
    if (batch.preview_hash !== previewHash) throw new ImportConflict('El hash no coincide con la vista previa: genere una nueva y revísela');
    const [{ n }] = await tx`SELECT count(*)::int AS n FROM billing_import_items WHERE batch_id = ${batchId} AND decision = 'revisar'`;
    // Se puede aprobar con entradas por revisar (quedan fuera, las carga Joel), pero se avisa en la respuesta.
    await tx`UPDATE billing_import_batches SET status = 'approved', approved_at = now(), approved_by = ${userId} WHERE id = ${batchId}`;
    return { approved: true, review: n };
  });
}

const settleStatus = (total: number, paid: number) => (total > 0 && paid >= total ? 'pagada' : paid > 0 ? 'parcial' : 'pendiente');

export async function applyBatch(ownerId: string, userId: string, batchId: string, opts: { legacyWrites: boolean }) {
  if (opts.legacyWrites) {
    throw new ImportConflict('El generador del sistema anterior sigue activo: apáguelo (LEGACY_BILLING_GENERATION=off) antes de aplicar la carga, o los datos cambiarían durante la carga');
  }
  return sql.begin(async tx => {
    const [batch] = await tx`SELECT * FROM billing_import_batches WHERE id = ${batchId} AND owner_id = ${ownerId} FOR UPDATE`;
    if (!batch) throw new ImportNotFound('Lote no encontrado');
    if (batch.status !== 'approved') throw new ImportConflict(`El lote está en estado "${batch.status}": solo se aplica un lote aprobado`);
    // Bloquea el contador del dueño (y lo crea si no existe) hasta el final de la transacción.
    await tx`INSERT INTO billing_counters (owner_id, name, last_number) VALUES (${ownerId}, 'invoice', 0) ON CONFLICT (owner_id, name) DO NOTHING`;
    const [counter] = await tx`SELECT last_number FROM billing_counters WHERE owner_id = ${ownerId} AND name = 'invoice' FOR UPDATE`;
    if (Number(counter.last_number) !== Number(batch.counter_before)) {
      throw new ImportConflict(`Se emitieron facturas desde la vista previa (contador ${counter.last_number}, se esperaba ${batch.counter_before}): genere una vista previa nueva`);
    }
    const fresh = await buildImportPreview(tx as unknown as Tx, ownerId, batch.manifest as ImportManifest);
    if (fresh.hash !== batch.preview_hash) {
      throw new ImportConflict('Los datos cambiaron desde que se aprobó la vista previa: genere una nueva y revísela');
    }

    const created: { key: string; externalId: string; code: string; invoiceId: string; paymentId: string | null }[] = [];
    for (const item of fresh.items.filter(candidate => candidate.decision === 'incluir')) {
      const d = item.data;
      const [{ n }] = await tx`SELECT billing_next_number(${ownerId}) AS n`;
      if (Number(n) !== d.projectedNumber) throw new ImportConflict(`El número asignado (${n}) no coincide con el de la vista previa (${d.projectedNumber})`);
      const [invoice] = await tx`
        INSERT INTO billing_invoices (owner_id, number, payer_client_id, kind, origin, cycle_start, cycle_end, cut_day, issued_on, due_on, total, notes, created_by, source_system, external_id)
        VALUES (${ownerId}, ${n}, ${d.payer.id}, ${d.kind}, 'carga_inicial', ${d.cycleStart}, ${d.cycleEnd}, ${d.cutDay}, ${d.issuedOn}, ${d.dueOn}, ${d.total},
          ${`Carga inicial (lote ${batchId.slice(0, 8)})`}, ${userId}, 'legacy_import', ${item.externalId})
        RETURNING id::text AS id`;
      for (const line of d.lines) {
        await tx`
          INSERT INTO billing_invoice_lines (invoice_id, beneficiary_client_id, line_type, description, quantity, unit_amount, amount, sessions_reference)
          VALUES (${invoice.id}, ${line.beneficiaryId}, 'plan', ${line.description}, 1, ${line.unitAmount}, ${line.amount}, ${line.sessionsReference})`;
      }
      let paymentId: string | null = null;
      if (d.payment) {
        const [payment] = await tx`
          INSERT INTO billing_payments (owner_id, payer_client_id, paid_on, amount, method, reference, notes, created_by, source_system, external_id)
          VALUES (${ownerId}, ${d.payer.id}, ${d.payment.paidOn}, ${d.payment.amount}, ${d.payment.method}, ${d.payment.reference},
            ${`Carga inicial (lote ${batchId.slice(0, 8)})`}, ${userId}, 'legacy_import', ${`${item.externalId}:payment`})
          RETURNING id::text AS id`;
        paymentId = payment.id as string;
        await tx`INSERT INTO billing_payment_applications (payment_id, invoice_id, amount, applied_on, created_by)
          VALUES (${paymentId}, ${invoice.id}, ${d.payment.amount}, ${d.payment.paidOn}, ${userId})`;
        await tx`UPDATE billing_invoices SET status = ${settleStatus(cents(d.total), cents(d.payment.amount))} WHERE id = ${invoice.id}`;
      }
      await tx`UPDATE billing_import_items SET destination_invoice_id = ${invoice.id}, destination_payment_id = ${paymentId}
        WHERE batch_id = ${batchId} AND seq = ${item.seq}`;
      created.push({ key: item.key, externalId: item.externalId as string, code: `FAC-${String(n).padStart(4, '0')}`, invoiceId: invoice.id as string, paymentId });
    }

    // Conteos y totales dentro de la misma transacción: si no coinciden con la vista previa, no queda nada.
    const [check] = await tx`
      SELECT count(*)::int AS invoices, COALESCE(sum(total), 0)::numeric AS total FROM billing_invoices
      WHERE owner_id = ${ownerId} AND source_system = 'legacy_import' AND external_id IN ${tx(created.length ? created.map(row => row.externalId) : [''])}`;
    if (check.invoices !== fresh.totals.invoices || cents(check.total) !== cents(fresh.totals.invoicesTotal)) {
      throw new ImportConflict('Los totales creados no coinciden con la vista previa: se canceló toda la carga');
    }
    const [after] = await tx`SELECT last_number FROM billing_counters WHERE owner_id = ${ownerId} AND name = 'invoice'`;
    await tx`UPDATE billing_import_batches SET status = 'applied', applied_at = now(), applied_by = ${userId}, counter_after = ${after.last_number} WHERE id = ${batchId}`;
    await tx`INSERT INTO billing_audit (owner_id, user_id, action, entity, entity_id, detail)
      VALUES (${ownerId}, ${userId}, 'IMPORT_APPLY', 'import_batch', ${batchId}, ${tx.json({ totals: fresh.totals, created } as any)})`;
    return { applied: true, totals: fresh.totals, created };
  });
}

export async function reverseBatch(ownerId: string, userId: string, batchId: string, reason: string) {
  return sql.begin(async tx => {
    const [batch] = await tx`SELECT * FROM billing_import_batches WHERE id = ${batchId} AND owner_id = ${ownerId} FOR UPDATE`;
    if (!batch) throw new ImportNotFound('Lote no encontrado');
    if (batch.status !== 'applied') throw new ImportConflict(`El lote está en estado "${batch.status}": solo se revierte un lote aplicado`);
    const [counter] = await tx`SELECT last_number FROM billing_counters WHERE owner_id = ${ownerId} AND name = 'invoice' FOR UPDATE`;
    if (Number(counter.last_number) !== Number(batch.counter_after)) {
      throw new ImportConflict('Ya se emitieron facturas después de la carga: no se puede borrar el lote. Corrija con anulaciones y reversiones de aplicaciones');
    }
    const items = await tx`SELECT destination_invoice_id::text AS invoice_id, destination_payment_id::text AS payment_id FROM billing_import_items
      WHERE batch_id = ${batchId} AND destination_invoice_id IS NOT NULL`;
    const invoiceIds = items.map(item => item.invoice_id as string);
    const paymentIds = items.map(item => item.payment_id as string | null).filter((id): id is string => !!id);
    if (invoiceIds.length) {
      const [voided] = await tx`SELECT count(*)::int AS n FROM billing_invoices WHERE id IN ${tx(invoiceIds)} AND status = 'anulada'`;
      if (voided.n > 0) throw new ImportConflict('Alguna factura del lote ya fue anulada: el lote recibió cambios y no se puede borrar');
      const [foreign] = await tx`SELECT count(*)::int AS n FROM billing_payment_applications
        WHERE invoice_id IN ${tx(invoiceIds)} AND (${paymentIds.length ? tx`payment_id NOT IN ${tx(paymentIds)}` : tx`true`} OR reversed_at IS NOT NULL)`;
      if (foreign.n > 0) throw new ImportConflict('Alguna factura del lote recibió cobros o cambios posteriores: no se puede borrar el lote');
    }
    if (paymentIds.length) {
      const [changed] = await tx`SELECT count(*)::int AS n FROM billing_payments WHERE id IN ${tx(paymentIds)} AND voided_at IS NOT NULL`;
      if (changed.n > 0) throw new ImportConflict('Algún cobro del lote fue anulado: no se puede borrar el lote');
    }
    // Única vía de borrado: activa la excepción SOLO dentro de esta transacción.
    await tx`SELECT set_config('billing.allow_import_reverse', 'on', true)`;
    if (invoiceIds.length) await tx`DELETE FROM billing_payment_applications WHERE invoice_id IN ${tx(invoiceIds)}`;
    if (paymentIds.length) await tx`DELETE FROM billing_payments WHERE id IN ${tx(paymentIds)}`;
    if (invoiceIds.length) {
      await tx`DELETE FROM billing_invoice_lines WHERE invoice_id IN ${tx(invoiceIds)}`;
      await tx`DELETE FROM billing_invoices WHERE id IN ${tx(invoiceIds)}`;
    }
    await tx`UPDATE billing_counters SET last_number = ${batch.counter_before} WHERE owner_id = ${ownerId} AND name = 'invoice'`;
    await tx`UPDATE billing_import_items SET destination_invoice_id = NULL, destination_payment_id = NULL WHERE batch_id = ${batchId}`;
    await tx`UPDATE billing_import_batches SET status = 'reversed', reversed_at = now(), reversed_by = ${userId}, reversal_reason = ${reason} WHERE id = ${batchId}`;
    await tx`INSERT INTO billing_audit (owner_id, user_id, action, entity, entity_id, detail)
      VALUES (${ownerId}, ${userId}, 'IMPORT_REVERSE', 'import_batch', ${batchId}, ${tx.json({ reason, invoices: invoiceIds.length, payments: paymentIds.length } as any)})`;
    return { reversed: true, invoices: invoiceIds.length, payments: paymentIds.length, counter: Number(batch.counter_before) };
  });
}
