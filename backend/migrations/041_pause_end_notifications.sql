ALTER TABLE client_package_pauses
  ADD COLUMN IF NOT EXISTS ends_on date;

ALTER TABLE client_package_pauses
  DROP CONSTRAINT IF EXISTS client_package_pauses_dates_check;

ALTER TABLE client_package_pauses
  ADD CONSTRAINT client_package_pauses_dates_check
  CHECK (ends_on IS NULL OR ends_on >= starts_on);

CREATE INDEX IF NOT EXISTS client_package_pauses_end_idx
  ON client_package_pauses (status, ends_on)
  WHERE status = 'active' AND ends_on IS NOT NULL;
