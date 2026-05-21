-- ============================================================
-- Migration 0006: Add processing mode and normalized text metadata
-- ============================================================

ALTER TABLE file_records
  ADD COLUMN IF NOT EXISTS processing_mode text NOT NULL DEFAULT 'full';

ALTER TABLE file_records
  ADD COLUMN IF NOT EXISTS processing_reason text;

ALTER TABLE file_records
  ADD COLUMN IF NOT EXISTS reduced_coverage boolean NOT NULL DEFAULT false;

ALTER TABLE file_records
  ADD COLUMN IF NOT EXISTS extracted_content_percent integer;

ALTER TABLE file_records
  ADD COLUMN IF NOT EXISTS normalized_text_object_key text;

ALTER TABLE file_records
  ADD COLUMN IF NOT EXISTS normalized_text_checksum text;

ALTER TABLE file_records
  ADD COLUMN IF NOT EXISTS normalized_text_length integer;

ALTER TABLE file_records
  ADD COLUMN IF NOT EXISTS normalized_text_stored_at timestamptz;

ALTER TABLE file_records
  ADD COLUMN IF NOT EXISTS encryption_key_version integer;

CREATE INDEX IF NOT EXISTS idx_file_records_processing_mode
  ON file_records (processing_mode);
