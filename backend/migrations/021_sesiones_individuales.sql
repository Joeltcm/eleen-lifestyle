-- Sesiones individuales: se cobra por sesión, sin mensualidad ni paquete.
--
-- Faltaba la tercera modalidad. El concepto ya existía al crear un cobro
-- ("Sesión individual"), pero no se podía tener un plan así, de modo que un
-- cliente suelto había que meterlo como mensualidad y quedaba contado entre
-- las membresías activas y con una meta de cumplimiento que nadie pactó.
--
-- No lleva sessions_included ni validity_days: no hay bolsa de sesiones que
-- gastar ni fecha en la que caduquen. Cada sesión se cobra cuando ocurre.
ALTER TABLE service_plans DROP CONSTRAINT IF EXISTS service_plans_billing_model_check;
ALTER TABLE service_plans ADD CONSTRAINT service_plans_billing_model_check
  CHECK (billing_model IN ('monthly', 'package', 'single'));

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_billing_model_check;
ALTER TABLE clients ADD CONSTRAINT clients_billing_model_check
  CHECK (billing_model IN ('monthly', 'package', 'single'));
