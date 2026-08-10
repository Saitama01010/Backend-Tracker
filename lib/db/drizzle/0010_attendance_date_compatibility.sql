-- Compatibility-first attendance date migration.
--
-- The existing text column remains the unique/public compatibility key. The
-- nullable PostgreSQL date shadow can be audited before any later type swap.
-- No legacy row is deleted, rewritten, or rejected by this migration.

ALTER TABLE "attendance_records"
  ADD COLUMN IF NOT EXISTS "attendance_date" date;

CREATE OR REPLACE FUNCTION attendance_text_to_date_compatibility(value text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  parsed date;
BEGIN
  IF value !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN NULL;
  END IF;
  parsed := to_date(value, 'YYYY-MM-DD');
  IF to_char(parsed, 'YYYY-MM-DD') <> value THEN
    RETURN NULL;
  END IF;
  RETURN parsed;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

UPDATE "attendance_records"
SET "attendance_date" = attendance_text_to_date_compatibility("date")
WHERE "attendance_date" IS NULL
  AND attendance_text_to_date_compatibility("date") IS NOT NULL;

CREATE OR REPLACE FUNCTION sync_attendance_date_compatibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."attendance_date" := attendance_text_to_date_compatibility(NEW."date");
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_date_compatibility_sync ON "attendance_records";
CREATE TRIGGER attendance_date_compatibility_sync
BEFORE INSERT OR UPDATE OF "date" ON "attendance_records"
FOR EACH ROW
EXECUTE FUNCTION sync_attendance_date_compatibility();

CREATE INDEX IF NOT EXISTS "attendance_records_attendance_date_member_idx"
  ON "attendance_records" ("attendance_date", "member_id")
  WHERE "attendance_date" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendance_date_matches_text_compatibility'
  ) THEN
    ALTER TABLE "attendance_records"
      ADD CONSTRAINT "attendance_date_matches_text_compatibility"
      CHECK (
        "attendance_date" IS NULL
        OR to_char("attendance_date", 'YYYY-MM-DD') = "date"
      ) NOT VALID;
  END IF;
END;
$$;
