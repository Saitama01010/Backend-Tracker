CREATE TABLE IF NOT EXISTS "webhook_inbox" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"object_id" text,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"first_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_started_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error_code" text,
	CONSTRAINT "webhook_inbox_status_check" CHECK ("status" in ('received', 'processing', 'processed', 'ignored', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_inbox_provider_event_uidx" ON "webhook_inbox" USING btree ("provider", "provider_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_inbox_status_received_idx" ON "webhook_inbox" USING btree ("status", "last_received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_inbox_object_event_idx" ON "webhook_inbox" USING btree ("object_id", "event_type");
