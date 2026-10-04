-- Reversa de 057_rutina_en_lugar_de_clase.sql.
-- Elimina las ofertas de rutina y las duraciones registradas, por eso exige una
-- orden explícita. No toca sesiones ni rutinas: solo la liga y el cronómetro.
BEGIN;
DO $$
BEGIN
  IF (to_regclass('session_routine_offers') IS NOT NULL AND EXISTS (SELECT 1 FROM session_routine_offers)
      OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'routine_completions' AND column_name = 'duration_seconds')
         AND EXISTS (SELECT 1 FROM routine_completions WHERE duration_seconds IS NOT NULL))
     AND COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
    RAISE EXCEPTION 'hay ofertas de rutina o duraciones guardadas: respalde y active billing.allow_destructive_down = on para continuar';
  END IF;
END $$;
DROP TABLE IF EXISTS session_routine_offers;
ALTER TABLE routine_completions DROP COLUMN IF EXISTS duration_seconds;
DELETE FROM schema_migrations WHERE name = '057_rutina_en_lugar_de_clase.sql';
COMMIT;
