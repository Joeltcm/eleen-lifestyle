-- Una agenda recurrente permanece activa hasta que Eileen la detiene o marca
-- al cliente como inactivo. Conservamos cualquier fecha final antigua antes
-- de quitarla: así una agenda temporal se puede auditar o reconstruir si fue
-- guardada por la primera versión del editor.
ALTER TABLE session_recurrences
  ADD COLUMN IF NOT EXISTS ends_on_antes_054 date;

UPDATE session_recurrences
SET ends_on_antes_054 = ends_on,
    ends_on = NULL,
    updated_at = now()
WHERE active AND ends_on IS NOT NULL AND ends_on_antes_054 IS NULL;
