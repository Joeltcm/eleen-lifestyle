ALTER TABLE notification_preferences
  ALTER COLUMN session_reminder_hours SET DEFAULT 1;

-- The previous default was 24 hours. Move untouched/default preferences to the
-- requested one-hour reminder while preserving custom values chosen by users.
UPDATE notification_preferences
SET session_reminder_hours = 1, updated_at = now()
WHERE session_reminder_hours = 24;
