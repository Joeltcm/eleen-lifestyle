// Generador de facturas del módulo nuevo (etapa 1B-6).
//
// Emite las facturas recurrentes a partir de los PLANES DE FACTURACIÓN declarados en el expediente
// (billing_subscriptions), con las reglas decididas por Joel:
//   * Solo CONTINÚA: emite el ciclo siguiente al último facturado de cada pagador y modalidad (D-15).
//     Nunca emite un ciclo para quien no tiene factura previa ("sin referencia": se crea a mano y salta
//     una alerta) ni un ciclo atrasado (se avisa: "se crea a mano"): solo se emite EL MISMO DÍA que toca (RETRO_DAYS = 0, decisión de Joel 01-10-2026).
//   * Mensual y paquete son ANTICIPADOS: la factura sale el día en que empieza el ciclo y vence ese día (O-2).
//     El paquete usa su propia duración en días (Sara Djamous: 35).
//   * El CRÉDITO (Julio) es POSTPAGO: al cerrar el ciclo cobra las clases realmente impartidas (más las
//     cancelaciones que Eileen marcó como cobrables) × la tarifa por clase, en la ventana (corte anterior,
//     corte]. El día de corte pertenece al ciclo que termina y la factura sale ESE MISMO DÍA, a partir de
//     CREDIT_EMIT_HOUR (21:00 de Panamá), cuando las clases del día ya están marcadas.
//   * Una familia es UNA factura del pagador con una línea por persona; quien tiene un plan propio con
//     otro pagador (Ernesto) recibe además su propia factura.
//   * Las líneas con la casilla "Facturación automática" desmarcada se ignoran; las de personas en pausa o
//     inactivas tampoco se facturan.
//   * Sin retroactivos y sin duplicados: el índice único de ciclo por pagador y modalidad lo respalda.
//
// `planBillingGeneration` NO escribe (sirve para el modo sombra y para el reporte); `runBillingGeneration`
// escribe SOLO si el estado operativo lo permite (lo decide quien lo llama). "Hoy" se inyecta para poder
// probar con un reloj fijo.
import type { TransactionSql } from 'postgres';
import { sql } from './db.js';
import { fechaDeNegocioPanama, horaDeNegocioPanama } from './panama-date.js';

// Solo el día que toca (Joel, 01-10-2026): sin facturas "de rezago". El bucle corre cada 15 minutos, así que hay ~96 intentos ese día; si aun así no salió, se avisa y se crea a mano.
export const RETRO_DAYS = 0;
// A crédito (Julio): se emite EL DÍA DEL CORTE (último día del mes), pero solo a partir de esta hora de Panamá, para que ya estén marcadas las clases de ese día (Joel, 01-10-2026).
export const CREDIT_EMIT_HOUR = 21;

type Tx = TransactionSql<Record<string, unknown>>;
type Kind = 'mensual' | 'credito' | 'paquete';
const KIND_OF: Record<string, Kind> = { monthly: 'mensual', credit: 'credito', package: 'paquete' };
const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100);
const fromCents = (value: number) => value / 100;
const billingCode = (number: unknown) => `FAC-${String(number).padStart(4, '0')}`;

