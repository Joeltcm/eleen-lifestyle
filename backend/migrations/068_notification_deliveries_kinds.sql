-- notification_deliveries solo admitía 'session' y 'payment', pero el código también registra
-- 'pending' (clase sin marcar) y 'pause' (pausa por terminar): esos INSERT fallaban por la
-- restricción y abortaban toda la tanda de recordatorios. Se amplía la lista y se añade
-- 'routine_expiring' (aviso a la clienta de que su rutina ofrecida vence esta noche).
ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_kind_check;
ALTER TABLE notification_deliveries
  ADD CONSTRAINT notification_deliveries_kind_check
  CHECK (kind IN ('session', 'payment', 'pending', 'pause', 'routine_expiring'));

-- Al activarse "falta marcar" por primera vez NO se avisa de las clases ya terminadas y sin
-- marcar (hasta 7 días atrás): se dan por avisadas para no mandar una ráfaga de pushes a
-- Eileen. Solo se avisará de las que terminen a partir de ahora.
INSERT INTO notification_deliveries (user_id, kind, reference_id)
SELECT DISTINCT c.owner_id, 'pending', s.id
FROM sessions s JOIN clients c ON c.id = s.client_id
JOIN users u ON u.id = c.owner_id AND u.role IN ('admin', 'trainer')
WHERE s.status = 'scheduled' AND s.starts_at + make_interval(mins => s.duration_minutes) <= now()
ON CONFLICT DO NOTHING;
