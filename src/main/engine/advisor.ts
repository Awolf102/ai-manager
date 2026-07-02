import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AdvisorSendInput, AdvisorStreamEvent } from '../../shared/types'
import { IPC } from '../../shared/types'
import { advisorSystemPrompt, type AdvisorContext } from '../../shared/advisor'
import { getSettings, getBackends, getGraph, getCurrentProjectPath } from './project-store'

const READ_ONLY_DISALLOW = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']
const turns = new Map<string, AbortController>()

/** A shallow, bounded listing of a folder (top-level entries + package.json scripts). */
export async function folderDigest(absPath: string): Promise<string> {
  const lines: string[] = []
  try {
    const entries = await fs.readdir(absPath)
    lines.push('Top-level entries: ' + entries.slice(0, 60).join(', '))
  } catch {
    // unreadable — leave empty
  }
  try {
    const pkg = JSON.parse(await fs.readFile(join(absPath, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    if (pkg.scripts) lines.push('package.json scripts: ' + JSON.stringify(pkg.scripts))
  } catch {
    // no package.json — fine
  }
  return lines.join('\n')
}

/** Assemble the Advisor's grounding context from the current project (labels/models only — never tokens/URLs). */
export function buildAdvisorContext(digest?: string): AdvisorContext {
  return {
    projectName: getGraph().project.name,
    settings: getSettings(),
    backends: getBackends().map((b) => ({ label: b.label, models: b.models.map((m) => m.id) })),
    digest
  }
}

function emit(wc: WebContents, e: AdvisorStreamEvent): void {
  if (!wc.isDestroyed()) wc.send(IPC.advisorStream, e)
}

/** Run one Advisor turn on the user's Claude login (read-only), streaming plain-text deltas. */
export function streamAdvisor(wc: WebContents, input: AdvisorSendInput): { turnId: string } {
  const turnId = randomUUID()
  const abort = new AbortController()
  turns.set(turnId, abort)
  void (async () => {
    let sessionId: string | undefined
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')
      const digest = input.focusPath ? await folderDigest(input.focusPath) : undefined
      const options: Options = {
        cwd: input.focusPath ?? getCurrentProjectPath(),
        model: input.model ?? 'claude-sonnet-4-6',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: advisorSystemPrompt(buildAdvisorContext(digest)) },
        disallowedTools: READ_ONLY_DISALLOW,
        permissionMode: 'default',
        settingSources: ['project'],
        abortController: abort
      }
      if (input.sessionId) options.resume = input.sessionId
      for await (const message of query({ prompt: input.message, options }) as AsyncIterable<SDKMessage>) {
        const sid = (message as { session_id?: string }).session_id
        if (sid) sessionId = sid
        if (message.type === 'assistant') {
          for (const block of message.message.content as { type?: string; text?: string }[]) {
            if (block.type === 'text' && block.text) emit(wc, { turnId, kind: 'delta', text: block.text })
          }
        }
      }
      emit(wc, { turnId, kind: 'done', sessionId })
    } catch (err) {
      if (abort.signal.aborted) emit(wc, { turnId, kind: 'done', sessionId })
      else emit(wc, { turnId, kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      turns.delete(turnId)
    }
  })()
  return { turnId }
}

export function cancelAdvisor(turnId: string): void {
  turns.get(turnId)?.abort()
}
