ALTER TABLE "portal_users" ADD COLUMN "access_role" text;
ALTER TABLE "portal_users" ADD COLUMN "team_agent_id" integer;
ALTER TABLE "portal_users" ADD COLUMN "primary_team" text;

ALTER TABLE "portal_users"
  ADD CONSTRAINT "portal_users_access_role_check"
  CHECK ("access_role" IS NULL OR "access_role" IN ('agent', 'manager', 'admin'));

ALTER TABLE "portal_users"
  ADD CONSTRAINT "portal_users_primary_team_check"
  CHECK ("primary_team" IS NULL OR "primary_team" IN ('retention', 'nsf', 'cs', 'killers'));

ALTER TABLE "portal_users"
  ADD CONSTRAINT "portal_users_canonical_access_shape_check"
  CHECK (
    ("access_role" IS NULL AND "team_agent_id" IS NULL AND "primary_team" IS NULL)
    OR ("access_role" = 'agent' AND "team_agent_id" IS NOT NULL AND "primary_team" IS NULL)
    OR ("access_role" = 'manager' AND "team_agent_id" IS NULL AND "primary_team" IS NOT NULL)
    OR ("access_role" = 'admin' AND "team_agent_id" IS NULL AND "primary_team" IS NULL)
  );

ALTER TABLE "portal_users"
  ADD CONSTRAINT "portal_users_team_agent_id_team_agents_id_fk"
  FOREIGN KEY ("team_agent_id") REFERENCES "public"."team_agents"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "portal_users_team_agent_id_uidx"
  ON "portal_users" USING btree ("team_agent_id")
  WHERE "team_agent_id" IS NOT NULL;

CREATE TABLE "portal_user_team_grants" (
  "id" serial PRIMARY KEY NOT NULL,
  "portal_user_id" integer NOT NULL,
  "team" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "portal_user_team_grants_team_check"
    CHECK ("team" IN ('retention', 'nsf', 'cs', 'killers'))
);

ALTER TABLE "portal_user_team_grants"
  ADD CONSTRAINT "portal_user_team_grants_portal_user_id_portal_users_id_fk"
  FOREIGN KEY ("portal_user_id") REFERENCES "public"."portal_users"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "portal_user_team_grants_user_team_uidx"
  ON "portal_user_team_grants" USING btree ("portal_user_id", "team");
CREATE INDEX "portal_user_team_grants_user_idx"
  ON "portal_user_team_grants" USING btree ("portal_user_id");

CREATE TABLE "portal_user_tab_grants" (
  "id" serial PRIMARY KEY NOT NULL,
  "portal_user_id" integer NOT NULL,
  "tab" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "portal_user_tab_grants_tab_check"
    CHECK ("tab" IN ('backend-stats', 'retention', 'cs', 'nsf', 'rmk', 'missed-no-cb', 'callback-review', 'violations', 'qa', 'onboarding'))
);

ALTER TABLE "portal_user_tab_grants"
  ADD CONSTRAINT "portal_user_tab_grants_portal_user_id_portal_users_id_fk"
  FOREIGN KEY ("portal_user_id") REFERENCES "public"."portal_users"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "portal_user_tab_grants_user_tab_uidx"
  ON "portal_user_tab_grants" USING btree ("portal_user_id", "tab");
CREATE INDEX "portal_user_tab_grants_user_idx"
  ON "portal_user_tab_grants" USING btree ("portal_user_id");
