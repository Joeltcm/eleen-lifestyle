-- Reversa de 062_routine_title_cleanups.sql.
-- Quita el registro de los títulos anteriores de las rutinas limpiadas; sin él ya no se puede volver al título con "(copia)" (los títulos limpios se quedan).
-- Por eso exige orden expresa si hay algo guardado.
BEGIN;
DO $$
BEGIN
  IF to_regclass('routine_title_cleanups') IS NOT NULL
     AND EXISTS (SELECT 1 FROM routine_title_cleanups)
     AND COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
    RAISE EXCEPTION 'hay títulos de rutinas limpiados con su título anterior guardado: ejecute antes limpiar-copias-rutinas --revertir, o respalde y active billing.allow_destructive_down = on para continuar';
  END IF;
END $$;
DROP TABLE IF EXISTS routine_title_cleanups;
DELETE FROM schema_migrations WHERE name = '062_routine_title_cleanups.sql';
COMMIT;
