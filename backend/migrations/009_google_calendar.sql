ALTER TABLE sessions ADD COLUMN IF NOT EXISTS google_event_link text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS google_synced_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS google_sync_error text;

CREATE INDEX IF NOT EXISTS sessions_google_sync_idx
  ON sessions(starts_at)
  WHERE google_event_id IS NULL AND status <> 'cancelled';
