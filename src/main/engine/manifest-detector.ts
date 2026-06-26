// Standalone (non-graph) read-only orchestrator call that detects how to launch
// the built app. Returns a manifest only — the renderer launches it via server IPC.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { StreamAgentOptions } from './agent-runner'
import { streamAgent } from './agent-runner'
import { getAgent, getCurrentProjectPath, listRuns, loadRun } from './project-store'
import type { RunManifest } from '../../shared/types'
import { detectManifestPrompt, parseManifest } from '../../shared/run-manifest'

const THINK_DISALLOW = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']
const STRICT_REMINDER =
  '\n\nIMPORTANT: Your previous reply could not be parsed. Reply with ONLY the JSON code block described above — no prose before or after.'

export type AgentRunner = (opts: StreamAgentOptions) => Promise<{ text: string; sessionId?: string }>

async function projectDigest(projectPath: string): Promise<string> {
  const lines: string[] = []
  try {
    const entries = await fs.readdir(projectPath)
    lines.push('Top-level entries: ' + entries.slice(0, 60).join(', '))
  } catch {
    // no/unreadable project dir — leave digest empty; the agent can still read files
  }
  try {
    const pkg = JSON.parse(await fs.readFile(join(projectPath, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    if (pkg.scripts) lines.push('package.json scripts: ' + JSON.stringify(pkg.scripts))
  } catch {
    // no package.json — fine
  }
  return lines.join('\n')
}

async function lastRunReport(): Promise<string> {
  try {
    const runs = await listRuns()
    if (runs.length === 0) return ''
    const rec = await loadRun(runs[0].file)
    return rec?.final ?? ''
  } catch {
    return ''
  }
}

export async function detectManifest(
  opts: { goal: string; orchestratorId: string; wc: WebContents; abort: AbortController; runId: string },
  runAgent: AgentRunner = streamAgent
): Promise<RunManifest> {
  const digest = await projectDigest(getCurrentProjectPath())
  const report = await lastRunReport()
  const base = detectManifestPrompt(opts.goal, digest, report)
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
    const parsed = parseManifest(text)
    if (parsed) return parsed
  }
  throw new Error(
    `${getAgent(opts.orchestratorId).name} did not return a valid run manifest. Last output:\n${last.slice(0, 400)}`
  )
}
