-- Repintar de una vez los eventos que ya están en Google.
--
-- Los eventos que crea la aplicación pasan a ir en rosa, para distinguirlos de
-- los propios de Eileen. Pero la sincronización sólo reenvía a Google lo que
-- cambió desde la última vez, así que los que ya existían se quedarían del
-- color de siempre y el calendario acabaría con dos criterios conviviendo.
--
-- Tocar updated_at los marca como pendientes de enviar: en la siguiente
-- sincronización se repintan solos. No cambia ningún dato de la sesión.
UPDATE sessions
SET updated_at = now()
WHERE google_event_id IS NOT NULL
  AND status <> 'cancelled'
  AND starts_at >= now() - interval '1 day';
