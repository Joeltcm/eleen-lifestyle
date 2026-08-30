-- La mensualidad también trae un límite de sesiones.
--
-- Hasta ahora sólo los paquetes llevaban saldo: session_packages guarda
-- total/usadas/vencimiento y el descuento al completar una sesión busca ahí.
-- Un cliente de mensualidad no tenía ninguno, así que sus sesiones no se
-- descontaban de nada y su límite contratado no existía para el sistema.
--
-- En vez de inventar una segunda tabla con la misma forma, la mensualidad usa
-- la que ya está: un saldo que vence al cierre del período. Así el descuento,
-- el control de saldos y el cumplimiento funcionan igual para los dos sin
-- duplicar lógica.
ALTER TABLE session_packages ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'package';

ALTER TABLE session_packages DROP CONSTRAINT IF EXISTS session_packages_kind_check;
ALTER TABLE session_packages ADD CONSTRAINT session_packages_kind_check
  CHECK (kind IN ('package', 'monthly'));

CREATE INDEX IF NOT EXISTS session_packages_vencimiento_idx
  ON session_packages(client_id, expires_on)
  WHERE expires_on IS NOT NULL;
