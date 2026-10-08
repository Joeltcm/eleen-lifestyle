-- Modalidad gratuita para prospectos a quienes solo se les envían rutinas.
-- Los clientes existentes quedan explícitamente en standard.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS service_mode text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS demo_started_on date,
  ADD COLUMN IF NOT EXISTS demo_ends_on date,
  ADD COLUMN IF NOT EXISTS demo_routine_limit integer,
  ADD COLUMN IF NOT EXISTS demo_converted_at timestamptz,
  ADD COLUMN IF NOT EXISTS demo_note text;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_service_mode_check;
ALTER TABLE clients ADD CONSTRAINT clients_service_mode_check
  CHECK (service_mode IN ('standard', 'demo'));
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_demo_routine_limit_check;
ALTER TABLE clients ADD CONSTRAINT clients_demo_routine_limit_check
  CHECK (demo_routine_limit IS NULL OR demo_routine_limit >= 1);

CREATE TABLE IF NOT EXISTS client_mode_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_mode text NOT NULL,
  to_mode text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  note text
);
CREATE INDEX IF NOT EXISTS client_mode_events_client_at_idx
  ON client_mode_events(client_id, at DESC);
CREATE INDEX IF NOT EXISTS clients_service_mode_idx
  ON clients(owner_id, service_mode);

CREATE TABLE IF NOT EXISTS account_settings (
  owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  contact_whatsapp text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO account_settings (owner_id, contact_whatsapp)
SELECT id, '50762128180' FROM users WHERE role IN ('admin', 'trainer')
ON CONFLICT (owner_id) DO NOTHING;
