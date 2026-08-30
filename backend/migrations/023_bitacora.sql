-- Bitácora de borrados.
--
-- La aplicación borra de verdad: clientes, mediciones, rutinas, documentos,
-- gastos, cobros y saldos desaparecen sin dejar rastro. Es una decisión
-- deliberada —se pidió poder limpiar cobros de prueba— pero hasta ahora no
-- quedaba constancia de quién borró qué ni cuándo, así que un borrado por
-- error era indistinguible de algo que nunca existió.
--
-- No pretende ser un historial de cambios con antes/después: registra las
-- acciones destructivas, que son las que no se pueden deshacer.
CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  -- Se conserva el correo aparte del id: si algún día se borra el usuario,
  -- la bitácora debe seguir diciendo quién fue.
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  user_email text,
  action text NOT NULL,
  route text NOT NULL,
  target_id text,
  detail jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_fecha_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_usuario_idx ON audit_log (user_id, created_at DESC);
