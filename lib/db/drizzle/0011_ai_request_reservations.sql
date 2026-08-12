CREATE TABLE IF NOT EXISTS "ai_request_reservations" (
	"id" serial PRIMARY KEY NOT NULL,
	"feature" text NOT NULL,
	"scope_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"failure_code" text,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_request_reservations_status_check"
		CHECK ("status" IN ('reserved', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_request_reservations_feature_scope_key_uidx"
	ON "ai_request_reservations" USING btree ("feature", "scope_key", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_request_reservations_feature_scope_reserved_idx"
	ON "ai_request_reservations" USING btree ("feature", "scope_key", "reserved_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_request_reservations_expires_idx"
	ON "ai_request_reservations" USING btree ("expires_at");

