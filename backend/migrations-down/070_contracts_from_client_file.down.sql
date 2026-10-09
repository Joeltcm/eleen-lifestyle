BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM client_contracts)
     OR EXISTS (SELECT 1 FROM contract_notifications)
     OR EXISTS (SELECT 1 FROM account_settings WHERE legal_name IS NOT NULL OR legal_id IS NOT NULL OR legal_address IS NOT NULL OR contract_city IS NOT NULL)
     OR EXISTS (SELECT 1 FROM clients WHERE id_document IS NOT NULL OR birth_date IS NOT NULL OR emergency_contact_name IS NOT NULL OR emergency_contact_phone IS NOT NULL OR address IS NOT NULL)
     OR EXISTS (SELECT 1 FROM service_plans WHERE service_type <> 'presencial' OR routines_per_month IS NOT NULL)
  THEN
    IF COALESCE(current_setting('billing.allow_destructive_down', true), '') <> 'on' THEN
      RAISE EXCEPTION 'hay contratos o datos legales; la reversa 070 exige orden expresa con billing.allow_destructive_down = on';
    END IF;
  END IF;
END $$;
DROP TRIGGER IF EXISTS contract_document_immutable ON documents;
DROP FUNCTION IF EXISTS protect_contract_document();
DROP TABLE IF EXISTS contract_notifications;
DROP TABLE IF EXISTS client_contracts;
DROP FUNCTION IF EXISTS protect_signed_contract();
ALTER TABLE account_settings DROP COLUMN IF EXISTS contract_city;
ALTER TABLE account_settings DROP COLUMN IF EXISTS legal_address;
ALTER TABLE account_settings DROP COLUMN IF EXISTS legal_id;
ALTER TABLE account_settings DROP COLUMN IF EXISTS legal_name;
ALTER TABLE service_plans DROP CONSTRAINT IF EXISTS service_plans_routines_per_month_check;
ALTER TABLE service_plans DROP CONSTRAINT IF EXISTS service_plans_service_type_check;
ALTER TABLE service_plans DROP COLUMN IF EXISTS routines_per_month;
ALTER TABLE service_plans DROP COLUMN IF EXISTS service_type;
ALTER TABLE clients DROP COLUMN IF EXISTS address;
ALTER TABLE clients DROP COLUMN IF EXISTS emergency_contact_phone;
ALTER TABLE clients DROP COLUMN IF EXISTS emergency_contact_name;
ALTER TABLE clients DROP COLUMN IF EXISTS birth_date;
ALTER TABLE clients DROP COLUMN IF EXISTS id_document;
DELETE FROM schema_migrations WHERE name = '070_contracts_from_client_file.sql';
COMMIT;
