-- Parejas con un solo responsable de pago.
--
-- Cada persona conserva su expediente, su InBody, sus rutinas y su
-- cumplimiento: el progreso es individual. Lo que se comparte es el dinero y
-- el saldo de sesiones, que viven en el pagador.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_responsible_client_id uuid REFERENCES clients(id) ON DELETE SET NULL;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_pagador_distinto_check;
ALTER TABLE clients ADD CONSTRAINT clients_pagador_distinto_check
  CHECK (billing_responsible_client_id IS NULL OR billing_responsible_client_id <> id);

CREATE INDEX IF NOT EXISTS clients_pagador_idx
  ON clients(billing_responsible_client_id)
  WHERE billing_responsible_client_id IS NOT NULL;

-- Marca la fecha del encuentro que ya consumió una sesión del saldo. Con un
-- saldo de pareja, si los dos entrenan juntos hay dos sesiones registradas
-- —cada quien tiene su asistencia— pero es un solo encuentro y debe descontar
-- una sola vez. Esto permite reconocer que ese día ya se cobró.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS debited_group_id uuid;

CREATE INDEX IF NOT EXISTS sessions_grupo_cobro_idx
  ON sessions(debited_group_id, starts_at)
  WHERE debited_group_id IS NOT NULL;
