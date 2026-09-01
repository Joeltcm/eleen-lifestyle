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

-- El índice se rehace al final. Se quita primero porque el relleno de abajo
-- vuelve a marcar filas, y con el índice puesto la primera de ellas lo violaría
-- antes de que el reparto tenga ocasión de deshacer el empate.
DROP INDEX IF EXISTS sessions_ocurrencia_idx;

-- Las que ya existen se marcan con el día que les tocaba, en hora de Panamá:
-- sin esto el proceso las daría por inexistentes y las duplicaría todas.
UPDATE sessions
SET recurrence_on = (starts_at AT TIME ZONE 'America/Panama')::date
WHERE recurrence_id IS NOT NULL AND recurrence_on IS NULL;

-- Los duplicados que el fallo ya dejó creados: un mismo día de una misma regla
-- con dos sesiones o más. Sólo una puede quedarse con la ocurrencia, así que a
-- las demás se les suelta la marca y siguen siendo sesiones normales.
--
-- No se borra ninguna. Una de ellas puede tener asistencia marcada, haber
-- descontado del saldo o estar cancelada a propósito, y una migración no es el
-- sitio donde decidir a ciegas que el historial de alguien sobra. Quedan a la
-- vista en la agenda para que la entrenadora quite las que no quiere.
--
-- Se queda la que más pesa: la que se dio, luego la que no se presentó, luego
-- la cancelada, y a igualdad, la más antigua —la original, antes de que el
-- fallo la copiara—.
WITH ordenadas AS (
  SELECT id, row_number() OVER (
    PARTITION BY recurrence_id, recurrence_on
    ORDER BY CASE status
        WHEN 'completed' THEN 0
        WHEN 'no_show' THEN 1
        WHEN 'cancelled' THEN 2
        ELSE 3
      END, created_at, id
  ) AS puesto
  FROM sessions
  WHERE recurrence_id IS NOT NULL AND recurrence_on IS NOT NULL
)
UPDATE sessions s SET recurrence_on = NULL
FROM ordenadas o
WHERE o.id = s.id AND o.puesto > 1;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_ocurrencia_idx
  ON sessions(recurrence_id, recurrence_on)
  WHERE recurrence_id IS NOT NULL AND recurrence_on IS NOT NULL;
