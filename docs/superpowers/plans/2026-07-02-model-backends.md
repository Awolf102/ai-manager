# Model Backends Per Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each agent run on an alternative Anthropic-API-compatible model backend (e.g. GLM via z.ai, or ChatGPT via a gateway), driven by per-run `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` env; default (no backend) is byte-for-byte unchanged.

**Architecture:** A project-level `Backend[]` on the graph (non-secret) + `safeStorage`-encrypted tokens in the main process. A tri-state `resolveBackendEnv(agent)` bridges the graph + secret store; the single SDK call site (`agent-runner.streamAgent`) sets `options.env` (spreading `process.env`) only when a backend resolves, and the interactive PTY merges the same env. A `BackendsModal` manages backends; `AgentConfigPanel` gets a backend-aware model picker.

**Tech Stack:** TypeScript, Electron (main/preload/renderer, `safeStorage`), React + Zustand, Vitest, `@anthropic-ai/claude-agent-sdk`, `node-pty`.

## Global Constraints

- **Byte-for-byte when no backend:** an agent with no `backendId` (and an absent/empty `graph.backends`) MUST produce no `options.env`, no PTY env additions, unchanged `model`, and zero secret reads. Verify with explicit "none" tests.
- **Tokens are secret:** stored only `safeStorage`-encrypted in `<project>/.ai-manager/backend-secrets.json`, read only in the main process, **never** placed in `graph.json` and **never** returned to the renderer (the renderer sees only `hasToken: boolean`).
- **Anthropic-compatible only:** the env mechanism reaches Anthropic-API-compatible endpoints; the ChatGPT preset requires the user's own Anthropic→OpenAI gateway URL (a `gateway: true` preset with a blank base URL).
- **Mirror existing seams:** backend store CRUD + IPC + preload + `RendererApi` follow the `contextFolders`/`pairedDirs`/`folders:*` conventions.
- **No new dependencies** (`safeStorage` is built into Electron).
- **Green gates:** `npm run typecheck`, `npm run lint` (0 errors; 1 pre-existing HistoryView warning is expected), `npm run build`, and `npx vitest run <file>` per task; `npm test` at the end.
- **Renderer has no component-test harness** — renderer-only tasks are verified by typecheck + lint + build + a manual smoke note (consistent with prior features).

---

### Task 1: Types + presets + pure helpers

**Files:**
- Modify: `src/shared/types.ts` (add `BackendModel`/`Backend`/`BackendView` interfaces near `PairedDir`; `ProjectGraph.backends?`; `AgentNodeData.backendId?`; IPC channels; `RendererApi` methods)
- Create: `src/shared/model-backends.ts`
- Test: `src/shared/model-backends.test.ts`

**Interfaces:**
- Produces: `BackendModel { id: string; label: string }`; `Backend { id; label; baseUrl; models: BackendModel[]; presetId?: string; addedAt: string }`; `BackendView extends Backend { hasToken: boolean }`; `ProjectGraph.backends?: Backend[]`; `AgentNodeData.backendId?: string`; `BackendPreset`; `BACKEND_PRESETS: BackendPreset[]`; `backendEnv(baseUrl, token): Record<string,string>`; `parseModelIds(text): BackendModel[]`; IPC channel constants `backendAdd/backendUpdate/backendRemove/backendList/backendSetToken/backendEncryptionAvailable`; `RendererApi.addBackend/updateBackend/removeBackend/listBackends/setBackendToken/backendEncryptionAvailable`.

- [ ] **Step 1: Add the shared types.** In `src/shared/types.ts`, after the `PairedDir` interface, add:

```ts
/** A model within a backend (the id sent as options.model / --model; label for display). */
export interface BackendModel {
  id: string
  label: string
}

/** An Anthropic-API-compatible model backend for this project (e.g. GLM via z.ai). The token is
 *  NOT stored here — it lives safeStorage-encrypted in the main process. */
export interface Backend {
  id: string // randomUUID — React key + AgentNodeData.backendId reference + token key
  label: string
  baseUrl: string // the Anthropic-compatible endpoint
  models: BackendModel[]
  presetId?: string // provenance: 'zai-glm' | 'chatgpt-gateway' | 'custom'
  addedAt: string // ISO timestamp
}

/** Backend + whether a token is configured (renderer-facing; NEVER carries the token itself). */
export interface BackendView extends Backend {
  hasToken: boolean
}
```

On the `AgentNodeData` interface, after the `skills?: string[]` line, add:

```ts
  /** references a ProjectGraph.backends entry; absent = default Claude login (byte-for-byte) */
  backendId?: string
```

On the `ProjectGraph` interface, after the `pairedDirs?` line, add:

```ts
  /** Anthropic-compatible model backends for this project (tokens stored separately, encrypted) */
  backends?: Backend[]
```

In the `IPC` object, after the `removePairedDir` line, add:

```ts
  backendAdd: 'backend:add',
  backendUpdate: 'backend:update',
  backendRemove: 'backend:remove',
  backendList: 'backend:list',
  backendSetToken: 'backend:setToken',
  backendEncryptionAvailable: 'backend:encAvailable',
```

In the `RendererApi` interface, after the `removePairedDir` line, add:

```ts
  addBackend: (input: { label: string; baseUrl: string; models: BackendModel[]; presetId?: string }) => Promise<ProjectGraph>
  updateBackend: (id: string, patch: { label?: string; baseUrl?: string; models?: BackendModel[] }) => Promise<ProjectGraph>
  removeBackend: (id: string) => Promise<ProjectGraph>
  listBackends: () => Promise<BackendView[]>
  setBackendToken: (id: string, token: string) => Promise<{ ok: boolean; error?: string }>
  backendEncryptionAvailable: () => Promise<boolean>
```

