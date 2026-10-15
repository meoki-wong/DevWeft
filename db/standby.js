/**
 * db/standby.js — 链路网关方案 §5（增强）：区分「worker 主机」与「备用（standby）控制面」。
 *
 * 背景：host-worker / Hyper-V VM / blob 存储 / PostgreSQL 都只在主机；备用机只跑控制面（无 worker、无 VM）。
 * 因此「会产生节点本地工件（bundle blob）或需销毁本机 VM」的后台任务（夜间全量回归 nightly、
 * 每日 05:00 未完成任务清理 dailySweep）【绝不能在备用机上跑】——否则：
 *   - nightly 在备用机下单 → bundle 落备用机磁盘 → 主机 worker 取不到 → SNAPSHOT_HASH_MISMATCH；
 *   - dailySweep 在备用机执行 → 本地 Get-VM/Remove-VM 只作用备用机 → 主机僵尸 VM 永远清不掉。
 * 判定用「备用机 opt-out」极性：默认（未设）= worker 主机跑全部；仅备用机设 AWP_STANDBY=1 跳过这两类。
 * ⇒ 主机/dev 忘配也零回归；加 N 台备用机各自设同一 flag 即可，advisory 锁保证纯 DB 后台仍单实例。
 */

/** 是否为备用（standby）控制面：env.AWP_STANDBY === '1'（大小写/空白容忍）。 */
export function isStandbyControlPlane(env = process.env) {
  return String(env?.AWP_STANDBY ?? '').trim() === '1'
}
