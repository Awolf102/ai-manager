# Run Result Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Run result" button that detects how to launch the app the agents built, lets the user confirm/edit the command, spawns the server, and opens it in the system browser.

**Architecture:** Three layers mirror the existing Draft-roles / Build-team features: a pure prompt/parse module (`shared/run-manifest.ts`), a read-only detection agent with an injectable runAgent seam (`engine/manifest-detector.ts`), and a new `child_process` server runtime modeled on `pty-manager.ts` (`engine/server-manager.ts`). IPC + preload + a GoalBar button + `RunResultModal` complete the loop. Detection and launch are two distinct steps so the runtime never depends on the agent.

**Tech Stack:** TypeScript, Electron (main + preload + React renderer), vitest, Node `child_process`/`net`, `electron.shell`, lucide-react icons.

## Global Constraints

- **Node version:** ESM-only SDK is loaded via dynamic import elsewhere; this feature uses only `node:child_process`, `node:net`, `node:fs`, `node:path`, `node:crypto` — all CJS-safe.
- **No new dependencies.** Reuse `child_process.spawn`, `net.connect`, and `electron.shell` (already imported in `src/main/index.ts`).
- **Pure modules stay node-free.** `src/shared/run-manifest.ts` must not import `node:*`, `electron`, or any DOM — it is unit-tested in plain Node (mirrors `shared/role-draft.ts`, `shared/team-spawn.ts`).
- **Read-only detection.** The detection agent call uses `permissionMode: 'default'`, `disallowedTools: THINK_DISALLOW`, `header: false`, and retries once before throwing (mirrors `engine/role-drafter.ts`).
- **One server at a time.** A new launch stops the previous server; the server is killed on app quit and project switch.
- **Process-group kill.** Servers spawn with `detached: true` and are killed via `process.kill(-pid, 'SIGTERM')` (a `shell:true` parent would otherwise orphan the real server).
- **Test runner:** `npx vitest run <file>` for one file; `npm test` for all; `npm run typecheck` and `npm run build` for the no-unit-test layers.
- **Commits:** every commit message ends with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Branch:** all work lands on `feat/run-result-button` (already created; the design spec is committed there).

---

### Task 1: Pure manifest core — `shared/run-manifest.ts`

The prompt builder + output parser, plus the `RunManifest` type. No node/DOM imports. Fully unit-tested.

**Files:**
- Modify: `src/shared/types.ts` (add the `RunManifest` interface near the other run types, ~line 238 after `RunSummary`)
- Create: `src/shared/run-manifest.ts`
- Create: `src/shared/run-manifest.test.ts`

**Interfaces:**
- Produces: `interface RunManifest { type: 'web' | 'static' | 'cli' | 'library' | 'unknown'; startCommand: string; port?: number; path?: string; notes?: string }`
- Produces: `detectManifestPrompt(goal: string, projectFiles: string, lastRunReport: string): string`
- Produces: `parseManifest(text: string): RunManifest | null`

- [ ] **Step 1: Add the `RunManifest` type to `src/shared/types.ts`**

Insert after the `RunSummary` interface (the block ending at the line before `// ---- durable run state`):

```ts
/** How to launch + open the app the agents built. Produced by the detection
 *  agent, edited in the preview, replayed by the server runtime. */
export interface RunManifest {
  type: 'web' | 'static' | 'cli' | 'library' | 'unknown'
  startCommand: string
  port?: number
  path?: string
  notes?: string
}
```

