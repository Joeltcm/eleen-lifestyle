CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  role text NOT NULL DEFAULT 'trainer' CHECK (role IN ('admin', 'trainer', 'client')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  portal_user_id uuid UNIQUE REFERENCES users(id),
  full_name text NOT NULL,
  email text,
  phone text,
  goal text,
  notes text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'inactive')),
  billing_model text NOT NULL DEFAULT 'monthly' CHECK (billing_model IN ('monthly', 'package')),
  standard_price numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL,
  renewal_day smallint CHECK (renewal_day BETWEEN 1 AND 31),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
  starts_on date NOT NULL DEFAULT current_date,
  ends_on date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label text NOT NULL,
  total_sessions integer NOT NULL CHECK (total_sessions > 0),
  used_sessions integer NOT NULL DEFAULT 0 CHECK (used_sessions >= 0),
  amount numeric(12,2) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'exhausted', 'expired', 'cancelled')),
  purchased_on date NOT NULL DEFAULT current_date,
  expires_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (used_sessions <= total_sessions)
);

CREATE TABLE IF NOT EXISTS routines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  description text,
  sessions_per_week integer NOT NULL DEFAULT 1 CHECK (sessions_per_week BETWEEN 1 AND 7),
  exercises jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS routine_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  starts_on date NOT NULL DEFAULT current_date,
  ends_on date,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (routine_id, client_id, starts_on)
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  routine_id uuid REFERENCES routines(id) ON DELETE SET NULL,
  package_id uuid REFERENCES session_packages(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 60 CHECK (duration_minutes > 0),
  mode text NOT NULL DEFAULT 'Presencial',
  notes text,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  google_event_id text UNIQUE,
  package_debited boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  package_id uuid REFERENCES session_packages(id) ON DELETE SET NULL,
  concept text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'void')),
  payment_method text,
  payment_reference text,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('inbody', 'contract', 'receipt', 'progress_photo', 'other')),
  object_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inbody_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  device_model text,
  tested_at timestamptz NOT NULL,
  values jsonb NOT NULL,
  confidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  extraction_status text NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending', 'processing', 'ready', 'review', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, tested_at)
);

CREATE INDEX IF NOT EXISTS clients_owner_idx ON clients(owner_id);
CREATE INDEX IF NOT EXISTS sessions_client_time_idx ON sessions(client_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS invoices_client_due_idx ON invoices(client_id, due_on DESC);
CREATE INDEX IF NOT EXISTS inbody_client_tested_idx ON inbody_assessments(client_id, tested_at DESC);

