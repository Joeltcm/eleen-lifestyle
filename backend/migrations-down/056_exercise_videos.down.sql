-- Reversa destructiva: eliminar esta tabla también elimina el inventario de
-- variantes. Exige una orden explícita para no perder asociaciones por error.
BEGIN;
DO $$
BEGIN
  IF to_regclass('exercise_videos') IS NOT NULL
     AND EXISTS (SELECT 1 FROM exercise_videos)
     AND COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
    RAISE EXCEPTION 'exercise_videos tiene demostraciones: active billing.allow_destructive_down = on para continuar';
  END IF;
END $$;
DROP TABLE IF EXISTS exercise_videos;
DELETE FROM schema_migrations WHERE name = '056_exercise_videos.sql';
COMMIT;
