-- ============================================================
-- Migration 0008: Add chat interpretation and feedback metadata
-- ============================================================

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS interpretation jsonb;

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS feedback jsonb;
