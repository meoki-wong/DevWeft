-- testing schema v10: 测试资产 side 维度
-- Side-scoped E2E/smoke assets run only in their matching repository-configured lane.
-- A missing side keeps the asset eligible for each configured lane.
-- static lane（side=na）不执行 e2e/smoke 资产，不受分流影响。

ALTER TABLE test_specs ADD COLUMN side TEXT;
