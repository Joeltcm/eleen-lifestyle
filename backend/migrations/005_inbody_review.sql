ALTER TABLE inbody_assessments
  ADD COLUMN IF NOT EXISTS review_notes jsonb NOT NULL DEFAULT '[]'::jsonb;
