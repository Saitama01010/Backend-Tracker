ALTER TABLE "portal_users"
  DROP CONSTRAINT "portal_users_primary_team_check";

ALTER TABLE "portal_users"
  ADD CONSTRAINT "portal_users_primary_team_check"
  CHECK ("primary_team" IS NULL OR "primary_team" IN ('retention', 'nsf', 'cs', 'killers', 'onboarding'))
  NOT VALID;

ALTER TABLE "portal_users"
  VALIDATE CONSTRAINT "portal_users_primary_team_check";
