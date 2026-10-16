import { defineConfig } from 'vitest/config'



// 纯逻辑单测（Phase 1 测试自动化）：node 环境即可，不启 MCP 服务。

export default defineConfig({

  test: {

    environment: 'node',

    include: ['test/**/*.test.mjs'],

    // 数据库隔离：db.js import 即打开 data/team.db，这里先把 AWP_DB_PATH 指到一次性副本，

    // 测试不再读写真实 team.db（生产不受影响）

    setupFiles: ['test/setup-test-db.mjs'],
    globalSetup: ['test/global-setup-pg.mjs'],

    testTimeout: 60000, // async 化后 e2e 模拟套件单测耗时上移(微任务+事务队列),15s 会误伤
    hookTimeout: 60000, // PGlite 需在 beforeAll 中构建 PostgreSQL 基线与 RLS 策略

    // 注意：不要开 fileParallelism:false——threads 池串行反复加载 better-sqlite3

    // 原生模块会导致进程 0xC0000005 崩溃。副本库已按 worker 隔离，并发写锁冲突随之消失。

    coverage: {

      provider: 'v8',

      reporter: ['text', 'html', 'json-summary'],

      // 覆盖率基线只统计平台核心域（壳层 server.js/dashboard 由接口层测试覆盖）

      include: ['testing/**', 'harness/**', 'contracts/**', 'db/**'],

      exclude: ['testing/schema-*.sql', 'testing/migrate.js'],

      reportsDirectory: 'coverage',

    },

  },

})

