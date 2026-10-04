-- Reversa de 058_rutina_origen_cliente.sql.
-- Quita el origen de las ofertas y devuelve el estado a sus tres valores; las ofertas 'expired' (clases ya dadas por perdidas) pasan a 'withdrawn'.
-- No toca las clases canceladas. Exige orden expresa si hay ofertas con origen de cliente o vencidas.
BEGIN;
DO $$
BEGIN
  IF to_regclass('session_routine_offers') IS NOT NULL
     AND EXISTS (SELECT 1 FROM session_routine_offers WHERE origin = 'client' OR status = 'expired')
     AND COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
    RAISE EXCEPTION 'hay ofertas de rutina por cancelación del cliente o vencidas: active billing.allow_destructive_down = on para continuar';
  END IF;
END $$;
UPDATE session_routine_offers SET status = 'withdrawn' WHERE status = 'expired';
ALTER TABLE session_routine_offers DROP CONSTRAINT IF EXISTS session_routine_offers_status_check;
ALTER TABLE session_routine_offers ADD CONSTRAINT session_routine_offers_status_check CHECK (status IN ('offered', 'completed', 'withdrawn'));
ALTER TABLE session_routine_offers DROP CONSTRAINT IF EXISTS session_routine_offers_origin_check;
ALTER TABLE session_routine_offers DROP COLUMN IF EXISTS origin;
DELETE FROM schema_migrations WHERE name = '058_rutina_origen_cliente.sql';
COMMIT;
