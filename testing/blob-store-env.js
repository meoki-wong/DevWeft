/**
 * testing/blob-store-env.js — 按节点角色选择 blob 存储实现（主机本地 / 备用机远程 HTTP）。
 *
 * 从 submit-run.js 抽出的单一真源：bundle（git-bundle）与考卷内容（test-spec）两类工件共用，
 * 避免循环依赖（submit-run ↔ test-specs 经 submissions 相互引用）。
 *
 * 不变量：唯一持有 Hyper-V worker 的主机是 blob 内容的规范落盘位置；备用机
 * （AWP_STANDBY=1）只允许经 HTTP 上传到主机，写本机盘必然造成主机侧
 * SNAPSHOT_HASH_MISMATCH / SPEC_CONTENT_MISSING。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBlobStore, createRemoteBlobStore } from './blobs.js'
import { isStandbyControlPlane } from '../db/standby.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// testing/ 只距项目根一层（本文件在 testing/blob-store-env.js）——曾误写 '..','..' 导致
// 在项目根的上一级找 data/bootstrap-admin.token（备用机恒报“需要 token”，10-09 阻塞回滚单）。
const DEFAULT_REPO_ROOT = path.join(__dirname, '..')

/**
 * 备用机上传地址决策（纯函数，供单测）：
 * ① env AWP_BLOB_BASE_URL（规范名，指独立 blob 服务 8792）
 * ② env AWP_PRIMARY_BASE_URL（旧名兼容，指控制面 8791 时仍可用——控制面也挂着 blob 路由）
 * ③ links.primary（语义为链路控制面地址，仅非 loopback 时作兼容来源）
 * ④ 默认主机独立 blob 服务 http://127.0.0.1:8792
 * 注意：演练主备切换时会停控制面 8791，因此生产应配置 ① 指向 8792。
 */
export function resolveBlobUploadBase(env = process.env, linksPrimaryUrl = null) {
  const isLoopback = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(String(u || ''))
  const fromEnv = env.AWP_BLOB_BASE_URL || env.AWP_PRIMARY_BASE_URL || null
  if (fromEnv) return fromEnv
  if (linksPrimaryUrl && !isLoopback(linksPrimaryUrl)) return linksPrimaryUrl
  return 'http://127.0.0.1:8792'
}

/**
 * 创建 blob 存储：备用机 → 远程（HTTP 上传到主机）；主机 → 本地 data/blobs。
 * 上传目标应是主机独立 blob 服务（awp-blob-store，8792）而非控制面——主备切换
 * 演练停控制面不断单。
 * opts.env / opts.repoRoot 可注入（单测用）；生产默认 process.env 与项目根。
 */
export async function createBlobStoreForEnv(db, { env = process.env, repoRoot = DEFAULT_REPO_ROOT } = {}) {
  if (isStandbyControlPlane(env)) {
    let linksPrimaryUrl = null
    try {
      const row = await db.prepare('SELECT base_url FROM links WHERE is_primary = 1 LIMIT 1').get()
      linksPrimaryUrl = row?.base_url || null
    } catch { /* links 表可能不存在 */ }
    const uploadBase = resolveBlobUploadBase(env, linksPrimaryUrl)
    const tokenPath = path.join(repoRoot, 'data', 'bootstrap-admin.token')
    const token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : null
    if (!token) {
      throw new Error('备用机提交云端测试需要 data/bootstrap-admin.token（用于上传 bundle 到主机）')
    }
    process.stdout.write(`[blob-store-env] 备用机模式：工件将上传到主机 ${uploadBase}\n`)
    return createRemoteBlobStore(uploadBase, token)
  }
  return createBlobStore(path.join(repoRoot, 'data', 'blobs'))
}
