ALTER TABLE documents ADD COLUMN IF NOT EXISTS upload_status text NOT NULL DEFAULT 'pending';
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_upload_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_upload_status_check CHECK (upload_status IN ('pending', 'ready', 'failed'));

