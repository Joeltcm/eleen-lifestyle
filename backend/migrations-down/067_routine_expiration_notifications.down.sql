-- Quitar el tipo 'expired' borraría los avisos de expiración ya emitidos (y su
-- clave de idempotencia). Exige orden expresa si existe alguno.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM routine_activity_notifications WHERE kind = 'expired')
     AND COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
    RAISE EXCEPTION 'hay avisos de rutina expirada registrados; la reversa 067 exige orden expresa con billing.allow_destructive_down = on';
  END IF;
END $$;
DELETE FROM routine_activity_notifications WHERE kind = 'expired';
ALTER TABLE routine_activity_notifications DROP CONSTRAINT IF EXISTS routine_activity_notifications_kind_check;
ALTER TABLE routine_activity_notifications
  ADD CONSTRAINT routine_activity_notifications_kind_check CHECK (kind IN ('started', 'completed', 'feedback'));
DELETE FROM schema_migrations WHERE name = '067_routine_expiration_notifications.sql';
COMMIT;
