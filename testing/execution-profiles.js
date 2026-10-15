import { documentSha256 } from '../contracts/version.mjs'

export const DEFAULT_PROFILE_NAME = 'default-node-playwright'
export const DEFAULT_IMAGE_ID = process.env.AWP_RUNNER_IMAGE_ID || 'windows-node22-playwright'
export const NETWORK_POLICY_ID = 'npm-proxy-only-v1'
export const MOCK_POLICY_ID = 'mocked-services-v1'
export const SECRET_CAPABILITY_SET_ID = 'npm-readonly-v1'

export function defaultExecutionProfileDocument({ profileRevisionId, repoId }) {
  return {
    profileRevisionId,
    repoId,
    name: DEFAULT_PROFILE_NAME,
    runtime: {
      appNode: '22.x',
      suiteNode: '22.x',
    },
    imageId: DEFAULT_IMAGE_ID,
    resourceClass: 'browser-medium',
    networkPolicyId: NETWORK_POLICY_ID,
    mockPolicyId: MOCK_POLICY_ID,
    secretCapabilitySetId: SECRET_CAPABILITY_SET_ID,
    commands: {
      prepare: [],
      install: ['npm-ci-hardened'],
      static: ['eslint-readonly', 'hard-rules'],
      build: [],
      smoke: ['playwright'],
    },
    timeouts: {
      provisionSeconds: 300,
      installSeconds: 900,
      staticSeconds: 600,
      smokeSeconds: 720,
      artifactSeconds: 300,
      totalSeconds: 2400,
    },
  }
}

export function profileContentSha256(doc) {
  return documentSha256(doc)
}

export function parseProfileJson(profileJson) {
  const doc = typeof profileJson === 'string' ? JSON.parse(profileJson) : profileJson
  if (!doc || typeof doc !== 'object') return null
  return doc
}
