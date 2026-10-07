BEGIN;
DROP INDEX IF EXISTS session_routine_offers_routine_status_idx;
DROP INDEX IF EXISTS routines_owner_archived_created_idx;
DROP INDEX IF EXISTS routines_supersedes_idx;
DELETE FROM schema_migrations WHERE name = '065_routine_versions_indexes.sql';
COMMIT;
