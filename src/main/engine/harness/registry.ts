import { streamAgent } from '../agent-runner'
import { getAgent } from '../project-store'
import type { StreamAgentOptions } from '../agent-runner'
import type { AgentRunner } from '../nodes'
import type { HarnessId } from '../../../shared/types'
import type { Harness } from './types'

/**
 * Compile-time tripwire: every Harness must be usable as the engine's runAgent
 * seam (Eng.runAgent = AgentRunner). If Harness.run or AgentRunner ever drifts,
 * this assignment stops compiling — so SP2 harnesses are guaranteed to satisfy it.
 */
const _harnessRunSatisfiesAgentRunner: (h: Harness) => AgentRunner = (h) => h.run

/** The Claude Agent SDK harness — the current (and, in SP1, only) runtime. */
const claudeSdkHarness: Harness = { run: streamAgent }

/**
 * Runtimes keyed by HarnessId. SP2 registers additional harnesses here, e.g.
 *   harnessRegistry['openai-agents'] = new OpenAiAgentsHarness()
 * Widening HarnessId forces a matching entry (Record<HarnessId, Harness>).
 */
export const harnessRegistry: Record<HarnessId, Harness> = {
  'claude-sdk': claudeSdkHarness
}

/** Resolve a harness, defaulting absent/unknown ids to claude-sdk (defensive). */
export function harnessFor(id: HarnessId | undefined): Harness {
  return (id && harnessRegistry[id]) || claudeSdkHarness
}

/** Read an agent's harness id without ever throwing (a bad/missing id must not break a run). */
function harnessIdFor(agentId: string): HarnessId | undefined {
  try {
    return getAgent(agentId).harness
  } catch {
    return undefined // unknown/absent agent ⇒ default harness
  }
}

/** The orchestrator's single dispatch entry point: read the agent's harness and route. */
export function dispatchAgent(
  opts: StreamAgentOptions
): Promise<{ text: string; sessionId?: string }> {
  return harnessFor(harnessIdFor(opts.agentId)).run(opts)
}