// ── Fechas (puras) ───────────────────────────────────────────────────────────
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (value: number) => String(value).padStart(2, '0');
export function cutOn(year: number, month: number, cutDay: number) { return `${year}-${pad(month)}-${pad(Math.min(cutDay, daysInMonth(year, month)))}`; }
// Primer corte ESTRICTAMENTE posterior a la fecha (29, 30 y 31 se ajustan al último día del mes).
export function nextCutAfter(iso: string, cutDay: number): string {
  const [year, month] = iso.split('-').map(Number);
  const thisMonth = cutOn(year, month, cutDay);
  if (thisMonth > iso) return thisMonth;
  return month === 12 ? cutOn(year + 1, 1, cutDay) : cutOn(year, month + 1, cutDay);
}
export function addDays(iso: string, days: number): string {
  const base = new Date(`${iso}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

// ── Tipos ────────────────────────────────────────────────────────────────────
export type PlannedLine = {
  subscriptionId: string; beneficiaryId: string; beneficiaryName: string; description: string;
  quantity: number; unitAmount: number; amount: number; sessionsReference: number | null;
};
export type PlannedInvoice = {
  payerId: string; payerName: string; kind: Kind; cycleStart: string; cycleEnd: string; cutDay: number;
  issuedOn: string; dueOn: string; lines: PlannedLine[]; total: number;
  // emitir: toca emitirla hoy; programada: llegará (solo en el horizonte); omitida: demasiado atrasada;
  // sin_cargo: crédito sin clases cobrables; sin_referencia: el pagador no tiene factura previa de esa modalidad
  status: 'emitir' | 'programada' | 'omitida' | 'sin_cargo' | 'sin_referencia';
  reason: string | null; referenceInvoiceId: string | null; referenceCode: string | null;
};
type Subscription = {
  id: string; beneficiaryId: string; beneficiaryName: string; beneficiaryStatus: string; payerId: string; payerName: string; payerStatus: string;
  payerCutDay: number; kind: Kind; cycleDays: number | null; sessionsReference: number | null; price: number; startsOn: string; endsOn: string | null;
};

async function loadSubscriptions(tx: Tx, ownerId: string): Promise<Subscription[]> {
  const rows = await tx`
    SELECT s.id::text AS id, s.beneficiary_client_id::text AS beneficiary_id, b.full_name AS beneficiary_name, b.status AS beneficiary_status,
      s.payer_client_id::text AS payer_id, p.full_name AS payer_name, p.status AS payer_status, p.billing_cutoff_day AS payer_cut_day,
      s.kind, s.cycle_days, s.sessions_reference, s.price::text AS price, s.starts_on::text AS starts_on, s.ends_on::text AS ends_on
    FROM billing_subscriptions s
    JOIN clients b ON b.id = s.beneficiary_client_id
    JOIN clients p ON p.id = s.payer_client_id
    WHERE s.owner_id = ${ownerId} AND s.auto_generate = true
    ORDER BY p.full_name, b.full_name, s.starts_on`;
  return rows.map(row => ({
    id: row.id as string, beneficiaryId: row.beneficiary_id as string, beneficiaryName: row.beneficiary_name as string, beneficiaryStatus: row.beneficiary_status as string,
    payerId: row.payer_id as string, payerName: row.payer_name as string, payerStatus: row.payer_status as string, payerCutDay: Number(row.payer_cut_day) || 1,
    kind: KIND_OF[row.kind as string], cycleDays: row.cycle_days == null ? null : Number(row.cycle_days),
    sessionsReference: row.sessions_reference == null ? null : Number(row.sessions_reference), price: Number(row.price),
    startsOn: row.starts_on as string, endsOn: (row.ends_on as string | null) ?? null
  }));
}

// Clases cobrables de una persona en la ventana (inicio, fin]: impartidas, más cancelaciones del cliente que
// Eileen marcó como cobrables (misma regla que el sistema anterior).
async function billableSessions(tx: Tx, beneficiaryId: string, startExclusive: string, endInclusive: string) {
  const rows = await tx`
    SELECT count(*)::int AS n FROM sessions s
    WHERE s.client_id = ${beneficiaryId}
      AND (s.starts_at AT TIME ZONE 'America/Panama')::date > ${startExclusive}::date
      AND (s.starts_at AT TIME ZONE 'America/Panama')::date <= ${endInclusive}::date
      AND (s.status = 'completed'
        OR (s.status = 'cancelled' AND s.cancellation_kind = 'not_rescheduled'
          AND COALESCE(s.cancelled_by, 'client') = 'client' AND s.credit_charge = true))`;
  return Number(rows[0]?.n ?? 0);
}

// ── Plan (sin escribir) ──────────────────────────────────────────────────────
export async function planBillingGeneration(tx: Tx, ownerId: string, today = fechaDeNegocioPanama(), horizonDays = 0, hour = horaDeNegocioPanama()): Promise<PlannedInvoice[]> {
  const subscriptions = await loadSubscriptions(tx, ownerId);
  const groups = new Map<string, Subscription[]>();
  for (const subscription of subscriptions) {
    const key = `${subscription.payerId}|${subscription.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), subscription]);
  }
  const horizon = addDays(today, horizonDays);
  const planned: PlannedInvoice[] = [];

  for (const lines of groups.values()) {
    const { payerId, payerName, kind, payerCutDay } = lines[0];
    const [last] = await tx`
      SELECT id::text AS id, number, cycle_start::text AS cycle_start, cycle_end::text AS cycle_end FROM billing_invoices
      WHERE owner_id = ${ownerId} AND payer_client_id = ${payerId} AND kind = ${kind} AND status <> 'anulada'
      ORDER BY cycle_start DESC, number DESC LIMIT 1`;
    const base = { payerId, payerName, kind, cutDay: payerCutDay };
    if (!last) {
      planned.push({ ...base, cycleStart: today, cycleEnd: today, issuedOn: today, dueOn: today, lines: [], total: 0, status: 'sin_referencia',
        reason: 'Sin factura previa de esta modalidad: la primera se crea a mano (D-15)', referenceInvoiceId: null, referenceCode: null });
      continue;
    }
    let refEnd = last.cycle_end as string;
    let referenceInvoiceId = last.id as string; let referenceCode = billingCode(last.number);
    for (let guard = 0; guard < 24; guard += 1) {
      const cycleStart = refEnd;
      const packageDays = kind === 'paquete' ? (lines.find(line => line.cycleDays)?.cycleDays ?? 35) : null;
      const cycleEnd = kind === 'paquete' ? addDays(cycleStart, packageDays!) : nextCutAfter(cycleStart, payerCutDay);
      // Una línea cuenta si estaba vigente en el ciclo (anticipadas: al empezar; crédito: durante la ventana).
      const active = lines.filter(line => line.startsOn <= (kind === 'credito' ? cycleEnd : cycleStart) && (!line.endsOn || line.endsOn >= cycleStart)
        && line.beneficiaryStatus === 'active' && line.payerStatus === 'active');
      if (!active.length) break;
      // Cuándo toca emitirla: anticipadas al empezar el ciclo; crédito el día de corte (fin del ciclo), a partir de CREDIT_EMIT_HOUR.
      const due = kind === 'credito' ? cycleEnd : cycleStart;
      if (due > horizon) break;
      const issuedOn = kind === 'credito' ? cycleEnd : cycleStart;
      let status: PlannedInvoice['status'] = due <= today ? 'emitir' : 'programada';
      let reason: string | null = null;
      if (kind === 'credito' && due === today && hour < CREDIT_EMIT_HOUR) { status = 'programada'; reason = `Se emite hoy desde las ${CREDIT_EMIT_HOUR}:00, al cerrar el día de corte, con las clases ya marcadas`; }
      if (status === 'emitir' && daysBetween(due, today) > RETRO_DAYS) {
        status = 'omitida'; reason = `El ciclo ${kind === 'credito' ? 'cerró' : 'empezó'} hace ${daysBetween(due, today)} ${daysBetween(due, today) === 1 ? 'día' : 'días'}: las facturas automáticas solo se emiten el mismo día del corte; se crea a mano`;
      }
      const invoiceLines: PlannedLine[] = [];
      let projection = false;
      for (const line of active) {
        if (kind === 'credito') {
          // Programada con el ciclo ya en curso: PROYECCIÓN con lo marcado hasta hoy (no se emite; el importe final se confirma el día de corte desde CREDIT_EMIT_HOUR).
          const enCurso = status === 'programada' && cycleStart <= today;
          const quantity = status === 'programada' && !enCurso ? 0 : await billableSessions(tx, line.beneficiaryId, cycleStart, cycleEnd);
          if (enCurso) projection = true;
          invoiceLines.push({ subscriptionId: line.id, beneficiaryId: line.beneficiaryId, beneficiaryName: line.beneficiaryName, description: 'Sesiones a crédito',
            quantity, unitAmount: line.price, amount: fromCents(quantity * cents(line.price)), sessionsReference: quantity || null });
        } else {
          invoiceLines.push({ subscriptionId: line.id, beneficiaryId: line.beneficiaryId, beneficiaryName: line.beneficiaryName,
            description: kind === 'paquete' ? 'Paquete' : 'Mensualidad', quantity: 1, unitAmount: line.price, amount: line.price, sessionsReference: line.sessionsReference });
        }
      }
      const total = fromCents(invoiceLines.reduce((sum, line) => sum + cents(line.amount), 0));
      if (projection && status === 'programada' && !reason) {
        const clases = invoiceLines.reduce((sum, line) => sum + line.quantity, 0);
        reason = `Proyección con lo marcado hasta hoy: ${clases} ${clases === 1 ? 'clase' : 'clases'}. El importe final se confirma el ${cycleEnd.split('-').reverse().join('-')} desde las ${CREDIT_EMIT_HOUR}:00`;
      }
      if (kind === 'credito' && status === 'emitir' && total === 0) { status = 'sin_cargo'; reason = 'Sin clases cobrables en el ciclo: no hay nada que facturar'; }
      planned.push({ ...base, cycleStart, cycleEnd, issuedOn, dueOn: issuedOn, lines: invoiceLines.filter(line => kind !== 'credito' || line.quantity > 0 || status === 'programada'), total,
        status, reason, referenceInvoiceId, referenceCode });
      // Para planear el ciclo siguiente se supone emitido este.
      refEnd = cycleEnd; referenceInvoiceId = '(plan)'; referenceCode = '(plan)';
      if (status === 'omitida') break;
    }
  }
  return planned.sort((a, b) => a.cycleStart.localeCompare(b.cycleStart) || a.payerName.localeCompare(b.payerName, 'es'));
}

