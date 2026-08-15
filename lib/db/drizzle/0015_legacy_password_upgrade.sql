ALTER TABLE "portal_users"
  ADD COLUMN "password_policy_version" integer DEFAULT 0 NOT NULL;

ALTER TABLE "portal_users"
  ALTER COLUMN "password_policy_version" SET DEFAULT 1;

ALTER TABLE "portal_users"
  ADD COLUMN "password_changed_at" timestamp with time zone;

ALTER TABLE "portal_users"
  ADD CONSTRAINT "portal_users_password_policy_version_check"
  CHECK ("password_policy_version" >= 0);
