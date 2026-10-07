-- Registro inmutable de los envíos de rutinas y metadatos para sus futuras versiones.
-- Esta entrega solo escribe el registro; el aviso de repetidos, la bifurcación y
-- el relleno histórico se entregan por separado.
ALTER TABLE routines ADD COLUMN IF NOT EXISTS root_routine_id uuid REFERENCES routines(id) ON DELETE SET NULL;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE routines ADD COLUMN IF NOT EXISTS supersedes_routine_id uuid REFERENCES routines(id) ON DELETE SET NULL;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS exercises_hash text;

UPDATE routines SET root_routine_id = id WHERE root_routine_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS routines_root_version_idx ON routines(root_routine_id, version);
CREATE INDEX IF NOT EXISTS routines_exercises_hash_idx ON routines(owner_id, exercises_hash);

CREATE TABLE IF NOT EXISTS routine_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  routine_id uuid REFERENCES routines(id) ON DELETE SET NULL,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('assignment', 'link', 'offer', 'travel_link', 'new_version')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  sent_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  due_on date,
  share_link_id uuid REFERENCES routine_share_links(id) ON DELETE SET NULL,
  offer_id uuid REFERENCES session_routine_offers(id) ON DELETE SET NULL,
  assignment_id uuid REFERENCES routine_assignments(id) ON DELETE SET NULL,
  routine_title text NOT NULL,
  routine_version integer NOT NULL DEFAULT 1 CHECK (routine_version > 0),
  client_name text NOT NULL,
  summary_text text NOT NULL,
  exercises_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary_reconstructed boolean NOT NULL DEFAULT false,
  repeat_confirmed boolean NOT NULL DEFAULT false,
  backfilled boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS routine_deliveries_routine_sent_idx
  ON routine_deliveries(routine_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS routine_deliveries_client_sent_idx
  ON routine_deliveries(client_id, sent_at DESC);
