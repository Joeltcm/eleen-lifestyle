-- A quién corresponde cada cobro cuando lo paga otra persona.
--
-- Un pagador puede cubrir la mensualidad de varias personas —esposa, yerno— y
-- cada una tiene su propio precio. Hasta ahora el dependiente no generaba
-- ningún cobro: la regla decía "de una pareja sale una sola factura" y se
-- facturaba sólo la mensualidad del pagador. Con precios distintos por persona
-- eso deja sin cobrar a los demás, en silencio.
--
-- El cobro sigue yendo a nombre de quien paga —es quien debe— pero se guarda
-- de quién es la mensualidad, para que el estado de cuenta la desglose y para
-- poder dar de baja a uno sin tocar a los otros.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS billed_for_client_id uuid REFERENCES clients(id) ON DELETE SET NULL;

-- Lo ya existente es de la propia persona.
UPDATE invoices SET billed_for_client_id = client_id WHERE billed_for_client_id IS NULL;

-- El índice único impedía más de un cobro automático por cliente y mes, que es
-- justo lo que hace falta ahora: tres personas, tres cobros, un solo pagador.
DROP INDEX IF EXISTS invoices_automatic_period_idx;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_automatic_period_idx
  ON invoices(client_id, billing_period, billed_for_client_id)
  WHERE auto_generated = true;

CREATE INDEX IF NOT EXISTS invoices_por_persona_idx
  ON invoices(billed_for_client_id, billing_period DESC)
  WHERE billed_for_client_id IS NOT NULL;
