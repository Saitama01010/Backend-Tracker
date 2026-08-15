ALTER TABLE "portal_users" ADD COLUMN "email" text;
--> statement-breakpoint
ALTER TABLE "portal_users" ADD COLUMN "email_normalized" text;
--> statement-breakpoint
ALTER TABLE "portal_users"
  ADD CONSTRAINT "portal_users_email_identity_pair" CHECK (
    ("email" IS NULL AND "email_normalized" IS NULL)
    OR (
      "email" IS NOT NULL
      AND "email_normalized" IS NOT NULL
      AND "email_normalized" <> ''
      AND "email_normalized" = lower(btrim("email"))
    )
  );
--> statement-breakpoint
CREATE UNIQUE INDEX "portal_users_email_normalized_uidx"
  ON "portal_users" USING btree ("email_normalized")
  WHERE "email_normalized" IS NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
  target_count integer;
  updated_count integer;
BEGIN
  -- Empty bootstrap databases do not contain application accounts yet. For an
  -- established database, require both exact administrator identities before
  -- applying the owner-authorized email assignments.
  IF EXISTS (SELECT 1 FROM "portal_users") THEN
    SELECT count(*)
      INTO target_count
      FROM "portal_users"
     WHERE "username" IN ('admin', 'johnwilliam')
       AND (
         "access_role" = 'admin'
         OR ("access_role" IS NULL AND "role" = 'admin')
       );

    IF target_count <> 2 THEN
      RAISE EXCEPTION 'PORTAL_USER_EMAIL_ASSIGNMENT_BLOCKED:EXPECTED_TWO_ADMIN_TARGETS';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM "portal_users"
       WHERE "username" NOT IN ('admin', 'johnwilliam')
         AND "email_normalized" IN ('youssefnasserf77@gmail.com', 'johnwessam4@gmail.com')
    ) THEN
      RAISE EXCEPTION 'PORTAL_USER_EMAIL_ASSIGNMENT_BLOCKED:EMAIL_ALREADY_OWNED';
    END IF;

    UPDATE "portal_users"
       SET "email" = CASE "username"
             WHEN 'admin' THEN 'Youssefnasserf77@gmail.com'
             WHEN 'johnwilliam' THEN 'johnwessam4@gmail.com'
           END,
           "email_normalized" = CASE "username"
             WHEN 'admin' THEN 'youssefnasserf77@gmail.com'
             WHEN 'johnwilliam' THEN 'johnwessam4@gmail.com'
           END
     WHERE "username" IN ('admin', 'johnwilliam');

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    IF updated_count <> 2 THEN
      RAISE EXCEPTION 'PORTAL_USER_EMAIL_ASSIGNMENT_BLOCKED:UPDATE_COUNT_%', updated_count;
    END IF;
  END IF;
END
$$;
