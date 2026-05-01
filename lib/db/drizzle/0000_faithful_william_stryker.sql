CREATE TABLE "phone_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"line_id" text NOT NULL,
	"line_name" text NOT NULL,
	"line_team" text NOT NULL,
	"agent_id" text,
	"agent_name" text,
	"participant" text NOT NULL,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_sync_state" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"is_syncing" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "phone_calls_line_created" ON "phone_calls" USING btree ("line_id","created_at");--> statement-breakpoint
CREATE INDEX "phone_calls_agent_created" ON "phone_calls" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "phone_calls_team_created" ON "phone_calls" USING btree ("line_team","created_at");