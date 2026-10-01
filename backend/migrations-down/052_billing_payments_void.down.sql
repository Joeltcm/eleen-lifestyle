-- Reversa de 052_billing_payments_void.sql: quita la anulación de cobros y restaura la
-- guarda de aplicaciones de la 051. No toca facturas ni aplicaciones. Fallará si hay cobros
-- anulados que se quiera conservar: respaldar antes. Se ejecuta a mano:
--   psql "$DATABASE_URL" -f migrations-down/052_billing_payments_void.down.sql
BEGIN;
DROP TRIGGER IF EXISTS billing_payments_guard ON billing_payments;
DROP FUNCTION IF EXISTS billing_payment_guard();
ALTER TABLE billing_payments DROP CONSTRAINT IF EXISTS billing_payments_void_consistency;
ALTER TABLE billing_payments DROP COLUMN IF EXISTS voided_at, DROP COLUMN IF EXISTS void_reason, DROP COLUMN IF EXISTS voided_by;
CREATE OR REPLACE FUNCTION billing_check_application() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pay billing_payments%ROWTYPE; inv billing_invoices%ROWTYPE; aplicado_cobro numeric(12, 2); aplicado_factura numeric(12, 2);
BEGIN
  IF NEW.reversed_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT * INTO pay FROM billing_payments WHERE id = NEW.payment_id FOR UPDATE;
  SELECT * INTO inv FROM billing_invoices WHERE id = NEW.invoice_id FOR UPDATE;
  IF pay.owner_id <> inv.owner_id THEN
    RAISE EXCEPTION 'El cobro y la factura son de dueños distintos' USING ERRCODE = 'check_violation';
  END IF;
  IF pay.payer_client_id <> inv.payer_client_id THEN
    RAISE EXCEPTION 'Un cobro solo se aplica a facturas de su mismo pagador' USING ERRCODE = 'check_violation';
  END IF;
  IF inv.status = 'anulada' THEN
    RAISE EXCEPTION 'No se aplica un cobro a una factura anulada' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO aplicado_cobro FROM billing_payment_applications
    WHERE payment_id = NEW.payment_id AND reversed_at IS NULL AND id <> NEW.id;
  IF aplicado_cobro + NEW.amount > pay.amount THEN
    RAISE EXCEPTION 'La aplicación supera lo disponible del cobro (% de %)', aplicado_cobro + NEW.amount, pay.amount
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO aplicado_factura FROM billing_payment_applications
    WHERE invoice_id = NEW.invoice_id AND reversed_at IS NULL AND id <> NEW.id;
  IF aplicado_factura + NEW.amount > inv.total THEN
    RAISE EXCEPTION 'La aplicación supera el saldo de la factura (% de %)', aplicado_factura + NEW.amount, inv.total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DELETE FROM schema_migrations WHERE name = '052_billing_payments_void.sql';
COMMIT;
