CREATE TABLE IF NOT EXISTS "background_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"requested_by_user_id" integer,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "background_jobs_status_check" CHECK ("status" in ('queued', 'running', 'retry', 'completed', 'failed')),
	CONSTRAINT "background_jobs_attempts_check" CHECK ("attempts" >= 0 and "max_attempts" between 1 and 20)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "background_jobs_idempotency_uidx" ON "background_jobs" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "background_jobs_claim_idx" ON "background_jobs" USING btree ("status", "run_after", "priority");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "background_jobs_type_status_idx" ON "background_jobs" USING btree ("job_type", "status", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "background_jobs_lease_idx" ON "background_jobs" USING btree ("lease_expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "durable_runtime_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "durable_runtime_state_expires_idx" ON "durable_runtime_state" USING btree ("expires_at");
