-- Etapa 1A: líneas declarativas de cobro.
--
-- Esta tabla describe el acuerdo comercial vigente, pero no emite facturas,
-- no abre saldos y no reemplaza todavía al legado (clients/memberships).
-- Los importes y fechas se versionan: un cambio de precio cierra la línea
-- anterior y crea otra desde la fecha indicada.
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  beneficiary_client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  payer_client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('monthly', 'credit', 'package')),
  cycle_days integer CHECK (cycle_days IS NULL OR cycle_days BETWEEN 1 AND 366),
  sessions_reference integer CHECK (sessions_reference IS NULL OR sessions_reference > 0),
  starts_on date NOT NULL,
  ends_on date,
  price numeric(12,2) NOT NULL CHECK (price > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on <= ends_on),
  CHECK ((kind = 'package' AND cycle_days IS NOT NULL) OR (kind <> 'package' AND cycle_days IS NULL))
);

CREATE INDEX IF NOT EXISTS billing_subscriptions_beneficiary_idx
  ON billing_subscriptions (beneficiary_client_id, starts_on DESC);
CREATE INDEX IF NOT EXISTS billing_subscriptions_payer_idx
  ON billing_subscriptions (payer_client_id, starts_on DESC);
CREATE INDEX IF NOT EXISTS billing_subscriptions_owner_idx
  ON billing_subscriptions (owner_id, starts_on DESC);
