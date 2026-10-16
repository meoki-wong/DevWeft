import { createHash } from 'node:crypto'
import { ApiError, rejectUnknownFields } from './errors.js'
import { uuidv7, utcNow } from './ids.js'
import { bindClientTipObservation } from './branches.js'

export function canonicalizeRemoteUrl(raw) {
  let value = String(raw || '').trim()
  if (!value) throw new Error('empty remote url')
  value = value.replace(/\\/g, '/')
  let host
  let pathPart
  const scp = value.match(/^git@([^:]+):(.+)$/i)
  if (scp) {
    host = scp[1].toLowerCase()
    pathPart = scp[2]
  } else {
    const stripped = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    const noCred = stripped.replace(/^[^@/]+@/, '')
    const slash = noCred.indexOf('/')
    if (slash < 0) {
      host = noCred
      pathPart = ''
    } else {
      host = noCred.slice(0, slash)
      pathPart = noCred.slice(slash + 1)
    }
    const colon = host.lastIndexOf(':')
    if (colon > 0) {
      host = `${host.slice(0, colon).toLowerCase()}${host.slice(colon)}`
    } else {
      host = host.toLowerCase()
    }
  }
  pathPart = pathPart.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  pathPart = pathPart.replace(/^\/+/, '')
  return `https://${host}/${pathPart}`
}

export function remoteUrlFingerprint(canonicalUrl) {
  return createHash('sha256').update(canonicalUrl, 'utf8').digest('hex')
}

export async function registerRemote(db, {
  repoId,
  url,
  provider = 'generic',
  providerInstance,
  providerProjectId = null,
  relationship = 'canonical',
  now = utcNow(),
}) {
  const canonicalUrl = canonicalizeRemoteUrl(url)
  const urlFingerprint = remoteUrlFingerprint(canonicalUrl)
  const existing = await db.prepare('SELECT * FROM git_remotes WHERE url_fingerprint=?').get(urlFingerprint)
  if (existing) return existing
  const instance = providerInstance || new URL(canonicalUrl).host
  const remoteId = uuidv7()
  await db.prepare(
    `INSERT INTO git_remotes(
       remote_id, repo_id, provider, provider_instance, provider_project_id,
       canonical_url, url_fingerprint, relationship, enabled, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(remoteId, repoId, provider, instance, providerProjectId, canonicalUrl, urlFingerprint, relationship, now)
  return await db.prepare('SELECT * FROM git_remotes WHERE remote_id=?').get(remoteId)
}

export async function resolveGitContext(db, body) {
  rejectUnknownFields(body, ['remotes', 'sourceRef', 'headCommitOid', 'objectFormat'])
  if (!Array.isArray(body.remotes) || !body.remotes.length) throw new ApiError('INVALID_SCHEMA')
  if (!body.sourceRef || !String(body.sourceRef).startsWith('refs/')) throw new ApiError('INVALID_SCHEMA')
  if (!['sha1', 'sha256'].includes(body.objectFormat)) throw new ApiError('INVALID_SCHEMA')
  let matched = null
  for (const remote of body.remotes) {
    rejectUnknownFields(remote, ['name', 'url'])
    const fp = remoteUrlFingerprint(canonicalizeRemoteUrl(remote.url))
    const row = await db.prepare(
      `SELECT r.*, repo.repo_id FROM git_remotes r
       JOIN repositories repo ON repo.repo_id = r.repo_id
       WHERE r.url_fingerprint=? AND r.enabled=1`
    ).get(fp)
    if (row) {
      matched = row
      break
    }
  }
  if (!matched) throw new ApiError('UNRESOLVED_REMOTE')
  const observed = await bindClientTipObservation(db, {
    remoteId: matched.remote_id,
    fullRef: body.sourceRef,
    headCommitOid: body.headCommitOid,
  })
  return {
    repoId: matched.repo_id,
    sourceRemoteId: matched.remote_id,
    canonicalRemoteId: matched.relationship === 'canonical' ? matched.remote_id : matched.upstream_remote_id,
    branchIncarnationId: observed.branchIncarnationId,
    branchGeneration: observed.branchGeneration,
    authorizedTargets: [
      {
        remoteId: matched.remote_id,
        ref: (await db.prepare('SELECT default_target_ref FROM repositories WHERE repo_id=?').get(matched.repo_id))
          .default_target_ref,
      },
    ],
  }
}

/** Default Git provider seam: generic Git transports use canonical URL identity and the existing ref checks. */
export const genericGitProvider = Object.freeze({
  id: 'generic',
  canonicalizeRemoteUrl,
  remoteUrlFingerprint,
  resolveContext: resolveGitContext,
})
