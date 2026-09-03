-- La cobertura de una mensualidad empieza en la fecha real del pago, no en
-- el primer día del mes contable. Corrige saldos ya abiertos desde Zoho.
WITH covered AS (
  SELECT sp.id,
    COALESCE(
      (SELECT min(ip.paid_on)
       FROM payment_allocations pa
       JOIN invoice_payments ip ON ip.id = pa.payment_id
       WHERE pa.invoice_id = cov.invoice_id),
      i.issued_on, i.due_on, cov.billing_period
    ) AS start_on,
    COALESCE(c.billing_cutoff_day, 1)::integer AS cutoff_day
  FROM session_packages sp
  JOIN invoice_coverage cov ON cov.package_id = sp.id
  JOIN invoices i ON i.id = cov.invoice_id
  JOIN clients c ON c.id = cov.client_id
  WHERE sp.kind = 'monthly'
), calculated AS (
  SELECT id,
    CASE WHEN extract(day FROM start_on)::integer >= cutoff_day THEN
      (date_trunc('month', start_on + interval '1 month')::date
       + (least(cutoff_day, extract(day FROM (date_trunc('month', start_on + interval '2 month') - interval '1 day'))::integer) - 1))
    ELSE
      (date_trunc('month', start_on)::date
       + (least(cutoff_day, extract(day FROM (date_trunc('month', start_on + interval '1 month') - interval '1 day'))::integer) - 1))
    END AS expires_on
  FROM covered
)
UPDATE session_packages sp
SET purchased_on = c.start_on,
    expires_on = c.expires_on,
    status = CASE WHEN c.expires_on >= current_date AND sp.used_sessions < sp.total_sessions
                  THEN 'active' ELSE sp.status END
FROM (
  SELECT covered.id, covered.start_on, calculated.expires_on
  FROM covered JOIN calculated USING (id)
) c
WHERE sp.id = c.id;
