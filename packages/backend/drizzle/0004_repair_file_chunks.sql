-- ============================================================
-- Migration 0004: Repair missing file_chunks table
-- Creates file_chunks in environments where an earlier migration
-- sequence was partially applied.
-- ============================================================

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'pgvector extension unavailable: %', SQLERRM;
  END;
END $$;

DO $$
BEGIN
  IF to_regtype('vector') IS NOT NULL THEN
    EXECUTE $sql$
      CREATE TABLE IF NOT EXISTS file_chunks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES projects(id),
        file_id uuid NOT NULL REFERENCES file_records(id),
        onedrive_item_id text NOT NULL,
        file_name text NOT NULL,
        chunk_index integer NOT NULL,
        chunk_text text NOT NULL,
        token_count integer NOT NULL DEFAULT 0,
        embedding_model text NOT NULL,
        embedding jsonb,
        embedding_vector vector(1536),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    $sql$;
  ELSE
    EXECUTE $sql$
      CREATE TABLE IF NOT EXISTS file_chunks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES projects(id),
        file_id uuid NOT NULL REFERENCES file_records(id),
        onedrive_item_id text NOT NULL,
        file_name text NOT NULL,
        chunk_index integer NOT NULL,
        chunk_text text NOT NULL,
        token_count integer NOT NULL DEFAULT 0,
        embedding_model text NOT NULL,
        embedding jsonb,
        -- Fallback type when pgvector is unavailable in local environments.
        embedding_vector jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    $sql$;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_file_chunks_project
  ON file_chunks (project_id);

CREATE INDEX IF NOT EXISTS idx_file_chunks_file
  ON file_chunks (file_id);

CREATE INDEX IF NOT EXISTS idx_file_chunks_onedrive_item
  ON file_chunks (onedrive_item_id);

DO $$
BEGIN
  IF to_regtype('vector') IS NOT NULL THEN
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_file_chunks_embedding_hnsw
      ON file_chunks
      USING hnsw (embedding_vector vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    $sql$;
  END IF;
END $$;
