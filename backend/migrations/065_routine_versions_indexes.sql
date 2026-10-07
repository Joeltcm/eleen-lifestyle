-- Entrega 4: índices para consultar versiones archivadas, sus sucesoras y
-- ofertas que deben reapuntarse al bifurcar una rutina en uso.
-- No cambia datos ni elimina el historial de envíos.
CREATE INDEX IF NOT EXISTS routines_supersedes_idx
  ON routines(supersedes_routine_id)
  WHERE supersedes_routine_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS routines_owner_archived_created_idx
  ON routines(owner_id, archived_at, created_at DESC);

CREATE INDEX IF NOT EXISTS session_routine_offers_routine_status_idx
  ON session_routine_offers(routine_id, status);
