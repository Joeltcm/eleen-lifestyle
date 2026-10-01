-- Una agenda recurrente permanece activa hasta que Eileen la detiene o marca
-- al cliente como inactivo. Las fechas finales que pudiera haber guardado la
-- primera versión del editor no deben apagar una agenda vigente por accidente.
UPDATE session_recurrences
SET ends_on = NULL, updated_at = now()
WHERE active AND ends_on IS NOT NULL;
