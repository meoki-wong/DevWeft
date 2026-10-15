-- testing schema v7: M4 (branch/task overlay + candidate approval + waiver + promotion)
-- checksum source for schema_migrations

-- §13.3 task_overlays：四层 overlay 的 task 层（叠加在 task_instance_id 上）
-- protected=true 标记受保护用例（与 suite_revisions.approval_state 协同）
CREATE TABLE IF NOT EXISTS task_overlays (
  overlay_id              TEXT PRIMARY KEY,
  logical_name            TEXT NOT NULL,
  layer                   TEXT NOT NULL CHECK(layer IN ('task','branch_task')),
  repo_id                 TEXT,
  branch_incarnation_id   TEXT,
  task_instance_id        TEXT,
  ordinal                 INTEGER NOT NULL DEFAULT 0,
  protected               INTEGER NOT NULL DEFAULT 0 CHECK(protected IN (0,1)),
  state                   TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','deprecated','revoked')),
  created_by              TEXT NOT NULL REFERENCES principals(principal_id),
  created_at              TEXT NOT NULL,
  CHECK(
    (layer='task' AND task_instance_id IS NOT NULL AND repo_id IS NOT NULL)
    OR (layer='branch_task' AND branch_incarnation_id IS NOT NULL AND task_instance_id IS NULL AND repo_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_overlay_scope
  ON task_overlays(
    layer,
    COALESCE(repo_id,''),
    COALESCE(branch_incarnation_id,''),
    COALESCE(task_instance_id,''),
    ordinal
  );
CREATE INDEX IF NOT EXISTS idx_task_overlay_task
  ON task_overlays(task_instance_id, state);
CREATE INDEX IF NOT EXISTS idx_task_overlay_branch
  ON task_overlays(branch_incarnation_id, state);

-- §13.3 candidate_binding_approvals 两阶段审批的中间表
-- CHECK 约束保证 reviewer 永远不等于 candidate 作者
CREATE TABLE IF NOT EXISTS candidate_binding_approvals (
  approval_id                       TEXT PRIMARY KEY,
  repo_id                           TEXT NOT NULL REFERENCES repositories(repo_id),
  task_instance_id                  TEXT NOT NULL,
  branch_incarnation_id             TEXT REFERENCES branch_incarnations(branch_incarnation_id),
  candidate_suite_revision_id       TEXT NOT NULL REFERENCES suite_revisions(suite_revision_id),
  effective_approval                TEXT NOT NULL DEFAULT 'pending'
    CHECK(effective_approval IN ('pending','approved','rejected','expired')),
  candidate_author_principal_id     TEXT NOT NULL REFERENCES principals(principal_id),
  reviewer_principal_id             TEXT NOT NULL REFERENCES principals(principal_id),
  reviewed_at                       TEXT,
  review_note                       TEXT,
  expires_at                        TEXT NOT NULL,
  created_at                        TEXT NOT NULL,
  CHECK(reviewer_principal_id <> candidate_author_principal_id),
  FOREIGN KEY(task_instance_id) REFERENCES task_instances(task_instance_id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_review_status
  ON candidate_binding_approvals(effective_approval, expires_at);
CREATE INDEX IF NOT EXISTS idx_candidate_review_task
  ON candidate_binding_approvals(task_instance_id);

-- §7.5 promotion_proposals：candidate → stable 5 步晋升流程
-- state 流转：proposed → diffing → replaying → reviewing → merging → published | rejected
CREATE TABLE IF NOT EXISTS promotion_proposals (
  proposal_id              TEXT PRIMARY KEY,
  repo_id                  TEXT NOT NULL REFERENCES repositories(repo_id),
  target_suite_revision_id TEXT NOT NULL REFERENCES suite_revisions(suite_revision_id),
  base_suite_revision_id   TEXT NOT NULL REFERENCES suite_revisions(suite_revision_id),
  author_principal_id      TEXT NOT NULL REFERENCES principals(principal_id),
  state                    TEXT NOT NULL DEFAULT 'proposed'
    CHECK(state IN ('proposed','diffing','replaying','reviewing','merging','published','rejected')),
  structured_diff_json     TEXT,
  replay_summary_json      TEXT,
  mr_provider              TEXT,
  mr_project_id            TEXT,
  mr_iid                   TEXT,
  mr_url                   TEXT,
  mr_state                 TEXT,
  published_revision_id    TEXT REFERENCES suite_revisions(suite_revision_id),
  published_at             TEXT,
  proposed_at              TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  CHECK(published_at IS NULL OR state='published'),
  CHECK(author_principal_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_proposal_state
  ON promotion_proposals(state, proposed_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposal_target
  ON promotion_proposals(target_suite_revision_id, state);

-- §7.5 promotion_reviews：每个 proposal 可有多个 reviewer 审批轨迹
-- CHECK 约束不能含子查询；分立 trigger 保证 reviewer ≠ proposal author
CREATE TABLE IF NOT EXISTS promotion_reviews (
  review_id            TEXT PRIMARY KEY,
  proposal_id          TEXT NOT NULL REFERENCES promotion_proposals(proposal_id),
  reviewer_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  verdict              TEXT NOT NULL CHECK(verdict IN ('approve','reject','request_changes')),
  note                 TEXT,
  reviewed_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promotion_review_proposal
  ON promotion_reviews(proposal_id, reviewed_at);

CREATE TRIGGER IF NOT EXISTS trg_promotion_review_not_author
BEFORE INSERT ON promotion_reviews
FOR EACH ROW
WHEN (SELECT author_principal_id FROM promotion_proposals WHERE proposal_id=NEW.proposal_id) = NEW.reviewer_principal_id
BEGIN
  SELECT RAISE(ABORT, 'PROMOTION_REVIEW_SELF_FORBIDDEN');
END;

-- §7.5 candidate_replay_runs：proposal replay 编排的快照记录
-- 只保留 proposal_id + 快照 + 状态，不强行 FK business_snapshot（proposal 与 snapshot 无直接引用，
-- 真实 replay 编排由 API 层在内存里用 proposal.base_suite_revision 选取快照）；FK 太重易迁移。
CREATE TABLE IF NOT EXISTS candidate_replay_runs (
  replay_run_id         TEXT PRIMARY KEY,
  proposal_id           TEXT NOT NULL REFERENCES promotion_proposals(proposal_id),
  business_snapshot_id  TEXT NOT NULL,
  status                TEXT NOT NULL CHECK(status IN ('queued','running','passed','failed','error','canceled')),
  checks_passed_json    TEXT,
  started_at            TEXT NOT NULL,
  finished_at           TEXT
);

-- §20.1 experience_sources：M5 也用到，先建表
CREATE TABLE IF NOT EXISTS experience_sources (
  repo_id       TEXT NOT NULL REFERENCES repositories(repo_id),
  experience_id TEXT NOT NULL,
  source_type   TEXT NOT NULL CHECK(source_type IN ('test_failure','manual','ai_drift','verify_report')),
  source_id     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY(repo_id, experience_id, source_type, source_id)
);

-- §7.4 跨 repo 一致性：candidate_binding_approvals.repo_id 与其 suite_revision 的 overlay 同 repo
-- suite_revisions 不直接存 repo_id（需通过 overlay_id → suite_overlays.repo_id 间接定位），
-- 跨表一致性放到应用层：candidate_approval.createApproval 调前 assert。
-- 这里只保留 reviewer ≠ author 的 CHECK（CHECK 允许列对列，不能子查询）。
