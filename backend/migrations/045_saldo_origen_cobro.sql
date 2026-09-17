-- De qué cobro salió cada saldo de sesiones.
--
-- Hasta ahora el saldo mensual se abría (por la generación, al confirmar el pago,
-- al asignar el plan o al aplicar la cobertura) sin dejar dicho de qué cobro
-- venía. Esta columna guarda ese vínculo para poder mostrarlo. ON DELETE SET NULL:
-- si el cobro se borra, el saldo queda sin origen pero no se pierde.
ALTER TABLE session_packages
  ADD COLUMN IF NOT EXISTS origin_invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL;
