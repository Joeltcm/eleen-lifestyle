-- Reversa de 060_cancelacion_por_viaje.sql.
-- Quita el registro de por qué se canceló cada clase (viaje u oferta de rutina no cumplida); exige orden expresa si existe alguno. Las clases siguen canceladas.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'cancellation_reason')
     AND EXISTS (SELECT 1 FROM sessions WHERE cancellation_reason IS NOT NULL)
     AND COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
    RAISE EXCEPTION 'hay cancelaciones con su justificación guardada: respalde y active billing.allow_destructive_down = on para continuar';
  END IF;
END $$;
DROP INDEX IF EXISTS sessions_cancelled_travel_idx;
ALTER TABLE sessions DROP COLUMN IF EXISTS cancelled_travel_id, DROP COLUMN IF EXISTS cancellation_reason;
DELETE FROM schema_migrations WHERE name = '060_cancelacion_por_viaje.sql';
COMMIT;
