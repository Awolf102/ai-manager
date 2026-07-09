// Standalone (non-graph) acting call that enhances the project's design system, writing an
// enhanced candidate to .ai-manager/design-enhanced.html. Force-equipped with the design skills.
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { StreamAgentOptions } from './agent-runner'
import { streamAgent } from './agent-runner'
import { readDesignPreview, getGraph, getSettings } from './project-store'
import { actingModeFor } from './acting-mode'
import { enhanceDesignPrompt, DESIGN_SKILLS } from '../../shared/design-enhance'

export type AgentRunner = (opts: StreamAgentOptions) => Promise<{ text: string; sessionId?: string }>

export async function enhanceDesignSystem(
  opts: { directions: string[]; note: string; wc: WebContents; abort: AbortController },
  runAgent: AgentRunner = streamAgent
): Promise<void> {
  const current = await readDesignPreview()
  if (!current) throw new Error('No design system to enhance — import one first.')
  const orch = getGraph().nodes.find((n) => n.kind === 'orchestrator')
  if (!orch) throw new Error('This project has no orchestrator agent.')
  await runAgent({
    wc: opts.wc,
    agentId: orch.id,
    prompt: enhanceDesignPrompt(current, opts.directions, opts.note),
    runId: randomUUID(),
    stepId: orch.id,
    permissionMode: actingModeFor(getSettings().autonomy),
    extraSkillNames: DESIGN_SKILLS,
    abort: opts.abort
  })
}
