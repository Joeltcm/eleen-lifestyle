-- Etapa 1B-1: modelo de facturación nuevo (facturas, cobros y aplicaciones).
--
-- Son tablas NUEVAS y separadas del sistema anterior (`invoices`, `invoice_payments`,
-- `payment_allocations`): esta migración no modifica ni lee nada de ellas. Mientras
-- el generador nuevo esté apagado nadie escribe aquí salvo la pantalla manual de
-- 1B-2. Vocabulario (D-16): FACTURA = documento por cobrar con número FAC-;
-- COBRO = dinero recibido; APLICACIÓN = a qué factura se asigna ese dinero.
--
-- Reglas que la base misma hace cumplir (defensa en profundidad; la API valida
-- además y da mensajes claros):
--   * el número FAC es único por dueño y se asigna sin huecos (billing_next_number);
--   * una factura emitida no se borra ni se renumera ni se edita: solo cambia de
--     estado (anulada, con motivo);
--   * el total de la factura es la suma de sus líneas;
--   * un cobro solo se aplica a facturas del mismo dueño y pagador, y sin superar
--     ni lo disponible del cobro ni el saldo de la factura.
-- Reversa: backend/migrations-down/051_billing_core.down.sql.

-- ── Numeración sin huecos, por dueño ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_counters (
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (owner_id, name)
);

-- Toma el siguiente número. El UPSERT bloquea la fila del contador hasta que
-- termina la transacción de quien la llama: dos altas simultáneas se serializan
-- y, si la transacción falla, el contador vuelve atrás. Una SEQUENCE de Postgres
-- dejaría huecos al revertir; esto no.
CREATE OR REPLACE FUNCTION billing_next_number(p_owner uuid, p_name text DEFAULT 'invoice')
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  INSERT INTO billing_counters (owner_id, name, last_number) VALUES (p_owner, p_name, 1)
  ON CONFLICT (owner_id, name) DO UPDATE SET last_number = billing_counters.last_number + 1
  RETURNING last_number INTO n;
  RETURN n;
END $$;

