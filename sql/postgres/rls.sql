-- sql/postgres/rls.sql — 方案 §8：行级安全（租户隔离）
-- 三角色模型：
--   awp_tenant : MCP 与租户 REST —— 策略：行的 tenant_id = current_setting('app.tenant_id', true)
--                 或 = slug 'shared' 的 repo_id（§14.1）
--   awp_worker : acquireLease 与 host-worker —— 不启用租户策略；只授予租约/run 需要的表
-- 连接约定：AWP_PG_URL 使用数据库 owner，负责迁移和管理查询；
--          租户请求在事务内 SET LOCAL app.tenant_id + SET LOCAL ROLE awp_tenant；
--          工人事务内 SET LOCAL ROLE awp_worker。禁止会话级 SET（§14.1）。
-- 幂等：可重复执行（角色/策略均做存在性判断）。
-- awp_admin 不由该脚本创建：当前运行时代码不使用单独的 BYPASSRLS 角色。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awp_tenant') THEN
    CREATE ROLE awp_tenant NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awp_worker') THEN
    CREATE ROLE awp_worker NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO awp_tenant, awp_worker;

-- 租户角色：全表 DML（应用可运行），隔离由 RLS 策略承担（协作 8 表 + repo_id 键的测试表）。
-- 收紧到白名单属后续加固，不在本步范围。
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO awp_tenant;

-- 工人角色：只授予租约与 run 状态需要的表（§14.1）——注意没有协作 8 表的任何权限
GRANT SELECT, UPDATE ON test_runs TO awp_worker;
GRANT SELECT, INSERT, UPDATE ON run_attempts, runner_leases TO awp_worker;
GRANT SELECT ON test_bindings, workers, run_groups, repositories, business_snapshots, suite_plans, task_instances TO awp_worker;

-- 序列/IDENTITY：run_attempts.attempt 等由应用赋值，无需序列授权

-- 协作 8 表启用 + FORCE? 不 FORCE：owner（池默认/迁移）保持绕过 = admin 路径；
-- awp_admin 角色亦带 BYPASSRLS。策略对 awp_tenant 生效。
-- shared 的 repo_id 用运行时子查询解析（shared 若未注册则子查询为 NULL → 该分支不匹配，
-- 与「平台范围用 slug shared 的那一行 repo_id」一致且不依赖策略创建时机）
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tasks','task_versions','docs','docs_versions','experiences','verify_reports','gate_loops','task_sessions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (
         tenant_id = current_setting(''app.tenant_id'', true)
         OR tenant_id = (SELECT repo_id FROM repositories WHERE slug = ''shared'')
       ) WITH CHECK (
         tenant_id = current_setting(''app.tenant_id'', true)
         OR tenant_id = (SELECT repo_id FROM repositories WHERE slug = ''shared'')
       )', t);
  END LOOP;

  -- repo_id 键的测试表:同条件按 repo_id 隔离(§14.1 策略条件「tenant_id 或 repo_id」)
  FOREACH t IN ARRAY ARRAY[
    'task_instances','test_specs','test_runs','run_groups','test_submissions','test_bindings',
    'business_snapshots','suite_plans','artifacts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (
         repo_id = current_setting(''app.tenant_id'', true)
         OR repo_id = (SELECT repo_id FROM repositories WHERE slug = ''shared'')
       ) WITH CHECK (
         repo_id = current_setting(''app.tenant_id'', true)
         OR repo_id = (SELECT repo_id FROM repositories WHERE slug = ''shared'')
       )', t);
  END LOOP;

  -- 工人角色(§14.2):不套租户策略——全局队列可见、可领、可回写
  FOREACH t IN ARRAY ARRAY['test_runs', 'run_attempts', 'runner_leases'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS worker_access ON %I', t);
    EXECUTE format(
      'CREATE POLICY worker_access ON %I TO awp_worker USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- 租约领取是工人专属(§14.3 场景4):租户角色对租约簿记表无写权——
-- 领取语句(acquireLease 的 INSERT INTO run_attempts / runner_leases)对租户角色是权限错误,不是空结果
REVOKE INSERT, UPDATE, DELETE ON runner_leases, run_attempts FROM awp_tenant;
