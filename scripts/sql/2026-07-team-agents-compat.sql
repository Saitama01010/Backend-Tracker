ALTER TABLE team_agents
  ADD COLUMN IF NOT EXISTS arabic_name text;

ALTER TABLE team_agents
  ADD COLUMN IF NOT EXISTS shift text;

ALTER TABLE team_agents
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE team_agents
  ADD COLUMN IF NOT EXISTS active boolean;

UPDATE team_agents
SET active = true
WHERE active IS NULL;

ALTER TABLE team_agents
  ALTER COLUMN active SET DEFAULT true;

ALTER TABLE team_agents
  ALTER COLUMN active SET NOT NULL;

ALTER TABLE team_agents
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

UPDATE team_agents
SET created_at = now()
WHERE created_at IS NULL;

ALTER TABLE team_agents
  ALTER COLUMN created_at SET DEFAULT now();

ALTER TABLE team_agents
  ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE team_agents
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE team_agents
SET updated_at = now()
WHERE updated_at IS NULL;

ALTER TABLE team_agents
  ALTER COLUMN updated_at SET DEFAULT now();

ALTER TABLE team_agents
  ALTER COLUMN updated_at SET NOT NULL;