- [ ] **Step 2: Write the failing tests** — create `src/shared/run-manifest.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { detectManifestPrompt, parseManifest } from './run-manifest'

describe('detectManifestPrompt', () => {
  it('includes the goal, the JSON shape, the serve-static hint, and the default-path rule', () => {
    const p = detectManifestPrompt('build a CSV explorer', 'package.json scripts: {"dev":"vite"}', 'final report text')
    expect(p).toContain('build a CSV explorer')
    expect(p).toContain('"startCommand"')
    expect(p).toContain('python3 -m http.server')
    expect(p).toContain('localhost')
    expect(p).toContain('package.json scripts: {"dev":"vite"}')
    expect(p).toContain('final report text')
  })
})

describe('parseManifest', () => {
  it('parses a full web manifest from a fenced json block surrounded by prose', () => {
    const text = 'Here you go:\n```json\n{"type":"web","startCommand":"npm run dev","port":5173,"path":"/","notes":"vite"}\n```\nDone.'
    expect(parseManifest(text)).toEqual({
      type: 'web',
      startCommand: 'npm run dev',
      port: 5173,
      path: '/',
      notes: 'vite'
    })
  })

  it('coerces an unknown type to "unknown"', () => {
    const r = parseManifest('{"type":"webby","startCommand":"x"}')
    expect(r?.type).toBe('unknown')
  })

  it('defaults a missing path to "/" and normalizes a relative path', () => {
    expect(parseManifest('{"type":"web","startCommand":"x"}')?.path).toBe('/')
    expect(parseManifest('{"type":"web","startCommand":"x","path":"app"}')?.path).toBe('/app')
  })

  it('drops a non-positive or non-numeric port', () => {
    expect(parseManifest('{"type":"web","startCommand":"x","port":0}')?.port).toBeUndefined()
    expect(parseManifest('{"type":"web","startCommand":"x","port":"abc"}')?.port).toBeUndefined()
  })

  it('returns null when there is no JSON object', () => {
    expect(parseManifest('sorry, no idea')).toBeNull()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/shared/run-manifest.test.ts`
Expected: FAIL — `Failed to resolve import "./run-manifest"` (module not created yet).

- [ ] **Step 4: Implement `src/shared/run-manifest.ts`**

```ts
// Pure prompt-building + output-parsing for the Run-result manifest detection.
// No node/DOM imports — unit-tested in plain Node, used by the engine.
import type { RunManifest } from './types'

const TYPES: RunManifest['type'][] = ['web', 'static', 'cli', 'library', 'unknown']

export function detectManifestPrompt(goal: string, projectFiles: string, lastRunReport: string): string {
  return `You are figuring out how to LAUNCH and OPEN the app your team just built in this project, so a single button can run it. Inspect the project (you may read files) and report a single manifest.

GOAL (context only — the built artifact already exists on disk):
${goal || '(none given)'}

PROJECT FILES (a digest; read more if you need to):
${projectFiles || '(none)'}

MOST RECENT RUN REPORT (how the team described what they built; may mention the start command/port):
${lastRunReport || '(none)'}

Decide:
- "type": "web" (a server you start, e.g. vite/flask/express), "static" (HTML/CSS/JS with no server), "cli", "library", or "unknown".
- "startCommand": the exact shell command to start it from the project root (e.g. "npm run dev", "flask run", "python3 -m http.server 8000"). For a "static" site with no server, emit a SERVING command (python3 -m http.server <port>) rather than a file path, so relative asset paths resolve the same way over http://localhost. For "cli"/"library"/"unknown" you may leave it "".
- "port": the port it listens on as a number (pick the framework's conventional port if not configured: vite 5173, flask 5000, http.server 8000, express often 3000). Omit if there is no server.
- "path": the entry path to open, defaulting to "/".
- "notes": one short line on why you chose this, or any caveat.

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "type": "web", "startCommand": "npm run dev", "port": 5173, "path": "/", "notes": "" }
\`\`\``
}

export function parseManifest(text: string): RunManifest | null {
  const parsed = parseJsonBlock(text)
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  const rawType = String(o.type ?? '')
  const type = (TYPES as string[]).includes(rawType) ? (rawType as RunManifest['type']) : 'unknown'
  const startCommand = String(o.startCommand ?? '').trim()
  const portNum = Number(o.port)
  const port = Number.isInteger(portNum) && portNum > 0 ? portNum : undefined
  let path = String(o.path ?? '/').trim() || '/'
  if (!path.startsWith('/')) path = '/' + path
  const notes = o.notes != null && String(o.notes).trim() ? String(o.notes).trim() : undefined
  return { type, startCommand, ...(port !== undefined ? { port } : {}), path, ...(notes ? { notes } : {}) }
}

