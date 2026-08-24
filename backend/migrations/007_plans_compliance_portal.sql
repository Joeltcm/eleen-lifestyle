CREATE TABLE IF NOT EXISTS service_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  billing_model text NOT NULL CHECK (billing_model IN ('monthly', 'package')),
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  sessions_included integer CHECK (sessions_included IS NULL OR sessions_included > 0),
  validity_days integer CHECK (validity_days IS NULL OR validity_days > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

ALTER TABLE clients ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES service_plans(id) ON DELETE SET NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_cutoff_day smallint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_billing_cutoff_day_check') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_billing_cutoff_day_check CHECK (billing_cutoff_day BETWEEN 1 AND 31);
  END IF;
END $$;

INSERT INTO service_plans (owner_id, name, billing_model, price, sessions_included, validity_days)
SELECT DISTINCT c.owner_id,
  CASE WHEN c.billing_model = 'monthly'
    THEN 'Mensualidad ' || trim(to_char(c.standard_price, 'FM999999990.00'))
    ELSE 'Paquete ' || COALESCE(p.total_sessions, 8) || ' sesiones'
  END,
  c.billing_model,
  c.standard_price,
  CASE WHEN c.billing_model = 'package' THEN COALESCE(p.total_sessions, 8) ELSE NULL END,
  CASE WHEN c.billing_model = 'package' THEN 30 ELSE NULL END
FROM clients c
LEFT JOIN LATERAL (
  SELECT total_sessions FROM session_packages sp WHERE sp.client_id = c.id ORDER BY sp.created_at DESC LIMIT 1
) p ON true
ON CONFLICT (owner_id, name) DO NOTHING;

UPDATE clients c SET plan_id = p.id
FROM service_plans p
WHERE c.plan_id IS NULL AND p.owner_id = c.owner_id AND p.billing_model = c.billing_model AND p.price = c.standard_price;

UPDATE clients c SET billing_cutoff_day = COALESCE(m.renewal_day, EXTRACT(day FROM c.created_at)::integer)
FROM memberships m WHERE m.client_id = c.id AND c.billing_cutoff_day IS NULL;
UPDATE clients SET billing_cutoff_day = LEAST(28, EXTRACT(day FROM created_at)::integer) WHERE billing_cutoff_day IS NULL;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS completion_percent smallint NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS completed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS completion_recorded_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_completion_percent_check') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_completion_percent_check CHECK (completion_percent BETWEEN 0 AND 100);
  END IF;
END $$;

UPDATE sessions SET completion_percent = 100, completion_recorded_at = COALESCE(updated_at, now())
WHERE status = 'completed' AND completion_percent = 0;

CREATE TABLE IF NOT EXISTS routine_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  completed_on date NOT NULL DEFAULT current_date,
  completion_percent smallint NOT NULL CHECK (completion_percent BETWEEN 0 AND 100),
  marked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (routine_id, client_id, completed_on)
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  in_app_enabled boolean NOT NULL DEFAULT true,
  browser_enabled boolean NOT NULL DEFAULT false,
  session_reminder_hours integer NOT NULL DEFAULT 24 CHECK (session_reminder_hours BETWEEN 1 AND 168),
  payment_reminder_days integer NOT NULL DEFAULT 3 CHECK (payment_reminder_days BETWEEN 0 AND 30),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_plans_owner_idx ON service_plans(owner_id, active, name);
CREATE INDEX IF NOT EXISTS routine_completions_client_date_idx ON routine_completions(client_id, completed_on DESC);
CREATE INDEX IF NOT EXISTS sessions_compliance_idx ON sessions(client_id, starts_at DESC, completion_percent);
