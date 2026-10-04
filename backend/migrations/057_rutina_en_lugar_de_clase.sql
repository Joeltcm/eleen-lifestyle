-- Rutina ofrecida cuando un cliente cancela: si la hace, cuenta como su clase del día.
--
-- La oferta liga una clase (que sigue programada, no se cancela) con una rutina
-- asignada al cliente. Al completarla en el portal, la clase pasa a "realizada".
-- El cronómetro corre en el teléfono del cliente; al terminar se guarda la
-- duración: en la oferta y en el registro de la rutina cumplida.
CREATE TABLE IF NOT EXISTS session_routine_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  routine_id uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  offered_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  offered_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'completed', 'withdrawn')),
  completed_at timestamptz,
  completion_percent smallint CHECK (completion_percent BETWEEN 0 AND 100),
  duration_seconds integer CHECK (duration_seconds BETWEEN 1 AND 21600)
);
CREATE INDEX IF NOT EXISTS session_routine_offers_client_idx ON session_routine_offers(client_id, status);

ALTER TABLE routine_completions ADD COLUMN IF NOT EXISTS duration_seconds integer CHECK (duration_seconds BETWEEN 1 AND 21600);
