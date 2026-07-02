import type { AgentNodeData } from '../../shared/types'
import { backendEnv } from '../../shared/model-backends'
import { getBackends, getCurrentProjectPath } from './project-store'
import { getBackendToken } from './backend-secrets'

export type BackendResolution =
  | { kind: 'none' }
  | { kind: 'env'; env: Record<string, string>; label: string }
  | { kind: 'error'; message: string }

/** Resolve an agent's backend to env vars, or a tri-state describing why not. Main-process only. */
export async function resolveBackendEnv(agent: AgentNodeData): Promise<BackendResolution> {
  if (!agent.backendId) return { kind: 'none' }
  const backend = getBackends().find((b) => b.id === agent.backendId)
  if (!backend) {
    return { kind: 'error', message: `Agent "${agent.name}" references a backend that no longer exists — pick one in Manage backends.` }
  }
  const token = await getBackendToken(getCurrentProjectPath(), backend.id)
  if (!token) {
    return { kind: 'error', message: `Agent "${agent.name}" is set to backend "${backend.label}" but its token is missing — set it in Manage backends.` }
  }
  return { kind: 'env', env: backendEnv(backend.baseUrl, token), label: backend.label }
}
