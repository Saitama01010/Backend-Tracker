-- Roll back only the additive attendance-date compatibility layer.
-- The original attendance_records.date text column and every original row stay intact.

DROP INDEX IF EXISTS "attendance_records_attendance_date_member_idx";
ALTER TABLE "attendance_records"
  DROP CONSTRAINT IF EXISTS "attendance_date_matches_text_compatibility";
DROP TRIGGER IF EXISTS attendance_date_compatibility_sync ON "attendance_records";
DROP FUNCTION IF EXISTS sync_attendance_date_compatibility();
ALTER TABLE "attendance_records"
  DROP COLUMN IF EXISTS "attendance_date";
DROP FUNCTION IF EXISTS attendance_text_to_date_compatibility(text);
