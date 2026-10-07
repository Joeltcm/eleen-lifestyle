-- Registro reversible de la limpieza de títulos de rutinas reutilizadas.
-- La rutina conserva su id; sólo se guarda el título anterior para poder
-- revertir la operación explícitamente.
CREATE TABLE IF NOT EXISTS routine_title_cleanups (
  routine_id uuid PRIMARY KEY REFERENCES routines(id) ON DELETE CASCADE,
  old_title text NOT NULL,
  cleaned_at timestamptz NOT NULL DEFAULT now()
);
