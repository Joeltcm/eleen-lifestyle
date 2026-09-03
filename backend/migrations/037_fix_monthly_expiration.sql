-- Una mensualidad vence un ciclo después del período que cubre, no en el
-- día de corte dentro de ese mismo período. Corrige saldos ya creados y evita
-- que clases del ciclo queden sin descontar por una expiración prematura.
UPDATE session_packages sp
SET expires_on = (i.billing_period + interval '1 month')::date,
    status = CASE WHEN sp.status = 'expired'
                       AND (i.billing_period + interval '1 month')::date >= current_date
                       AND sp.used_sessions < sp.total_sessions
                  THEN 'active' ELSE sp.status END
FROM invoices i
WHERE sp.id = i.package_id
  AND sp.kind = 'monthly'
  AND i.billing_period IS NOT NULL;

UPDATE session_packages sp
SET expires_on = (cov.billing_period + interval '1 month')::date,
    status = CASE WHEN sp.status = 'expired'
                       AND (cov.billing_period + interval '1 month')::date >= current_date
                       AND sp.used_sessions < sp.total_sessions
                  THEN 'active' ELSE sp.status END
FROM invoice_coverage cov
WHERE sp.id = cov.package_id
  AND sp.kind = 'monthly';

-- Las asistencias que se marcaron durante el ciclo pero quedaron sin saldo
-- elegible se asocian ahora al saldo corregido, hasta agotarlo.
DO $$
DECLARE
  saldo record;
  clase record;
  restantes integer;
BEGIN
  FOR saldo IN
    SELECT id, client_id, total_sessions, used_sessions, expires_on
    FROM session_packages
    WHERE kind = 'monthly' AND status = 'active' AND used_sessions < total_sessions
      AND expires_on IS NOT NULL
  LOOP
    restantes := saldo.total_sessions - saldo.used_sessions;
    FOR clase IN
      SELECT id
      FROM sessions
      WHERE client_id = saldo.client_id AND status = 'completed' AND package_debited = false
        AND starts_at > (saldo.expires_on - interval '1 month')
        AND starts_at < (saldo.expires_on + interval '1 day')
      ORDER BY starts_at
      LIMIT restantes
    LOOP
      UPDATE sessions
      SET package_id = saldo.id, package_debited = true,
          debited_group_id = saldo.client_id, updated_at = now()
      WHERE id = clase.id;
      restantes := restantes - 1;
    END LOOP;
    UPDATE session_packages
    SET used_sessions = total_sessions - restantes,
        status = CASE WHEN total_sessions - restantes >= total_sessions THEN 'exhausted' ELSE status END
    WHERE id = saldo.id;
  END LOOP;
END $$;
