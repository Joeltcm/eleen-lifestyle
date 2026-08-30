-- Meta de sesiones mensuales pactada con el cliente.
--
-- La derivación automática (paquete repartido entre sus meses, o cadencia de
-- la rutina activa) sólo cubre a quien tiene paquete con vencimiento o rutina
-- asignada. La cartera es mayormente de mensualidad, donde ni una ni otra
-- existen, y esos clientes quedaban sin nada contra qué medirse. Este campo
-- manda sobre ambas derivaciones cuando está puesto.
--
-- Nulo significa "no pactada": se cae a la derivación automática y, si tampoco
-- hay, la pantalla dice que no hay referencia en vez de inventar una meta.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS monthly_session_target integer;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_monthly_session_target_check;
ALTER TABLE clients ADD CONSTRAINT clients_monthly_session_target_check
  CHECK (monthly_session_target IS NULL OR (monthly_session_target > 0 AND monthly_session_target <= 31));
