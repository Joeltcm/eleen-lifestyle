-- Quién cancela la clase, y qué se hace a cambio.
--
-- Hasta ahora sólo se guardaba si la clase se reprogramaría o no, nunca de
-- quién venía la cancelación. Con eso, una clase que cancelaba la entrenadora
-- le bajaba el cumplimiento al cliente igual que si hubiera faltado él: la
-- métrica culpaba a quien no lo causó.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cancelled_by text
  CHECK (cancelled_by IN ('client', 'trainer'));

-- Las que ya estaban se quedan como cliente, que es como se contaron hasta
-- hoy. Reinterpretar el pasado a ciegas cambiaría cumplimientos ya dados por
-- buenos sin que nadie lo haya decidido.
UPDATE sessions SET cancelled_by = 'client'
WHERE status = 'cancelled' AND cancelled_by IS NULL;

-- Descuentos a favor del cliente por clases que la entrenadora no dio.
--
-- La alternativa a reponer: en vez de otra clase, menos dinero el mes que
-- viene. Se guarda como algo propio y no restando del cobro a mano, porque
-- tiene que quedar dicho de dónde salió —qué clase, de qué día— y verse en el
-- estado de cuenta del cliente el día que pregunte.
CREATE TABLE IF NOT EXISTS billing_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  concept text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  -- Nulo mientras está pendiente; al aplicarse queda apuntando al cobro que
  -- rebajó, para que no se aplique dos veces y se sepa dónde acabó.
  applied_invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  applied_on date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_credits_pendientes_idx
  ON billing_credits(client_id) WHERE applied_invoice_id IS NULL;
