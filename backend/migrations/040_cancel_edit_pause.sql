-- Edición auditable de cancelaciones y pausa real de paquetes.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cancellation_resolution text
  CHECK (cancellation_resolution IS NULL OR cancellation_resolution IN ('discount','makeup','none','debit'));
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cancellation_edited_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cancellation_makeup_package_id uuid REFERENCES session_packages(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS paused_hold boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS session_cancellation_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  editor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  previous_cancelled_by text,
  previous_cancellation_kind text,
  previous_resolution text,
  new_cancelled_by text NOT NULL,
  new_cancellation_kind text NOT NULL,
  new_resolution text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_cancellation_edits_session_idx ON session_cancellation_edits(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS client_package_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  package_id uuid REFERENCES session_packages(id) ON DELETE SET NULL,
  recurrence_id uuid REFERENCES session_recurrences(id) ON DELETE SET NULL,
  starts_on date NOT NULL DEFAULT current_date,
  resumed_on date,
  days_frozen integer NOT NULL DEFAULT 0 CHECK (days_frozen >= 0),
  carried_sessions integer NOT NULL DEFAULT 0 CHECK (carried_sessions >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','resumed')),
  reason text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resumed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resumed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS client_package_pauses_active_client_idx ON client_package_pauses(client_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS client_package_pauses_package_idx ON client_package_pauses(package_id, status);
CREATE INDEX IF NOT EXISTS sessions_paused_hold_idx ON sessions(client_id, starts_at) WHERE paused_hold = true;
