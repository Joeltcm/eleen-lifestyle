-- Intentos de autenticación, para frenar la fuerza bruta y dejar rastro.
--
-- No había ningún límite: se podía probar contraseñas contra /api/auth/login
-- tan rápido como aguantara el servidor, y adivinar el SETUP_TOKEN de
-- /api/auth/reset-password, que permite cambiar la contraseña de la primera
-- cuenta administradora. Tampoco quedaba constancia de los fallos.
--
-- Se guarda en la base y no en memoria a propósito: un contador en memoria se
-- borra en cada despliegue —y aquí se despliega a menudo— y no sirve si algún
-- día corre más de una réplica.
--
-- La IP se guarda como texto y no como inet: si llegara una cabecera rara, un
-- inet inválido reventaría el login entero, que es justo lo que no queremos
-- que pase por culpa de un intento de abuso.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id bigserial PRIMARY KEY,
  endpoint text NOT NULL,
  email text,
  ip text,
  succeeded boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Índices parciales: sólo se consultan los fallos recientes.
CREATE INDEX IF NOT EXISTS auth_attempts_correo_idx
  ON auth_attempts (email, created_at DESC) WHERE NOT succeeded;
CREATE INDEX IF NOT EXISTS auth_attempts_ip_idx
  ON auth_attempts (ip, created_at DESC) WHERE NOT succeeded;
CREATE INDEX IF NOT EXISTS auth_attempts_limpieza_idx
  ON auth_attempts (created_at);
