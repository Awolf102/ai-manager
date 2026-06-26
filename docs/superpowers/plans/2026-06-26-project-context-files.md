# Project Context Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user attach images/files to a project as persistent reference context (each with an optional note) that every agent reads and uses — via a top-bar Context manager and canvas drag-and-drop.

**Architecture:** Files are copied into `.ai-manager/context/` and recorded in `ProjectGraph.context`. A pure `shared/context-files.ts` builds a system-prompt section listing each file's project-relative path + note; `composeAppend` in `agent-runner.ts` injects it into EVERY agent's system prompt (one seam, no `nodes.ts` changes). Agents read the files on demand with their existing tools (the Read tool renders images). Approach A from the spec — no SDK multimodal plumbing.

**Tech Stack:** TypeScript, Electron 42 (main + preload + React renderer), Zustand store, vitest. No new dependencies.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-26-project-context-files-design.md`.
- **No new dependencies.** Use `node:fs`/`node:path`/`node:crypto` and Electron's built-in `dialog`/`webUtils`.
- **Storage:** copied files live in `.ai-manager/context/<fileName>` (hidden, alongside the app's other data). The project-relative path agents read is `.ai-manager/context/<fileName>`.
- **Thumbnail cap:** generate image data-URL thumbnails only for images **≤ 5,000,000 bytes**; otherwise the renderer shows a file icon.
- **Electron 42:** dropped-file absolute paths come from `webUtils.getPathForFile(file)` exposed through the preload — NOT the removed `File.path`.
- **Backward compatibility:** a project with no context (`graph.context` absent/empty) behaves byte-for-byte as today — `buildContextBlock([])` returns `''`, so no system-prompt section is added.
- **House testing precedent:** pure `shared/*` modules and `project-store` logic are unit-tested; the `agent-runner`/IPC/preload/renderer layers are verified by `npm run typecheck` + `npm run build` (not unit-tested).
- **Test runner:** `npx vitest run <file>` for one file; `npm test` for all; `npm run typecheck` + `npm run build` for the non-unit layers.
- **Commits:** every commit message ends with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Foundation — `ContextFile` type + pure `shared/context-files.ts`

The additive type, the `ProjectGraph.context` field, and the pure, fully-unit-tested core (path/note rendering, image detection, collision-safe naming). No behavior change anywhere else.

**Files:**
- Modify: `src/shared/types.ts` (add `ContextFile`; add `ProjectGraph.context?`)
- Create: `src/shared/context-files.ts`
- Create: `src/shared/context-files.test.ts`

**Interfaces:**
- Produces: `ContextFile { id: string; fileName: string; note: string; addedAt: string; bytes: number; isImage: boolean }`
- Produces: `ProjectGraph.context?: ContextFile[]`
- Produces: `isImageName(name: string): boolean`
- Produces: `uniqueContextName(existing: string[], original: string): string`
- Produces: `buildContextBlock(context: ContextFile[]): string`

- [ ] **Step 1: Add the `ContextFile` type and the `ProjectGraph.context` field (`src/shared/types.ts`)**

Add the `ContextFile` interface immediately **above** `export interface ProjectGraph {`:

```ts
/** A user-attached reference file (image/doc) for the project, available to every agent. */
export interface ContextFile {
  id: string // randomUUID — React key + update/remove handle
  fileName: string // name AS STORED under .ai-manager/context/ (collision-uniquified)
  note: string // optional user note ('' when none)
  addedAt: string // ISO timestamp
  bytes: number // file size, for display
  isImage: boolean // precomputed from the extension
}
```

Then add the field to `ProjectGraph` (right after `linkedTeam?...`):

```ts
  /** the team brain this project syncs portable lessons with (B2 living team) */
  linkedTeam?: { teamId: string; path: string }
  /** user-attached reference files (images/docs) for this project, given to every agent */
  context?: ContextFile[]
```

- [ ] **Step 2: Write the failing tests (`src/shared/context-files.test.ts`)**

```ts
import { describe, it, expect } from 'vitest'
import { isImageName, uniqueContextName, buildContextBlock } from './context-files'
import type { ContextFile } from './types'

