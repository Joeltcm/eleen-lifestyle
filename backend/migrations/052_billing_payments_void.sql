-- Etapa 1B-3: anular un cobro mal registrado.
--
-- Un cobro (dinero recibido) no se edita ni se borra. Si se registró mal (monto, fecha,
-- pagador), se ANULA con motivo —después de revertir sus aplicaciones— y se registra
-- uno correcto. Esta migración es aditiva: agrega las columnas de anulación a
-- billing_payments, impide cualquier otro cambio sobre un cobro y reemplaza la guarda
-- de aplicaciones de la 051 para que un cobro anulado no pueda aplicarse.
-- Reversa: backend/migrations-down/052_billing_payments_void.down.sql.

ALTER TABLE billing_payments
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS voided_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE billing_payments ADD CONSTRAINT billing_payments_void_consistency CHECK (
  (voided_at IS NULL AND void_reason IS NULL)
  OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND length(btrim(void_reason)) > 0)
);

-- Un cobro solo puede cambiar para anularse; todo lo demás es inmutable.
CREATE OR REPLACE FUNCTION billing_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.payer_client_id IS DISTINCT FROM OLD.payer_client_id
     OR NEW.paid_on IS DISTINCT FROM OLD.paid_on OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.method IS DISTINCT FROM OLD.method OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.source_system IS DISTINCT FROM OLD.source_system OR NEW.external_id IS DISTINCT FROM OLD.external_id THEN
    RAISE EXCEPTION 'Un cobro no se edita: se anula con motivo y se registra uno correcto' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL AND NEW.voided_at IS NULL THEN
    RAISE EXCEPTION 'Un cobro anulado no se reactiva' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM billing_payment_applications WHERE payment_id = NEW.id AND reversed_at IS NULL) THEN
      RAISE EXCEPTION 'El cobro tiene aplicaciones vigentes: revierta primero esas aplicaciones' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_payments_guard BEFORE UPDATE ON billing_payments
  FOR EACH ROW EXECUTE FUNCTION billing_payment_guard();

-- Misma guarda de aplicaciones que la 051, más: no se aplica un cobro anulado.
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
  IF pay.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'No se aplica un cobro anulado' USING ERRCODE = 'check_violation';
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
