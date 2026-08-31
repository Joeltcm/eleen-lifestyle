-- Cancelar una clase deja de ser gratis.
--
-- El cálculo de cumplimiento excluía las canceladas por completo: al cancelar,
-- la sesión no contaba como incumplida, simplemente desaparecía del promedio.
-- Un cliente que cancelaba la mitad de sus clases seguía saliendo al 100%.
--
-- Pero no toda cancelación es igual: si la clase se mueve a otro día, la que
-- cuenta es la nueva, y penalizar las dos sería cobrar dos veces por lo mismo.
-- De ahí que al cancelar haya que decir cuál de las dos cosas es.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cancellation_kind text;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_cancelacion_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_cancelacion_check
  CHECK (cancellation_kind IS NULL OR cancellation_kind IN ('rescheduled', 'not_rescheduled'));

-- Las canceladas de antes se quedan en NULL y siguen sin contar. No sabemos
-- cuáles se reprogramaron, e inventarlo reescribiría el historial de
-- cumplimiento de todos hacia atrás.
CREATE INDEX IF NOT EXISTS sessions_cancelacion_idx
  ON sessions (client_id, starts_at) WHERE cancellation_kind = 'not_rescheduled';
