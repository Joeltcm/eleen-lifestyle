-- Registro reversible de reemplazos de videos. Los objetos originales en R2
-- permanecen intactos hasta que se ejecute --purgar-originales explícitamente.
CREATE TABLE IF NOT EXISTS exercise_video_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('applying', 'applied', 'failed', 'reverted', 'purged')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  reverted_at timestamptz,
  purged_at timestamptz
);

CREATE TABLE IF NOT EXISTS exercise_video_conversion_items (
  conversion_id uuid NOT NULL REFERENCES exercise_video_conversions(id) ON DELETE CASCADE,
  old_object_key text NOT NULL,
  new_object_key text NOT NULL,
  references_json jsonb NOT NULL,
  normalized_size_bytes bigint NOT NULL CHECK (normalized_size_bytes > 0),
  normalized_duration_seconds numeric(6,2),
  converted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversion_id, old_object_key),
  UNIQUE (conversion_id, new_object_key)
);

CREATE INDEX IF NOT EXISTS exercise_video_conversion_status_idx
  ON exercise_video_conversions (status, created_at DESC);
