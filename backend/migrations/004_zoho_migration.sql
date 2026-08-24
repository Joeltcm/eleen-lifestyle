ALTER TABLE clients ADD COLUMN IF NOT EXISTS source_system text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS external_updated_at timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS source_payload jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS clients_external_source_idx ON clients(owner_id, source_system, external_id);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source_system text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_number text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issued_on date;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal numeric(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_total numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS balance numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS external_status text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS line_items jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS external_updated_at timestamptz;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source_payload jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_external_source_idx ON invoices(source_system, external_id);
CREATE INDEX IF NOT EXISTS invoices_number_idx ON invoices(invoice_number);

ALTER TABLE memberships ADD COLUMN IF NOT EXISTS source_system text;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS recurrence_name text;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS recurrence_interval text;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS next_invoice_on date;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS source_payload jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS memberships_external_source_idx ON memberships(source_system, external_id);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_system text,
  external_id text,
  payment_number text,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  paid_on date NOT NULL,
  method text,
  reference text,
  source_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_system, external_id)
);
CREATE INDEX IF NOT EXISTS invoice_payments_client_date_idx ON invoice_payments(client_id, paid_on DESC);

CREATE TABLE IF NOT EXISTS payment_allocations (
  payment_id uuid NOT NULL REFERENCES invoice_payments(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  PRIMARY KEY(payment_id, invoice_id)
);

CREATE TABLE IF NOT EXISTS credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_system text,
  external_id text,
  credit_note_number text,
  issued_on date NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  balance numeric(12,2) NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'open',
  reference text,
  source_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_system, external_id)
);

CREATE TABLE IF NOT EXISTS integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  encrypted_refresh_token text,
  organization_id text,
  organization_name text,
  accounts_url text NOT NULL,
  api_base_url text NOT NULL,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'syncing', 'ready', 'completed', 'error')),
  sync_enabled boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  cutover_at timestamptz,
  last_error text,
  source_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  local_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, provider)
);

CREATE TABLE IF NOT EXISTS integration_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  source_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  local_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciled boolean NOT NULL DEFAULT false,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS integration_sync_runs_owner_idx ON integration_sync_runs(owner_id, started_at DESC);
