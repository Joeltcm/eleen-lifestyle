-- El horario de trabajo de la entrenadora, por tramos.
--
-- Hasta ahora se deducía de su agenda —de la clase más temprana a la más
-- tardía—, y eso no sabe de cortes: quien entrena de 5 a 11 y de 4 a 8 tenía
-- toda la tarde muerta ofrecida como hueco libre. Varios tramos por día es el
-- caso normal aquí, no la excepción.
--
-- Una fila por tramo, no una franja por día: así el turno de mañana y el de
-- tarde son dos cosas independientes que se mueven por separado, y añadir un
-- tercero no cambia nada.
CREATE TABLE IF NOT EXISTS working_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 0 = domingo, 6 = sábado; el mismo criterio que el resto de la aplicación.
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts_at time NOT NULL,
  ends_at time NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS working_hours_dueno_idx ON working_hours(owner_id, weekday, starts_at);
