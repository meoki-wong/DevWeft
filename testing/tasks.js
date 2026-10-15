export async function lookupOpenTask(db, repoId, id) {
  const byPk = await db.prepare(
    `SELECT * FROM task_instances WHERE task_instance_id=? AND repo_id=?`
  ).get(id, repoId)
  if (byPk && byPk.status === 'open') return byPk
  return await db.prepare(
    `SELECT * FROM task_instances
     WHERE repo_id=? AND external_task_id=? AND status='open'
     ORDER BY epoch DESC LIMIT 1`
  ).get(repoId, id)
}
