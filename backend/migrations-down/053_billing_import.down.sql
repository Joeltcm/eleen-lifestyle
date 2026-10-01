-- Reversa de 053_billing_import.sql: quita las tablas del cargador y restaura la guarda
-- de borrado de la 051. No toca facturas, cobros ni aplicaciones ya cargadas.
-- Se ejecuta a mano: psql "$DATABASE_URL" -f migrations-down/053_billing_import.down.sql
BEGIN;
DROP TABLE IF EXISTS billing_import_items, billing_import_batches CASCADE;
CREATE OR REPLACE FUNCTION billing_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Una factura emitida no se borra: se anula con motivo (%)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
DELETE FROM schema_migrations WHERE name = '053_billing_import.sql';
COMMIT;
