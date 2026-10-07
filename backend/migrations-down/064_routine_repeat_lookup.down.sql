BEGIN;

DROP INDEX IF EXISTS routine_deliveries_repeat_lookup_idx;

DELETE FROM schema_migrations WHERE name = '064_routine_repeat_lookup.sql';

COMMIT;
