-- Un ejercicio puede tener más de una demostración (por ejemplo, dos variantes
-- de Elevación de Piernas Colgado). Se conserva la columna histórica en
-- exercises para no romper instalaciones ni clientes antiguos: la primera
-- demostración de cada ejercicio sigue siendo el video predeterminado.
CREATE TABLE IF NOT EXISTS exercise_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id uuid NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'Demostración',
  object_key text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('video/mp4', 'video/webm')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  duration_seconds numeric(6,2),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, object_key)
);

CREATE INDEX IF NOT EXISTS exercise_videos_exercise_idx
  ON exercise_videos (owner_id, exercise_id, sort_order, created_at);

-- Los videos existentes pasan a ser la primera demostración sin mover ni
-- renombrar el objeto en R2.
INSERT INTO exercise_videos
  (exercise_id, owner_id, label, object_key, content_type, size_bytes, duration_seconds, uploaded_at)
SELECT id, owner_id, 'Demostración', video_object_key,
       COALESCE(video_content_type, 'video/mp4'), COALESCE(video_size_bytes, 1),
       video_duration_seconds, COALESCE(video_uploaded_at, now())
FROM exercises
WHERE video_object_key IS NOT NULL
ON CONFLICT (owner_id, object_key) DO NOTHING;
