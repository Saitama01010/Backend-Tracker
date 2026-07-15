ALTER TABLE "qa_reviews"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS "qa_reviews_source_agent_evaluated"
  ON "qa_reviews" ("source", "agent_name", "evaluated_at");

CREATE TABLE IF NOT EXISTS "ai_request_usage" (
  "id" serial PRIMARY KEY NOT NULL,
  "feature" text NOT NULL,
  "user_id" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "ai_request_usage_feature_user_created"
  ON "ai_request_usage" ("feature", "user_id", "created_at");
CREATE INDEX IF NOT EXISTS "ai_request_usage_created"
  ON "ai_request_usage" ("created_at");

CREATE TABLE IF NOT EXISTS "qa_biweekly_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "trigger" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "result" jsonb,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "qa_biweekly_runs_started"
  ON "qa_biweekly_runs" ("started_at");
