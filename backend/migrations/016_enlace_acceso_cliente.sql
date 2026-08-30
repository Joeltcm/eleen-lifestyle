-- Enlaces de acceso de un solo uso para el portal del cliente.
--
-- Hasta ahora la entrenadora inventaba la contraseña del cliente y se la
-- comunicaba, y cada olvido la obligaba a repetir el trámite a mano. Con esto
-- genera un enlace, el cliente define su propia contraseña, y ella nunca llega
-- a conocerla.
CREATE TABLE IF NOT EXISTS portal_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Sólo el hash. Quien lea la base no debe poder usar un enlace vigente, del
  -- mismo modo que no puede leer una contraseña.
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_access_tokens_client_idx
  ON portal_access_tokens(client_id, created_at DESC);

-- Para poder invalidar de golpe los enlaces vivos de un cliente cuando se
-- emite uno nuevo: si emitió dos, sólo el último debe servir.
CREATE INDEX IF NOT EXISTS portal_access_tokens_vigentes_idx
  ON portal_access_tokens(client_id)
  WHERE used_at IS NULL;
