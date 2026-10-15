-- testing schema v8: M5 (failure/experience 闭环)
-- §20 failure fingerprint + classification + pending review + dedup
-- §23 infra/canary 拦截：infra_failure 不入 experience

-- v8 CREATE IF NOT EXISTS 在真 db（已有 evolver experiences 同名表）会因缺列失败
-- 进化路径：v8 schema 写得**与 evolver `experiences` 字段兼容**（repo_id, title, content, source_type, source_id）
-- 真实部署场景：evolver 已用 `experiences` 表，本 schema 与之同字段；不需要重新建表
-- v8 SQL 块故意使用 `IF NOT EXISTS` 幂等：若真 db 已有同结构 `experiences`，跳过；in-memory 新 db 走完整建

-- v8 升级：补加 v5 旧 experience_pending/experiences/failure_occurrences/experience_sources
-- 缺漏列（IF NOT EXISTS 不改已有表）
-- ALTER TABLE 需要在 CREATE TABLE IF NOT EXISTS 之前，否则触发错
-- 这些表是 v8 新增，in-memory 全新 db 不需要 ALTER

CREATE TABLE IF NOT EXISTS test_failures (
  failure_id           TEXT PRIMARY KEY,
  repo_id              TEXT NOT NULL REFERENCES repositories(repo_id),
  binding_id           TEXT,  -- 跨表引用在应用层校验（trigger 太严，绕开）
  task_instance_id     TEXT,
  failure_phase        TEXT NOT NULL CHECK(failure_phase IN (
    'snapshot','install','static','build','vite_start','smoke','artifact','unknown'
  )),
  failure_class        TEXT NOT NULL CHECK(failure_class IN (
    'unclassified','product','regression','dependency_input','product_hang',
    'flaky','infra','registry_infra','vm_infra','suite','environment'
  )),
  fingerprint_version  INTEGER NOT NULL,
  fingerprint          TEXT NOT NULL,
  case_key             TEXT,
  spec_file            TEXT,
  test_title           TEXT,
  error_signature      TEXT NOT NULL,
  occurrence_count     INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'open' CHECK(status IN (
    'open','triaged','linked','dismissed','promoted'
  )),
  linked_experience_id TEXT,
  linked_suite_revision_id TEXT,  -- audit only, no FK
  review_note          TEXT,
  first_seen_at        TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_failure_fingerprint
  ON test_failures(repo_id, fingerprint_version, fingerprint)
  WHERE status IN ('open','triaged');
ALTER TABLE test_failures ADD COLUMN reviewed_by TEXT;
ALTER TABLE test_failures ADD COLUMN reviewed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_failures_fingerprint
  ON test_failures(repo_id, fingerprint_version, fingerprint, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS failure_occurrences (
  occurrence_id   TEXT PRIMARY KEY,
  failure_id      TEXT NOT NULL REFERENCES test_failures(failure_id),
  run_id          TEXT NOT NULL,
  attempt         INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('failed','passed_on_diagnostic','dismissed')),
  created_at      TEXT NOT NULL,
  FOREIGN KEY(failure_id) REFERENCES test_failures(failure_id)
);
CREATE INDEX IF NOT EXISTS idx_failure_occurrences
  ON failure_occurrences(failure_id, created_at DESC);

-- experience_pending：reviewer 介入前的暂存表
-- status: pending_review (新) / linked_to_failure (已回链到 test_failures) / promoted_to_experience (升级) / rejected
CREATE TABLE IF NOT EXISTS experience_pending (
  pending_id     TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(repo_id),
  source_id      TEXT NOT NULL,
  failure_class  TEXT NOT NULL,
  content        TEXT NOT NULL,
  title          TEXT,
  tags_json      TEXT,
  status         TEXT NOT NULL CHECK(status IN (
    'pending_review','linked_to_failure','promoted_to_experience','rejected'
  )),
  created_at     TEXT NOT NULL,
  reviewed_at    TEXT,
  reviewed_by    TEXT REFERENCES principals(principal_id),
  review_note    TEXT,
  linked_failure_id TEXT REFERENCES test_failures(failure_id),
  linked_experience_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_experience_pending_repo
  ON experience_pending(repo_id, status, created_at DESC);

-- §20.1 experience 主表：经 reviewer 批准的稳定知识
CREATE TABLE IF NOT EXISTS experiences (
  experience_id  TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(repo_id),
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  source_type    TEXT NOT NULL CHECK(source_type IN (
    'test_failure','manual','ai_drift','verify_report'
  )),
  source_id      TEXT NOT NULL,
  origin_type    TEXT NOT NULL DEFAULT 'coding',
  failure_fingerprint TEXT,
  promotion_type TEXT,
  reviewed_by    TEXT REFERENCES principals(principal_id),
  reviewed_at    TEXT,
  confidence     REAL,
  tags_json      TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_experiences_repo
  ON experiences(repo_id, created_at DESC);

-- §20.2 infra/canary 检测触发器：failure_class='infra*' 不允许进 experience_pending.promoted_to_experience
CREATE TRIGGER IF NOT EXISTS trg_experience_pending_infra_block
BEFORE UPDATE OF status ON experience_pending
FOR EACH ROW
WHEN NEW.status = 'promoted_to_experience'
  AND NEW.failure_class IN ('infra','registry_infra','vm_infra','environment')
BEGIN
  SELECT RAISE(ABORT, 'INFRA_FAILURE_BLOCKED_FROM_EXPERIENCE');
END;