function parseJsonBlock(text: string): unknown {
  const candidates: string[] = []
  const fences = [...text.matchAll(/\x60{3}(?:json)?\s*([\s\S]*?)\x60{3}/gi)]
  // (\x60 = backtick; matches a ```json … ``` fenced block without literal backticks here)
  if (fences.length) candidates.push(fences[fences.length - 1][1])
  candidates.push(text)
  for (const c of candidates) {
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1))
    } catch {
      // try the next candidate
    }
  }
  return null
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/shared/run-manifest.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/shared/run-manifest.ts src/shared/run-manifest.test.ts src/shared/types.ts
git commit -m "feat(run-result): pure manifest prompt + parser + RunManifest type"
```

---

### Task 2: Detection agent — `engine/manifest-detector.ts`

The read-only orchestrator call that gathers a project digest + the last run's report, prompts the agent, parses the manifest, and retries once. Seam-tested with an injected `runAgent` (mirrors `role-drafter.test.ts`).

**Files:**
- Create: `src/main/engine/manifest-detector.ts`
- Create: `src/main/engine/manifest-detector.test.ts`

**Interfaces:**
- Consumes: `RunManifest`, `detectManifestPrompt`, `parseManifest` (Task 1); `StreamAgentOptions`, `streamAgent` from `./agent-runner`; `getAgent`, `getCurrentProjectPath`, `listRuns`, `loadRun` from `./project-store`.
- Produces: `type AgentRunner = (opts: StreamAgentOptions) => Promise<{ text: string; sessionId?: string }>`
- Produces: `detectManifest(opts: { goal: string; orchestratorId: string; wc: WebContents; abort: AbortController; runId: string }, runAgent?: AgentRunner): Promise<RunManifest>`

- [ ] **Step 1: Write the failing tests** — create `src/main/engine/manifest-detector.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('./project-store', () => ({
  getCurrentProjectPath: () => '/no/such/project-xyz',
  getAgent: (id: string) => ({ id, name: 'Boss' }),
  listRuns: async () => [],
  loadRun: async () => null
}))
vi.mock('./agent-runner', () => ({ streamAgent: async () => ({ text: '' }) }))

import { detectManifest, type AgentRunner } from './manifest-detector'

const opts = () => ({
  goal: 'build it',
  orchestratorId: 'o',
  wc: {} as never,
  abort: new AbortController(),
  runId: 'detect'
})

