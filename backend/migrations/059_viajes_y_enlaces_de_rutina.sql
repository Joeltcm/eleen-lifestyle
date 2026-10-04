-- Cliente de viaje y rutina enviada por enlace temporal (J-107).
--
-- client_travel: periodos en que el cliente está de viaje. Es solo un marcador: NO pausa su plan ni mueve su corte de cobro (si viaja, igual se cobra la mensualidad).
--   ends_on NULL = aún no se sabe cuándo regresa. Pueden existir varios viajes por cliente (historial), sin traslapes.
-- routine_share_links: enlaces sin cuenta para abrir UNA rutina asignada a un cliente. El token nunca se guarda (solo su hash), vence en expires_at y se puede revocar.
-- routine_completions.via_link: cumplimiento confirmado desde el enlace (no hay usuario de portal que lo marque).
CREATE TABLE IF NOT EXISTS client_travel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  starts_on date NOT NULL,
  ends_on date,
  destination text,
  note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS client_travel_client_idx ON client_travel(client_id, starts_on);

CREATE TABLE IF NOT EXISTS routine_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  routine_id uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  travel_id uuid REFERENCES client_travel(id) ON DELETE SET NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  opens integer NOT NULL DEFAULT 0,
  last_opened_at timestamptz
);
CREATE INDEX IF NOT EXISTS routine_share_links_client_idx ON routine_share_links(client_id, expires_at);

ALTER TABLE routine_completions ADD COLUMN IF NOT EXISTS via_link boolean NOT NULL DEFAULT false;