const mk = (over: Partial<ContextFile>): ContextFile => ({
  id: 'i',
  fileName: 'f.txt',
  note: '',
  addedAt: 'S',
  bytes: 0,
  isImage: false,
  ...over
})

describe('isImageName', () => {
  it('recognizes common image extensions, case-insensitively', () => {
    expect(isImageName('shot.PNG')).toBe(true)
    expect(isImageName('a.jpeg')).toBe(true)
    expect(isImageName('diagram.svg')).toBe(true)
  })
  it('is false for non-images and extensionless names', () => {
    expect(isImageName('spec.md')).toBe(false)
    expect(isImageName('notes.txt')).toBe(false)
    expect(isImageName('README')).toBe(false)
  })
})

describe('uniqueContextName', () => {
  it('returns the name unchanged when free', () => {
    expect(uniqueContextName([], 'a.png')).toBe('a.png')
    expect(uniqueContextName(['b.png'], 'a.png')).toBe('a.png')
  })
  it('suffixes -2, -3 before the extension on collision', () => {
    expect(uniqueContextName(['a.png'], 'a.png')).toBe('a-2.png')
    expect(uniqueContextName(['a.png', 'a-2.png'], 'a.png')).toBe('a-3.png')
  })
  it('handles names with no extension', () => {
    expect(uniqueContextName(['LICENSE'], 'LICENSE')).toBe('LICENSE-2')
  })
})

