-- Solo hay marcas de "ya avisado" (sin datos de negocio): se borran las de los tipos nuevos
-- y se restaura la restricción anterior.
BEGIN;
DELETE FROM notification_deliveries WHERE kind NOT IN ('session', 'payment');
ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_kind_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_kind_check CHECK (kind IN ('session', 'payment'));
DELETE FROM schema_migrations WHERE name = '068_notification_deliveries_kinds.sql';
COMMIT;
