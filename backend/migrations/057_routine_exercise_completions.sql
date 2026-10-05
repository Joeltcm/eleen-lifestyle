ALTER TABLE routine_completions
  ADD COLUMN IF NOT EXISTS elapsed_seconds integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'routine_completions_elapsed_seconds_check') THEN
    ALTER TABLE routine_completions
      ADD CONSTRAINT routine_completions_elapsed_seconds_check CHECK (elapsed_seconds BETWEEN 0 AND 86400);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS routine_exercise_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  completed_on date NOT NULL DEFAULT current_date,
  exercise_index integer NOT NULL CHECK (exercise_index >= 0),
  completed boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (routine_id, client_id, completed_on, exercise_index)
);

CREATE INDEX IF NOT EXISTS routine_exercise_completions_client_date_idx
  ON routine_exercise_completions(client_id, completed_on DESC);
