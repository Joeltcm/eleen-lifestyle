-- Modalidad de pago del cliente.
--
-- 'anticipado' (por defecto): paga por adelantado. El saldo de sesiones se abre
--   y esas clases ya están pagadas. Es como funciona casi todo el mundo.
-- 'no_anticipado': entrena a crédito y paga al final del ciclo (el caso de
--   Julio: da sus clases y paga en su día de corte cubriendo lo que YA dio).
--   El saldo se abre IGUAL —entrena—, pero mientras no se registre el pago la
--   ficha lo señala como "pago pendiente" para no confundir clases dadas a
--   crédito con clases ya cobradas. La única diferencia es esa alerta.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'anticipado';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_payment_mode_check') THEN
    ALTER TABLE clients ADD CONSTRAINT clients_payment_mode_check
      CHECK (payment_mode IN ('anticipado', 'no_anticipado'));
  END IF;
END $$;
