-- Reversa de 055_tarifas_referencia_zonas.sql.
-- Elimina datos del catálogo (zonas y referencias especiales), por eso exige
-- una orden explícita. No toca clientes, facturas ni planes de facturación.
BEGIN;
DO $$
BEGIN
  IF to_regclass('service_plans') IS NOT NULL
     AND EXISTS (SELECT 1 FROM service_plans WHERE zone IS NOT NULL OR special_for IS NOT NULL)
     AND COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
    RAISE EXCEPTION 'service_plans tiene zonas o tarifas especiales: respalde el catálogo y active billing.allow_destructive_down = on para continuar';
  END IF;
END $$;
ALTER TABLE service_plans
  DROP COLUMN IF EXISTS zone,
  DROP COLUMN IF EXISTS special_for;
DELETE FROM schema_migrations WHERE name = '055_tarifas_referencia_zonas.sql';
COMMIT;
