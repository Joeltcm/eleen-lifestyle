-- Reversa de 050_billing_subscriptions.sql: elimina billing_subscriptions (los planes de facturación declarados en
-- los expedientes). NO toca facturas ni ninguna tabla del sistema anterior. DESTRUYE los planes: no hay vuelta atrás
-- salvo con un respaldo. Con facturas del módulo nuevo ya emitidas NO es un rollback operativo: ver el procedimiento
-- de restauración en la bitácora del canal (usar el respaldo diario de R2 con pg_restore 18), no esta reversa.
-- Se ejecuta a mano, y solo si no existen planes que se quiera conservar:
--   psql "$DATABASE_URL" -c "SET billing.allow_destructive_down = 'on'" -f migrations-down/050_billing_subscriptions.down.sql
-- (psql ejecuta -c y -f en orden y en la misma sesión, así que el SET sí rige para el archivo).
BEGIN;
DO $$
BEGIN
  IF to_regclass('billing_subscriptions') IS NOT NULL
     AND EXISTS (SELECT 1 FROM billing_subscriptions)
     AND COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
    RAISE EXCEPTION 'billing_subscriptions tiene planes: haga un respaldo y active billing.allow_destructive_down = on para continuar';
  END IF;
END $$;
DROP TABLE IF EXISTS billing_subscriptions CASCADE;
DELETE FROM schema_migrations WHERE name = '050_billing_subscriptions.sql';
COMMIT;
