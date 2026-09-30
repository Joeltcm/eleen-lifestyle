-- Crédito por clases: la mensualidad de clientes no anticipados tiene un
-- mínimo y cobra las clases que exceden ese mínimo. La migración recalcula las
-- facturas locales existentes (incluida la de septiembre) sin tocar Zoho.
--
-- La ventana es estrictamente el ciclo del cliente: (corte anterior, corte
-- actual]. Las clases del calendario son la fuente de verdad y las clases
-- reprogramadas no se cuentan dos veces porque la sesión original conserva su
-- estado final.
WITH base AS (
  SELECT i.id,
    COALESCE(i.billed_for_client_id, i.client_id) AS training_client_id,
    i.due_on,
    i.status,
    i.amount AS invoice_amount,
    c.standard_price,
    COALESCE(c.billing_cutoff_day, 1)::integer AS cutoff_day,
    COALESCE(c.monthly_session_target, p.sessions_included, 0)::integer AS target_sessions,
    (
      date_trunc('month', i.due_on - interval '1 month')::date
      + (least(
          COALESCE(c.billing_cutoff_day, 1),
          extract(day FROM (date_trunc('month', i.due_on) - interval '1 day'))::integer
        ) - 1)
    )::date AS cycle_start
  FROM invoices i
  JOIN clients c ON c.id = COALESCE(i.billed_for_client_id, i.client_id)
  LEFT JOIN service_plans p ON p.id = c.plan_id
  WHERE c.payment_mode = 'no_anticipado'
    AND c.billing_model = 'monthly'
    AND i.status <> 'void'
    AND i.source_system IS NULL
    AND (i.auto_generated = true OR lower(i.concept) LIKE '%mensual%')
), counted AS (
  SELECT b.*,
    (
      SELECT count(*)::integer
      FROM sessions s
      WHERE s.client_id = b.training_client_id
        AND (s.starts_at AT TIME ZONE 'America/Panama')::date > b.cycle_start
        AND (s.starts_at AT TIME ZONE 'America/Panama')::date <= b.due_on
        AND (
          s.status IN ('completed', 'no_show')
          OR (s.status = 'cancelled' AND s.cancellation_kind = 'not_rescheduled'
            AND COALESCE(s.cancelled_by, 'client') = 'client')
        )
    ) AS billable_sessions
  FROM base b
), calculated AS (
  SELECT c.*,
    round((c.standard_price + greatest(c.billable_sessions - c.target_sessions, 0)
      * c.standard_price / nullif(c.target_sessions, 0))::numeric, 2) AS new_amount,
    COALESCE((
      SELECT sum(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = c.id
    ), CASE WHEN c.status = 'confirmed' THEN c.invoice_amount ELSE 0 END, 0)::numeric AS paid_amount
  FROM counted c
  WHERE c.standard_price > 0 AND c.target_sessions > 0
)
UPDATE invoices i
SET amount = c.new_amount,
    subtotal = c.new_amount,
    concept = 'Mensualidad a crédito · ' || c.billable_sessions || ' clases · ' || to_char(c.due_on, 'MM/YYYY'),
    line_items = jsonb_build_array(
      jsonb_build_object(
        'name', 'Mínimo mensual · ' || c.target_sessions || ' clases',
        'quantity', 1,
        'rate', c.standard_price,
        'item_total', c.standard_price
      )
    ) || CASE WHEN c.billable_sessions > c.target_sessions THEN jsonb_build_array(
      jsonb_build_object(
        'name', (c.billable_sessions - c.target_sessions) || ' clases excedentes',
        'quantity', c.billable_sessions - c.target_sessions,
        'rate', round((c.standard_price / c.target_sessions)::numeric, 2),
        'item_total', round(((c.billable_sessions - c.target_sessions) * c.standard_price / c.target_sessions)::numeric, 2)
      )
    ) ELSE '[]'::jsonb END,
    balance = greatest(c.new_amount - c.paid_amount, 0),
    status = CASE WHEN c.paid_amount >= c.new_amount - 0.01 THEN 'confirmed' ELSE 'pending' END
FROM calculated c
WHERE i.id = c.id;
