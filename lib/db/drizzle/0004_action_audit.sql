CREATE TABLE IF NOT EXISTS "action_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"username" text NOT NULL,
	"source" text NOT NULL,
	"capability_name" text NOT NULL,
	"target_resource" text NOT NULL,
	"target_id" text,
	"previous_value" jsonb,
	"new_value" jsonb,
	"success" boolean NOT NULL,
	"error" text,
	"instruction_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_audit_user_created_idx" ON "action_audit" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_audit_capability_created_idx" ON "action_audit" USING btree ("capability_name","created_at");
