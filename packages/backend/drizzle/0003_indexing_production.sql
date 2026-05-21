-- ============================================================
-- Migration 0003: Production Indexing Branch
-- Adds pgvector, construction intelligence fields, document
-- relationships, and indexing error tracking.
-- ============================================================

-- Enable pgvector extension (requires pg >= 14 + pgvector installed)
CREATE EXTENSION IF NOT EXISTS vector;

-- --------------------------------------------------------
-- Extend file_records with production indexing fields
-- --------------------------------------------------------
ALTER TABLE file_records
  ADD COLUMN IF NOT EXISTS priority_score    integer      NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS extracted_fields  jsonb,
  ADD COLUMN IF NOT EXISTS version_hash      text,
  ADD COLUMN IF NOT EXISTS owner             text;

-- Extend doc_category to cover all construction document types.
-- We store as free-text (enforced at application layer), so just widen the
-- existing "not-null" check if one exists.  The original column is TEXT so
-- no enum migration is required — just document the accepted values.

-- --------------------------------------------------------
-- Add vector column to file_chunks
-- Dimensions: 1536 for OpenAI text-embedding-3-small / ada-002,
--             256 for deterministic fallback (resized at query time).
-- --------------------------------------------------------
ALTER TABLE file_chunks
  ADD COLUMN IF NOT EXISTS embedding_vector  vector(1536);

-- HNSW index for sub-second ANN search at scale
CREATE INDEX IF NOT EXISTS idx_file_chunks_embedding_hnsw
  ON file_chunks
  USING hnsw (embedding_vector vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Composite index for priority-ordered processing queue
CREATE INDEX IF NOT EXISTS idx_file_records_priority_queue
  ON file_records (project_id, index_status, priority_score DESC);

-- --------------------------------------------------------
-- Document Relationships (file-level cross-references)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_relationships (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_file_id  uuid        NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
  target_file_id  uuid        NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
  -- 'references' | 'supersedes' | 'responds_to' | 'tied_to' | 'part_of'
  relation_type   text        NOT NULL,
  confidence      integer     NOT NULL DEFAULT 80 CHECK (confidence BETWEEN 0 AND 100),
  -- free-form metadata: { rfi_number, submittal_number, drawing_number, ... }
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doc_relationships_project
  ON document_relationships (project_id);
CREATE INDEX IF NOT EXISTS idx_doc_relationships_source
  ON document_relationships (source_file_id);
CREATE INDEX IF NOT EXISTS idx_doc_relationships_target
  ON document_relationships (target_file_id);

-- --------------------------------------------------------
-- Indexing Errors — detailed error log per file per stage
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS indexing_errors (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id          uuid        REFERENCES file_records(id) ON DELETE CASCADE,
  onedrive_item_id text,
  file_name        text,
  -- pipeline stage: 'metadata' | 'download' | 'extract' | 'chunk' | 'embed' | 'classify'
  stage            text        NOT NULL,
  error_code       text        NOT NULL,
  error_message    text        NOT NULL,
  attempt          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_indexing_errors_project
  ON indexing_errors (project_id);
CREATE INDEX IF NOT EXISTS idx_indexing_errors_file
  ON indexing_errors (file_id);
