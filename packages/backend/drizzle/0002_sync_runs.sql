CREATE TABLE IF NOT EXISTS "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'success' NOT NULL,
	"scanned_file_count" integer DEFAULT 0 NOT NULL,
	"supported_file_count" integer DEFAULT 0 NOT NULL,
	"unsupported_file_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sync_runs_project" ON "sync_runs" ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sync_runs_finished_at" ON "sync_runs" ("finished_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
