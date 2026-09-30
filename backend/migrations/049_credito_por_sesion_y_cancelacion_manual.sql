-- Crédito por sesión: el cliente entrena a crédito y la factura del ciclo
-- cobra únicamente las sesiones realizadas. Las cancelaciones del cliente
-- requieren una decisión explícita de Eileen; un no_show sólo es cumplimiento.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS credit_session_price numeric(12,2);

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS credit_charge boolean NOT NULL DEFAULT false;

ALTER TABLE session_cancellation_edits
  ADD COLUMN IF NOT EXISTS previous_credit_charge boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS new_credit_charge boolean NOT NULL DEFAULT false;

-- La tarifa pactada actual de Julio es $25 por sesión. No se pisa una tarifa
-- que Eileen ya haya configurado en otro cliente a crédito.
UPDATE clients
SET credit_session_price = 25, updated_at = now()
WHERE payment_mode = 'no_anticipado' AND credit_session_price IS NULL;

-- Corrección retroactiva, incluida la factura de septiembre: la factura se
-- reconstruye desde el calendario y desde las decisiones guardadas en
-- sessions.credit_charge. No se tocan facturas de Zoho.
WITH base AS (
  SELECT i.id,
    COALESCE(i.billed_for_client_id, i.client_id) AS training_client_id,
    i.due_on, i.status, i.amount AS previous_amount,
    COALESCE(c.credit_session_price, 25)::numeric AS rate,
    COALESCE(c.billing_cutoff_day, 1)::integer AS cutoff_day
  FROM invoices i
  JOIN clients c ON c.id = COALESCE(i.billed_for_client_id, i.client_id)
  WHERE c.payment_mode = 'no_anticipado'
    AND c.billing_model = 'monthly'
    AND i.status <> 'void'
    AND i.source_system IS NULL
    AND (i.auto_generated = true OR lower(i.concept) LIKE '%mensual%'
      OR lower(i.concept) LIKE '%sesiones a crédito%')
), ciclos AS (
  SELECT b.*,
    (date_trunc('month', b.due_on - interval '1 month')::date +
      (least(b.cutoff_day,
        extract(day FROM (date_trunc('month', b.due_on) - interval '1 day'))::integer) - 1))::date AS cycle_start
  FROM base b
), lineas AS (
  SELECT c.*,
    COALESCE(jsonb_agg(jsonb_build_object(
      'name', CASE WHEN s.credit_charge THEN 'Cancelación cobrada · ' ELSE 'Sesión · ' END
        || to_char((s.starts_at AT TIME ZONE 'America/Panama')::date, 'DD/MM/YYYY'),
      'quantity', 1, 'rate', c.rate, 'item_total', c.rate
    ) ORDER BY s.starts_at) FILTER (WHERE s.id IS NOT NULL), '[]'::jsonb) AS items,
    count(s.id)::integer AS billable_sessions
  FROM ciclos c
  LEFT JOIN sessions s ON s.client_id = c.training_client_id
    AND (s.starts_at AT TIME ZONE 'America/Panama')::date > c.cycle_start
    AND (s.starts_at AT TIME ZONE 'America/Panama')::date <= c.due_on::date
    AND (s.status = 'completed' OR (s.status = 'cancelled'
      AND s.cancellation_kind = 'not_rescheduled'
      AND COALESCE(s.cancelled_by, 'client') = 'client'
      AND s.credit_charge = true))
  GROUP BY c.id, c.training_client_id, c.due_on, c.status, c.previous_amount, c.rate, c.cutoff_day, c.cycle_start
), pagado AS (
  SELECT l.*, COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = l.id),
    CASE WHEN l.status = 'confirmed' THEN l.previous_amount ELSE 0 END, 0)::numeric AS paid_amount
  FROM lineas l
)
UPDATE invoices i
SET amount = round((p.billable_sessions * p.rate)::numeric, 2),
    subtotal = round((p.billable_sessions * p.rate)::numeric, 2),
    concept = 'Sesiones a crédito · ' || p.billable_sessions || ' clase'
      || CASE WHEN p.billable_sessions = 1 THEN '' ELSE 's' END || ' · ' || to_char(p.due_on, 'MM/YYYY'),
    line_items = p.items,
    balance = greatest(round((p.billable_sessions * p.rate)::numeric, 2) - p.paid_amount, 0),
    status = CASE WHEN p.billable_sessions = 0
      OR p.paid_amount >= round((p.billable_sessions * p.rate)::numeric, 2) - 0.01
      THEN 'confirmed' ELSE 'pending' END
FROM pagado p
WHERE i.id = p.id;
