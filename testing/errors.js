const HTTP = {
  UNKNOWN_FIELD: 400,
  INVALID_SCHEMA: 400,
  RUN_NOT_FOUND: 404,
  BLOB_STORE_UNAVAILABLE: 503,
  UNRESOLVED_REMOTE: 403,
  CROSS_REPO_REFERENCE: 403,
  BRANCH_UNVERIFIED: 409,
  BRANCH_GENERATION_CHANGED: 409,
  TASK_REVISION_CONFLICT: 412,
  SNAPSHOT_HASH_MISMATCH: 400,
  WORKSPACE_CHANGED_DURING_SNAPSHOT: 409,
  BUNDLE_TOO_LARGE: 413,
  SECRET_FILES_DETECTED: 400,
  SUITE_CASE_CONFLICT: 409,
  PROTECTED_CASE_VIOLATION: 403,
  SUITE_CAPABILITY_DENIED: 403,
  SUITE_REVOKED: 409,
  IMAGE_CHANGED: 409,
  STALE_LEASE: 409,
  LEASE_EXPIRED: 409,
  RUNSPEC_SIGNATURE_INVALID: 400,
  ARTIFACT_HASH_MISMATCH: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  PRECONDITION_FAILED: 412,
  CLIENT_TOO_OLD: 426,
  INVALID_FEATURE_KEY: 400,
  INVALID_SPEC_CONTRACT: 400,
}

export class ApiError extends Error {
  constructor(code, extras = {}) {
    super(code)
    this.name = 'ApiError'
    this.code = code
    this.httpStatus = HTTP[code] || 400
    this.validationErrors = extras.validationErrors
    this.detail = extras.detail || null
  }
}

export function envelope(data, error, requestId) {
  return {
    data,
    error,
    meta: { requestId: requestId || null },
  }
}

export function sendError(res, err, requestId) {
  if (err instanceof ApiError) {
    const body = { code: err.code }
    if (err.validationErrors) body.validationErrors = err.validationErrors
    if (err.detail) body.detail = err.detail
    res.status(err.httpStatus).json(envelope(null, body, requestId))
    return
  }
  res.status(400).json(envelope(null, { code: 'INVALID_SCHEMA' }, requestId))
}

export function rejectUnknownFields(body, allowed) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError('INVALID_SCHEMA')
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ApiError('UNKNOWN_FIELD')
  }
}
