ALTER TABLE invoices ADD COLUMN IF NOT EXISTS billing_period date;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS auto_generated boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_automatic_period_idx
  ON invoices(client_id, billing_period)
  WHERE auto_generated = true;

CREATE INDEX IF NOT EXISTS invoices_billing_period_idx
  ON invoices(billing_period DESC, due_on DESC);
