-- Contratos internos generados desde el expediente. No contiene datos legales:
-- esos valores viven en account_settings y los captura Eileen.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS id_document text,
  ADD COLUMN IF NOT EXISTS birth_date date,
  ADD COLUMN IF NOT EXISTS emergency_contact_name text,
  ADD COLUMN IF NOT EXISTS emergency_contact_phone text,
  ADD COLUMN IF NOT EXISTS address text;

ALTER TABLE service_plans
  ADD COLUMN IF NOT EXISTS service_type text NOT NULL DEFAULT 'presencial',
  ADD COLUMN IF NOT EXISTS routines_per_month integer;

ALTER TABLE service_plans DROP CONSTRAINT IF EXISTS service_plans_service_type_check;
ALTER TABLE service_plans ADD CONSTRAINT service_plans_service_type_check
  CHECK (service_type IN ('presencial', 'virtual', 'rutinas'));
ALTER TABLE service_plans DROP CONSTRAINT IF EXISTS service_plans_routines_per_month_check;
ALTER TABLE service_plans ADD CONSTRAINT service_plans_routines_per_month_check
  CHECK (routines_per_month IS NULL OR routines_per_month >= 1);

ALTER TABLE account_settings
  ADD COLUMN IF NOT EXISTS legal_name text,
  ADD COLUMN IF NOT EXISTS legal_id text,
  ADD COLUMN IF NOT EXISTS legal_address text,
  ADD COLUMN IF NOT EXISTS contract_city text;

CREATE TABLE IF NOT EXISTS client_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  template_key text NOT NULL CHECK (template_key IN ('mensualidad', 'paquete', 'rutinas')),
  template_version integer NOT NULL DEFAULT 1 CHECK (template_version > 0),
  status text NOT NULL DEFAULT 'borrador' CHECK (status IN ('borrador', 'enviado', 'firmado', 'reemplazado', 'anulado')),
  values jsonb NOT NULL DEFAULT '{}'::jsonb,
  body_text text NOT NULL,
  pdf_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  sent_at timestamptz,
  signed_at timestamptz,
  signed_name text,
  signed_ip text,
  signed_user_agent text,
  guardian_name text,
  guardian_id text,
  pdf_sha256 text,
  replaced_by uuid REFERENCES client_contracts(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS client_contracts_one_signed_idx
  ON client_contracts(client_id) WHERE status = 'firmado';
CREATE INDEX IF NOT EXISTS client_contracts_owner_client_idx
  ON client_contracts(owner_id, client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contract_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id)
);
CREATE INDEX IF NOT EXISTS contract_notifications_owner_idx
  ON contract_notifications(owner_id, read_at, created_at DESC);

-- Un contrato aceptado conserva el texto, los datos y la evidencia, incluso
-- si después se reemplaza. No basta con que la pantalla no ofrezca editar.
CREATE OR REPLACE FUNCTION protect_signed_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.signed_at IS NOT NULL THEN RAISE EXCEPTION 'Un contrato firmado no se borra'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.signed_at IS NOT NULL AND (
    NEW.values IS DISTINCT FROM OLD.values OR NEW.body_text IS DISTINCT FROM OLD.body_text
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.client_id IS DISTINCT FROM OLD.client_id
    OR NEW.template_key IS DISTINCT FROM OLD.template_key OR NEW.template_version IS DISTINCT FROM OLD.template_version
    OR NEW.signed_at IS DISTINCT FROM OLD.signed_at OR NEW.signed_name IS DISTINCT FROM OLD.signed_name
    OR NEW.signed_ip IS DISTINCT FROM OLD.signed_ip OR NEW.signed_user_agent IS DISTINCT FROM OLD.signed_user_agent
    OR NEW.guardian_name IS DISTINCT FROM OLD.guardian_name OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
    OR NEW.pdf_document_id IS DISTINCT FROM OLD.pdf_document_id OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256
    OR NEW.status NOT IN ('firmado', 'reemplazado', 'anulado')
  ) THEN RAISE EXCEPTION 'Un contrato firmado es inmutable; genera otro contrato'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_contracts_immutable BEFORE UPDATE OR DELETE ON client_contracts
  FOR EACH ROW EXECUTE FUNCTION protect_signed_contract();

CREATE OR REPLACE FUNCTION protect_contract_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM client_contracts WHERE pdf_document_id = OLD.id AND signed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'El documento de un contrato firmado es inmutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_document_immutable BEFORE UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION protect_contract_document();