// ── Emisión (escribe) ────────────────────────────────────────────────────────
export type GenerationResult = { created: { code: string; invoiceId: string; payerName: string; kind: Kind; cycleStart: string; cycleEnd: string; total: number }[];
  skipped: { payerName: string; kind: Kind; status: PlannedInvoice['status']; reason: string | null }[] };

// Emite lo que toca HOY. Cada factura va en su propia transacción: si una falla, las demás siguen.
export async function runBillingGeneration(ownerId: string, today = fechaDeNegocioPanama(), hour = horaDeNegocioPanama()): Promise<GenerationResult> {
  const plan = await sql.begin('isolation level repeatable read read only', tx => planBillingGeneration(tx as unknown as Tx, ownerId, today, 0, hour));
  const result: GenerationResult = { created: [], skipped: [] };
  for (const item of plan) {
    if (item.status !== 'emitir') { result.skipped.push({ payerName: item.payerName, kind: item.kind, status: item.status, reason: item.reason }); continue; }
    try {
      const created = await sql.begin(async tx => {
        // Vuelve a comprobar dentro de la transacción (otro proceso pudo emitirla): el índice único lo respalda.
        const [{ n }] = await tx`SELECT billing_next_number(${ownerId}) AS n`;
        const [invoice] = await tx`
          INSERT INTO billing_invoices (owner_id, number, payer_client_id, kind, origin, cycle_start, cycle_end, cut_day, issued_on, due_on, total, notes)
          VALUES (${ownerId}, ${n}, ${item.payerId}, ${item.kind}, 'auto', ${item.cycleStart}, ${item.cycleEnd}, ${item.cutDay}, ${item.issuedOn}, ${item.dueOn}, ${item.total},
            ${`Generada automáticamente (${today})`})
          RETURNING id::text AS id`;
        for (const line of item.lines) {
          await tx`
            INSERT INTO billing_invoice_lines (invoice_id, beneficiary_client_id, line_type, description, quantity, unit_amount, amount, sessions_reference)
            VALUES (${invoice.id}, ${line.beneficiaryId}, 'plan', ${line.description}, ${line.quantity}, ${line.unitAmount}, ${line.amount}, ${line.sessionsReference})`;
        }
        await tx`INSERT INTO billing_audit (owner_id, user_id, action, entity, entity_id, detail)
          VALUES (${ownerId}, NULL, 'GENERATE_INVOICE', 'invoice', ${invoice.id}, ${tx.json({ code: billingCode(n), kind: item.kind, cycleStart: item.cycleStart, cycleEnd: item.cycleEnd,
            total: item.total, reference: item.referenceCode } as any)})`;
        return { code: billingCode(n), invoiceId: invoice.id as string };
      });
      result.created.push({ ...created, payerName: item.payerName, kind: item.kind, cycleStart: item.cycleStart, cycleEnd: item.cycleEnd, total: item.total });
    } catch (error) {
      const pg = error as { code?: string; constraint_name?: string };
      if (pg.code === '23505' && pg.constraint_name === 'billing_invoices_cycle_idx') {
        result.skipped.push({ payerName: item.payerName, kind: item.kind, status: 'emitir', reason: 'Ya existía una factura de ese ciclo' });
      } else throw error;
    }
  }
  return result;
}
