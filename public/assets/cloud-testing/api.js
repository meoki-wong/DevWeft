// 仅适配通信；读取接口不执行门禁判断，重推仅由用户确认后调用。
export async function fetchJson(path, options = {}) {
  const response = await fetch(path, options)
  let data = {}
  try { data = await response.json() } catch { /* 兼容旧看板的非 JSON 错误响应。 */ }
  if (!response.ok || data?.error) {
    const detail = data?.error
    const error = new Error(typeof detail === 'string' ? detail : detail?.message || `${response.status} ${response.statusText}`)
    error.status = response.status
    error.code = detail?.code || data?.code || null
    error.data = data
    throw error
  }
  return data
}

export function createTestingApi({ repo, taskId, request = fetchJson }) {
  const query = (values) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(values)) {
      if (value !== null && value !== undefined && value !== '') params.set(key, String(value))
    }
    return params.size ? `?${params}` : ''
  }
  const runPath = (runId, tail) => `/api/testing/runs/${encodeURIComponent(runId)}/${tail}`
  const assertContext = (data) => {
    const context = data?.summary?.context
    if ((context?.repo != null && context.repo !== repo) || (context?.taskId != null && context.taskId !== taskId)) {
      throw new Error('响应不属于当前仓库或任务，已忽略')
    }
    return data
  }
  const assertRun = (data, runId, artifactId) => {
    if (data?.runId != null && String(data.runId) !== String(runId)) throw new Error('证据响应不属于所选运行')
    if (artifactId != null && data?.artifactId != null && String(data.artifactId) !== String(artifactId)) {
      throw new Error('证据包已变化，不能混用不同 artifact')
    }
    return data
  }
  const logUrl = (runId, path, { artifactId } = {}) => runPath(runId, 'log') + query({ path, artifactId })
  return {
    async getPage({ before = null, limit = 5, signal } = {}) {
      const data = assertContext(await request(`/api/testing/by-task/${encodeURIComponent(taskId)}` + query({ repo, limit, before }), { signal }))
      const page = data?.page || data?.flow?.page
      if (page && Object.hasOwn(page, 'before') && (page.before || null) !== (before || null)) {
        throw new Error('响应游标与所请求的正式轮页面不一致')
      }
      return data
    },
    async getSummary({ signal } = {}) {
      return assertContext(await request('/api/testing/cloud-status' + query({ repo, taskId }), { signal }))
    },
    async getLogs(runId, { artifactId, signal } = {}) {
      return assertRun(await request(runPath(runId, 'logs') + query({ artifactId }), { signal }), runId, artifactId)
    },
    async getLog(runId, path, { artifactId, signal } = {}) {
      return assertRun(await request(logUrl(runId, path, { artifactId }), { signal }), runId, artifactId)
    },
    async getTimeline(runId, { signal } = {}) {
      return assertRun(await request(runPath(runId, 'timeline'), { signal }), runId)
    },
    logUrl,
    async requeue(runId, { signal } = {}) {
      return assertRun(await request(runPath(runId, 'requeue'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author: 'dashboard' }), signal,
      }), runId)
    },
  }
}
