CREATE TABLE IF NOT EXISTS "onedrive_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" text,
	"account_email" text,
	"drive_id" text NOT NULL,
	"drive_type" text,
	"refresh_token" text NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onedrive_connections_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_onedrive_connections_org" ON "onedrive_connections" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_onedrive_connections_user" ON "onedrive_connections" ("user_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onedrive_connections" ADD CONSTRAINT "onedrive_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onedrive_connections" ADD CONSTRAINT "onedrive_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;