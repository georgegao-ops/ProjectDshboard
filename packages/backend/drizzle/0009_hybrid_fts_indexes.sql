-- PR4: Hybrid retrieval support (Postgres full-text search indexes)
-- Additive and backward-compatible: no column changes, index-only migration.

CREATE INDEX IF NOT EXISTS idx_file_chunks_chunk_text_fts
ON file_chunks
USING GIN (to_tsvector('english', COALESCE(chunk_text, '')));

CREATE INDEX IF NOT EXISTS idx_file_chunks_file_name_fts
ON file_chunks
USING GIN (to_tsvector('english', COALESCE(file_name, '')));
