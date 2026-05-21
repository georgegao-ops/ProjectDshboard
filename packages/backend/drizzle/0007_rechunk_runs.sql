-- ============================================================
-- Migration 0007: Add rechunk run tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS rechunk_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  file_id uuid NOT NULL REFERENCES file_records(id),
  status text NOT NULL DEFAULT 'pending',
  trigger_reason text NOT NULL,
  strategy_version text NOT NULL DEFAULT 'v1',
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rechunk_runs_project
  ON rechunk_runs (project_id);

CREATE INDEX IF NOT EXISTS idx_rechunk_runs_file
  ON rechunk_runs (file_id);

CREATE INDEX IF NOT EXISTS idx_rechunk_runs_status
  ON rechunk_runs (status);

CREATE INDEX IF NOT EXISTS idx_rechunk_runs_created_at
  ON rechunk_runs (created_at);