- [ ] **Step 2: Write the failing test.** Create `src/shared/model-backends.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { BACKEND_PRESETS, backendEnv, parseModelIds } from './model-backends'

describe('backendEnv', () => {
  it('maps base URL + token to the Anthropic env vars', () => {
    expect(backendEnv('https://x/api', 'tok')).toEqual({
      ANTHROPIC_BASE_URL: 'https://x/api',
      ANTHROPIC_AUTH_TOKEN: 'tok'
    })
  })
})

describe('BACKEND_PRESETS', () => {
  it('has unique preset ids including custom, and the expected flags', () => {
    const ids = BACKEND_PRESETS.map((p) => p.presetId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('custom')
    expect(BACKEND_PRESETS.find((p) => p.presetId === 'zai-glm')!.baseUrl).not.toBe('')
    expect(BACKEND_PRESETS.find((p) => p.presetId === 'chatgpt-gateway')!.gateway).toBe(true)
    expect(BACKEND_PRESETS.find((p) => p.presetId === 'chatgpt-gateway')!.baseUrl).toBe('')
  })
})

describe('parseModelIds', () => {
  it('parses comma/newline lists, supports id|Label, trims, drops blanks', () => {
    expect(parseModelIds('glm-4.6, glm-4.5-air')).toEqual([
      { id: 'glm-4.6', label: 'glm-4.6' },
      { id: 'glm-4.5-air', label: 'glm-4.5-air' }
    ])
    expect(parseModelIds('a|Alpha\n b ')).toEqual([
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'b' }
    ])
    expect(parseModelIds('  ')).toEqual([])
  })
})
```

- [ ] **Step 3: Run test to verify it fails.**

Run: `npx vitest run src/shared/model-backends.test.ts`
Expected: FAIL — module `./model-backends` not found.

- [ ] **Step 4: Implement.** Create `src/shared/model-backends.ts`:

```ts
// Pure helpers + built-in preset templates for model backends (no node/DOM imports).
import type { BackendModel } from './types'

export interface BackendPreset {
  presetId: string // 'zai-glm' | 'chatgpt-gateway' | 'custom'
  label: string
  baseUrl: string // '' when the user must supply it
  gateway?: boolean // true ⇒ baseUrl is a user-supplied Anthropic→OpenAI proxy
  models: BackendModel[]
}

export const BACKEND_PRESETS: BackendPreset[] = [
  {
    presetId: 'zai-glm',
    label: 'z.ai (GLM)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    models: [
      { id: 'glm-4.6', label: 'GLM-4.6' },
      { id: 'glm-4.5-air', label: 'GLM-4.5 Air' }
    ]
  },
  {
    presetId: 'chatgpt-gateway',
    label: 'ChatGPT (via gateway)',
    baseUrl: '',
    gateway: true,
    models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }]
  },
  { presetId: 'custom', label: 'Custom', baseUrl: '', models: [] }
]

/** The env vars that route a Claude-SDK run to an Anthropic-compatible backend. */
export function backendEnv(baseUrl: string, token: string): Record<string, string> {
  return { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token }
}

/** Parse a comma/newline model-id list into BackendModel[]. Each entry is `id` or `id|Label`. */
export function parseModelIds(text: string): BackendModel[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const [id, label] = entry.split('|').map((p) => p.trim())
      return { id, label: label || id }
    })
}
```

- [ ] **Step 5: Run test to verify it passes.**

Run: `npx vitest run src/shared/model-backends.test.ts`
Expected: PASS (3 describes).

- [ ] **Step 6: Typecheck + commit.**

```bash
npm run typecheck
git add src/shared/types.ts src/shared/model-backends.ts src/shared/model-backends.test.ts
git commit -m "feat(backends): types, presets, and pure helpers"
```

---

### Task 2: Secure token store (`backend-secrets.ts`)

**Files:**
- Create: `src/main/engine/backend-secrets.ts`
- Test: `src/main/engine/backend-secrets.test.ts`

**Interfaces:**
- Produces: `encryptionAvailable(): boolean`; `setBackendToken(projectPath, id, token): Promise<void>` (throws if unavailable); `getBackendToken(projectPath, id): Promise<string | undefined>`; `hasBackendToken(projectPath, id): Promise<boolean>`; `deleteBackendToken(projectPath, id): Promise<void>`. Takes `projectPath` explicitly (no `project-store` import ⇒ no cycle).

