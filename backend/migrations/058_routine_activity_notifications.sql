ALTER TABLE routine_completions
  ADD COLUMN IF NOT EXISTS feeling text,
  ADD COLUMN IF NOT EXISTS difficulty text,
  ADD COLUMN IF NOT EXISTS feedback text;

CREATE TABLE IF NOT EXISTS routine_activity_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  routine_id uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  completed_on date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('started', 'completed', 'feedback')),
  title text NOT NULL,
  body text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, routine_id, client_id, completed_on, kind)
);

CREATE INDEX IF NOT EXISTS routine_activity_notifications_owner_idx
  ON routine_activity_notifications(owner_id, read_at, created_at DESC);
