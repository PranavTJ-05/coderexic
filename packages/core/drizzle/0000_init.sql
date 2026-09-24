CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"file_fetch_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"termination_reason" text,
	CONSTRAINT "agent_runs_status_ck" CHECK ("agent_runs"."status" IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT')),
	CONSTRAINT "agent_runs_termination_reason_ck" CHECK ("agent_runs"."termination_reason" IS NULL OR "agent_runs"."termination_reason" IN ('SUBMITTED', 'NO_FINDINGS', 'MAX_TURNS', 'MAX_FILE_FETCHES', 'TIMEOUT', 'MODEL_ERROR', 'INVALID_OUTPUT'))
);
--> statement-breakpoint
CREATE TABLE "agent_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"turn_number" integer NOT NULL,
	"tool_name" text NOT NULL,
	"arguments_json" jsonb NOT NULL,
	"result_size_bytes" integer,
	"duration_ms" bigint,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tool_calls_status_ck" CHECK ("agent_tool_calls"."status" IN ('SUCCEEDED', 'FAILED', 'REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"repository_id" uuid,
	"event_type" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dependency_edges" (
	"repository_id" uuid NOT NULL,
	"source_path" text NOT NULL,
	"target_path" text NOT NULL,
	"commit_sha" text NOT NULL,
	"relation_type" text DEFAULT 'import' NOT NULL,
	"resolved" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dependency_edges_pk" PRIMARY KEY("repository_id","source_path","target_path")
);
--> statement-breakpoint
CREATE TABLE "ignore_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ignore_patterns_repository_pattern_uq" UNIQUE("repository_id","pattern")
);
--> statement-breakpoint
CREATE TABLE "index_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"files_seen" integer DEFAULT 0 NOT NULL,
	"files_indexed" integer DEFAULT 0 NOT NULL,
	"edges_created" integer DEFAULT 0 NOT NULL,
	"duration_ms" bigint,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "index_runs_status_ck" CHECK ("index_runs"."status" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "indexed_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"path" text NOT NULL,
	"sha" text,
	"language" text,
	"size_bytes" bigint,
	"is_supported" boolean DEFAULT false NOT NULL,
	"last_indexed_at" timestamp with time zone,
	CONSTRAINT "indexed_files_repository_path_uq" UNIQUE("repository_id","path")
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_installation_id" bigint NOT NULL,
	"owner_type" text NOT NULL,
	"owner_login" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "installations_github_installation_id_unique" UNIQUE("github_installation_id")
);
--> statement-breakpoint
CREATE TABLE "model_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repository_id" uuid,
	"provider" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"github_repository_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"owner_login" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text,
	"head_sha" text,
	"index_status" text DEFAULT 'PENDING' NOT NULL,
	"indexed_sha" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "repositories_installation_github_repo_uq" UNIQUE("installation_id","github_repository_id"),
	CONSTRAINT "repositories_index_status_ck" CHECK ("repositories"."index_status" IN ('PENDING', 'INDEXING', 'READY', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "repository_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"source_filename" text NOT NULL,
	"content" text NOT NULL,
	"commit_sha" text NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"model_provider" text,
	"model_name" text,
	"minimum_severity" text DEFAULT 'low' NOT NULL,
	"max_agent_turns" integer DEFAULT 10 NOT NULL,
	"max_file_fetches" integer DEFAULT 12 NOT NULL,
	"max_review_seconds" integer DEFAULT 60 NOT NULL,
	"max_context_tokens" integer,
	"language_hint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_settings_repository_id_unique" UNIQUE("repository_id"),
	CONSTRAINT "repository_settings_minimum_severity_ck" CHECK ("repository_settings"."minimum_severity" IN ('critical', 'high', 'medium', 'low')),
	CONSTRAINT "repository_settings_limits_ck" CHECK ("repository_settings"."max_agent_turns" > 0 AND "repository_settings"."max_file_fetches" >= 0 AND "repository_settings"."max_review_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "review_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"severity" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"issue" text NOT NULL,
	"fix_type" text NOT NULL,
	"suggested_code" text,
	"confidence" numeric,
	"github_comment_id" bigint,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_findings_severity_ck" CHECK ("review_findings"."severity" IN ('critical', 'high', 'medium', 'low')),
	CONSTRAINT "review_findings_fix_type_ck" CHECK ("review_findings"."fix_type" IN ('applyable', 'recommendation', 'warning')),
	CONSTRAINT "review_findings_lines_ck" CHECK ("review_findings"."start_line" >= 1 AND "review_findings"."end_line" >= "review_findings"."start_line"),
	CONSTRAINT "review_findings_confidence_ck" CHECK ("review_findings"."confidence" IS NULL OR ("review_findings"."confidence" >= 0 AND "review_findings"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "review_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"pull_request_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text,
	"trigger_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"github_event_id" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	CONSTRAINT "review_jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "review_jobs_status_ck" CHECK ("review_jobs"."status" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED')),
	CONSTRAINT "review_jobs_trigger_type_ck" CHECK ("review_jobs"."trigger_type" IN ('automatic', 'manual')),
	CONSTRAINT "review_jobs_pull_request_number_ck" CHECK ("review_jobs"."pull_request_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_job_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"summary" text,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"files_considered" integer DEFAULT 0 NOT NULL,
	"files_fetched" integer DEFAULT 0 NOT NULL,
	"agent_turns" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"duration_ms" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_review_job_id_unique" UNIQUE("review_job_id"),
	CONSTRAINT "reviews_status_ck" CHECK ("reviews"."status" IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_user_id" bigint NOT NULL,
	"login" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_github_user_id_unique" UNIQUE("github_user_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_event_id" text NOT NULL,
	"installation_id" uuid,
	"event_name" text NOT NULL,
	"action" text,
	"delivery_status" text DEFAULT 'RECEIVED' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_events_github_event_id_unique" UNIQUE("github_event_id"),
	CONSTRAINT "webhook_events_delivery_status_ck" CHECK ("webhook_events"."delivery_status" IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_edges" ADD CONSTRAINT "dependency_edges_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ignore_patterns" ADD CONSTRAINT "ignore_patterns_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "index_runs" ADD CONSTRAINT "index_runs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexed_files" ADD CONSTRAINT "indexed_files_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installations" ADD CONSTRAINT "installations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_credentials" ADD CONSTRAINT "model_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_credentials" ADD CONSTRAINT "model_credentials_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_rules" ADD CONSTRAINT "repository_rules_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_settings" ADD CONSTRAINT "repository_settings_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_jobs" ADD CONSTRAINT "review_jobs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_jobs" ADD CONSTRAINT "review_jobs_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_review_job_id_review_jobs_id_fk" FOREIGN KEY ("review_job_id") REFERENCES "public"."review_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_review_idx" ON "agent_runs" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "agent_tool_calls_run_idx" ON "agent_tool_calls" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "dependency_edges_target_idx" ON "dependency_edges" USING btree ("repository_id","target_path");--> statement-breakpoint
CREATE INDEX "index_runs_repository_started_idx" ON "index_runs" USING btree ("repository_id","started_at");--> statement-breakpoint
CREATE INDEX "model_credentials_user_idx" ON "model_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "repositories_full_name_idx" ON "repositories" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "repository_rules_repository_idx" ON "repository_rules" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "review_findings_review_idx" ON "review_findings" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "review_jobs_repository_pr_idx" ON "review_jobs" USING btree ("repository_id","pull_request_number");--> statement-breakpoint
CREATE INDEX "review_jobs_status_idx" ON "review_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_login_idx" ON "users" USING btree ("login");--> statement-breakpoint
CREATE INDEX "webhook_events_received_idx" ON "webhook_events" USING btree ("received_at");