/**
 * sqlite-tx.js — db.tx（异步安全事务）的原型安装器（方案 §13.1）
 *
 * 独立进程（cas-worker、host-worker 等）不经 db.js 打开 better-sqlite3，
 * 引入本模块为该实例类安装与 db.js 相同的 tx 实现，保证 db.tx 在两种进程形态下可用。
 * 嵌套（AsyncLocalStorage 同链）直接参与外层事务；并发（不同异步链）在同一连接上排队串行。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const txAls = new AsyncLocalStorage()

export function installSqliteTx(Database) {
  if (!Database.prototype || Database.prototype.tx) return Database
  // 方言标记：db/dialect-helpers.js 的 isPostgres/tableExists 按此分流（方案 §2.8）
  Database.prototype.dialect = 'sqlite'
  Database.prototype.tx = function (fn) {
    if (txAls.getStore()) return fn(this)
    const run = async () => {
      this.exec('BEGIN')  // 方案 §13.1:普通 BEGIN;连接级队列串行保证升级安全,query_only 只读库可用
      try {
        const result = await txAls.run(this, () => fn(this))
        this.exec('COMMIT')
        return result
      } catch (e) {
        try { this.exec('ROLLBACK') } catch { /* 事务已回滚/连接异常 */ }
        throw e
      }
    }
    this._txQueue = (this._txQueue || Promise.resolve()).then(run, run)
    return this._txQueue
  }
  return Database
}
