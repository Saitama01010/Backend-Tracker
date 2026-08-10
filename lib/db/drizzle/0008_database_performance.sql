-- Date-range scans used by Quo dashboards and KPI reports.
CREATE INDEX IF NOT EXISTS "phone_calls_created_at_idx"
  ON "phone_calls" USING btree ("created_at");
--> statement-breakpoint

-- Exact predicate used to determine each attendance member's first valid call.
CREATE INDEX IF NOT EXISTS "phone_calls_attendance_created_agent_idx"
  ON "phone_calls" USING btree ("created_at", "agent_name")
  WHERE "agent_name" IS NOT NULL
    AND ("direction" = 'outgoing' OR ("direction" = 'incoming' AND "status" = 'completed'));
--> statement-breakpoint

-- Exact participant history used by Samia and missed-call callback matching.
CREATE INDEX IF NOT EXISTS "phone_calls_participant_created_idx"
  ON "phone_calls" USING btree ("participant", "created_at" DESC);
--> statement-breakpoint

-- Missed inbound calls are repeatedly filtered by line and date.
CREATE INDEX IF NOT EXISTS "phone_calls_missed_line_created_idx"
  ON "phone_calls" USING btree ("line_name", "created_at")
  WHERE "direction" = 'incoming'
    AND "status" IN ('no-answer', 'voicemail', 'missed', 'voicemail-brief');
--> statement-breakpoint

-- Live-call polling only reads in-progress rows updated in a recent window.
CREATE INDEX IF NOT EXISTS "phone_calls_live_synced_idx"
  ON "phone_calls" USING btree ("synced_at")
  WHERE "status" = 'in-progress';
--> statement-breakpoint

-- PBX callback history looks up a source/from number and then orders by time.
CREATE INDEX IF NOT EXISTS "pbx_missed_from_created_idx"
  ON "pbx_missed_calls" USING btree ("from_number", "created_at" DESC);
--> statement-breakpoint

-- Attendance screens read a date for a scoped set of members; the existing
-- unique key is ordered member_id first and cannot serve the date-only scan.
CREATE INDEX IF NOT EXISTS "attendance_records_date_member_idx"
  ON "attendance_records" USING btree ("date", "member_id");
