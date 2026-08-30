-- Fecha límite de la rutina y registro rápido de entrenamientos presenciales.

-- due_on es la fecha en que la rutina asignada debería estar cumplida. Nula
-- significa "sin fecha pactada": la rutina se cumple cuando se cumpla y no
-- entra al conteo de incumplidas, que es como se comportaba hasta ahora.
ALTER TABLE routine_assignments ADD COLUMN IF NOT EXISTS due_on date;

CREATE INDEX IF NOT EXISTS routine_assignments_due_idx
  ON routine_assignments(client_id, due_on)
  WHERE due_on IS NOT NULL AND active = true;

-- Marca las sesiones creadas desde el registro diario, que nacen ya
-- completadas y sin rutina. Se necesita distinguirlas para que desmarcar a un
-- cliente en esa pantalla borre sólo lo que esa pantalla creó, y nunca una
-- sesión agendada de verdad.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS quick_logged boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS sessions_quick_log_idx
  ON sessions(client_id, starts_at)
  WHERE quick_logged = true;