- [ ] **Step 1: Write the failing test.** Create `src/main/engine/backend-secrets.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ avail: true }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => state.avail,
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  }
}))

import {
  encryptionAvailable,
  setBackendToken,
  getBackendToken,
  hasBackendToken,
  deleteBackendToken
} from './backend-secrets'

let proj: string
beforeEach(async () => {
  state.avail = true
  proj = await fs.mkdtemp(join(tmpdir(), 'aim-sec-'))
})
afterEach(async () => {
  await fs.rm(proj, { recursive: true, force: true })
})

describe('backend secrets', () => {
  it('roundtrips a token and reports presence', async () => {
    expect(encryptionAvailable()).toBe(true)
    expect(await hasBackendToken(proj, 'b1')).toBe(false)
    await setBackendToken(proj, 'b1', 'sk-123')
    expect(await hasBackendToken(proj, 'b1')).toBe(true)
    expect(await getBackendToken(proj, 'b1')).toBe('sk-123')
  })

  it('returns undefined for an unknown id', async () => {
    expect(await getBackendToken(proj, 'nope')).toBeUndefined()
  })

  it('deletes a token', async () => {
    await setBackendToken(proj, 'b1', 'x')
    await deleteBackendToken(proj, 'b1')
    expect(await hasBackendToken(proj, 'b1')).toBe(false)
  })

  it('writes a self-contained .ai-manager/.gitignore for the secret file', async () => {
    await setBackendToken(proj, 'b1', 'x')
    const gi = await fs.readFile(join(proj, '.ai-manager', '.gitignore'), 'utf8')
    expect(gi).toContain('backend-secrets.json')
  })

  it('throws when encryption is unavailable', async () => {
    state.avail = false
    await expect(setBackendToken(proj, 'b1', 'x')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `npx vitest run src/main/engine/backend-secrets.test.ts`
Expected: FAIL — module `./backend-secrets` not found.

- [ ] **Step 3: Implement.** Create `src/main/engine/backend-secrets.ts`:

```ts
import { safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './atomic-write'

const SECRET_FILE = 'backend-secrets.json'

function aimDir(projectPath: string): string {
  return join(projectPath, '.ai-manager')
}
function secretPath(projectPath: string): string {
  return join(aimDir(projectPath), SECRET_FILE)
}

/** True when the OS provides an encryption backend (keychain / DPAPI / libsecret). */
export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

async function readMap(projectPath: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(secretPath(projectPath), 'utf8')) as Record<string, string>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

/** Ensure `.ai-manager/.gitignore` ignores the secret file (scoped to the app dir; project root untouched). */
async function ensureGitignore(projectPath: string): Promise<void> {
  const gi = join(aimDir(projectPath), '.gitignore')
  let cur = ''
  try {
    cur = await fs.readFile(gi, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (cur.split(/\r?\n/).some((l) => l.trim() === SECRET_FILE)) return
  const next = (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + SECRET_FILE + '\n'
  await fs.writeFile(gi, next, 'utf8')
}

/** Encrypt + persist a backend token (base64 of the safeStorage cipher). Throws if unavailable. */
export async function setBackendToken(projectPath: string, id: string, token: string): Promise<void> {
  if (!encryptionAvailable()) throw new Error('Secure storage is unavailable on this system')
  await fs.mkdir(aimDir(projectPath), { recursive: true })
  const map = await readMap(projectPath)
  map[id] = safeStorage.encryptString(token).toString('base64')
  await atomicWrite(secretPath(projectPath), JSON.stringify(map, null, 2))
  await ensureGitignore(projectPath)
}

/** Decrypt a backend token, or undefined if unset/undecryptable. MAIN PROCESS ONLY. */
export async function getBackendToken(projectPath: string, id: string): Promise<string | undefined> {
  const enc = (await readMap(projectPath))[id]
  if (!enc) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return undefined
  }
}

export async function hasBackendToken(projectPath: string, id: string): Promise<boolean> {
  return !!(await readMap(projectPath))[id]
}

export async function deleteBackendToken(projectPath: string, id: string): Promise<void> {
  const map = await readMap(projectPath)
  if (!(id in map)) return
  delete map[id]
  await atomicWrite(secretPath(projectPath), JSON.stringify(map, null, 2))
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `npx vitest run src/main/engine/backend-secrets.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit.**

```bash
npm run typecheck
git add src/main/engine/backend-secrets.ts src/main/engine/backend-secrets.test.ts
git commit -m "feat(backends): safeStorage-encrypted token store"
```

---

### Task 3: Backend store CRUD (`project-store.ts`)

**Files:**
- Modify: `src/main/engine/project-store.ts` (type import; `backends` default-fill in `openProject` ~L218; CRUD + `backendsView` near the `pairedDirs`/`contextFolders` block; import from `backend-secrets`)
- Test: `src/main/engine/project-store.backends.test.ts`

**Interfaces:**
- Consumes: `hasBackendToken`, `deleteBackendToken` (Task 2).
- Produces: `getBackends(): Backend[]`; `addBackend(input): Promise<ProjectGraph>`; `updateBackend(id, patch): Promise<ProjectGraph>`; `removeBackend(id): Promise<ProjectGraph>` (unassigns agents + deletes token); `backendsView(): Promise<BackendView[]>`.

- [ ] **Step 1: Write the failing test.** Create `src/main/engine/project-store.backends.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const USERDATA = vi.hoisted(() => `/tmp/aim-userdata-${Math.random().toString(36).slice(2)}`)
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  }
}))

import {
  openProject,
  getBackends,
  addBackend,
  updateBackend,
  removeBackend,
  backendsView,
  createAgent,
  updateAgent,
  getGraph
} from './project-store'
import { setBackendToken } from './backend-secrets'

let proj: string
beforeEach(async () => {
  proj = await fs.mkdtemp(join(tmpdir(), 'aim-be-'))
  await openProject(proj)
})
afterEach(async () => {
  await fs.rm(proj, { recursive: true, force: true })
})

const input = { label: 'z.ai', baseUrl: 'https://z/api', models: [{ id: 'glm-4.6', label: 'GLM-4.6' }], presetId: 'zai-glm' }

