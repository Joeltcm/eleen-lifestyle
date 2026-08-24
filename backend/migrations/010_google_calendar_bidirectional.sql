ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS google_event_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS google_event_etag text;

CREATE INDEX IF NOT EXISTS sessions_google_event_updated_at_idx
  ON sessions (google_event_updated_at)
  WHERE google_event_id IS NOT NULL;
