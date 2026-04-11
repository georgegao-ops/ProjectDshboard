CREATE TABLE IF NOT EXISTS "organizations" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" text NOT NULL,
    "onedrive_tenant_id" text,
    "created_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "users" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "org_id" uuid NOT NULL,
    "email" text UNIQUE NOT NULL,
    "name" text NOT NULL,
    "role" text DEFAULT 'member',
    "created_at" timestamp with time zone DEFAULT now(),
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "projects" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "org_id" uuid NOT NULL,
    "name" text NOT NULL,
    "onedrive_folder_id" text,
    "status" text DEFAULT 'active',
    "created_at" timestamp with time zone DEFAULT now(),
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "file_records" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "project_id" uuid NOT NULL,
    "onedrive_item_id" text UNIQUE,
    "file_name" text NOT NULL,
    "file_path" text NOT NULL,
    "file_type" text,
    "file_size" bigint,
    "mime_type" text,
    "summary" text,
    "key_topics" text[],
    "tags" text[],
    "doc_category" text,
    "spec_section" text,
    "sheet_number" text,
    "revision" text,
    "onedrive_etag" text,
    "last_synced" timestamp with time zone,
    "index_status" text DEFAULT 'pending',
    "last_indexed" timestamp with time zone,
    "chunk_count" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now(),
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE
);

CREATE INDEX idx_file_records_project ON "file_records"("project_id");
CREATE INDEX idx_file_records_category ON "file_records"("doc_category");
CREATE INDEX idx_file_records_tags ON "file_records" USING GIN("tags");
CREATE INDEX idx_file_records_spec ON "file_records"("spec_section");

CREATE TABLE IF NOT EXISTS "chat_sessions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "project_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "created_at" timestamp with time zone DEFAULT now(),
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "chat_messages" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "session_id" uuid NOT NULL,
    "role" text NOT NULL,
    "content" text NOT NULL,
    "sources" jsonb,
    "created_at" timestamp with time zone DEFAULT now(),
    FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "features" (
    "id" text PRIMARY KEY,
    "name" text NOT NULL,
    "icon" text NOT NULL,
    "route" text NOT NULL,
    "enabled" boolean DEFAULT false,
    "sort_order" integer DEFAULT 0,
    "config" jsonb DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS "project_features" (
    "project_id" uuid NOT NULL,
    "feature_id" text NOT NULL,
    "enabled" boolean DEFAULT true,
    "config" jsonb DEFAULT '{}',
    PRIMARY KEY ("project_id", "feature_id"),
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
    FOREIGN KEY ("feature_id") REFERENCES "features"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "vector_chunks" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "file_id" uuid NOT NULL,
    "chunk_index" integer NOT NULL,
    "chunk_text" text NOT NULL,
    "vector_id" text,
    "token_count" integer,
    "created_at" timestamp with time zone DEFAULT now(),
    FOREIGN KEY ("file_id") REFERENCES "file_records"("id") ON DELETE CASCADE
);

CREATE INDEX idx_vector_chunks_file ON "vector_chunks"("file_id");
CREATE INDEX idx_vector_chunks_vector_id ON "vector_chunks"("vector_id");
