// These code points let the release check scan every public text file, including
// this module and its tests, without retaining the retired names in source text.
const retiredSignatures = [
  [0x6d, 0x78, 0x74, 0x2d, 0x6d, 0x79, 0x6d, 0x69, 0x78, 0x75, 0x65, 0x2d, 0x68, 0x35],
  [0x6d, 0x79, 0x6d, 0x69, 0x78, 0x75, 0x65],
  [0x6d, 0x78, 0x62, 0x63],
  [0x6d, 0x69, 0x78, 0x75, 0x65],
  [0x871c, 0x96ea],
]

const retiredNames = retiredSignatures.map((points) =>
  String.fromCodePoint(...points).toLowerCase(),
)

export function containsRetiredBrand(value) {
  const normalized = String(value).toLowerCase()
  return retiredNames.some((name) => normalized.includes(name))
}

const credentialPatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/i,
  /\bAIza[0-9A-Za-z_-]{35}\b/i,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{24,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
]

export function containsCredentialLikeValue(value) {
  const text = String(value)
  return credentialPatterns.some((pattern) => pattern.test(text))
}

const pipelineDirectoryPatterns = [
  /(^|\/)\.github\/workflows(?:\/|$)/i,
  /(^|\/)\.circleci(?:\/|$)/i,
  /(^|\/)\.buildkite(?:\/|$)/i,
  /(^|\/)\.semaphore(?:\/|$)/i,
  /(^|\/)\.teamcity(?:\/|$)/i,
  /(^|\/)\.harness(?:\/|$)/i,
  /(^|\/)\.tekton(?:\/|$)/i,
]

const pipelineFilePattern = /(^|\/)(?:jenkinsfile(?:\.[^/]*)?|\.gitlab-ci(?:\.(?:yml|yaml))?|azure-pipelines?\.(?:yml|yaml)|bitbucket-pipelines\.(?:yml|yaml)|\.travis\.yml|appveyor\.yml|\.drone\.(?:yml|yaml)|\.woodpecker\.(?:yml|yaml)|cloudbuild\.(?:yml|yaml))$/i

/** Return true for common hosted or self-managed CI pipeline configuration paths. */
export function isPipelineConfigurationPath(value) {
  const normalized = String(value).replaceAll('\\', '/')
  return pipelineFilePattern.test(normalized) || pipelineDirectoryPatterns.some((pattern) => pattern.test(normalized))
}
