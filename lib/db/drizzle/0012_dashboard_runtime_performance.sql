-- The dashboard summary query filters by a bounded date range and excludes
-- in-progress calls, then aggregates only these included columns. Production
-- installs this definition with CREATE INDEX CONCURRENTLY before this ledgered
-- migration is applied; IF NOT EXISTS makes the migration an idempotent no-op
-- once the online index is valid.
CREATE INDEX IF NOT EXISTS "phone_calls_dashboard_stats_cover_idx"
  ON "phone_calls" USING btree ("created_at")
  INCLUDE (
    "agent_name",
    "line_name",
    "line_team",
    "line_id",
    "participant",
    "direction",
    "status",
    "duration_seconds",
    "post_answer_seconds"
  )
  WHERE "status" <> 'in-progress';
