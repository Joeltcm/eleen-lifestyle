-- Reversa de 051_billing_core.sql. DESTRUYE las tablas billing_* de facturas,
-- cobros, aplicaciones, ajustes, contadores y bitácora (NO toca billing_subscriptions,
-- que es de la migración 050, ni ninguna tabla del sistema anterior).
-- Usar solo antes de que existan facturas reales en ellas. Con facturas emitidas NO es un rollback operativo: la vuelta atrás real es RESTAURAR EL RESPALDO
-- (pg_restore 18 del dump diario de R2) o archivar las tablas; por eso este script se niega a correr si hay facturas, salvo que se active expresamente
-- `SET billing.allow_destructive_down = 'on'` en la misma sesión.
-- Se ejecuta a mano: psql "$DATABASE_URL" -f migrations-down/051_billing_core.down.sql
BEGIN;
DO $$
DECLARE hay boolean := false; tabla text;
BEGIN
  -- X-019: cualquier dato financiero (no solo facturas) basta para negarse: cobros sin aplicar, ajustes, aplicaciones, líneas o bitácora.
  FOREACH tabla IN ARRAY ARRAY['billing_invoices', 'billing_payments', 'billing_payment_applications', 'billing_adjustments', 'billing_invoice_lines', 'billing_audit'] LOOP
    IF to_regclass(tabla) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', tabla) INTO hay;
      IF hay AND COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
        RAISE EXCEPTION '% tiene datos financieros: restaure desde el respaldo o active billing.allow_destructive_down = on sabiendo que se perderán', tabla;
      END IF;
    END IF;
  END LOOP;
END $$;
DROP TABLE IF EXISTS billing_audit, billing_adjustments, billing_payment_applications,
  billing_payments, billing_invoice_lines, billing_invoices, billing_counters CASCADE;
DROP FUNCTION IF EXISTS billing_next_number(uuid, text);
DROP FUNCTION IF EXISTS billing_forbid_delete();
DROP FUNCTION IF EXISTS billing_invoice_guard();
DROP FUNCTION IF EXISTS billing_line_immutable();
DROP FUNCTION IF EXISTS billing_check_invoice_total();
DROP FUNCTION IF EXISTS billing_check_application();
DROP FUNCTION IF EXISTS billing_application_guard();
DELETE FROM schema_migrations WHERE name = '051_billing_core.sql';
COMMIT;
