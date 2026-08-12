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
	"post_answer_seconds" integer,
	"ring_duration_seconds" integer,
	"created_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "phone_sync_state" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"is_syncing" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "pbx_missed_calls" (
	"id" integer PRIMARY KEY NOT NULL,
	"from_number" text NOT NULL,
	"to_number" text NOT NULL,
	"ring_group_id" integer NOT NULL,
	"ring_group_name" text NOT NULL,
	"team" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "attendance_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"shift" text DEFAULT '' NOT NULL,
	"shift_hours" text DEFAULT '8' NOT NULL,
	"department" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "attendance_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"member_id" integer NOT NULL,
	"date" text NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"note" text,
	"coaching" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_records_member_date" UNIQUE("member_id","date")
);

CREATE TABLE "portal_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'view' NOT NULL,
	"permissions" text DEFAULT '[]' NOT NULL,
	"team_access" text,
	"allowed_tabs" text,
	"allowed_agents" text,
	"allowed_sub_tabs" text,
	"lock_to_today" boolean DEFAULT false NOT NULL,
	"samia_curse" boolean DEFAULT false NOT NULL,
	"hide_backend_stats" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_users_username_unique" UNIQUE("username")
);

CREATE TABLE "blocked_numbers" (
	"number" text PRIMARY KEY NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "violation_verifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"member" text NOT NULL,
	"department" text NOT NULL,
	"date" text NOT NULL,
	"details" text NOT NULL,
	"verified_by" text DEFAULT 'admin' NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "violation_verifications_key_unique" UNIQUE("key")
);

CREATE TABLE "samia_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"username" text,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"images" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "agent_breaks" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_name" text NOT NULL,
	"department" text NOT NULL,
	"break_start" timestamp with time zone NOT NULL,
	"break_end" timestamp with time zone,
	"note" text,
	"logged_by" text DEFAULT 'self' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "team_agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"arabic_name" text,
	"shift" text,
	"notes" text,
	"team" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "nsf_readymode_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone_number" text NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	"done_by" text
);

CREATE TABLE "manager_qa_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_name" text NOT NULL,
	"department" text DEFAULT 'Retention' NOT NULL,
	"ai_score" integer DEFAULT 0 NOT NULL,
	"score" integer NOT NULL,
	"reason" text NOT NULL,
	"critical_fail" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'auto_flag' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"manager_score" integer,
	"variance" integer,
	"final_score" integer,
	"comments" text,
	"coaching_complete" boolean DEFAULT false NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "qa_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_name" text NOT NULL,
	"phone_number" text,
	"call_date" timestamp with time zone NOT NULL,
	"line_team" text NOT NULL,
	"department" text DEFAULT 'Retention' NOT NULL,
	"transcript" text,
	"ai_summary" text,
	"score" integer NOT NULL,
	"soft_skills_score" integer DEFAULT 0 NOT NULL,
	"protocol_score" integer DEFAULT 0 NOT NULL,
	"pass" boolean NOT NULL,
	"critical_fail" boolean DEFAULT false NOT NULL,
	"strengths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missed_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"critical_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category_scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"manager_review_required" boolean DEFAULT false NOT NULL,
	"model" text,
	"source" text DEFAULT 'legacy' NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "ai_request_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"feature" text NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "qa_biweekly_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"result" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);

CREATE TABLE "readymode_uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_name" text NOT NULL,
	"stat_date" text NOT NULL,
	"dialed" integer DEFAULT 0 NOT NULL,
	"talk_secs" integer DEFAULT 0 NOT NULL,
	"uploaded_by" text DEFAULT 'unknown' NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "readymode_uploads_agent_date" UNIQUE("agent_name","stat_date")
);

CREATE TABLE "onboarding_classifications" (
	"call_id" text PRIMARY KEY NOT NULL,
	"call_type" text NOT NULL,
	"customer_name" text,
	"closer_agent" text,
	"mentions_tax" boolean,
	"tx_status" text,
	"notes" text,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "onboarding_report_state" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"is_running" boolean DEFAULT false NOT NULL,
	"progress_done" integer DEFAULT 0 NOT NULL,
	"progress_total" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "live_transfer_classifications" (
	"call_id" text PRIMARY KEY NOT NULL,
	"is_live" boolean DEFAULT false NOT NULL,
	"kind" text,
	"company" text,
	"agent" text,
	"evidence" text,
	"tx_status" text,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "live_transfer_state" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"is_running" boolean DEFAULT false NOT NULL,
	"progress_done" integer DEFAULT 0 NOT NULL,
	"progress_total" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "action_audit" (
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

ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_member_id_attendance_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."attendance_members"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "phone_calls_line_created" ON "phone_calls" USING btree ("line_id","created_at");
CREATE INDEX "phone_calls_agent_created" ON "phone_calls" USING btree ("agent_id","created_at");
CREATE INDEX "phone_calls_team_created" ON "phone_calls" USING btree ("line_team","created_at");
CREATE INDEX "pbx_missed_created" ON "pbx_missed_calls" USING btree ("created_at");
CREATE INDEX "pbx_missed_team_created" ON "pbx_missed_calls" USING btree ("team","created_at");
CREATE INDEX "agent_breaks_agent_start" ON "agent_breaks" USING btree ("agent_name","break_start");
CREATE INDEX "agent_breaks_start" ON "agent_breaks" USING btree ("break_start");
CREATE INDEX "nsf_readymode_active" ON "nsf_readymode_queue" USING btree ("done_at");
CREATE INDEX "nsf_readymode_number" ON "nsf_readymode_queue" USING btree ("phone_number");
CREATE INDEX "manager_qa_tasks_status_created" ON "manager_qa_tasks" USING btree ("status","created_at");
CREATE INDEX "manager_qa_tasks_agent" ON "manager_qa_tasks" USING btree ("agent_name");
CREATE INDEX "manager_qa_tasks_department" ON "manager_qa_tasks" USING btree ("department");
CREATE INDEX "qa_reviews_agent_evaluated" ON "qa_reviews" USING btree ("agent_name","evaluated_at");
CREATE INDEX "qa_reviews_call_date" ON "qa_reviews" USING btree ("call_date");
CREATE INDEX "qa_reviews_department" ON "qa_reviews" USING btree ("department");
CREATE INDEX "qa_reviews_source_agent_evaluated" ON "qa_reviews" USING btree ("source","agent_name","evaluated_at");
CREATE INDEX "ai_request_usage_feature_user_created" ON "ai_request_usage" USING btree ("feature","user_id","created_at");
CREATE INDEX "ai_request_usage_created" ON "ai_request_usage" USING btree ("created_at");
CREATE INDEX "qa_biweekly_runs_started" ON "qa_biweekly_runs" USING btree ("started_at");
CREATE INDEX "readymode_uploads_date" ON "readymode_uploads" USING btree ("stat_date");
CREATE INDEX "action_audit_user_created_idx" ON "action_audit" USING btree ("user_id","created_at");
CREATE INDEX "action_audit_capability_created_idx" ON "action_audit" USING btree ("capability_name","created_at");
