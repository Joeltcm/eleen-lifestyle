-- Sesión persistida del cronómetro. La duración que llega del navegador se
-- conserva para poder reanudar tras una recarga, pero la existencia de esta
-- fila es la autoridad del servidor para permitir cerrar una rutina.
CREATE TABLE IF NOT EXISTS routine_timer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  completed_on date NOT NULL,
  started_at timestamptz NOT NULL,
  paused_at timestamptz,
  elapsed_seconds integer NOT NULL DEFAULT 0 CHECK (elapsed_seconds BETWEEN 0 AND 86400),
  active boolean NOT NULL DEFAULT true,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (routine_id, client_id, completed_on)
);

CREATE INDEX IF NOT EXISTS routine_timer_sessions_client_date_idx
  ON routine_timer_sessions(client_id, completed_on DESC);
