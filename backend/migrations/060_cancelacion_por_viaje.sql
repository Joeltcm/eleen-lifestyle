-- Registro de por qué una clase se canceló sola (J-108). Una clase de un día de viaje del cliente sin rutina confirmada se cancela automáticamente; la cancelación queda
-- justificada con el viaje: cancelled_travel_id lo liga y cancellation_reason guarda el texto tal como era ese día (por si luego se edita el viaje).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cancelled_travel_id uuid REFERENCES client_travel(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cancellation_reason text;
CREATE INDEX IF NOT EXISTS sessions_cancelled_travel_idx ON sessions(cancelled_travel_id) WHERE cancelled_travel_id IS NOT NULL;
