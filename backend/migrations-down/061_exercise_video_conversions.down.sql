-- Los lotes aplicados conservan la relación entre el video original y el
-- reemplazo. Borrarla impediría revertir una conversión o auditarla.
BEGIN;
DO $$
BEGIN
  IF to_regclass('exercise_video_conversions') IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM exercise_video_conversions)
       OR EXISTS (SELECT 1 FROM exercise_video_conversion_items)
     )
     AND COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
    RAISE EXCEPTION 'hay conversiones de videos registradas; la reversa 061 exige orden expresa con billing.allow_destructive_down = on';
  END IF;
END $$;
DROP TABLE IF EXISTS exercise_video_conversion_items;
DROP TABLE IF EXISTS exercise_video_conversions;
DELETE FROM schema_migrations WHERE name = '061_exercise_video_conversions.sql';
COMMIT;