describe('detectManifest', () => {
  it('returns the parsed manifest from the agent output', async () => {
    const runAgent: AgentRunner = async () => ({
      text: '```json\n{"type":"web","startCommand":"npm run dev","port":5173,"path":"/"}\n```'
    })
    expect(await detectManifest(opts(), runAgent)).toEqual({
      type: 'web',
      startCommand: 'npm run dev',
      port: 5173,
      path: '/'
    })
  })

  it('retries once, then throws on persistently unparseable output', async () => {
    let calls = 0
    const runAgent: AgentRunner = async () => {
      calls++
      return { text: 'no json here' }
    }
    await expect(detectManifest(opts(), runAgent)).rejects.toThrow(/did not return a valid run manifest/)
    expect(calls).toBe(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/engine/manifest-detector.test.ts`
Expected: FAIL — cannot resolve `./manifest-detector`.

- [ ] **Step 3: Implement `src/main/engine/manifest-detector.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/engine/manifest-detector.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green (115 prior + 6 + 2 = 123 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/engine/manifest-detector.ts src/main/engine/manifest-detector.test.ts
git commit -m "feat(run-result): read-only manifest detection agent (seam-tested)"
```

---

### Task 3: Server runtime — `engine/server-manager.ts`

A `child_process`-based long-running-server manager modeled on `pty-manager.ts`. Spawns the start command, streams stdout/stderr to the renderer, polls the TCP port until ready, then opens the system browser. One server at a time; process-group kill; killed on app quit. Not unit-tested (impure `child_process`, following the `pty-manager` precedent) — verified by typecheck + build, then live smoke.

**Files:**
- Modify: `src/shared/types.ts` (add `ServerStatus` + the 3 event payload interfaces, after `RunManifest`)
- Create: `src/main/engine/server-manager.ts`
- Modify: `src/main/index.ts` (kill servers on quit)

**Interfaces:**
- Consumes: `getCurrentProjectPath` from `./project-store`; `IPC` + the new server channels/types from `../../shared/types`; `shell` from `electron`.
- Produces: `type ServerStatus = 'starting' | 'running' | 'exited' | 'error'`
- Produces: `interface ServerLogEvent { serverId: string; data: string }`, `interface ServerStatusEvent { serverId: string; status: ServerStatus }`, `interface ServerReadyEvent { serverId: string; url: string }`
- Produces: `launchServer(wc: WebContents, input: { startCommand: string; port?: number; path?: string }): { serverId: string }`, `stopServer(serverId: string): void`, `killAllServers(): void`

- [ ] **Step 1: Add the server event types to `src/shared/types.ts`**

Insert immediately after the `RunManifest` interface added in Task 1:

```ts
export type ServerStatus = 'starting' | 'running' | 'exited' | 'error'
export interface ServerLogEvent {
  serverId: string
  data: string
}
export interface ServerStatusEvent {
  serverId: string
  status: ServerStatus
}
export interface ServerReadyEvent {
  serverId: string
  url: string
}
```

- [ ] **Step 2: Add the IPC channels to the `IPC` const in `src/shared/types.ts`**

Add these keys to the `IPC` object (after `applySpawn: 'team:applySpawn'`, keeping the trailing brace):

```ts
  detectManifest: 'manifest:detect',
  launchServer: 'server:launch',
  stopServer: 'server:stop',
  openPath: 'app:openPath',
  serverLog: 'server:log',
  serverStatus: 'server:status',
  serverReady: 'server:ready'
```

(Add a comma after `applySpawn: 'team:applySpawn'` so the object stays valid.)

- [ ] **Step 3: Implement `src/main/engine/server-manager.ts`**

```ts
// Launches and tracks the long-running server the agents built, streaming its
// output to the renderer and opening the system browser when the port is ready.
// Modeled on pty-manager.ts; impure (child_process) and not unit-tested.
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { shell } from 'electron'
import type { WebContents } from 'electron'
import { IPC } from '../../shared/types'
import type { ServerStatus } from '../../shared/types'
import { getCurrentProjectPath } from './project-store'

type Server = { serverId: string; proc: ChildProcess }
let active: Server | null = null

const READY_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 300

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v != null)
  ) as Record<string, string>
}

function sendStatus(wc: WebContents, serverId: string, status: ServerStatus): void {
  if (!wc.isDestroyed()) wc.send(IPC.serverStatus, { serverId, status })
}

export function launchServer(
  wc: WebContents,
  input: { startCommand: string; port?: number; path?: string }
): { serverId: string } {
  stopActive() // one server at a time
  const serverId = randomUUID()
  const projectPath = getCurrentProjectPath()
  const proc = spawn(input.startCommand, {
    shell: true,
    detached: true,
    cwd: projectPath,
    env: cleanEnv()
  })
  active = { serverId, proc }
  sendStatus(wc, serverId, 'starting')

  const onLog = (data: Buffer): void => {
    if (!wc.isDestroyed()) wc.send(IPC.serverLog, { serverId, data: data.toString() })
  }
  proc.stdout?.on('data', onLog)
  proc.stderr?.on('data', onLog)
  proc.on('error', (err) => {
    if (!wc.isDestroyed()) wc.send(IPC.serverLog, { serverId, data: `[spawn error] ${err.message}\n` })
    sendStatus(wc, serverId, 'error')
  })
  proc.on('exit', (code) => {
    if (active?.serverId === serverId) active = null
    sendStatus(wc, serverId, 'exited')
    if (!wc.isDestroyed()) wc.send(IPC.serverLog, { serverId, data: `\n[server exited (${code})]\n` })
  })

  if (input.port) waitForPort(wc, serverId, input.port, input.path ?? '/')
  else sendStatus(wc, serverId, 'running') // no port to poll — assume up

  return { serverId }
}

function waitForPort(wc: WebContents, serverId: string, port: number, path: string): void {
  const deadline = Date.now() + READY_TIMEOUT_MS
  const tick = (): void => {
    if (active?.serverId !== serverId) return // replaced or stopped
    const sock = connect(port, '127.0.0.1')
    sock.once('connect', () => {
      sock.destroy()
      if (active?.serverId !== serverId) return
      const url = `http://localhost:${port}${path}`
      sendStatus(wc, serverId, 'running')
      if (!wc.isDestroyed()) wc.send(IPC.serverReady, { serverId, url })
      void shell.openExternal(url)
    })
    sock.once('error', () => {
      sock.destroy()
      if (active?.serverId !== serverId) return
      if (Date.now() > deadline) {
        if (!wc.isDestroyed())
          wc.send(IPC.serverLog, { serverId, data: `\n[timed out waiting for port ${port}]\n` })
        sendStatus(wc, serverId, 'error')
      } else {
        setTimeout(tick, POLL_INTERVAL_MS)
      }
    })
  }
  setTimeout(tick, POLL_INTERVAL_MS)
}

export function stopServer(serverId: string): void {
  if (active?.serverId === serverId) stopActive()
}

function stopActive(): void {
  if (!active) return
  const { proc } = active
  active = null
  try {
    if (proc.pid) process.kill(-proc.pid, 'SIGTERM') // negative pid = whole process group
    else proc.kill()
  } catch {
    try {
      proc.kill()
    } catch {
      // already dead
    }
  }
}

export function killAllServers(): void {
  stopActive()
}
```

- [ ] **Step 4: Wire server cleanup into `src/main/index.ts`**

Add the import next to the existing `killAllPtys` import:

```ts
import { killAllServers } from './engine/server-manager'
```

Then call it in both lifecycle hooks alongside `killAllPtys()`:

```ts
app.on('window-all-closed', () => {
  killAllPtys()
  killAllServers()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  killAllPtys()
  killAllServers()
})
```

- [ ] **Step 5: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: no errors (server-manager is impure and intentionally has no unit test, mirroring `pty-manager.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/main/engine/server-manager.ts src/main/index.ts src/shared/types.ts
git commit -m "feat(run-result): child_process server runtime + lifecycle + event types"
```

---

### Task 4: IPC + preload wiring

Expose detection, launch, stop, and the folder-open fallback over IPC; subscribe the three server events in preload; kill any server on project switch.

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/types.ts` (add the `RendererApi` methods)

**Interfaces:**
- Consumes: `detectManifest` from `./engine/manifest-detector`; `launchServer`/`stopServer`/`killAllServers` from `./engine/server-manager`; `shell` from `electron`; `RunManifest`, `ServerLogEvent`, `ServerStatusEvent`, `ServerReadyEvent`, the new `IPC` channels.
- Produces (on `RendererApi`): `detectManifest`, `launchServer`, `stopServer`, `openProjectPath`, `onServerLog`, `onServerStatus`, `onServerReady` (signatures below).

- [ ] **Step 1: Add the `RendererApi` methods to `src/shared/types.ts`**

Insert before the closing `}` of the `RendererApi` interface (after `applySpawnedTeam`):

```ts
  detectManifest: (input: { goal: string; orchestratorId: string }) => Promise<{
    ok: boolean
    manifest?: RunManifest
    error?: string
  }>
  launchServer: (input: { startCommand: string; port?: number; path?: string }) => Promise<{ serverId: string }>
  stopServer: (serverId: string) => void
  openProjectPath: () => void
  onServerLog: (cb: (e: ServerLogEvent) => void) => () => void
  onServerStatus: (cb: (e: ServerStatusEvent) => void) => () => void
  onServerReady: (cb: (e: ServerReadyEvent) => void) => () => void
```

- [ ] **Step 2: Register the handlers in `src/main/ipc.ts`**

Add to the imports at the top:

```ts
import { detectManifest } from './engine/manifest-detector'
import * as serverMgr from './engine/server-manager'
```

Change the electron import line `import { dialog, ipcMain } from 'electron'` to also import `shell`:

```ts
import { dialog, ipcMain, shell } from 'electron'
```

At the end of `registerIpc()` (after the team-spawning block, before the final closing brace), add:

```ts
  // ---- run result (launch the built app) ----
  ipcMain.handle(
    IPC.detectManifest,
    async (e: IpcMainInvokeEvent, input: { goal: string; orchestratorId: string }) => {
      try {
        const manifest = await detectManifest({
          goal: input.goal,
          orchestratorId: input.orchestratorId,
          wc: e.sender,
          abort: new AbortController(),
          runId: 'detect-manifest'
        })
        return { ok: true, manifest }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  ipcMain.handle(
    IPC.launchServer,
    (e: IpcMainInvokeEvent, input: { startCommand: string; port?: number; path?: string }) =>
      serverMgr.launchServer(e.sender, input)
  )
  ipcMain.on(IPC.stopServer, (_e, serverId: string) => serverMgr.stopServer(serverId))
  ipcMain.on(IPC.openPath, () => {
    void shell.openPath(store.getCurrentProjectPath())
  })
```

- [ ] **Step 3: Kill any running server on project switch in `src/main/ipc.ts`**

In the `pickProjectFolder` handler, add `serverMgr.killAllServers()` just before `return store.openProject(r.filePaths[0])`:

```ts
    if (r.canceled || r.filePaths.length === 0) return null
    serverMgr.killAllServers()
    return store.openProject(r.filePaths[0])
```

In the `openProject` handler, add the kill before opening:

```ts
  ipcMain.handle(IPC.openProject, (_e, path: string) => {
    serverMgr.killAllServers()
    return store.openProject(path)
  })
```

- [ ] **Step 4: Expose the methods in `src/preload/index.ts`**

Add the new event types to the type import block:

```ts
import type {
  AgentStreamEvent,
  OrchestrationEvent,
  PtyDataEvent,
  PtyExitEvent,
  RendererApi,
  ServerLogEvent,
  ServerReadyEvent,
  ServerStatusEvent
} from '../shared/types'
```

Add these entries to the `api` object (after `applySpawnedTeam`):

```ts
  detectManifest: (input) => ipcRenderer.invoke(IPC.detectManifest, input),
  launchServer: (input) => ipcRenderer.invoke(IPC.launchServer, input),
  stopServer: (serverId) => ipcRenderer.send(IPC.stopServer, serverId),
  openProjectPath: () => ipcRenderer.send(IPC.openPath),
  onServerLog: (cb) => sub<ServerLogEvent>(IPC.serverLog, cb),
  onServerStatus: (cb) => sub<ServerStatusEvent>(IPC.serverStatus, cb),
  onServerReady: (cb) => sub<ServerReadyEvent>(IPC.serverReady, cb)
```

(Add a comma after the previous final entry `applySpawnedTeam: ...` so the object stays valid.)

- [ ] **Step 5: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: no errors. (TypeScript will confirm the `RendererApi` shape matches both the preload `api` object and the handlers.)

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts src/shared/types.ts
git commit -m "feat(run-result): IPC + preload for detect/launch/stop/open-folder"
```

---

### Task 5: Renderer — GoalBar button + `RunResultModal`

A `Rocket` button in the GoalBar runs detection and opens the modal. The modal shows editable command/port/path, a Launch button, live server logs, a status line, and Stop — or, for non-web types, an Open-project-folder button.

**Files:**
- Create: `src/renderer/run/RunResultModal.tsx`
- Modify: `src/renderer/run/GoalBar.tsx`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: `window.api.detectManifest/launchServer/stopServer/openProjectPath/onServerLog/onServerStatus/onServerReady` (Task 4); `RunManifest`, `ServerStatus` types.
- Produces: the `RunResultModal` component; a Run-result button in `GoalBar`.

- [ ] **Step 1: Create `src/renderer/run/RunResultModal.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import type { RunManifest, ServerStatus } from '../../shared/types'

export default function RunResultModal({
  manifest,
  onClose
}: {
  manifest: RunManifest
  onClose: () => void
}) {
  const [cmd, setCmd] = useState(manifest.startCommand)
  const [port, setPort] = useState(manifest.port ? String(manifest.port) : '')
  const [path, setPath] = useState(manifest.path ?? '/')
  const [serverId, setServerId] = useState<string | null>(null)
  const [status, setStatus] = useState<ServerStatus | 'idle'>('idle')
  const [url, setUrl] = useState<string | null>(null)
  const [log, setLog] = useState('')
  const logRef = useRef<HTMLPreElement>(null)
  const launchable = manifest.type === 'web' || manifest.type === 'static'

  useEffect(() => {
    const offLog = window.api.onServerLog((e) => {
      if (e.serverId === serverId) setLog((p) => p + e.data)
    })
    const offStatus = window.api.onServerStatus((e) => {
      if (e.serverId === serverId) setStatus(e.status)
    })
    const offReady = window.api.onServerReady((e) => {
      if (e.serverId === serverId) setUrl(e.url)
    })
    return () => {
      offLog()
      offStatus()
      offReady()
    }
  }, [serverId])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const launch = async (): Promise<void> => {
    setLog('')
    setUrl(null)
    setStatus('starting')
    const p = parseInt(port, 10)
    const { serverId: id } = await window.api.launchServer({
      startCommand: cmd.trim(),
      port: Number.isInteger(p) && p > 0 ? p : undefined,
      path: path.trim() || '/'
    })
    setServerId(id)
  }
  const stop = (): void => {
    if (serverId) window.api.stopServer(serverId)
  }

  const running = serverId !== null && status !== 'exited' && status !== 'error'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Run result</h2>
        {launchable ? (
          <>
            <div className="field">
              <label>Start command</label>
              <input className="spawn-name" value={cmd} onChange={(e) => setCmd(e.target.value)} />
            </div>
            <div className="rr-row">
              <div className="field">
                <label>Port</label>
                <input className="spawn-name" value={port} onChange={(e) => setPort(e.target.value)} placeholder="e.g. 5173" />
              </div>
              <div className="field">
                <label>Entry path</label>
                <input className="spawn-name" value={path} onChange={(e) => setPath(e.target.value)} />
              </div>
            </div>
            {manifest.notes && <p className="rr-notes">{manifest.notes}</p>}
            <div className="rr-status">
              {status === 'idle' ? 'Not started' : `Status: ${status}`}
              {url && <> — opened {url}</>}
            </div>
            <pre className="server-log" ref={logRef}>
              {log || '(no output yet)'}
            </pre>
          </>
        ) : (
          <p className="rr-notes">
            This project doesn't look like a runnable web app (detected: {manifest.type}).{' '}
            {manifest.notes ?? 'Open the project folder to run it yourself.'}
          </p>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          {launchable ? (
            running ? (
              <button className="btn danger" onClick={stop}>
                Stop
              </button>
            ) : (
              <button className="btn primary" onClick={() => void launch()} disabled={!cmd.trim()}>
                Launch &amp; open
              </button>
            )
          ) : (
            <button className="btn primary" onClick={() => window.api.openProjectPath()}>
              Open project folder
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add the button to `src/renderer/run/GoalBar.tsx`**

Update the lucide import to include `Rocket`:

```tsx
import { Network, Play, Rocket, Sparkles, Square, Target } from 'lucide-react'
```

Add the modal import below the other modal imports:

```tsx
import RunResultModal from './RunResultModal'
```

Extend the existing type import to add `RunManifest`:

```tsx
import type { RunManifest, SpawnedMember } from '../../shared/types'
```

Add state (next to `spawned`):

```tsx
  const [detecting, setDetecting] = useState(false)
  const [manifest, setManifest] = useState<RunManifest | null>(null)
```

Add the derived flag (next to `canBuild`):

```tsx
  const canRunResult = !!target && !running && !detecting
```

Add the handler (next to `buildTeam`):

```tsx
  const runResult = async (): Promise<void> => {
    if (!target || running || detecting) return
    setDetecting(true)
    try {
      const r = await window.api.detectManifest({ goal: goal.trim(), orchestratorId: target.id })
      if (r.ok && r.manifest) setManifest(r.manifest)
      else window.alert(r.error ?? 'Could not detect how to run the result.')
    } finally {
      setDetecting(false)
    }
  }
```

Add the button right after the Build-team `<button>…</button>` block:

```tsx
      <button
        className="btn"
        onClick={() => void runResult()}
        disabled={!canRunResult}
        title="Launch the app your team built and open it in the browser"
      >
        <Rocket size={14} /> {detecting ? 'Detecting…' : 'Run result'}
      </button>
```

Add the modal render next to the other modals (before the closing `</div>` of `.goalbar`):

```tsx
      {manifest && <RunResultModal manifest={manifest} onClose={() => setManifest(null)} />}
```

- [ ] **Step 3: Add CSS to `src/renderer/styles.css`**

Append:

```css
.rr-row {
  display: flex;
  gap: 12px;
}
.rr-row .field {
  flex: 1;
}
.rr-notes {
  margin: 4px 0;
  font-size: 12px;
  color: var(--muted, #9aa0aa);
}
.rr-status {
  margin: 6px 0;
  font-size: 12px;
  color: var(--muted, #9aa0aa);
}
.server-log {
  max-height: 280px;
  overflow: auto;
  background: #0a0b0e;
  border: 1px solid #23262d;
  border-radius: 6px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  color: #c8ccd4;
}
```

(If `--muted` is not a defined CSS variable in this file, the `#9aa0aa` fallback applies; check an existing `.rr-notes`-like rule and match the project's muted color token if one exists.)

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: no errors. (Renderer has no unit-test harness in this repo — verified by typecheck + build, then live smoke.)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all green (123 tests; renderer/runtime changes add no unit tests).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/run/RunResultModal.tsx src/renderer/run/GoalBar.tsx src/renderer/styles.css
git commit -m "feat(run-result): GoalBar button + RunResultModal (launch/logs/stop)"
```

---

## Live smoke (after all tasks)

Not a code step — for the user to run once the branch is built:
1. Open a project whose agents built a web app (e.g. the throwaway Flask/vite app).
2. Click **Run result** → confirm the detected command/port/path look right (edit if not).
3. Click **Launch & open** → the server logs stream in, the status reaches `running`, and the system browser opens `http://localhost:PORT/`.
4. Click **Stop** → the server process dies (verify the port is free again).
5. Quit the app while a server runs → confirm no orphan process remains.
6. On a non-web project, confirm the modal offers **Open project folder** instead of Launch.

## Self-Review

**Spec coverage:**
- On-click read-only detection agent → Task 2 (`detectManifest`, retry-once). ✓
- `RunManifest` shape + parse/defaults → Task 1. ✓
- Editable preview + launch + logs + Stop → Task 5 (`RunResultModal`). ✓
- `child_process` runtime, stdout/stderr streaming, TCP-port readiness, `shell.openExternal` → Task 3. ✓
- `detached` + process-group kill; one-at-a-time; kill on quit + project switch → Task 3 (runtime + index) and Task 4 (project switch). ✓
- System browser now; `server:ready` event carries the URL for a future webview → Task 3 emits `serverReady`. ✓
- Non-web fallback = Open project folder via `app:openPath` → Task 4 handler + Task 5 modal branch. ✓
- Static collapses into launch (serve command) → Task 1 prompt instruction + Task 5 `launchable` includes `static`. ✓
- Tests: pure parse/prompt (Task 1), seam detection (Task 2), runtime/IPC/renderer build-verified (Tasks 3–5). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The only conditional note (CSS `--muted` token) gives a working fallback. ✓

**Type consistency:** `RunManifest`, `ServerStatus`, the three `Server*Event` types, `detectManifestPrompt`/`parseManifest`/`detectManifest` signatures, and the `IPC`/`RendererApi`/preload entries all use identical names and shapes across Tasks 1–5. The seam type `AgentRunner` matches `role-drafter.ts`. ✓
