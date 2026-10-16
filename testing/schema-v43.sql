-- v43: structured, reviewable run/failure resolution feedback.
-- Submitted solutions remain unverified until a human review explicitly confirms them.
CREATE TABLE IF NOT EXISTS experience_feedback (
  feedback_id        TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL REFERENCES repositories(repo_id),
  run_id             TEXT,
  failure_id         TEXT,
  experience_ref     TEXT,
  author             TEXT,
  source_type        TEXT NOT NULL CHECK(source_type IN ('run','manual','external')),
  failure_summary    TEXT NOT NULL,
  resolution_summary TEXT NOT NULL,
  scope_json         TEXT NOT NULL,
  evidence_json      TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'unverified'
                     CHECK(verification_status IN ('unverified','confirmed','rejected')),
  created_at         TEXT NOT NULL,
  reviewed_at        TEXT,
  reviewed_by        TEXT,
  review_note        TEXT,
  CHECK(length(trim(failure_summary)) > 0),
  CHECK(length(trim(resolution_summary)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_experience_feedback_repo_status
  ON experience_feedback(repo_id, verification_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_experience_feedback_run
  ON experience_feedback(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_experience_feedback_failure
  ON experience_feedback(failure_id, created_at DESC);