describe('backend store', () => {
  it('defaults to [] on open', () => {
    expect(getBackends()).toEqual([])
  })

  it('adds a backend with an id + addedAt', async () => {
    await addBackend(input)
    const [b] = getBackends()
    expect(b.label).toBe('z.ai')
    expect(b.baseUrl).toBe('https://z/api')
    expect(typeof b.id).toBe('string')
    expect(typeof b.addedAt).toBe('string')
  })

  it('updates label/baseUrl/models', async () => {
    await addBackend(input)
    const id = getBackends()[0].id
    await updateBackend(id, { label: 'renamed' })
    expect(getBackends()[0].label).toBe('renamed')
  })

  it('removes a backend, unassigns referencing agents, and deletes its token', async () => {
    await addBackend(input)
    const id = getBackends()[0].id
    await setBackendToken(proj, id, 'sk-1')
    await createAgent({ name: 'W', kind: 'worker' })
    const agentId = getGraph().nodes[0].id
    await updateAgent({ id: agentId, backendId: id })
    await removeBackend(id)
    expect(getBackends()).toEqual([])
    expect(getGraph().nodes[0].backendId).toBeUndefined()
    expect((await backendsView()).length).toBe(0)
  })

  it('backendsView reports hasToken without exposing the token', async () => {
    await addBackend(input)
    const id = getBackends()[0].id
    expect((await backendsView())[0].hasToken).toBe(false)
    await setBackendToken(proj, id, 'sk-1')
    const view = await backendsView()
    expect(view[0].hasToken).toBe(true)
    expect('token' in view[0]).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `npx vitest run src/main/engine/project-store.backends.test.ts`
Expected: FAIL — `getBackends`/`addBackend`/etc. not exported.

- [ ] **Step 3: Implement.** In `src/main/engine/project-store.ts`: add `Backend, BackendModel, BackendView` to the `'../../shared/types'` type import; add `import { hasBackendToken, deleteBackendToken } from './backend-secrets'` near the other engine imports. In `openProject`, after `graph.pairedDirs = graph.pairedDirs ?? []`, add:

```ts
  graph.backends = graph.backends ?? []
```

After the paired-dir CRUD block, add:

```ts
// ---------- model backends ----------

/** The Anthropic-compatible backends configured for this project. */
export function getBackends(): Backend[] {
  return [...(requireCurrent().graph.backends ?? [])]
}

export async function addBackend(input: {
  label: string
  baseUrl: string
  models: BackendModel[]
  presetId?: string
}): Promise<ProjectGraph> {
  const { graph } = requireCurrent()
  graph.backends = graph.backends ?? []
  graph.backends.push({
    id: randomUUID(),
    label: input.label,
    baseUrl: input.baseUrl,
    models: input.models,
    presetId: input.presetId,
    addedAt: new Date().toISOString()
  })
  return saveGraph()
}

export async function updateBackend(
  id: string,
  patch: { label?: string; baseUrl?: string; models?: BackendModel[] }
): Promise<ProjectGraph> {
  const { graph } = requireCurrent()
  const b = (graph.backends ?? []).find((x) => x.id === id)
  if (b) {
    if (patch.label !== undefined) b.label = patch.label
    if (patch.baseUrl !== undefined) b.baseUrl = patch.baseUrl
    if (patch.models !== undefined) b.models = patch.models
  }
  return saveGraph()
}

/** Remove a backend: drop it, unassign any agent using it, and delete its encrypted token. */
export async function removeBackend(id: string): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  graph.backends = (graph.backends ?? []).filter((x) => x.id !== id)
  for (const n of graph.nodes) if (n.backendId === id) n.backendId = undefined
  await deleteBackendToken(path, id)
  return saveGraph()
}

/** Backends augmented with whether a token is configured (never the token itself). */
export async function backendsView(): Promise<BackendView[]> {
  const { path, graph } = requireCurrent()
  const list = graph.backends ?? []
  return Promise.all(list.map(async (b) => ({ ...b, hasToken: await hasBackendToken(path, b.id) })))
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `npx vitest run src/main/engine/project-store.backends.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit.**

```bash
npm run typecheck
git add src/main/engine/project-store.ts src/main/engine/project-store.backends.test.ts
git commit -m "feat(backends): project-store CRUD + backendsView"
```

---

### Task 4: `resolveBackendEnv` (`backend-resolve.ts`)

**Files:**
- Create: `src/main/engine/backend-resolve.ts`
- Test: `src/main/engine/backend-resolve.test.ts`

**Interfaces:**
- Consumes: `getBackends`, `getCurrentProjectPath` (project-store); `getBackendToken` (Task 2); `backendEnv` (Task 1).
- Produces: `type BackendResolution = { kind: 'none' } | { kind: 'env'; env: Record<string,string>; label: string } | { kind: 'error'; message: string }`; `resolveBackendEnv(agent: AgentNodeData): Promise<BackendResolution>`.

- [ ] **Step 1: Write the failing test.** Create `src/main/engine/backend-resolve.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const USERDATA = vi.hoisted(() => `/tmp/aim-userdata-${Math.random().toString(36).slice(2)}`)
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  }
}))

import { openProject, addBackend, getBackends, createAgent, updateAgent, getGraph } from './project-store'
import { setBackendToken } from './backend-secrets'
import { resolveBackendEnv } from './backend-resolve'

let proj: string
beforeEach(async () => {
  proj = await fs.mkdtemp(join(tmpdir(), 'aim-res-'))
  await openProject(proj)
  await createAgent({ name: 'W', kind: 'worker' })
})
afterEach(async () => {
  await fs.rm(proj, { recursive: true, force: true })
})

const agent = () => getGraph().nodes[0]

describe('resolveBackendEnv', () => {
  it('returns none when the agent has no backend', async () => {
    expect(await resolveBackendEnv(agent())).toEqual({ kind: 'none' })
  })

  it('returns env + label when the backend and token resolve', async () => {
    await addBackend({ label: 'z.ai', baseUrl: 'https://z/api', models: [{ id: 'glm-4.6', label: 'GLM' }] })
    const id = getBackends()[0].id
    await setBackendToken(proj, id, 'sk-1')
    await updateAgent({ id: agent().id, backendId: id })
    const r = await resolveBackendEnv(agent())
    expect(r).toEqual({
      kind: 'env',
      label: 'z.ai',
      env: { ANTHROPIC_BASE_URL: 'https://z/api', ANTHROPIC_AUTH_TOKEN: 'sk-1' }
    })
  })

  it('errors when the backend is missing', async () => {
    await updateAgent({ id: agent().id, backendId: 'ghost' })
    const r = await resolveBackendEnv(agent())
    expect(r.kind).toBe('error')
  })

  it('errors when the token is missing', async () => {
    await addBackend({ label: 'z.ai', baseUrl: 'https://z/api', models: [] })
    const id = getBackends()[0].id
    await updateAgent({ id: agent().id, backendId: id })
    const r = await resolveBackendEnv(agent())
    expect(r.kind).toBe('error')
  })
})
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `npx vitest run src/main/engine/backend-resolve.test.ts`
Expected: FAIL — module `./backend-resolve` not found.

- [ ] **Step 3: Implement.** Create `src/main/engine/backend-resolve.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `npx vitest run src/main/engine/backend-resolve.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit.**

```bash
npm run typecheck
git add src/main/engine/backend-resolve.ts src/main/engine/backend-resolve.test.ts
git commit -m "feat(backends): resolveBackendEnv tri-state"
```

---

### Task 5: SDK runner wiring (`agent-runner.ts`)

**Files:**
- Modify: `src/main/engine/agent-runner.ts` (import `backend-resolve`; add exported `applyBackendToRun`; resolve backend + error-guard + header label + `options.model`/`options.env` in `streamAgent`)
- Test: `src/main/engine/agent-runner.backends.test.ts`

**Interfaces:**
- Consumes: `resolveBackendEnv`, `BackendResolution` (Task 4).
- Produces: `applyBackendToRun(result: BackendResolution, agentModel: string, modelOverride: string | undefined): { model: string; env?: Record<string, string | undefined>; label?: string }`.

- [ ] **Step 1: Write the failing test.** Create `src/main/engine/agent-runner.backends.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

const USERDATA = vi.hoisted(() => `/tmp/aim-userdata-${Math.random().toString(36).slice(2)}`)
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
}))

import { applyBackendToRun } from './agent-runner'

describe('applyBackendToRun', () => {
  it('for an env backend: uses agent.model, spreads process.env + backend env, sets label', () => {
    process.env.__AIM_TEST__ = 'sentinel'
    const r = applyBackendToRun(
      { kind: 'env', label: 'z.ai', env: { ANTHROPIC_BASE_URL: 'https://z', ANTHROPIC_AUTH_TOKEN: 't' } },
      'glm-4.6',
      'claude-haiku-4-5' // an override that must be IGNORED for a backend agent
    )
    expect(r.model).toBe('glm-4.6')
    expect(r.label).toBe('z.ai')
    expect(r.env!.ANTHROPIC_BASE_URL).toBe('https://z')
    expect(r.env!.__AIM_TEST__).toBe('sentinel')
    delete process.env.__AIM_TEST__
  })

  it('for none: applies the override precedence and sets no env/label', () => {
    expect(applyBackendToRun({ kind: 'none' }, 'claude-sonnet-4-6', 'claude-haiku-4-5')).toEqual({ model: 'claude-haiku-4-5' })
    expect(applyBackendToRun({ kind: 'none' }, 'claude-sonnet-4-6', undefined)).toEqual({ model: 'claude-sonnet-4-6' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `npx vitest run src/main/engine/agent-runner.backends.test.ts`
Expected: FAIL — `applyBackendToRun` is not exported.

- [ ] **Step 3: Implement the helper.** In `src/main/engine/agent-runner.ts`, add the import near the other engine imports:

```ts
import { resolveBackendEnv, type BackendResolution } from './backend-resolve'
```

Add the exported helper (place it near `composeAppend`, top-level):

```ts
/** Compute the run's model + optional env from a resolved backend. The 'error' kind is handled by
 *  the caller (streamAgent) BEFORE this is called. For an 'env' backend, agent.model wins (a
 *  transient modelOverride would send a Claude id to a non-Claude endpoint) and process.env is
 *  spread so PATH/HOME survive; 'none' keeps today's override precedence. */
export function applyBackendToRun(
  result: BackendResolution,
  agentModel: string,
  modelOverride: string | undefined
): { model: string; env?: Record<string, string | undefined>; label?: string } {
  if (result.kind === 'env') {
    return { model: agentModel, env: { ...process.env, ...result.env }, label: result.label }
  }
  return { model: modelOverride ?? agentModel }
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `npx vitest run src/main/engine/agent-runner.backends.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire `streamAgent`.** Inside the `try` block, right after `const { query } = await import('@anthropic-ai/claude-agent-sdk')`, add the backend resolution + error guard + header (replacing the existing `if (opts.header !== false) { ... }` block):

```ts
    const backend = await resolveBackendEnv(agent)
    if (backend.kind === 'error') {
      send('error', `\r\n\x1b[31m✗ ${backend.message}\x1b[0m\r\n`, { isFinal: true })
      throw new Error(backend.message)
    }
    const run = applyBackendToRun(backend, agent.model, opts.modelOverride)
    if (opts.header !== false) {
      send('system', `\x1b[2m▶ ${agent.name} · ${run.model}${run.label ? ` (${run.label})` : ''}\x1b[0m\r\n`)
    }
```

In the `options` object literal, change the `model` line from `model: opts.modelOverride ?? agent.model,` to:

```ts
      model: run.model,
```

Immediately after the `options` object literal closes (next to the `additionalDirectories` attach), add:

```ts
    if (run.env) options.env = run.env
```

- [ ] **Step 6: Verify wiring compiles + focused test still green.**

Run: `npm run typecheck && npx vitest run src/main/engine/agent-runner.backends.test.ts`
Expected: typecheck PASS; tests PASS. (`streamAgent` itself is not unit-tested — it dynamically imports the live SDK.)

- [ ] **Step 7: Commit.**

```bash
git add src/main/engine/agent-runner.ts src/main/engine/agent-runner.backends.test.ts
git commit -m "feat(backends): route SDK runs to a resolved backend"
```

---

### Task 6: Interactive terminal env (`pty-manager.ts`)

**Files:**
- Modify: `src/main/engine/pty-manager.ts` (import `backend-resolve`; add exported `mergeBackendEnv`; use it in `spawnPty`)
- Test: `src/main/engine/pty-manager.test.ts` (add cases)

**Interfaces:**
- Consumes: `resolveBackendEnv`, `BackendResolution` (Task 4).
- Produces: `mergeBackendEnv(base: Record<string, string>, result: BackendResolution): Record<string, string>`.

- [ ] **Step 1: Write the failing test.** Add to `src/main/engine/pty-manager.test.ts`:

```ts
import { mergeBackendEnv } from './pty-manager'

describe('mergeBackendEnv', () => {
  it('merges backend env over the base for an env result', () => {
    const out = mergeBackendEnv({ PATH: '/bin', ANTHROPIC_BASE_URL: 'old' }, { kind: 'env', label: 'z', env: { ANTHROPIC_BASE_URL: 'new', ANTHROPIC_AUTH_TOKEN: 't' } })
    expect(out).toEqual({ PATH: '/bin', ANTHROPIC_BASE_URL: 'new', ANTHROPIC_AUTH_TOKEN: 't' })
  })
  it('leaves the base unchanged for none/error', () => {
    const base = { PATH: '/bin' }
    expect(mergeBackendEnv(base, { kind: 'none' })).toEqual(base)
    expect(mergeBackendEnv(base, { kind: 'error', message: 'x' })).toEqual(base)
  })
})
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `npx vitest run src/main/engine/pty-manager.test.ts`
Expected: FAIL — `mergeBackendEnv` is not exported.

- [ ] **Step 3: Implement.** In `src/main/engine/pty-manager.ts`, add the import:

```ts
import { resolveBackendEnv, type BackendResolution } from './backend-resolve'
```

Add the exported helper (top-level, near `buildClaudeArgs`):

```ts
/** Merge a resolved backend's env over a base env (for the interactive claude PTY). none/error ⇒ base. */
export function mergeBackendEnv(base: Record<string, string>, result: BackendResolution): Record<string, string> {
  return result.kind === 'env' ? { ...base, ...result.env } : base
}
```

In `spawnPty`, change the headless-agent `pty.spawn(...)` `env` field from `env: cleanEnv()` to:

```ts
    env: mergeBackendEnv(cleanEnv(), await resolveBackendEnv(agent))
```

(Leave `spawnShellPty` and its `env: cleanEnv()` untouched — the plain shell is not `claude`.)

- [ ] **Step 4: Run test to verify it passes.**

Run: `npx vitest run src/main/engine/pty-manager.test.ts`
Expected: PASS (existing `writePty` + `buildClaudeArgs` + 2 new).

- [ ] **Step 5: Typecheck + commit.**

```bash
npm run typecheck
git add src/main/engine/pty-manager.ts src/main/engine/pty-manager.test.ts
git commit -m "feat(backends): route the interactive terminal to a resolved backend"
```

---

### Task 7: IPC + preload + handlers

**Files:**
- Modify: `src/main/ipc.ts` (import `backend-secrets`; add six handlers after the paired-dir handlers)
- Modify: `src/preload/index.ts` (six bridge entries after the paired-dir entries)

**Interfaces:**
- Consumes: `store.addBackend/updateBackend/removeBackend/backendsView/getCurrentProjectPath` (Task 3); `setBackendToken`, `encryptionAvailable` (Task 2); IPC constants + `RendererApi` (Task 1).
- Produces: `window.api.addBackend/updateBackend/removeBackend/listBackends/setBackendToken/backendEncryptionAvailable`.

- [ ] **Step 1: Add the main handlers.** In `src/main/ipc.ts`, add near the top-of-file engine imports:

```ts
import { setBackendToken, encryptionAvailable } from './engine/backend-secrets'
```

Add `BackendModel` to the existing `'../shared/types'` type import if types are imported there (otherwise import it). After the paired-dir handlers, add:

```ts
  // ---- model backends ----
  ipcMain.handle(IPC.backendAdd, (_e, input: { label: string; baseUrl: string; models: BackendModel[]; presetId?: string }) =>
    store.addBackend(input)
  )
  ipcMain.handle(IPC.backendUpdate, (_e, id: string, patch: { label?: string; baseUrl?: string; models?: BackendModel[] }) =>
    store.updateBackend(id, patch)
  )
  ipcMain.handle(IPC.backendRemove, (_e, id: string) => store.removeBackend(id))
  ipcMain.handle(IPC.backendList, () => store.backendsView())
  ipcMain.handle(IPC.backendSetToken, async (_e, id: string, token: string) => {
    try {
      await setBackendToken(store.getCurrentProjectPath(), id, token)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC.backendEncryptionAvailable, () => encryptionAvailable())
```

- [ ] **Step 2: Add the preload bridge.** In `src/preload/index.ts`, after the paired-dir entries, add:

```ts
  addBackend: (input) => ipcRenderer.invoke(IPC.backendAdd, input),
  updateBackend: (id, patch) => ipcRenderer.invoke(IPC.backendUpdate, id, patch),
  removeBackend: (id) => ipcRenderer.invoke(IPC.backendRemove, id),
  listBackends: () => ipcRenderer.invoke(IPC.backendList),
  setBackendToken: (id, token) => ipcRenderer.invoke(IPC.backendSetToken, id, token),
  backendEncryptionAvailable: () => ipcRenderer.invoke(IPC.backendEncryptionAvailable),
```

- [ ] **Step 3: Verify it compiles (plumbing has no unit test).**

Run: `npm run typecheck && npm run lint`
Expected: PASS — the new handlers, bridge, and `RendererApi` types line up (lint may report the 1 pre-existing HistoryView warning only).

- [ ] **Step 4: Commit.**

```bash
git add src/main/ipc.ts src/preload/index.ts
git commit -m "feat(backends): IPC + preload wiring"
```

---

### Task 8: Backends manager modal (`BackendsModal.tsx`)

**Files:**
- Create: `src/renderer/BackendsModal.tsx`
- Test: none (renderer has no component-test harness — verified via typecheck/lint/build + smoke)

**Interfaces:**
- Consumes: `window.api.listBackends/addBackend/updateBackend/removeBackend/setBackendToken/backendEncryptionAvailable` (Task 7); `BACKEND_PRESETS`, `parseModelIds` (Task 1); `useStore` `setGraph`; `Modal`.
- Produces: `<BackendsModal onClose={() => void} />` default export.

- [ ] **Step 1: Create the component.** Create `src/renderer/BackendsModal.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import Modal from './Modal'
import { useStore } from './store'
import { BACKEND_PRESETS, parseModelIds } from '../shared/model-backends'
import type { BackendView } from '../shared/types'

export default function BackendsModal({ onClose }: { onClose: () => void }) {
  const setGraph = useStore((s) => s.setGraph)
  const [list, setList] = useState<BackendView[]>([])
  const [encOk, setEncOk] = useState(true)

  // add/edit form
  const [editingId, setEditingId] = useState<string | null>(null)
  const [presetId, setPresetId] = useState('zai-glm')
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelsText, setModelsText] = useState('')
  const gateway = BACKEND_PRESETS.find((p) => p.presetId === presetId)?.gateway

  const refresh = async (): Promise<void> => setList(await window.api.listBackends())
  useEffect(() => {
    void refresh()
    void window.api.backendEncryptionAvailable().then(setEncOk)
  }, [])

  const applyPreset = (id: string): void => {
    setPresetId(id)
    const p = BACKEND_PRESETS.find((x) => x.presetId === id)
    if (!p) return
    setLabel(p.label === 'Custom' ? '' : p.label)
    setBaseUrl(p.baseUrl)
    setModelsText(p.models.map((m) => (m.label === m.id ? m.id : `${m.id}|${m.label}`)).join(', '))
  }

  const resetForm = (): void => {
    setEditingId(null); setPresetId('zai-glm'); setLabel(''); setBaseUrl(''); setModelsText('')
  }

  const save = async (): Promise<void> => {
    const models = parseModelIds(modelsText)
    if (editingId) {
      setGraph(await window.api.updateBackend(editingId, { label, baseUrl, models }))
    } else {
      setGraph(await window.api.addBackend({ label, baseUrl, models, presetId }))
    }
    resetForm()
    await refresh()
  }

  const startEdit = (b: BackendView): void => {
    setEditingId(b.id); setPresetId(b.presetId ?? 'custom'); setLabel(b.label); setBaseUrl(b.baseUrl)
    setModelsText(b.models.map((m) => (m.label === m.id ? m.id : `${m.id}|${m.label}`)).join(', '))
  }

  const remove = async (id: string): Promise<void> => {
    setGraph(await window.api.removeBackend(id))
    if (editingId === id) resetForm()
    await refresh()
  }

  return (
    <Modal title="Model backends" onClose={onClose}>
      <div className="backends">
        {!encOk && (
          <div className="setting-danger-callout">Secure storage is unavailable on this system — tokens can't be saved.</div>
        )}
        {list.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No backends yet. Add one below.</div>}
        {list.map((b) => (
          <BackendRow key={b.id} b={b} encOk={encOk} onEdit={() => startEdit(b)} onRemove={() => void remove(b.id)} onToken={refresh} />
        ))}

        <h4>{editingId ? 'Edit backend' : 'Add backend'}</h4>
        <div className="field">
          <label>Preset</label>
          <select value={presetId} onChange={(e) => applyPreset(e.target.value)} disabled={!!editingId}>
            {BACKEND_PRESETS.map((p) => (<option key={p.presetId} value={p.presetId}>{p.label}</option>))}
          </select>
        </div>
        {gateway && (
          <div className="muted" style={{ fontSize: 12 }}>
            Requires an Anthropic-compatible gateway in front of OpenAI — enter your gateway's base URL below.
          </div>
        )}
        <div className="field">
          <label>Label</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="z.ai (GLM)" />
        </div>
        <div className="field">
          <label>Base URL</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.z.ai/api/anthropic" />
        </div>
        <div className="field">
          <label>Models (comma or newline; `id` or `id|Label`)</label>
          <textarea value={modelsText} onChange={(e) => setModelsText(e.target.value)} rows={2} placeholder="glm-4.6, glm-4.5-air" />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={!label || !baseUrl} onClick={() => void save()}>{editingId ? 'Save' : 'Add backend'}</button>
          {editingId && <button className="btn" onClick={resetForm}>Cancel</button>}
        </div>
      </div>
    </Modal>
  )
}

function BackendRow({ b, encOk, onEdit, onRemove, onToken }: {
  b: BackendView; encOk: boolean; onEdit: () => void; onRemove: () => void; onToken: () => Promise<void>
}) {
  const notify = useStore((s) => s.notify)
  const [token, setToken] = useState('')
  const saveToken = async (): Promise<void> => {
    const r = await window.api.setBackendToken(b.id, token)
    if (!r.ok) notify({ kind: 'error', message: r.error ?? 'Could not save token.' })
    setToken('')
    await onToken()
  }
  return (
    <div className="backend-row">
      <div className="backend-head">
        <strong>{b.label}</strong> <span className="muted">{b.baseUrl}</span>
        <span className="spacer" />
        <button className="btn" onClick={onEdit}>Edit</button>
        <button className="backend-remove" aria-label="Remove backend" onClick={onRemove}><Trash2 size={13} /></button>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>{b.models.map((m) => m.label).join(', ') || 'no models'}</div>
      <div className="field token-field">
        <label>{b.hasToken ? 'Token configured — replace:' : 'Token:'}</label>
        <input type="password" value={token} disabled={!encOk} placeholder={b.hasToken ? '••••••••' : 'paste token'} onChange={(e) => setToken(e.target.value)} />
        <button className="btn" disabled={!encOk || !token} onClick={() => void saveToken()}>Save token</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add minimal styles.** In `src/renderer/styles.css`, near the other modal/section rules, add:

```css
.backends { display: flex; flex-direction: column; gap: var(--space-3); }
.backend-row { border: 1px solid var(--hairline); border-radius: var(--radius-sm); padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.backend-head { display: flex; align-items: center; gap: var(--space-3); }
.backend-remove { display: flex; align-items: center; padding: 3px; background: none; border: none; color: var(--fg-muted); border-radius: var(--radius-sm); }
.backend-remove:hover { color: var(--fg); background: var(--surface-hover); }
.token-field { display: flex; align-items: center; gap: 6px; }
```

(Grep `src/renderer/tokens.css` first; if any token name is absent, substitute the nearest existing one — do not invent a new visual language. Reuse the existing `.field`, `.muted`, `.btn`, `.setting-danger-callout`, `.spacer` classes as shown.)

- [ ] **Step 3: Verify build + types.**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/renderer/BackendsModal.tsx src/renderer/styles.css
git commit -m "feat(backends): backends manager modal"
```

---

### Task 9: Agent config — backend + backend-aware model picker

**Files:**
- Modify: `src/renderer/panels/AgentConfigPanel.tsx` (Backend dropdown; model options from the selected backend; "Manage backends…" opening `BackendsModal`)
- Test: none (renderer — verified via typecheck/lint/build + smoke)

**Interfaces:**
- Consumes: `graph.backends` (Task 1/3); `MODELS` (existing); `<BackendsModal />` (Task 8); `updateAgent` (existing).
- Produces: backend + model UI on the agent config panel.

- [ ] **Step 1: Implement.** In `src/renderer/panels/AgentConfigPanel.tsx`:

Add imports at the top:

```tsx
import { useState } from 'react'
import BackendsModal from '../BackendsModal'
```

(merge `useState` into the existing `react` import — the file already imports `useEffect, useState`; if `useState` is already imported, don't duplicate it.)

Inside the component, after the `const agent = ...; if (!agent) return null` guard, add:

```tsx
  const [showBackends, setShowBackends] = useState(false)
  const backends = graph?.backends ?? []
  const selectedBackend = backends.find((b) => b.id === agent.backendId)
  const modelOptions = selectedBackend ? selectedBackend.models : MODELS
  const validModel = (opts: { id: string }[], cur: string): string =>
    opts.some((o) => o.id === cur) ? cur : (opts[0]?.id ?? cur)
  const onBackendChange = (id: string): void => {
    const b = backends.find((x) => x.id === id)
    const opts = b ? b.models : MODELS
    void update({ backendId: id || undefined, model: validModel(opts, agent.model) })
  }
```

Replace the existing Model `<div className="field">` block with a Backend field followed by the backend-aware Model field:

```tsx
      <div className="field">
        <label>Backend</label>
        <select value={agent.backendId ?? ''} onChange={(e) => onBackendChange(e.target.value)}>
          <option value="">Claude (default)</option>
          {backends.map((b) => (<option key={b.id} value={b.id}>{b.label}</option>))}
        </select>
        <button className="linklike" onClick={() => setShowBackends(true)}>Manage backends…</button>
      </div>
      <div className="field">
        <label>Model</label>
        <select value={agent.model} onChange={(e) => update({ model: e.target.value })}>
          {modelOptions.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
        </select>
      </div>
```

At the end of the returned JSX, before the closing `</div>` of `.panel-section`, add the modal mount:

```tsx
      {showBackends && <BackendsModal onClose={() => setShowBackends(false)} />}
```

- [ ] **Step 2: Add the link style (if `.linklike` is absent).** Grep `src/renderer/styles.css` for `.linklike`; if missing, add:

```css
.linklike { background: none; border: none; color: var(--accent, var(--fg-muted)); font-size: var(--text-xs); padding: 4px 0 0; cursor: pointer; text-align: left; }
.linklike:hover { text-decoration: underline; }
```

(Substitute the nearest existing token for `--accent` if it isn't defined.)

- [ ] **Step 3: Verify build + types.**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/renderer/panels/AgentConfigPanel.tsx src/renderer/styles.css
git commit -m "feat(backends): per-agent backend + backend-aware model picker"
```

---

### Final: full suite + gates

- [ ] **Step 1: Run everything.**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green; test count = prior 549 + new (model-backends 3 describes, backend-secrets 5, project-store.backends 5, backend-resolve 4, agent-runner.backends 2, pty-manager +2).

- [ ] **Step 2: On-device smoke (manual).**
  - Agent config → **Manage backends…** → add the **z.ai (GLM)** preset (base URL prefilled), Save; set a token (paste anything) → "Token configured".
  - Assign the backend to a worker; the **Model** dropdown now lists the backend's models; run header shows `· glm-4.6 (z.ai)`.
  - With a **valid** GLM token + a real run, confirm the agent reaches the GLM endpoint; open that agent's interactive terminal and confirm it uses the backend too.
  - Assign a backend but clear its token → a run streams the clear "token is missing" error (no silent Claude fallback).
  - Remove the backend → referencing agents fall back to Claude (default), and the token file entry is gone.
  - Set every agent back to Claude (default) → runs/terminal have no `ANTHROPIC_BASE_URL` (byte-for-byte).
  - Confirm `<project>/.ai-manager/.gitignore` contains `backend-secrets.json`.

---

## Self-Review

**Spec coverage:**
- Built-in presets (GLM ready, ChatGPT-via-gateway, Custom) → Task 1 (`BACKEND_PRESETS`) + Task 8 (preset picker + gateway note). ✅
- `ProjectGraph.backends` (non-secret) + `AgentNodeData.backendId` + default-fill → Tasks 1, 3. ✅
- safeStorage token store, main-only, gitignore, never to renderer → Task 2 + `backendsView` hasToken (Task 3). ✅
- `resolveBackendEnv` tri-state → Task 4. ✅
- Runner: `options.env` present only when resolved; model = backend model (override ignored); error streams + throws → Task 5. ✅
- Interactive terminal env merge → Task 6. ✅
- IPC/preload/RendererApi (token setter write-only, `hasToken` only) → Tasks 1, 7. ✅
- UI: backend dropdown + backend-aware model + manager + run-header label → Tasks 5, 8, 9. ✅
- Interactions (cheap-model override neutralized at runner; effort caps pass through; autoAssign unaffected) → Task 5 (`applyBackendToRun` ignores override for env backends; `clampEffort` unchanged). ✅
- Byte-for-byte guarantee → explicit "none" tests in Tasks 4, 5, 6; plumbing via typecheck. ✅

**Placeholder scan:** none — every step has concrete code/commands. Model ids in presets are real example strings (user-editable), not placeholders.

**Type consistency:** `Backend`/`BackendModel`/`BackendView`, `BackendResolution`, `backendEnv`, `resolveBackendEnv`, `applyBackendToRun`, `mergeBackendEnv`, `backendsView`, and the `backend:*` IPC names are used identically across tasks. `RendererApi` method names match the preload keys and the `window.api` calls in the modal/panel.

**Deviation note:** the spec's cheap-model interaction is implemented at the single runner seam (`applyBackendToRun` ignores `modelOverride` for env backends) rather than at the 4 `nodes.ts` dispatch sites — same guarantee, DRY-er; the spec was updated to match. Renderer tasks (8, 9) ship without component tests, consistent with the codebase (no renderer harness).
