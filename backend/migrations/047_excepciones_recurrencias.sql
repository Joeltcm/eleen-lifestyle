-- Excepciones explícitas de un horario fijo.
--
-- Borrar una sesión futura que nació de una recurrencia es una decisión sobre
-- ese día, no una invitación a que el expansor la vuelva a crear. La fila de
-- excepción conserva esa decisión aunque la sesión ya no exista.
CREATE TABLE IF NOT EXISTS session_recurrence_exceptions (
  recurrence_id uuid NOT NULL REFERENCES session_recurrences(id) ON DELETE CASCADE,
  recurrence_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recurrence_id, recurrence_on)
);
