import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

export function loadDeploymentEnv(envFile = join(projectRoot, 'data', 'deploy.env')) {
  if (!existsSync(envFile)) return false
  process.loadEnvFile(envFile)
  return true
}

// Loaded with Node's --import flag before application modules read process.env.
loadDeploymentEnv()
