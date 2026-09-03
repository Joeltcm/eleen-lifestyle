-- Corrige mensualidades creadas con una fecha de vencimiento anterior al
-- inicio real del ciclo y concilia cancelaciones del cliente que quedaron sin
-- descontar por ese error.

WITH payment_dates AS (
  SELECT cov.package_id,
         min(COALESCE(ip.paid_on, i.issued_on, i.due_on))::date AS paid_on
  FROM invoice_coverage cov
  JOIN invoices i ON i.id = cov.invoice_id
  LEFT JOIN payment_allocations pa ON pa.invoice_id = i.id
  LEFT JOIN invoice_payments ip ON ip.id = pa.payment_id
  WHERE cov.package_id IS NOT NULL
  GROUP BY cov.package_id
), candidates AS (
  SELECT sp.id, sp.client_id,
         COALESCE(pd.paid_on, sp.purchased_on) AS starts_on,
         COALESCE(c.billing_cutoff_day, EXTRACT(day FROM COALESCE(pd.paid_on, sp.purchased_on)))::int AS cutoff_day
  FROM session_packages sp
  JOIN clients c ON c.id = sp.client_id
  LEFT JOIN payment_dates pd ON pd.package_id = sp.id
  WHERE sp.kind = 'monthly'
), corrected AS (
  SELECT id, starts_on,
         make_date(
           EXTRACT(year FROM (starts_on + interval '1 month'))::int,
           EXTRACT(month FROM (starts_on + interval '1 month'))::int,
           LEAST(cutoff_day, EXTRACT(day FROM (date_trunc('month', starts_on + interval '2 month') - interval '1 day'))::int)
         ) AS expires_on
  FROM candidates
)
UPDATE session_packages sp
SET purchased_on = corrected.starts_on,
    expires_on = corrected.expires_on,
    label = 'Mensualidad · ' || to_char(corrected.starts_on, 'DD/MM/YYYY') || ' – ' || to_char(corrected.expires_on, 'DD/MM/YYYY'),
    status = CASE WHEN sp.used_sessions >= sp.total_sessions THEN 'exhausted' ELSE 'active' END
FROM corrected
WHERE sp.id = corrected.id;

-- Una cancelación del cliente sin reprogramación consume una clase. Si el
-- paquete estaba mal fechado, la operación anterior no pudo encontrarlo;
-- aquí se asocia al saldo vigente y se evita duplicar descuentos.
WITH pending AS (
  SELECT s.id AS session_id, s.client_id, s.starts_at::date AS session_day,
         sp.id AS package_id
  FROM sessions s
  JOIN LATERAL (
    SELECT p.id
    FROM session_packages p
    WHERE p.client_id = s.client_id
      AND p.kind = 'monthly'
      AND p.status = 'active'
      AND p.used_sessions < p.total_sessions
      AND p.purchased_on <= s.starts_at::date
      AND (p.expires_on IS NULL OR p.expires_on >= s.starts_at::date)
    ORDER BY p.expires_on ASC NULLS LAST, p.purchased_on
    LIMIT 1
  ) sp ON true
  WHERE s.status = 'cancelled'
    AND s.cancellation_kind = 'not_rescheduled'
    AND COALESCE(s.cancelled_by, 'client') = 'client'
    AND s.package_debited = false
)
UPDATE session_packages p
SET used_sessions = p.used_sessions + 1,
    status = CASE WHEN p.used_sessions + 1 >= p.total_sessions THEN 'exhausted' ELSE 'active' END
FROM pending
WHERE p.id = pending.package_id;

WITH pending AS (
  SELECT s.id AS session_id, s.client_id, s.starts_at::date AS session_day,
         sp.id AS package_id
  FROM sessions s
  JOIN LATERAL (
    SELECT p.id
    FROM session_packages p
    WHERE p.client_id = s.client_id
      AND p.kind = 'monthly'
      AND p.status IN ('active', 'exhausted')
      AND p.purchased_on <= s.starts_at::date
      AND (p.expires_on IS NULL OR p.expires_on >= s.starts_at::date)
    ORDER BY p.expires_on ASC NULLS LAST, p.purchased_on
    LIMIT 1
  ) sp ON true
  WHERE s.status = 'cancelled'
    AND s.cancellation_kind = 'not_rescheduled'
    AND COALESCE(s.cancelled_by, 'client') = 'client'
    AND s.package_debited = false
)
UPDATE sessions s
SET package_id = pending.package_id,
    package_debited = true,
    debited_group_id = pending.client_id,
    updated_at = now()
FROM pending
WHERE s.id = pending.session_id;
