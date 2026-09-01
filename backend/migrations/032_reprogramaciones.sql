-- Reprogramaciones: cuántas veces se movió la clase de cada cliente.
--
-- Cancelar y reprogramar no son lo mismo, y la entrenadora ya lo distingue al
-- cancelar ("se reprogramará" / "no se reprograma"). Lo que faltaba era
-- contarlo: un cliente que cancela y no repone es un problema de cumplimiento,
-- y uno que mueve la clase cuatro veces al mes es un problema de agenda. Sin
-- separarlos, los dos se ven igual.
--
-- Hace falta una tabla y no basta con mirar las sesiones porque la forma más
-- común de reprogramar no deja rastro: arrastrar la cita en Google Calendar
-- mueve la misma sesión y no cancela nada. Aquí se anota el movimiento.
CREATE TABLE IF NOT EXISTS session_reschedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- De dónde a dónde. Se guarda el origen porque una vez movida la sesión, la
  -- fecha vieja no está en ningún sitio y sin ella no se puede saber si el
  -- movimiento cruzó de ciclo.
  from_starts_at timestamptz NOT NULL,
  to_starts_at timestamptz,
  -- 'cancelled'  la cancelación pidiendo reprogramar; todavía sin fecha nueva.
  -- 'moved'      se corrió la cita, en la aplicación o arrastrándola en Google.
  origin text NOT NULL CHECK (origin IN ('cancelled', 'moved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_reschedules_cliente_idx
  ON session_reschedules(client_id, created_at DESC);

-- El ciclo de un cliente empieza en su último día de corte, no el día uno del
-- mes: es la unidad con la que se cobra, se abre el saldo y vence. Contar por
-- mes natural mezclaría dos mensualidades en el mismo número.
CREATE OR REPLACE FUNCTION inicio_ciclo(dia_de_corte integer) RETURNS date AS $$
  SELECT CASE
    WHEN extract(day FROM current_date)::int >= COALESCE(dia_de_corte, 1)
      -- Ya pasó el corte de este mes: el ciclo empezó ahí.
      THEN make_date(
        extract(year FROM current_date)::int, extract(month FROM current_date)::int,
        least(COALESCE(dia_de_corte, 1), extract(day FROM (date_trunc('month', current_date) + interval '1 month - 1 day'))::int))
    -- Todavía no: viene del corte del mes pasado.
    ELSE make_date(
      extract(year FROM (current_date - interval '1 month'))::int,
      extract(month FROM (current_date - interval '1 month'))::int,
      least(COALESCE(dia_de_corte, 1), extract(day FROM (date_trunc('month', current_date - interval '1 month') + interval '1 month - 1 day'))::int))
  END
$$ LANGUAGE sql STABLE;
