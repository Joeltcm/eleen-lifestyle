-- Lesiones y padecimientos del cliente, pasados o surgidos durante el paquete.
CREATE TABLE IF NOT EXISTS client_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'injury' CHECK (kind IN ('injury', 'condition')),
  title text NOT NULL,
  body_area text,
  severity text NOT NULL DEFAULT 'moderate' CHECK (severity IN ('mild', 'moderate', 'severe')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'monitoring', 'recovered')),
  -- started_on nulo = antecedente sin fecha precisa; el cliente recuerda la lesión
  -- pero no el mes. Obligar una fecha inventaría un dato clínico.
  started_on date,
  resolved_on date,
  restrictions text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (resolved_on IS NULL OR started_on IS NULL OR resolved_on >= started_on)
);

CREATE INDEX IF NOT EXISTS client_conditions_client_idx
  ON client_conditions(client_id, status, started_on DESC);

-- Fotos de progreso. El archivo vive en documents (kind = 'progress_photo');
-- aquí solo se guarda lo que el archivo no sabe de sí mismo.
CREATE TABLE IF NOT EXISTS progress_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  document_id uuid NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  -- taken_on es la fecha de la foto, no la de subida: una foto de hace tres
  -- semanas debe compararse contra el InBody de entonces, no contra el de hoy.
  taken_on date NOT NULL DEFAULT current_date,
  pose text NOT NULL DEFAULT 'front' CHECK (pose IN ('front', 'side', 'back', 'other')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS progress_photos_client_idx
  ON progress_photos(client_id, taken_on DESC);
