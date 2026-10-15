-- testing schema v16: 项目环境登录账号（dev/qa）
-- 密码明文只存 secret-broker（独立库，不进 team.db/备份）；本表仅存 username + secret_ref。

CREATE TABLE IF NOT EXISTS repo_env_accounts (
  repo_id    TEXT NOT NULL REFERENCES repositories(repo_id),
  env        TEXT NOT NULL CHECK(env IN ('dev','qa')),
  username   TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, env)
);
