-- Registros voluntarios de peso tomados por el cliente.
-- Se conserva el valor mostrado y una copia canónica en kg para que cambiar
-- de unidad no altere la historia ni las gráficas.
CREATE TABLE IF NOT EXISTS client_weight_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  weight_kg numeric(7,3) NOT NULL CHECK (weight_kg > 0 AND weight_kg <= 500),
  weight_value numeric(7,3) NOT NULL CHECK (weight_value > 0 AND weight_value <= 1100),
  unit text NOT NULL CHECK (unit IN ('kg', 'lb')),
  measured_at timestamptz NOT NULL DEFAULT now(),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_weight_logs_client_date_idx
  ON client_weight_logs (client_id, measured_at DESC);
