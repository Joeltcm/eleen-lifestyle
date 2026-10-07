-- La bitácora de envíos es evidencia histórica. Nunca se elimina por una
-- reversa accidental: primero hay que vaciarla o respaldarla y dar la orden
-- explícita mediante la convención de billing del proyecto.
BEGIN;
DO $$
BEGIN
  IF to_regclass('routine_deliveries') IS NOT NULL
     AND EXISTS (SELECT 1 FROM routine_deliveries)
     AND COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
    RAISE EXCEPTION 'hay envíos de rutinas registrados; la reversa 063 exige orden expresa con billing.allow_destructive_down = on';
  END IF;
END $$;
DROP TABLE IF EXISTS routine_deliveries;
DROP INDEX IF EXISTS routines_exercises_hash_idx;
DROP INDEX IF EXISTS routines_root_version_idx;
ALTER TABLE routines DROP COLUMN IF EXISTS exercises_hash;
ALTER TABLE routines DROP COLUMN IF EXISTS archived_at;
ALTER TABLE routines DROP COLUMN IF EXISTS supersedes_routine_id;
ALTER TABLE routines DROP COLUMN IF EXISTS version;
ALTER TABLE routines DROP COLUMN IF EXISTS root_routine_id;
DELETE FROM schema_migrations WHERE name = '063_routine_deliveries_and_versions.sql';
COMMIT;
