-- La rutina ofrecida distingue quién canceló (J-104): 'trainer' = Eileen no pudo atender (si no se cumple, Eileen decide); 'client' = canceló el cliente
-- (si no la cumple ese día, la clase se da por perdida y la oferta pasa a 'expired'). Se agrega aparte de la 057, que ya estaba aplicada.
ALTER TABLE session_routine_offers ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'trainer';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_routine_offers_origin_check') THEN
    ALTER TABLE session_routine_offers ADD CONSTRAINT session_routine_offers_origin_check CHECK (origin IN ('trainer', 'client'));
  END IF;
END $$;
ALTER TABLE session_routine_offers DROP CONSTRAINT IF EXISTS session_routine_offers_status_check;
ALTER TABLE session_routine_offers ADD CONSTRAINT session_routine_offers_status_check CHECK (status IN ('offered', 'completed', 'withdrawn', 'expired'));