-- ── Facturas ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  payer_client_id uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('mensual', 'credito', 'clase_suelta', 'paquete', 'manual')),
  origin text NOT NULL CHECK (origin IN ('auto', 'manual', 'carga_inicial')),
  cycle_start date NOT NULL,
  cycle_end date NOT NULL,
  cut_day smallint NOT NULL CHECK (cut_day BETWEEN 1 AND 31),
  issued_on date NOT NULL,
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'parcial', 'pagada', 'anulada')),
  total numeric(12, 2) NOT NULL CHECK (total >= 0),
  void_reason text,
  voided_at timestamptz,
  voided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  source_system text,
  external_id text,
  CHECK (cycle_end >= cycle_start),
  CHECK (status <> 'anulada' OR (void_reason IS NOT NULL AND length(btrim(void_reason)) > 0 AND voided_at IS NOT NULL)),
  CHECK (status = 'anulada' OR (void_reason IS NULL AND voided_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_invoices_number_idx ON billing_invoices (owner_id, number);
-- Una factura de mensualidad, crédito o paquete por pagador, ciclo y modalidad
-- (las anuladas no cuentan: se puede reemplazar una anulada).
CREATE UNIQUE INDEX IF NOT EXISTS billing_invoices_cycle_idx
  ON billing_invoices (owner_id, payer_client_id, cycle_start, kind)
  WHERE kind IN ('mensual', 'credito', 'paquete') AND status <> 'anulada';
CREATE UNIQUE INDEX IF NOT EXISTS billing_invoices_external_idx
  ON billing_invoices (owner_id, source_system, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_invoices_payer_idx ON billing_invoices (owner_id, payer_client_id, cycle_start DESC);
CREATE INDEX IF NOT EXISTS billing_invoices_due_idx ON billing_invoices (owner_id, due_on) WHERE status IN ('pendiente', 'parcial');

-- ── Líneas: una por beneficiario ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES billing_invoices(id) ON DELETE RESTRICT,
  beneficiary_client_id uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  plan_id uuid REFERENCES service_plans(id) ON DELETE SET NULL,
  line_type text NOT NULL DEFAULT 'plan' CHECK (line_type IN ('plan', 'sesion', 'ajuste')),
  description text NOT NULL,
  quantity numeric(10, 2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount numeric(12, 2) NOT NULL,
  amount numeric(12, 2) NOT NULL,
  -- Solo texto de referencia (D-14): nunca un saldo de clases.
  sessions_reference integer CHECK (sessions_reference IS NULL OR sessions_reference > 0),
  CHECK (line_type = 'ajuste' OR amount >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_invoice_lines_plan_idx
  ON billing_invoice_lines (invoice_id, beneficiary_client_id) WHERE line_type = 'plan';
CREATE INDEX IF NOT EXISTS billing_invoice_lines_invoice_idx ON billing_invoice_lines (invoice_id);
CREATE INDEX IF NOT EXISTS billing_invoice_lines_beneficiary_idx ON billing_invoice_lines (beneficiary_client_id);

-- ── Cobros (dinero recibido) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payer_client_id uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  paid_on date NOT NULL,
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('Efectivo', 'Yappy', 'Transferencia bancaria', 'Tarjeta', 'Otro')),
  reference text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  source_system text,
  external_id text
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_payments_external_idx
  ON billing_payments (owner_id, source_system, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_payments_payer_idx ON billing_payments (owner_id, payer_client_id, paid_on DESC);

-- ── Aplicaciones: a qué factura va cada cobro ────────────────────────────────
-- Un cobro no se edita ni se borra: una corrección se hace REVIRTIENDO la
-- aplicación (queda marcada, con motivo) y aplicando de nuevo.
CREATE TABLE IF NOT EXISTS billing_payment_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES billing_payments(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL REFERENCES billing_invoices(id) ON DELETE RESTRICT,
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  applied_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reversed_at timestamptz,
  reversed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reversal_reason text,
  CHECK ((reversed_at IS NULL AND reversal_reason IS NULL)
      OR (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL AND length(btrim(reversal_reason)) > 0))
);
CREATE INDEX IF NOT EXISTS billing_payment_applications_payment_idx ON billing_payment_applications (payment_id);
CREATE INDEX IF NOT EXISTS billing_payment_applications_invoice_idx ON billing_payment_applications (invoice_id);

-- ── Ajustes (créditos, descuentos, recargos) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payer_client_id uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('credito', 'descuento', 'recargo')),
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  source_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  applied_invoice_id uuid REFERENCES billing_invoices(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS billing_adjustments_payer_idx ON billing_adjustments (owner_id, payer_client_id);

-- ── Bitácora ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_audit (
  id bigserial PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS billing_audit_owner_idx ON billing_audit (owner_id, at DESC);
CREATE INDEX IF NOT EXISTS billing_audit_entity_idx ON billing_audit (entity, entity_id);

-- ── Reglas que hace cumplir la base ──────────────────────────────────────────

-- Una factura emitida no se borra.
CREATE OR REPLACE FUNCTION billing_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Una factura emitida no se borra: se anula con motivo (%)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER billing_invoices_no_delete BEFORE DELETE ON billing_invoices
  FOR EACH ROW EXECUTE FUNCTION billing_forbid_delete();
CREATE TRIGGER billing_invoice_lines_no_delete BEFORE DELETE ON billing_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION billing_forbid_delete();

-- Una factura emitida no se renumera ni se edita: solo puede pasar a otro estado
-- (parcial, pagada, anulada) o anotarse. Sus líneas son inmutables.
CREATE OR REPLACE FUNCTION billing_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.payer_client_id IS DISTINCT FROM OLD.payer_client_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.cycle_start IS DISTINCT FROM OLD.cycle_start
     OR NEW.cycle_end IS DISTINCT FROM OLD.cycle_end OR NEW.cut_day IS DISTINCT FROM OLD.cut_day
     OR NEW.issued_on IS DISTINCT FROM OLD.issued_on OR NEW.due_on IS DISTINCT FROM OLD.due_on
     OR NEW.total IS DISTINCT FROM OLD.total OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.source_system IS DISTINCT FROM OLD.source_system OR NEW.external_id IS DISTINCT FROM OLD.external_id THEN
    RAISE EXCEPTION 'Una factura emitida no se edita ni se renumera: se anula con motivo y se emite otra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'anulada' AND NEW.status <> 'anulada' THEN
    RAISE EXCEPTION 'Una factura anulada no se reactiva' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_invoices_guard BEFORE UPDATE ON billing_invoices
  FOR EACH ROW EXECUTE FUNCTION billing_invoice_guard();

CREATE OR REPLACE FUNCTION billing_line_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Las líneas de una factura emitida no se editan' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER billing_invoice_lines_immutable BEFORE UPDATE ON billing_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION billing_line_immutable();

-- El total es la suma de las líneas. Se comprueba AL CIERRE de la transacción
-- (DEFERRED), porque la cabecera se inserta antes que sus líneas.
CREATE OR REPLACE FUNCTION billing_check_invoice_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv_id uuid; header numeric(12, 2); suma numeric(12, 2); lineas integer;
BEGIN
  -- Se separa en IF/ELSE: plpgsql resolvería NEW.invoice_id también para la tabla
  -- de cabeceras (que no tiene ese campo) si fuera una sola expresión.
  IF TG_TABLE_NAME = 'billing_invoices' THEN
    inv_id := NEW.id;
  ELSE
    inv_id := NEW.invoice_id;
  END IF;
  SELECT total INTO header FROM billing_invoices WHERE id = inv_id;
  IF header IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(amount), 0), count(*) INTO suma, lineas FROM billing_invoice_lines WHERE invoice_id = inv_id;
  IF lineas = 0 THEN
    RAISE EXCEPTION 'La factura debe tener al menos una línea' USING ERRCODE = 'check_violation';
  END IF;
  IF suma <> header THEN
    RAISE EXCEPTION 'El total de la factura (%) no coincide con la suma de sus líneas (%)', header, suma
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER billing_invoices_sum_of_lines AFTER INSERT ON billing_invoices
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_check_invoice_total();
CREATE CONSTRAINT TRIGGER billing_invoice_lines_sum_of_lines AFTER INSERT ON billing_invoice_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_check_invoice_total();

-- Un cobro solo se aplica a facturas del mismo dueño y pagador, sin superar lo
-- disponible del cobro ni el saldo de la factura (las aplicaciones revertidas no
-- cuentan). Bloquea cobro y factura para que dos aplicaciones simultáneas no
-- se pisen.
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
CREATE TRIGGER billing_payment_applications_check BEFORE INSERT ON billing_payment_applications
  FOR EACH ROW EXECUTE FUNCTION billing_check_application();

-- Los cobros y las aplicaciones no se borran; una aplicación solo puede
-- marcarse como revertida.
CREATE TRIGGER billing_payments_no_delete BEFORE DELETE ON billing_payments
  FOR EACH ROW EXECUTE FUNCTION billing_forbid_delete();
CREATE TRIGGER billing_payment_applications_no_delete BEFORE DELETE ON billing_payment_applications
  FOR EACH ROW EXECUTE FUNCTION billing_forbid_delete();

CREATE OR REPLACE FUNCTION billing_application_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_id IS DISTINCT FROM OLD.payment_id OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.applied_on IS DISTINCT FROM OLD.applied_on THEN
    RAISE EXCEPTION 'Una aplicación no se edita: se revierte y se aplica de nuevo' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.reversed_at IS NOT NULL AND NEW.reversed_at IS NULL THEN
    RAISE EXCEPTION 'Una aplicación revertida no se reactiva' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_payment_applications_guard BEFORE UPDATE ON billing_payment_applications
  FOR EACH ROW EXECUTE FUNCTION billing_application_guard();
