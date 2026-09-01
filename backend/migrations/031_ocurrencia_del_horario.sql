-- Qué día de la regla es cada sesión de un horario fijo.
--
-- El proceso que mantiene creadas las sesiones de las próximas semanas decidía
-- qué faltaba mirando si había una sesión "a esa hora exacta". Con eso, mover
-- el lunes de 5:30 a 6:15 dejaba libre el hueco de las 5:30, y a las pocas
-- horas volvía a aparecer una sesión ahí: el cliente quedaba con dos, y la
-- edición parecía no haberse guardado. Cancelar una tenía el mismo efecto:
-- reaparecía sola, después de que la entrenadora ya había dicho que no la daba.
--
-- Ahora cada ocurrencia —regla más día— se crea una sola vez y queda marcada.
-- Moverla, cancelarla o borrarla es una decisión sobre ese día, y se respeta.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS recurrence_on date;

-- Las que ya existen se marcan con el día que les tocaba, en hora de Panamá:
-- sin esto el proceso las daría por inexistentes y las duplicaría todas.
UPDATE sessions
SET recurrence_on = (starts_at AT TIME ZONE 'America/Panama')::date
WHERE recurrence_id IS NOT NULL AND recurrence_on IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_ocurrencia_idx
  ON sessions(recurrence_id, recurrence_on)
  WHERE recurrence_id IS NOT NULL AND recurrence_on IS NOT NULL;
