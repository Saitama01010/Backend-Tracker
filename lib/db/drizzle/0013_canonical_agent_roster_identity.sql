DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM team_agents
     GROUP BY lower(regexp_replace(btrim(normalize(name, NFKC)), '[[:space:]]+', ' ', 'g'))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'AGENT_IDENTITY_MIGRATION_BLOCKED_BY_EXISTING_DUPLICATES:ENGLISH_NAME';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM team_agents
     WHERE arabic_name IS NOT NULL
       AND btrim(normalize(arabic_name, NFKC)) <> ''
     GROUP BY regexp_replace(btrim(normalize(arabic_name, NFKC)), '[[:space:]]+', ' ', 'g')
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'AGENT_IDENTITY_MIGRATION_BLOCKED_BY_EXISTING_DUPLICATES:ARABIC_NAME';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM team_agents
     WHERE regexp_replace(btrim(normalize(name, NFKC)), '[[:space:]]+', ' ', 'g') = ''
  ) THEN
    RAISE EXCEPTION 'AGENT_IDENTITY_MIGRATION_BLOCKED_BY_INVALID_ENGLISH_NAME';
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "team_agents" ADD COLUMN "name_normalized" text;
--> statement-breakpoint
ALTER TABLE "team_agents" ADD COLUMN "arabic_name_normalized" text;
--> statement-breakpoint
ALTER TABLE "team_agents" ADD COLUMN "email" text;
--> statement-breakpoint
ALTER TABLE "team_agents" ADD COLUMN "email_normalized" text;
--> statement-breakpoint
UPDATE "team_agents"
   SET "name_normalized" = lower(regexp_replace(btrim(normalize("name", NFKC)), '[[:space:]]+', ' ', 'g')),
       "arabic_name_normalized" = CASE
         WHEN "arabic_name" IS NULL OR btrim(normalize("arabic_name", NFKC)) = '' THEN NULL
         ELSE regexp_replace(btrim(normalize("arabic_name", NFKC)), '[[:space:]]+', ' ', 'g')
       END,
       "email" = NULL,
       "email_normalized" = NULL;
--> statement-breakpoint
ALTER TABLE "team_agents" ALTER COLUMN "name_normalized" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_agents"
  ADD CONSTRAINT "team_agents_name_normalized_required" CHECK (
    "name_normalized" <> ''
    AND "name_normalized" = lower(regexp_replace(btrim(normalize("name", NFKC)), '[[:space:]]+', ' ', 'g'))
  ),
  ADD CONSTRAINT "team_agents_arabic_identity_pair" CHECK (
    ("arabic_name" IS NULL AND "arabic_name_normalized" IS NULL)
    OR (
      "arabic_name" IS NOT NULL
      AND "arabic_name_normalized" IS NOT NULL
      AND "arabic_name_normalized" <> ''
      AND "arabic_name_normalized" = regexp_replace(btrim(normalize("arabic_name", NFKC)), '[[:space:]]+', ' ', 'g')
    )
  ),
  ADD CONSTRAINT "team_agents_email_identity_pair" CHECK (
    ("email" IS NULL AND "email_normalized" IS NULL)
    OR (
      "email" IS NOT NULL
      AND "email_normalized" IS NOT NULL
      AND "email_normalized" <> ''
      AND "email_normalized" = lower(btrim("email"))
    )
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "team_agents_name_normalized_uidx"
  ON "team_agents" USING btree ("name_normalized");
--> statement-breakpoint
CREATE UNIQUE INDEX "team_agents_arabic_name_normalized_uidx"
  ON "team_agents" USING btree ("arabic_name_normalized")
  WHERE "arabic_name_normalized" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "team_agents_email_normalized_uidx"
  ON "team_agents" USING btree ("email_normalized")
  WHERE "email_normalized" IS NOT NULL;
