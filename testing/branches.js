import { ApiError } from './errors.js'
import { uuidv7, utcNow } from './ids.js'

const ANCESTRY = new Set(['first', 'fast_forward', 'non_fast_forward', 'deleted', 'recreated'])

export async function getActiveIncarnation(db, remoteId, fullRef) {
  return await db.prepare(
    `SELECT * FROM branch_incarnations
     WHERE remote_id=? AND full_ref=? AND state='active'`
  ).get(remoteId, fullRef)
}

async function insertObservation(db, row) {
  await db.prepare(
    `INSERT INTO branch_ref_observations(
       observation_id, remote_id, full_ref, provider_ref_version,
       old_tip_oid, new_tip_oid, observed_state, ancestry_result,
       resulting_generation, observed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.observationId,
    row.remoteId,
    row.fullRef,
    row.providerRefVersion,
    row.oldTipOid,
    row.newTipOid,
    row.observedState,
    row.ancestryResult,
    row.resultingGeneration,
    row.observedAt
  )
}

async function insertIncarnation(db, {
  repoId,
  remoteId,
  fullRef,
  generation,
  tipOid,
  now,
}) {
  const id = uuidv7()
  await db.prepare(
    `INSERT INTO branch_incarnations(
       branch_incarnation_id, repo_id, remote_id, full_ref, generation,
       anchor_commit_oid, last_observed_tip_oid, provider_ref_version,
       state, created_at, superseded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, NULL)`
  ).run(id, repoId, remoteId, fullRef, generation, tipOid, tipOid, now)
  return await db.prepare('SELECT * FROM branch_incarnations WHERE branch_incarnation_id=?').get(id)
}

/**
 * Authoritative branch generation update. Callers must pass ancestry from
 * Git-provider ref data plus server-side git merge-base, not from the client branch name.
 */
export async function observeBranchRef(db, {
  remoteId,
  fullRef,
  newTipOid = null,
  observedState = 'present',
  ancestryResult,
  providerRefVersion = null,
  now = utcNow(),
}) {
  if (!fullRef || !String(fullRef).startsWith('refs/')) throw new ApiError('INVALID_SCHEMA')
  if (!['present', 'deleted'].includes(observedState)) throw new ApiError('INVALID_SCHEMA')
  if (!ANCESTRY.has(ancestryResult)) throw new ApiError('INVALID_SCHEMA')
  if (observedState === 'present' && !newTipOid) throw new ApiError('INVALID_SCHEMA')
  if (observedState === 'deleted' && ancestryResult !== 'deleted') throw new ApiError('INVALID_SCHEMA')
  if (observedState === 'present' && ancestryResult === 'deleted') throw new ApiError('INVALID_SCHEMA')

  const tx = async (tx) => {
    const remote = await tx.prepare('SELECT * FROM git_remotes WHERE remote_id=?').get(remoteId)
    if (!remote || !remote.enabled) throw new ApiError('UNRESOLVED_REMOTE')
    const active = await getActiveIncarnation(tx, remoteId, fullRef)
    const lastGenRow = await tx.prepare(
      `SELECT MAX(generation) AS g FROM branch_incarnations WHERE remote_id=? AND full_ref=?`
    ).get(remoteId, fullRef)
    const lastGen = lastGenRow && lastGenRow.g ? lastGenRow.g : 0
    const version = providerRefVersion || `${now}:${ancestryResult}:${newTipOid || 'none'}`
    const oldTip = active ? active.last_observed_tip_oid : null

    if (observedState === 'deleted') {
      if (active) {
        await tx.prepare(
          `UPDATE branch_incarnations SET state='deleted', superseded_at=? WHERE branch_incarnation_id=?`
        ).run(now, active.branch_incarnation_id)
      }
      await insertObservation(tx, {
        observationId: uuidv7(),
        remoteId,
        fullRef,
        providerRefVersion: version,
        oldTipOid: oldTip,
        newTipOid: null,
        observedState: 'deleted',
        ancestryResult: 'deleted',
        resultingGeneration: active ? active.generation : Math.max(lastGen, 1),
        observedAt: now,
      })
      return {
        branchIncarnationId: active ? active.branch_incarnation_id : null,
        branchGeneration: active ? active.generation : null,
        state: 'deleted',
      }
    }

    if (!active) {
      if (ancestryResult !== 'first' && ancestryResult !== 'recreated') {
        throw new ApiError('BRANCH_UNVERIFIED')
      }
      const generation = ancestryResult === 'first' && lastGen === 0 ? 1 : lastGen + 1
      const row = await insertIncarnation(tx, {
        repoId: remote.repo_id,
        remoteId,
        fullRef,
        generation,
        tipOid: newTipOid,
        now,
      })
      await insertObservation(tx, {
        observationId: uuidv7(),
        remoteId,
        fullRef,
        providerRefVersion: version,
        oldTipOid: oldTip,
        newTipOid,
        observedState: 'present',
        ancestryResult,
        resultingGeneration: generation,
        observedAt: now,
      })
      return {
        branchIncarnationId: row.branch_incarnation_id,
        branchGeneration: row.generation,
        state: row.state,
      }
    }

    if (ancestryResult === 'fast_forward') {
      await tx.prepare(
        `UPDATE branch_incarnations SET last_observed_tip_oid=? WHERE branch_incarnation_id=?`
      ).run(newTipOid, active.branch_incarnation_id)
      await insertObservation(tx, {
        observationId: uuidv7(),
        remoteId,
        fullRef,
        providerRefVersion: version,
        oldTipOid: oldTip,
        newTipOid,
        observedState: 'present',
        ancestryResult: 'fast_forward',
        resultingGeneration: active.generation,
        observedAt: now,
      })
      return {
        branchIncarnationId: active.branch_incarnation_id,
        branchGeneration: active.generation,
        state: 'active',
      }
    }

    if (ancestryResult === 'non_fast_forward' || ancestryResult === 'recreated') {
      await tx.prepare(
        `UPDATE branch_incarnations SET state='superseded', superseded_at=? WHERE branch_incarnation_id=?`
      ).run(now, active.branch_incarnation_id)
      const generation = active.generation + 1
      const row = await insertIncarnation(tx, {
        repoId: remote.repo_id,
        remoteId,
        fullRef,
        generation,
        tipOid: newTipOid,
        now,
      })
      await insertObservation(tx, {
        observationId: uuidv7(),
        remoteId,
        fullRef,
        providerRefVersion: version,
        oldTipOid: oldTip,
        newTipOid,
        observedState: 'present',
        ancestryResult,
        resultingGeneration: generation,
        observedAt: now,
      })
      return {
        branchIncarnationId: row.branch_incarnation_id,
        branchGeneration: row.generation,
        state: row.state,
      }
    }

    throw new ApiError('INVALID_SCHEMA')
  }
  return await db.tx(tx)
}

/** Client tip from git-contexts:resolve. Without provider ancestry, accept first/same-tip only. */
export async function bindClientTipObservation(db, { remoteId, fullRef, headCommitOid }) {
  const active = await getActiveIncarnation(db, remoteId, fullRef)
  if (!active) {
    return await observeBranchRef(db, {
      remoteId,
      fullRef,
      newTipOid: headCommitOid,
      observedState: 'present',
      ancestryResult: 'first',
    })
  }
  if (active.last_observed_tip_oid === headCommitOid) {
    return {
      branchIncarnationId: active.branch_incarnation_id,
      branchGeneration: active.generation,
      state: 'active',
    }
  }
  return {
    branchIncarnationId: null,
    branchGeneration: null,
    state: null,
    unverified: true,
  }
}
