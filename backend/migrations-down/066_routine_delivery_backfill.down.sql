-- La reversa no puede borrar el registro de un relleno ni su relación con
-- envíos históricos sin una orden expresa. Antes debe ejecutarse el script
-- con --revertir y comprobar su informe.
BEGIN;
DO $$
BEGIN
  IF to_regclass('routine_backfill_runs') IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM routine_backfill_runs)
       OR EXISTS (SELECT 1 FROM routine_backfill_items)
       OR EXISTS (SELECT 1 FROM routine_deliveries WHERE backfill_run_id IS NOT NULL)
     )
     AND COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
    RAISE EXCEPTION 'hay rellenos de envíos de rutinas registrados; la reversa 066 exige orden expresa con billing.allow_destructive_down = on';
  END IF;
END $$;
DROP INDEX IF EXISTS routine_deliveries_backfill_run_idx;
DROP INDEX IF EXISTS routine_backfill_runs_status_idx;
ALTER TABLE routine_deliveries DROP COLUMN IF EXISTS backfill_run_id;
DROP TABLE IF EXISTS routine_backfill_items;
DROP TABLE IF EXISTS routine_backfill_runs;
DELETE FROM schema_migrations WHERE name = '066_routine_delivery_backfill.sql';
COMMIT;
