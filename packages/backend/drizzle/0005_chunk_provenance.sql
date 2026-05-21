-- ============================================================
-- Migration 0005: Add chunk provenance metadata for evidence-backed RAG
-- ============================================================

ALTER TABLE file_chunks
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'content';

ALTER TABLE file_chunks
  ADD COLUMN IF NOT EXISTS page_number integer;

ALTER TABLE file_chunks
  ADD COLUMN IF NOT EXISTS section_label text;

ALTER TABLE file_chunks
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_file_chunks_source_type
  ON file_chunks (source_type);

CREATE INDEX IF NOT EXISTS idx_file_chunks_page_number
  ON file_chunks (page_number);