describe('buildContextBlock', () => {
  it('returns empty string when there is no context', () => {
    expect(buildContextBlock([])).toBe('')
  })
  it('lists each file as a project-relative path with the heading + read instruction', () => {
    const out = buildContextBlock([mk({ fileName: 'spec.md', note: 'the API' })])
    expect(out).toContain('## Reference context the user provided')
    expect(out).toContain('Read the relevant ones')
    expect(out).toContain('- .ai-manager/context/spec.md — the API')
  })
  it('tags images and omits the note separator when the note is empty', () => {
    const out = buildContextBlock([mk({ fileName: 'm.png', isImage: true, note: '' })])
    const bullet = out.split('\n').find((l) => l.startsWith('- '))!
    expect(bullet).toBe('- .ai-manager/context/m.png (image)')
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/shared/context-files.test.ts`
Expected: FAIL — `./context-files` cannot be resolved / functions not exported.

- [ ] **Step 4: Implement the pure module (`src/shared/context-files.ts`)**

```ts
// Pure helpers for project context files (no node/DOM imports — unit-tested in plain Node,
// used by the main process and the agent runner). The .ai-manager/context/ path is the
// documented location agents read; it mirrors AIM_DIR in project-store.ts.
import type { ContextFile } from './types'

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic']

/** True when the file name's extension is a known image type. */
export function isImageName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return false
  return IMAGE_EXT.includes(name.slice(dot + 1).toLowerCase())
}

/** A name not already in `existing`, suffixing "-2", "-3", … before the extension on collision. */
export function uniqueContextName(existing: string[], original: string): string {
  const taken = new Set(existing)
  if (!taken.has(original)) return original
  const dot = original.lastIndexOf('.')
  const stem = dot === -1 ? original : original.slice(0, dot)
  const ext = dot === -1 ? '' : original.slice(dot)
  let i = 2
  while (taken.has(`${stem}-${i}${ext}`)) i++
  return `${stem}-${i}${ext}`
}

/** The system-prompt section listing the user's reference files, or '' when there are none. */
export function buildContextBlock(context: ContextFile[]): string {
  if (!context || context.length === 0) return ''
  const lines = context.map((c) => {
    const tag = c.isImage ? ' (image)' : ''
    const note = c.note.trim() ? ` — ${c.note.trim()}` : ''
    return `- .ai-manager/context/${c.fileName}${tag}${note}`
  })
  return [
    '## Reference context the user provided',
    'The user attached these reference files for this project. Read the relevant ones before you plan, build, or review (the Read tool shows images). Treat them as authoritative context for the goal.',
    ...lines
  ].join('\n')
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/shared/context-files.test.ts`
Expected: PASS (all in this file).

- [ ] **Step 6: Typecheck + full suite + commit**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full suite green (existing + the new context-files tests; the type/field additions are additive and unused elsewhere so far).
```bash
git add src/shared/types.ts src/shared/context-files.ts src/shared/context-files.test.ts
git commit -m "feat(context): ContextFile type + pure context-files module"
```

---

### Task 2: project-store — context CRUD + thumbnails + `buildAgentContext`

The fs-backed store operations and the `buildAgentContext` extension that carries context to the runner. Unit-tested via the file's existing temp-project pattern.

**Files:**
- Modify: `src/main/engine/project-store.ts`
- Modify: `src/main/engine/project-store.test.ts`

**Interfaces:**
- Consumes: `isImageName`, `uniqueContextName` (Task 1); `ContextFile` (Task 1).
- Produces: `getContextFiles(): ContextFile[]`
- Produces: `getGraph(): ProjectGraph`
- Produces: `addContextFiles(sourcePaths: string[]): Promise<ProjectGraph>`
- Produces: `updateContextFile(id: string, patch: { note?: string }): Promise<ProjectGraph>`
- Produces: `removeContextFile(id: string): Promise<ProjectGraph>`
- Produces: `contextThumbnail(id: string): Promise<string | null>`
- Produces: `buildAgentContext` now additionally returns `context: ContextFile[]`

- [ ] **Step 1: Add imports + the `CONTEXT_DIR` constant (`src/main/engine/project-store.ts`)**

In the `import type { … } from '../../shared/types'` block, add `ContextFile`:

```ts
import type {
  AgentKind,
  AgentNodeData,
  ContextFile,
  CreateAgentInput,
  GraphEdge,
  ProjectGraph,
  ProjectMeta,
  ProjectSettings,
  RunRecord,
  RunSummary,
  SpawnedMember
} from '../../shared/types'
```

Add a new import below the `slug` import:

```ts
import { slugify, uniqueSlug } from '../../shared/slug'
import { isImageName, uniqueContextName } from '../../shared/context-files'
```

Add the directory constant next to the others (after `const AGENTS_DIR = 'agents'`):

```ts
const AGENTS_DIR = 'agents'
const CONTEXT_DIR = 'context'
```

- [ ] **Step 2: Default `context` on open + add a `getGraph` accessor (`src/main/engine/project-store.ts`)**

In `openProject`, right after the settings-defaults line, default the field:

```ts
  // apply settings defaults for graphs created before this field existed
  graph.settings = { ...DEFAULT_SETTINGS, ...(graph.settings ?? {}) }
  graph.context = graph.context ?? []
  current = { path: projectPath, graph }
```

Add a `getGraph` accessor right below `getCurrentProjectPath` (≈ line 45):

```ts
export function getGraph(): ProjectGraph {
  return requireCurrent().graph
}
```

- [ ] **Step 3: Write the failing tests (`src/main/engine/project-store.test.ts`)**

Add `getContextFiles, addContextFiles, updateContextFile, removeContextFile, contextThumbnail` to the existing import block from `./project-store`. Then add this describe block at the end of the file. It writes real temp source files and copies them in.

```ts
describe('context files', () => {
  it('copies a file into .ai-manager/context, records it, and uniquifies a name collision', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    // two sources with the SAME basename in different dirs
    const srcDirA = join(tmpdir(), `ctx-a-${Math.random().toString(36).slice(2)}`)
    const srcDirB = join(tmpdir(), `ctx-b-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(srcDirA, { recursive: true })
    await fs.mkdir(srcDirB, { recursive: true })
    await fs.writeFile(join(srcDirA, 'mockup.png'), 'AAAA', 'utf8')
    await fs.writeFile(join(srcDirB, 'mockup.png'), 'BBBB', 'utf8')

    await addContextFiles([join(srcDirA, 'mockup.png')])
    const graph = await addContextFiles([join(srcDirB, 'mockup.png')])

    expect(graph.context).toHaveLength(2)
    const names = graph.context!.map((c) => c.fileName).sort()
    expect(names).toEqual(['mockup-2.png', 'mockup.png'])
    expect(graph.context!.every((c) => c.isImage)).toBe(true)
    // both copies exist on disk under .ai-manager/context/
    expect(await fs.readFile(join(proj, '.ai-manager', 'context', 'mockup.png'), 'utf8')).toBe('AAAA')
    expect(await fs.readFile(join(proj, '.ai-manager', 'context', 'mockup-2.png'), 'utf8')).toBe('BBBB')
  })

  it('updates a note and removes a file (deleting the copy)', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    const srcDir = join(tmpdir(), `ctx-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(srcDir, { recursive: true })
    await fs.writeFile(join(srcDir, 'spec.md'), '# spec', 'utf8')

    const added = await addContextFiles([join(srcDir, 'spec.md')])
    const id = added.context![0].id

    const noted = await updateContextFile(id, { note: 'the API the backend must follow' })
    expect(noted.context![0].note).toBe('the API the backend must follow')

    const removed = await removeContextFile(id)
    expect(removed.context).toHaveLength(0)
    await expect(fs.readFile(join(proj, '.ai-manager', 'context', 'spec.md'), 'utf8')).rejects.toThrow()
  })

  it('returns a data-URL thumbnail for an image, null for a non-image', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    const srcDir = join(tmpdir(), `ctx-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(srcDir, { recursive: true })
    await fs.writeFile(join(srcDir, 'pic.png'), 'PNGDATA', 'utf8')
    await fs.writeFile(join(srcDir, 'notes.txt'), 'text', 'utf8')

    const g = await addContextFiles([join(srcDir, 'pic.png'), join(srcDir, 'notes.txt')])
    const pic = g.context!.find((c) => c.fileName === 'pic.png')!
    const txt = g.context!.find((c) => c.fileName === 'notes.txt')!

    const thumb = await contextThumbnail(pic.id)
    expect(thumb?.startsWith('data:image/png;base64,')).toBe(true)
    expect(await contextThumbnail(txt.id)).toBeNull()
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/main/engine/project-store.test.ts`
Expected: FAIL — `addContextFiles`/`updateContextFile`/`removeContextFile`/`contextThumbnail` not exported.

- [ ] **Step 5: Implement the context functions (`src/main/engine/project-store.ts`)**

Add this section just **above** `// ---------- orchestration helpers ----------` (after `buildAgentContext`, ≈ line 300):

```ts
// ---------- context files ----------

/** The user's attached reference files for this project. */
export function getContextFiles(): ContextFile[] {
  return requireCurrent().graph.context ?? []
}

/** Copy each source path into .ai-manager/context/ and record it (note ''). Unreadable paths are skipped. */
export async function addContextFiles(sourcePaths: string[]): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const dir = aimPath(path, CONTEXT_DIR)
  await fs.mkdir(dir, { recursive: true })
  graph.context = graph.context ?? []
  for (const src of sourcePaths) {
    try {
      const stat = await fs.stat(src)
      if (!stat.isFile()) continue
      const fileName = uniqueContextName(graph.context.map((c) => c.fileName), basename(src))
      await fs.copyFile(src, join(dir, fileName))
      graph.context.push({
        id: randomUUID(),
        fileName,
        note: '',
        addedAt: new Date().toISOString(),
        bytes: stat.size,
        isImage: isImageName(fileName)
      })
    } catch {
      // skip unreadable / missing source; the rest still add
    }
  }
  return saveGraph()
}

/** Edit an attached file's note. */
export async function updateContextFile(id: string, patch: { note?: string }): Promise<ProjectGraph> {
  const { graph } = requireCurrent()
  const entry = (graph.context ?? []).find((c) => c.id === id)
  if (entry && patch.note !== undefined) entry.note = patch.note
  return saveGraph()
}

/** Remove an attached file: delete the copy (tolerate a missing file) and drop the entry. */
export async function removeContextFile(id: string): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const entry = (graph.context ?? []).find((c) => c.id === id)
  if (entry) {
    await fs.rm(aimPath(path, CONTEXT_DIR, entry.fileName), { force: true })
    graph.context = (graph.context ?? []).filter((c) => c.id !== id)
  }
  return saveGraph()
}

/** A base64 data-URL thumbnail for an image entry under the size cap, else null. */
export async function contextThumbnail(id: string): Promise<string | null> {
  const { path, graph } = requireCurrent()
  const entry = (graph.context ?? []).find((c) => c.id === id)
  if (!entry || !entry.isImage || entry.bytes > 5_000_000) return null
  try {
    const buf = await fs.readFile(aimPath(path, CONTEXT_DIR, entry.fileName))
    const ext = entry.fileName.slice(entry.fileName.lastIndexOf('.') + 1).toLowerCase()
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
```

- [ ] **Step 6: Extend `buildAgentContext` to carry context (`src/main/engine/project-store.ts`)**

Replace the `buildAgentContext` function with:

```ts
/** Read everything the runner/PTY need to launch an agent. */
export async function buildAgentContext(agentId: string): Promise<{
  agent: AgentNodeData
  projectPath: string
  role: string
  memory: string
  context: ContextFile[]
}> {
  const agent = getAgent(agentId)
  const [role, memory] = await Promise.all([readRole(agentId), readMemory(agentId)])
  return { agent, projectPath: getCurrentProjectPath(), role, memory, context: getContextFiles() }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/main/engine/project-store.test.ts`
Expected: PASS — the three new context tests pass; existing project-store tests unchanged.

- [ ] **Step 8: Typecheck + full suite + commit**

Run: `npm run typecheck && npm test`
Expected: all green.
```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "feat(context): project-store add/update/remove/thumbnail + buildAgentContext carries context"
```

---

### Task 3: Inject context into every agent's system prompt (`agent-runner.ts`)

Wire `buildContextBlock` into `composeAppend` so all agents (orchestration, manual headless, interactive) get the context section. The only engine change. No `nodes.ts` edits.

**Files:**
- Modify: `src/main/engine/agent-runner.ts`

**Interfaces:**
- Consumes: `buildContextBlock` (Task 1); `ContextFile` (Task 1); `buildAgentContext` now returning `context` (Task 2).

- [ ] **Step 1: Import the block builder + the type (`src/main/engine/agent-runner.ts`)**

Below the existing `skillOptionsFor` import, add:

```ts
import { skillOptionsFor } from '../../shared/skill-catalog'
import { buildContextBlock } from '../../shared/context-files'
import { buildAgentContext, updateAgent } from './project-store'
```

In the type-only import from `'../../shared/types'`, add `ContextFile`:

```ts
import type { AgentStreamEvent, ContextFile, Effort, PermissionMode, RunHeadlessInput } from '../../shared/types'
```

- [ ] **Step 2: Append the context block in `composeAppend`**

Replace `composeAppend` with:

```ts
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
```

- [ ] **Step 3: Pass context from `buildAgentContext` into `composeAppend`**

In `streamAgent`, change the destructure to include `context`:

```ts
  const { agent, projectPath, role, memory, context } = await buildAgentContext(agentId)
```

And update the `systemPrompt` line in the `options` object:

```ts
      systemPrompt: { type: 'preset', preset: 'claude_code', append: composeAppend(role, memory, context) },
```

- [ ] **Step 4: Typecheck + build + full suite + commit**

Run: `npm run typecheck && npm run build && npm test`
Expected: all green. (`agent-runner` is not unit-tested per house precedent; `buildContextBlock` is covered by Task 1. A project with no context yields `composeAppend` identical to today because `buildContextBlock([]) === ''`.)
```bash
git add src/main/engine/agent-runner.ts
git commit -m "feat(context): inject project context block into every agent's system prompt"
```

---

### Task 4: IPC + preload + typed API

Expose `context:add/update/remove/thumbnail` and the `getPathForFile` bridge so the renderer can manage context. `context:add` opens a multi-select dialog when given no paths (button) or uses given paths (drag-drop).

**Files:**
- Modify: `src/shared/types.ts` (IPC channel constants + `RendererApi`)
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc.ts`

**Interfaces:**
- Consumes: `store.addContextFiles`/`updateContextFile`/`removeContextFile`/`contextThumbnail`/`getGraph` (Task 2).
- Produces (on `RendererApi`): `addContext(paths?: string[]) => Promise<ProjectGraph>`, `updateContext(id, note) => Promise<ProjectGraph>`, `removeContext(id) => Promise<ProjectGraph>`, `contextThumbnail(id) => Promise<string | null>`, `getPathForFile(file: File) => string`.

- [ ] **Step 1: Add the IPC channel constants (`src/shared/types.ts`)**

In the `IPC` const map, after `openPath: 'app:openPath',`, add:

```ts
  openPath: 'app:openPath',
  addContext: 'context:add',
  updateContext: 'context:update',
  removeContext: 'context:remove',
  contextThumbnail: 'context:thumbnail',
```

- [ ] **Step 2: Add the methods to `RendererApi` (`src/shared/types.ts`)**

Inside `export interface RendererApi { … }`, after `openProjectPath: () => void`, add:

```ts
  openProjectPath: () => void
  addContext: (paths?: string[]) => Promise<ProjectGraph>
  updateContext: (id: string, note: string) => Promise<ProjectGraph>
  removeContext: (id: string) => Promise<ProjectGraph>
  contextThumbnail: (id: string) => Promise<string | null>
  getPathForFile: (file: File) => string
```

- [ ] **Step 3: Expose them in the preload (`src/preload/index.ts`)**

Add `webUtils` to the electron import:

```ts
import { contextBridge, ipcRenderer, webUtils } from 'electron'
```

In the `api` object, after `openProjectPath: () => ipcRenderer.send(IPC.openPath),`, add:

```ts
  openProjectPath: () => ipcRenderer.send(IPC.openPath),
  addContext: (paths) => ipcRenderer.invoke(IPC.addContext, paths),
  updateContext: (id, note) => ipcRenderer.invoke(IPC.updateContext, id, note),
  removeContext: (id) => ipcRenderer.invoke(IPC.removeContext, id),
  contextThumbnail: (id) => ipcRenderer.invoke(IPC.contextThumbnail, id),
  getPathForFile: (file) => webUtils.getPathForFile(file),
```

- [ ] **Step 4: Add the main-process handlers (`src/main/ipc.ts`)**

After the `// ---- run result (launch the built app) ----` block (i.e. after the `ipcMain.on(IPC.openPath, …)` handler at the end of `registerIpc`), add:

```ts
  // ---- project context files ----
  ipcMain.handle(IPC.addContext, async (_e, paths?: string[]) => {
    let sources = paths
    if (!sources || sources.length === 0) {
      const r = await dialog.showOpenDialog({
        title: 'Add context files',
        properties: ['openFile', 'multiSelections']
      })
      if (r.canceled || r.filePaths.length === 0) return store.getGraph()
      sources = r.filePaths
    }
    return store.addContextFiles(sources)
  })
  ipcMain.handle(IPC.updateContext, (_e, id: string, note: string) =>
    store.updateContextFile(id, { note })
  )
  ipcMain.handle(IPC.removeContext, (_e, id: string) => store.removeContextFile(id))
  ipcMain.handle(IPC.contextThumbnail, (_e, id: string) => store.contextThumbnail(id))
```

- [ ] **Step 5: Typecheck + build + commit**

Run: `npm run typecheck && npm run build`
Expected: clean. (`store.getGraph` returns the unchanged graph when the dialog is canceled, so the renderer always receives a `ProjectGraph`.)
```bash
git add src/shared/types.ts src/preload/index.ts src/main/ipc.ts
git commit -m "feat(context): IPC + preload for add/update/remove/thumbnail + getPathForFile"
```

---

### Task 5: Renderer — Context modal, top-bar button, canvas drag-and-drop

The user-facing surface: a Context manager modal (list, thumbnails, editable notes, add/remove), a top-bar Context button with a count badge, and window-wide drag-and-drop with an overlay.

**Files:**
- Create: `src/renderer/ContextModal.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: `window.api.addContext`/`updateContext`/`removeContext`/`contextThumbnail`/`getPathForFile` (Task 4); `useStore` `graph`/`setGraph`; `ContextFile` (Task 1).

- [ ] **Step 1: Create the Context modal (`src/renderer/ContextModal.tsx`)**

```tsx
import { useEffect, useState } from 'react'
import { FileText, Image as ImageIcon, Plus, X } from 'lucide-react'
import { useStore } from './store'
import type { ContextFile } from '../shared/types'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function Thumb({ file }: { file: ContextFile }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (file.isImage) {
      void window.api.contextThumbnail(file.id).then((u) => {
        if (alive) setUrl(u)
      })
    }
    return () => {
      alive = false
    }
  }, [file.id, file.isImage])
  if (file.isImage && url) return <img className="ctx-thumb" src={url} alt={file.fileName} />
  return (
    <span className="ctx-thumb ctx-thumb-icon">
      {file.isImage ? <ImageIcon size={18} /> : <FileText size={18} />}
    </span>
  )
}

export default function ContextModal({ onClose }: { onClose: () => void }) {
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)
  const files = graph?.context ?? []

  const add = async (): Promise<void> => {
    setGraph(await window.api.addContext())
  }
  const remove = async (id: string): Promise<void> => {
    setGraph(await window.api.removeContext(id))
  }
  const setNote = async (id: string, note: string): Promise<void> => {
    setGraph(await window.api.updateContext(id, note))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal ctx-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Project context</h2>
        <p className="ctx-hint">
          Files and images here are given to every agent as reference context for this project. Add a
          note to say what each one is for.
        </p>
        <div className="ctx-list">
          {files.length === 0 && (
            <div className="empty-hint">
              No context files yet. Add images or files, or drag them onto the canvas.
            </div>
          )}
          {files.map((f) => (
            <div className="ctx-row" key={f.id}>
              <Thumb file={f} />
              <div className="ctx-meta">
                <div className="ctx-name">
                  {f.fileName} <span className="ctx-size">{fmtBytes(f.bytes)}</span>
                </div>
                <input
                  className="ctx-note"
                  defaultValue={f.note}
                  placeholder="note — what is this / how to use it (optional)"
                  onBlur={(e) => {
                    if (e.target.value !== f.note) void setNote(f.id, e.target.value)
                  }}
                />
              </div>
              <button className="close" title="Remove" onClick={() => void remove(f.id)}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => void add()}>
            <Plus size={14} /> Add files
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire the top-bar button + state + modal into `App.tsx`**

Add `Paperclip` to the lucide import on line 2:

```tsx
import { Clock, CloudDownload, CloudUpload, Download, FolderOpen, Paperclip, Plus, Settings as SettingsIcon, Upload, Users } from 'lucide-react'
```

Import the modal (after the `SettingsModal` import, ≈ line 11):

```tsx
import SettingsModal from './SettingsModal'
import ContextModal from './ContextModal'
```

Add state next to `showSettings` (≈ line 28):

```tsx
  const [showSettings, setShowSettings] = useState(false)
  const [showContext, setShowContext] = useState(false)
  const [dragDepth, setDragDepth] = useState(0)
```

Add the Context button immediately **before** the Settings button (the `<button … title="Settings" …>`):

```tsx
        <button
          className="btn ctx-btn"
          title="Project context — files & images for the team"
          onClick={() => setShowContext(true)}
        >
          <Paperclip size={14} />
          {(graph.context?.length ?? 0) > 0 && <span className="ctx-badge">{graph.context!.length}</span>}
        </button>
```

Render the modal next to the others (where `{showSettings && …}` is, ≈ line 225):

```tsx
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showContext && <ContextModal onClose={() => setShowContext(false)} />}
```

- [ ] **Step 3: Add window-wide drag-and-drop + overlay (`App.tsx`)**

Define the handlers just above the `return (` of the main (graph-open) render — after `const showDock = …`:

```tsx
  const showDock = terminals.length > 0 || showRunView || showHistory

  const hasFiles = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')
  const onDragEnter = (e: React.DragEvent): void => {
    if (hasFiles(e)) {
      e.preventDefault()
      setDragDepth((d) => d + 1)
    }
  }
  const onDragOver = (e: React.DragEvent): void => {
    if (hasFiles(e)) e.preventDefault()
  }
  const onDragLeave = (): void => setDragDepth((d) => Math.max(0, d - 1))
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragDepth(0)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.getPathForFile(f))
      .filter((p) => p) // drop non-file items (text/url) whose path is ''
    if (paths.length === 0) return
    setGraph(await window.api.addContext(paths))
  }
```

Attach them to the root `<div className="app">` and add the overlay as its first child:

```tsx
    <div
      className="app"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e)}
    >
      {dragDepth > 0 && <div className="ctx-drop-overlay">Drop files to add as project context</div>}
      <div className="topbar">
```

(`setGraph` is already pulled from the store at the top of `App`. `React` types are available — the file already uses React; if a `React` namespace import is needed for `React.DragEvent`, add `import type React from 'react'` at the top.)

- [ ] **Step 4: Add the styles (`src/renderer/styles.css`)**

Append at the end of the file:

```css
/* ---- project context ---- */
.ctx-btn {
  position: relative;
}
.ctx-badge {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent);
  color: #0b0c10;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}
.ctx-modal {
  width: 560px;
  max-width: 92vw;
}
.ctx-hint {
  color: var(--muted);
  font-size: 12px;
  margin: 4px 0 12px;
}
.ctx-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 50vh;
  overflow-y: auto;
}
.ctx-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
}
.ctx-thumb {
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  border-radius: 6px;
  object-fit: cover;
  background: var(--bg);
}
.ctx-thumb-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  border: 1px solid var(--border);
}
.ctx-meta {
  flex: 1 1 auto;
  min-width: 0;
}
.ctx-name {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ctx-size {
  color: var(--muted);
  font-weight: 400;
  margin-left: 6px;
}
.ctx-note {
  width: 100%;
  margin-top: 4px;
  padding: 4px 6px;
  font-size: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
}
.ctx-note:focus {
  border-color: var(--accent);
  outline: none;
}
.ctx-drop-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  background: rgba(110, 168, 254, 0.12);
  border: 3px dashed var(--accent);
  color: var(--text);
  font-size: 18px;
  font-weight: 600;
}
```

- [ ] **Step 5: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean — the renderer compiles and bundles.

- [ ] **Step 6: Full suite + commit**

Run: `npm test`
Expected: all green (unchanged — renderer has no unit tests).
```bash
git add src/renderer/ContextModal.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(context): Context manager modal + top-bar button + canvas drag-and-drop"
```

---

## Self-Review

**Spec coverage:**
- Project-level persistent context attached to the project → `ProjectGraph.context` (Task 1) + store CRUD (Task 2). ✓
- Optional per-file note passed to agents → `ContextFile.note`, editable in the modal (Task 5), rendered in `buildContextBlock` (Task 1), injected via `composeAppend` (Task 3). ✓
- Two add paths: top-bar button (dialog) + canvas drag-drop → Task 5 (button → `addContext()`; drop → `getPathForFile` → `addContext(paths)`); dual-mode `context:add` (Task 4). ✓
- Agents consume via existing tools, no SDK multimodal → `buildContextBlock` lists project-relative paths; `composeAppend` injection only (Task 3); no `nodes.ts`/SDK changes. ✓
- Files copied into `.ai-manager/context/` (hidden) → `CONTEXT_DIR` + `addContextFiles` (Task 2). ✓
- Thumbnails via data-URL, ≤ 5 MB, `webSecurity`-safe → `contextThumbnail` (Task 2), `Thumb` component (Task 5). ✓
- Electron 42 `webUtils.getPathForFile` → preload bridge (Task 4) used by the drop handler (Task 5). ✓
- Backward compatible (no context = today) → `buildContextBlock([]) === ''` (Task 1) + `composeAppend` conditional (Task 3); regression covered by the existing nodes/agent tests staying green. ✓
- Error handling: skip unreadable sources, tolerate missing file on remove, thumbnail fallback → Task 2 functions + Task 5 `Thumb`. ✓
- Testing: pure unit (`context-files.test.ts`), store fs round-trip (`project-store.test.ts`), typecheck+build for IPC/preload/renderer/agent-runner → Tasks 1–5. ✓
- Non-goals (multimodal, per-run/per-agent scope, team-bundle carry) → not implemented. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands.

**Type consistency:** `ContextFile` shape (Task 1) is used identically in `project-store` (Task 2), `agent-runner` (Task 3), and `ContextModal` (Task 5). `addContextFiles(string[])`/`updateContextFile(id,{note})`/`removeContextFile(id)`/`contextThumbnail(id)`/`getGraph()` signatures (Task 2) match the IPC handlers (Task 4) and the `RendererApi`/preload methods (`addContext(paths?)`/`updateContext(id,note)`/`removeContext(id)`/`contextThumbnail(id)`/`getPathForFile(file)`) and their renderer callers (Task 5). `buildContextBlock(ContextFile[])` (Task 1) is consumed by `composeAppend` (Task 3). `buildAgentContext` returning `context` (Task 2) is destructured in `streamAgent` (Task 3). ✓
