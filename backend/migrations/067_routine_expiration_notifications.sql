-- Una rutina que sustituye una clase puede vencer sin que la clienta la complete.
-- Se conserva como aviso distinto al de rutina completada para que Eileen pueda
-- distinguir el resultado en la campanita y en las notificaciones push.
ALTER TABLE routine_activity_notifications
  DROP CONSTRAINT IF EXISTS routine_activity_notifications_kind_check;

ALTER TABLE routine_activity_notifications
  ADD CONSTRAINT routine_activity_notifications_kind_check
  CHECK (kind IN ('started', 'completed', 'feedback', 'expired'));
