-- Horarios fijos que se repiten hasta que alguien los detenga.
--
-- Agendar por lotes resolvía "las próximas cuatro semanas", pero un cliente que
-- entrena lunes y miércoles a las 5:30 no tiene fecha de fin: entrena hasta que
-- deja de entrenar. Con un rango fijo había que acordarse de volver a agendar
-- cada mes, y el día que se olvidara, el cliente se quedaba sin agenda.
--
-- No se guardan sesiones infinitas: se guarda la regla, y un proceso mantiene
-- creadas las de las próximas semanas. Así cambiar o detener el horario no
-- obliga a borrar cientos de filas futuras.
CREATE TABLE IF NOT EXISTS session_recurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  routine_id uuid REFERENCES routines(id) ON DELETE SET NULL,
  -- 0 = domingo, 6 = sábado; el mismo criterio que getDay() del navegador.
  weekdays smallint[] NOT NULL CHECK (array_length(weekdays, 1) BETWEEN 1 AND 7),
  -- Hora local de Panamá. Se guarda como hora y no como marca de tiempo porque
  -- lo que se repite es "las 5:30 de la mañana", no un instante concreto.
  time_of_day time NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 15 AND 480),
  mode text NOT NULL DEFAULT 'Presencial',
  notes text,
  starts_on date NOT NULL DEFAULT current_date,
  -- Nulo a propósito: indefinido es el caso normal.
  ends_on date,
  active boolean NOT NULL DEFAULT true,
  stopped_at timestamptz,
  stopped_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_recurrences_activas_idx
  ON session_recurrences (client_id) WHERE active;

-- Permite reconocer las sesiones nacidas de una regla, para no duplicarlas y
-- para poder retirar las futuras cuando el horario se detiene.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS recurrence_id uuid
  REFERENCES session_recurrences(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sessions_recurrencia_idx
  ON sessions (recurrence_id, starts_at) WHERE recurrence_id IS NOT NULL;
