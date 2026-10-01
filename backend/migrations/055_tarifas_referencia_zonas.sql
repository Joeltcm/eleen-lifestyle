-- E2: las tarifas de referencia se pueden ordenar por zona y distinguir de
-- los acuerdos especiales. No se toca ningún cliente ni concepto de cobro.
ALTER TABLE service_plans
  ADD COLUMN IF NOT EXISTS zone text,
  ADD COLUMN IF NOT EXISTS special_for text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'service_plans' AND column_name = 'zone'
  ) THEN
    COMMENT ON COLUMN service_plans.zone IS 'Zona de cobertura de la tarifa de referencia; no se copia a clientes ni a facturacion';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'service_plans' AND column_name = 'special_for'
  ) THEN
    COMMENT ON COLUMN service_plans.special_for IS 'Cliente o acuerdo especial al que se refiere la tarifa; nunca se ofrece por defecto';
  END IF;
END $$;
