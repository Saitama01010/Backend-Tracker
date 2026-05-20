CREATE TABLE IF NOT EXISTS "team_agents" (
"id" serial PRIMARY KEY NOT NULL,
"name" text NOT NULL,
"arabic_name" text,
"shift" text,
"team" text NOT NULL,
"active" boolean DEFAULT true NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_agents" ADD COLUMN IF NOT EXISTS "arabic_name" text;--> statement-breakpoint
ALTER TABLE "team_agents" ADD COLUMN IF NOT EXISTS "shift" text;
