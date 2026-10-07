-- Entrega 5: lote reversible para reconstruir envíos históricos y huellas de
-- ejercicios. El relleno se ejecuta con un script y nunca se hace al migrar.
CREATE TABLE IF NOT EXISTS routine_backfill_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('applying', 'applied', 'reverted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS routine_backfill_items (
  run_id uuid NOT NULL REFERENCES routine_backfill_runs(id) ON DELETE CASCADE,
  routine_id uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  previous_root_routine_id uuid,
  previous_exercises_hash text,
  PRIMARY KEY (run_id, routine_id)
);

ALTER TABLE routine_deliveries
  ADD COLUMN IF NOT EXISTS backfill_run_id uuid REFERENCES routine_backfill_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS routine_backfill_runs_status_idx
  ON routine_backfill_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS routine_deliveries_backfill_run_idx
  ON routine_deliveries(backfill_run_id)
  WHERE backfill_run_id IS NOT NULL;
