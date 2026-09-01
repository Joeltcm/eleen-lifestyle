-- A quién cubre un cobro, cuando el cobro no lo dice.
--
-- Las facturas de Zoho llegan como llegan: una sola línea de $350 a nombre de
-- quien paga. La app no tenía dónde anotar que esos $350 son la mensualidad de
-- dos personas, $175 cada una, así que a quien no aparecía en la factura no se
-- le abría saldo de sesiones y la generación se la volvía a cobrar creyéndola
-- impaga.
--
-- Esto se guarda aparte y no toca la factura: sobre lo suyo manda Zoho. Es
-- una anotación nuestra que dice "este cobro cubre la mensualidad de fulano
-- en este período", y de ahí salen las sesiones de cada quien.
CREATE TABLE IF NOT EXISTS invoice_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- El saldo que se abrió al aplicar la cobertura. Se recuerda para poder
  -- deshacerlo: quitar la cobertura sin llevarse el saldo dejaría sesiones
  -- regaladas que nadie sabría de dónde salieron.
  package_id uuid REFERENCES session_packages(id) ON DELETE SET NULL,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  -- Primer día del mes que cubre. Es la misma unidad que billing_period en
  -- invoices, para que la generación pueda comparar las dos sin traducir.
  billing_period date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Una persona no puede estar cubierta dos veces en el mismo mes. Sin esto,
  -- pulsar dos veces le abriría dos saldos y le regalaría el doble de clases.
  UNIQUE (client_id, billing_period)
);

CREATE INDEX IF NOT EXISTS invoice_coverage_factura_idx ON invoice_coverage(invoice_id);
