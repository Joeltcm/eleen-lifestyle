CREATE TABLE IF NOT EXISTS ai_usage_daily (
  usage_date date NOT NULL,
  feature text NOT NULL,
  units integer NOT NULL DEFAULT 0 CHECK (units >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usage_date, feature)
);
