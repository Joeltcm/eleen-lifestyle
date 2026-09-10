-- Saldar, una sola vez, los cobros de Zoho que la entrenadora ya reconció.
--
-- Zoho ya no sincroniza. Un cobro suyo que se pagó después de la migración quedó
-- congelado en 'pendiente', y no había forma de marcarlo pagado dentro de la app
-- (un cobro de Zoho no tiene "Confirmar pago"). Cuando ella le aplica un paquete
-- o una mensualidad, está diciendo que el dinero entró —pero eso, hasta ahora,
-- no cerraba la deuda—, así que el cliente seguía mostrando "pago pendiente"
-- aunque las clases ya estuvieran disponibles.
--
-- Aquí se cierran de golpe los que YA fueron aplicados: un cobro de Zoho
-- pendiente que tiene un paquete ligado (invoice.package_id) o una cobertura
-- anotada (invoice_coverage) es uno que ella ya reconció. No se tocan los que no
-- ha aplicado —esos pueden ser deuda real— ni el ingreso en finanzas, que ya vino
-- con la migración. De aquí en adelante, aplicar salda en el mismo paso.
UPDATE invoices i
SET status = 'confirmed', balance = 0,
    confirmed_at = COALESCE(i.confirmed_at, i.issued_on::timestamptz, i.due_on::timestamptz, now())
WHERE i.source_system = 'zoho_invoice'
  AND i.status = 'pending'
  AND (
    i.package_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM invoice_coverage cov WHERE cov.invoice_id = i.id)
  );
