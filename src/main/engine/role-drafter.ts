// Standalone (non-graph) orchestrator call that drafts a tailored role.md for each
// non-orchestrator agent. Read-only — returns drafts only; the renderer writes them
// via the existing writeRole IPC after the user approves.
import type { WebContents } from 'electron'
import type { StreamAgentOptions } from './agent-runner'
import { streamAgent } from './agent-runner'
import { getAgent, rosterForDrafting, getSettings } from './project-store'
import { draftRolesPrompt, parseDraftedRoles } from '../../shared/role-draft'
import { offeredSkills } from '../../shared/skill-trust'
import { discoverSkills } from './skill-discovery'

const THINK_DISALLOW = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']
const STRICT_REMINDER =
  '\n\nIMPORTANT: Your previous reply could not be parsed. Reply with ONLY the JSON code block described above — no prose before or after.'

export type AgentRunner = (opts: StreamAgentOptions) => Promise<{ text: string; sessionId?: string }>

export async function draftRoles(
  opts: { goal: string; orchestratorId: string; wc: WebContents; abort: AbortController; runId: string },
  runAgent: AgentRunner = streamAgent
): Promise<{ agentId: string; name: string; role: string; skills?: string[] }[]> {
  const { agents, edges } = await rosterForDrafting()
  if (agents.length === 0) return []
  const knownIds = agents.map((a) => a.id)
  const nameById = new Map(agents.map((a) => [a.id, a.name]))
  const s = getSettings()
  const discovered = await discoverSkills({
    mode: s.trustAnthropicOnly ? 'anthropic-only' : 'anthropic-marketplaces',
    blockHooks: s.blockPluginHooks
  })
  const offered = offeredSkills(discovered, 40)
  const validIds = discovered.flatMap((p) => p.skills.map((sk) => sk.id))
  const base = draftRolesPrompt(opts.goal, agents, edges, offered)
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
    const parsed = parseDraftedRoles(text, knownIds, validIds)
    if (parsed && parsed.length > 0) {
      return parsed.map((r) => {
        const out: { agentId: string; name: string; role: string; skills?: string[] } = {
          agentId: r.agentId,
          name: nameById.get(r.agentId) ?? r.agentId,
          role: r.role
        }
        if (r.skills) out.skills = r.skills
        return out
      })
    }
  }
  throw new Error(
    `${getAgent(opts.orchestratorId).name} did not return valid role drafts. Last output:\n${last.slice(0, 400)}`
  )
}
