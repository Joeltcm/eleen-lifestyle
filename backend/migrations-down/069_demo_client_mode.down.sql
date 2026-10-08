BEGIN;
DO $$
BEGIN
  IF (
    EXISTS (SELECT 1 FROM clients WHERE service_mode = 'demo')
    OR EXISTS (SELECT 1 FROM client_mode_events)
  ) AND COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
    RAISE EXCEPTION 'hay clientes o eventos demo; la reversa 069 exige orden expresa con billing.allow_destructive_down = on';
  END IF;
END $$;
DROP TABLE IF EXISTS account_settings;
DROP TABLE IF EXISTS client_mode_events;
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_demo_routine_limit_check;
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_service_mode_check;
ALTER TABLE clients DROP COLUMN IF EXISTS demo_note;
ALTER TABLE clients DROP COLUMN IF EXISTS demo_converted_at;
ALTER TABLE clients DROP COLUMN IF EXISTS demo_routine_limit;
ALTER TABLE clients DROP COLUMN IF EXISTS demo_ends_on;
ALTER TABLE clients DROP COLUMN IF EXISTS demo_started_on;
ALTER TABLE clients DROP COLUMN IF EXISTS service_mode;
DELETE FROM schema_migrations WHERE name = '069_demo_client_mode.sql';
COMMIT;
