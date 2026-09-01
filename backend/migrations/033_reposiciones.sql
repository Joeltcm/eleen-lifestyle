-- Clases por reponer: las que el cliente pidió mover y no se llegaron a dar.
--
-- Al cerrar el ciclo, una clase cancelada pidiendo otro día no es una clase
-- perdida: es una que quedó debiendo. La entrenadora le da una semana desde el
-- corte para tomarla, dos como mucho. Lo que no se tome en esa semana se
-- pierde y sí cuenta como incumplido, porque la oportunidad estuvo dada.
--
-- Se modela como un saldo más, y no como una tabla aparte, porque es
-- exactamente eso: sesiones disponibles con fecha de caducidad. Así hereda sin
-- código nuevo el descuento al marcar la clase, el conteo de disponibles, y el
-- cumplimiento —que ya apunta como incumplida cada sesión sin usar de un saldo
-- vencido—. Lo único propio es la etiqueta y que no vale dinero: ya se cobró
-- dentro de la mensualidad del mes que cerró.
ALTER TABLE session_packages DROP CONSTRAINT IF EXISTS session_packages_kind_check;
ALTER TABLE session_packages ADD CONSTRAINT session_packages_kind_check
  CHECK (kind IN ('package', 'monthly', 'makeup'));

-- De qué ciclo viene la reposición, para no abrirla dos veces en el mismo
-- corte por mucho que el proceso se repita.
ALTER TABLE session_packages ADD COLUMN IF NOT EXISTS makeup_for_period date;

CREATE UNIQUE INDEX IF NOT EXISTS session_packages_reposicion_idx
  ON session_packages(client_id, makeup_for_period)
  WHERE kind = 'makeup' AND makeup_for_period IS NOT NULL;
