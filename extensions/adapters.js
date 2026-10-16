import { validateExtension } from './contracts.js'

export function createRunnerBackendAdapter({ id, runLane, capabilities = {} }) {
  return Object.freeze(validateExtension('runnerBackend', { id, runLane, capabilities: Object.freeze({ ...capabilities }) }))
}

export function createBlobBackendAdapter(id, store) {
  validateExtension('blobBackend', { ...store, id })
  const adapter = {
    id,
    prepare: (...args) => store.prepare(...args),
    writeUpload: (...args) => store.writeUpload(...args),
    contentPath: (...args) => store.contentPath(...args),
    isRemote: Boolean(store.isRemote),
  }
  if (typeof store.writeUploadBuffer === 'function') adapter.writeUploadBuffer = (...args) => store.writeUploadBuffer(...args)
  if (typeof store.writeUploadStream === 'function') adapter.writeUploadStream = (...args) => store.writeUploadStream(...args)
  return Object.freeze(validateExtension('blobBackend', adapter))
}
