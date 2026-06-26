import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
// Type-only import: erased at compile time, so it does NOT trigger a runtime
// require of this ESM-only package (we load it via dynamic import below).
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentStreamEvent, ContextFile, Effort, PermissionMode, RunHeadlessInput } from '../../shared/types'
import { IPC } from '../../shared/types'
import { skillOptionsFor } from '../../shared/skill-trust'
import { discoverSkills } from './skill-discovery'
import { buildContextBlock } from '../../shared/context-files'
import { buildAgentContext, getSettings, updateAgent } from './project-store'

/** Role + persistent memory + the user's project context, appended onto Claude Code's preset system prompt. */
function composeAppend(role: string, memory: string, context: ContextFile[]): string {
  const block = buildContextBlock(context)
  return [
    role.trim(),
    '',
    '## Your memory (persistent brain — read and apply these lessons)',
    memory.trim() || '(empty)',
    ...(block ? ['', block] : [])
  ].join('\n')
}

function emit(wc: WebContents, e: AgentStreamEvent): void {
  if (!wc.isDestroyed()) wc.send(IPC.agentStream, e)
}

let discoveryCache: { at: number; plugins: import('../../shared/types').DiscoveredPlugin[] } | null = null

/** Discover trusted installed skills, cached briefly so a run doesn't re-read the catalog per agent step. */
async function discoveredPlugins(): Promise<import('../../shared/types').DiscoveredPlugin[]> {
  const now = Date.now()
  if (discoveryCache && now - discoveryCache.at < 30_000) return discoveryCache.plugins
  const plugins = await discoverSkills(getSettings().skillInstallThreshold ?? 100000)
  discoveryCache = { at: now, plugins }
  return plugins
}

export interface StreamAgentOptions {
  wc: WebContents
  agentId: string
  prompt: string
  runId: string
  /** orchestration step id (tags the stream so the run view can route output) */
  stepId?: string
  /** override the agent's configured permission mode */
  permissionMode?: PermissionMode
  /** reasoning effort for this run (manager-assigned by task difficulty) */
  effort?: Effort
  /** tools to withhold from the agent this step (e.g. edit tools for read-only steps) */
  disallowedTools?: string[]
  resume?: boolean
  /** explicit session id to resume (Phase 3 handoff threads the asker's in-run session; avoids the stale on-disk read) */
  resumeSessionId?: string
  abort?: AbortController
  /** set false to suppress the "▶ name · model" header line */
  header?: boolean
}

/**
 * Run a single headless Claude Code task for one agent, streaming its output to
 * the renderer and resolving with the final text + session id. Throws on a real
 * error (after streaming it); returns partial text on abort.
 */
export async function streamAgent(
  opts: StreamAgentOptions
): Promise<{ text: string; sessionId?: string }> {
  const { wc, agentId, prompt, runId, stepId } = opts
  const { agent, projectPath, role, memory, context } = await buildAgentContext(agentId)
  const abort = opts.abort ?? new AbortController()
  const send = (
    kind: AgentStreamEvent['kind'],
    text: string,
    extra?: Partial<AgentStreamEvent>
  ): void => emit(wc, { agentId, runId, stepId, kind, text, ...extra })

  let outText = ''
  let lastSession: string | undefined

  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    if (opts.header !== false) {
      send('system', `\x1b[2m▶ ${agent.name} · ${agent.model}\x1b[0m\r\n`)
    }

    const options: Options = {
      cwd: projectPath,
      model: agent.model,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: composeAppend(role, memory, context) },
      permissionMode: opts.permissionMode ?? agent.permissionMode,
      settingSources: ['project'],
      abortController: abort
    }
    if (opts.disallowedTools && opts.disallowedTools.length > 0) {
      options.disallowedTools = opts.disallowedTools
    }
    if (opts.resumeSessionId) options.resume = opts.resumeSessionId
    else if (opts.resume && agent.sessionId) options.resume = agent.sessionId

    // Per-agent skills: load each assigned skill's plugin (MCP servers skipped —
    // we want the skill guidance, not the warehouse connectors) and filter to the
    // assigned ids. Discovered paths are already verified to exist on disk.
    const skillOpts = skillOptionsFor(agent.skills, await discoveredPlugins())
    if (skillOpts) {
      options.plugins = skillOpts.plugins
      options.skills = skillOpts.skills
    }

    if (opts.effort) options.effort = opts.effort

    for await (const message of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
      const sid = (message as { session_id?: string }).session_id
      if (sid) lastSession = sid

      if (message.type === 'assistant') {
        for (const block of message.message.content as ContentBlock[]) {
          if (block.type === 'text' && block.text) {
            outText += block.text + '\n'
            send('assistant', toTerminal(block.text))
          } else if (block.type === 'tool_use') {
            send('tool_use', `\x1b[36m⚙ ${block.name}\x1b[0m ${oneLine(JSON.stringify(block.input))}\r\n`)
          }
        }
      } else if (message.type === 'user') {
        const content = (message.message as { content?: unknown }).content
        for (const block of asArray(content)) {
          if (block?.type === 'tool_result') {
            send('tool_result', `\x1b[2m  ↳ ${oneLine(stringifyResult(block.content))}\x1b[0m\r\n`)
          }
        }
      } else if (message.type === 'result') {
        const text = (message as { result?: string }).result
        if (typeof text === 'string' && text.trim()) {
          outText = text
          send('assistant', toTerminal(text))
        }
      }
    }

    send('result', `\r\n\x1b[32m✓ done\x1b[0m\r\n`, { isFinal: true, sessionId: lastSession })
    return { text: outText.trim(), sessionId: lastSession }
  } catch (err) {
    if (abort.signal.aborted) {
      send('error', `\r\n\x1b[33m■ cancelled\x1b[0m\r\n`, { isFinal: true })
      return { text: outText.trim(), sessionId: lastSession }
    }
    const msg = err instanceof Error ? err.message : String(err)
    send('error', `\r\n\x1b[31m✗ ${msg}\x1b[0m\r\n`, { isFinal: true })
    throw err
  }
}

// ---- the manual "Run" button (single headless task) ----

const runs = new Map<string, AbortController>()

export function runHeadless(wc: WebContents, input: RunHeadlessInput): { runId: string } {
  const runId = randomUUID()
  const abort = new AbortController()
  runs.set(runId, abort)
  void (async () => {
    try {
      const { sessionId } = await streamAgent({
        wc,
        agentId: input.agentId,
        prompt: input.prompt,
        runId,
        resume: input.resume,
        abort
      })
      if (sessionId) await updateAgent({ id: input.agentId, sessionId })
    } catch {
      // streamAgent already streamed the error to the pane
    } finally {
      runs.delete(runId)
    }
  })()
  return { runId }
}

export function cancelHeadless(runId: string): void {
  runs.get(runId)?.abort()
}

// ---- helpers ----

// minimal structural types for the Anthropic content blocks we read (other
// block types at runtime simply match neither branch)
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }

function asArray(content: unknown): { type?: string; content?: unknown }[] {
  return Array.isArray(content) ? (content as { type?: string; content?: unknown }[]) : []
}

function toTerminal(s: string): string {
  return s.replace(/\r?\n/g, '\r\n') + '\r\n'
}

function oneLine(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').slice(0, 240)
}

function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : ((c as { text?: string })?.text ?? '')))
      .join(' ')
  }
  return JSON.stringify(content ?? '')
}
