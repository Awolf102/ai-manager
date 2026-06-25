// Standalone (non-graph) orchestrator call that proposes a hierarchical team for a
// goal. Read-only — returns the validated proposal; the renderer creates it via the
// applySpawn IPC after the user approves.
import type { WebContents } from 'electron'
import type { SpawnedMember } from '../../shared/types'
import type { StreamAgentOptions } from './agent-runner'
import { streamAgent } from './agent-runner'
import { getAgent, rosterForDrafting } from './project-store'
import { spawnTeamPrompt, parseSpawnedTeam } from '../../shared/team-spawn'

const THINK_DISALLOW = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']
const STRICT_REMINDER =
  '\n\nIMPORTANT: Your previous reply could not be parsed. Reply with ONLY the JSON code block described above — no prose before or after.'

export type AgentRunner = (opts: StreamAgentOptions) => Promise<{ text: string; sessionId?: string }>

export async function spawnTeam(
  opts: { goal: string; orchestratorId: string; wc: WebContents; abort: AbortController; runId: string },
  runAgent: AgentRunner = streamAgent
): Promise<SpawnedMember[]> {
  const { agents } = await rosterForDrafting()
  const base = spawnTeamPrompt(opts.goal, getAgent(opts.orchestratorId).name, agents)
  let last = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await runAgent({
      wc: opts.wc,
      agentId: opts.orchestratorId,
      prompt: attempt === 0 ? base : base + STRICT_REMINDER,
      runId: opts.runId,
      stepId: opts.orchestratorId,
      permissionMode: 'default',
      disallowedTools: THINK_DISALLOW,
      abort: opts.abort,
      header: false
    })
    last = text
    const members = parseSpawnedTeam(text)
    if (members && members.length > 0) return members
  }
  throw new Error(`${getAgent(opts.orchestratorId).name} did not return a valid team. Last output:\n${last.slice(0, 400)}`)
}
