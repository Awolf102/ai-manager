# Env-var Editor (no AI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A top-bar button opens a modal to view/edit the project-root `.env` directly (no agent), with plain-English labels, masked values, and comment-preserving edits.

**Architecture:** A pure `shared/env-file.ts` (parse for display, comment-preserving reconcile for write, plain-English labels) does all the logic; `main/engine/env-store.ts` wraps it over `<projectPath>/.env` + `atomicWrite`; two IPC channels (mirroring `readRole`/`writeRole`) expose it; a renderer `EnvModal` + top-bar key button is the UI. Zero engine/agent involvement.

**Tech Stack:** TypeScript, Electron (electron-vite), React 19, Vitest.

## Global Constraints

- **No AI / no engine change.** Reading/writing `.env` is pure fs + UI; nothing runs during an agent run. Do NOT touch the orchestration engine, agent-runner, or run paths.
- **Comment/format-preserving writes:** `applyEnvEdits` keeps every non-KV line (comment/blank) and the position of retained keys; deleted keys drop their line; new keys append at the end. `writeEnvFile` re-reads the current file at write time.
- **v1 = the single project-root `.env`** (`join(getCurrentProjectPath(), '.env')`), created on first Save; missing file reads as `[]`.
- **Exact shapes:** `interface EnvEntry { key: string; value: string }`; `parseEnvEntries(text): EnvEntry[]`; `applyEnvEdits(existingText: string, desired: EnvEntry[]): string`; `labelFor(key: string): string`; IPC channels `readEnv: 'env:read'`, `writeEnv: 'env:write'`; `RendererApi.readEnv(): Promise<EnvEntry[]>`, `RendererApi.writeEnv(entries: EnvEntry[]): Promise<void>`.
- **On-brand:** reuse `Modal`, `.btn`, existing field styles, tokens; lucide `KeyRound` icon; no new colors/CSS.
- **Gates:** implementers run `npm run typecheck` + `npm run test`; controller runs `npm run build` + `npm run lint` at integration; user runs the on-device smoke.
- **Commit trailer:** end commits with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Branch: `feat/env-editor`.

---

### Task 1: Pure module `shared/env-file.ts`

**Files:**
- Create: `src/shared/env-file.ts`
- Test: `src/shared/env-file.test.ts`

**Interfaces:**
- Produces: `interface EnvEntry { key: string; value: string }`; `parseEnvEntries(text)`; `applyEnvEdits(existingText, desired)`; `labelFor(key)`.

- [ ] **Step 1: Write the failing test**

Create `src/shared/env-file.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseEnvEntries, applyEnvEdits, labelFor } from './env-file'

describe('parseEnvEntries', () => {
  it('parses KEY=value, export, quoted, and empty; ignores comments/blanks', () => {
    const text = '# a comment\nPORT=3000\nexport NODE_ENV=production\nQUOTED="hello world"\nSINGLE=\'x y\'\nEMPTY=\n\n'
    expect(parseEnvEntries(text)).toEqual([
      { key: 'PORT', value: '3000' },
      { key: 'NODE_ENV', value: 'production' },
      { key: 'QUOTED', value: 'hello world' },
      { key: 'SINGLE', value: 'x y' },
      { key: 'EMPTY', value: '' }
    ])
  })
  it('dedups keeping the last value, first position', () => {
    expect(parseEnvEntries('A=1\nB=2\nA=9')).toEqual([{ key: 'A', value: '9' }, { key: 'B', value: '2' }])
  })
})

describe('applyEnvEdits', () => {
  it('edits a value in place and preserves comments + position', () => {
    const existing = '# db\nDATABASE_URL=old\nPORT=3000'
    const out = applyEnvEdits(existing, [{ key: 'DATABASE_URL', value: 'new' }, { key: 'PORT', value: '3000' }])
    expect(out).toBe('# db\nDATABASE_URL=new\nPORT=3000\n')
  })
  it('drops a deleted key but keeps comments', () => {
    const out = applyEnvEdits('# keep\nA=1\nB=2', [{ key: 'A', value: '1' }])
    expect(out).toBe('# keep\nA=1\n')
  })
  it('appends new keys at the end', () => {
    const out = applyEnvEdits('A=1', [{ key: 'A', value: '1' }, { key: 'NEW', value: '2' }])
    expect(out).toBe('A=1\nNEW=2\n')
  })
  it('writes a fresh file with no leading blank line', () => {
    expect(applyEnvEdits('', [{ key: 'A', value: '1' }])).toBe('A=1\n')
  })
  it('quotes values that need it', () => {
    expect(applyEnvEdits('', [{ key: 'A', value: 'has space' }])).toBe('A="has space"\n')
    expect(applyEnvEdits('', [{ key: 'A', value: 'a"b' }])).toBe('A="a\\"b"\n')
  })
})

describe('labelFor', () => {
  it('uses the curated map', () => {
    expect(labelFor('ANTHROPIC_API_KEY')).toBe('Anthropic API key')
    expect(labelFor('DATABASE_URL')).toBe('Database URL')
  })
  it('humanizes unknown keys with acronym casing', () => {
    expect(labelFor('MY_TOKEN')).toBe('My token')
    expect(labelFor('CUSTOM_API_URL')).toBe('Custom API URL')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/env-file.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the module**

Create `src/shared/env-file.ts`:

```ts
// Pure .env parsing/serialization + plain-English labels. No node/DOM imports —
// unit-tested in plain Node. Used by the AI-free env editor (Phase-3 #13).

export interface EnvEntry {
  key: string
  value: string
}

const KV = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

function unquote(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    const inner = v.slice(1, -1)
    return v[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n') : inner
  }
  return v
}

/** Parse a single line into a KV entry, or null for comments/blank/non-KV lines. */
function parseKvLine(line: string): EnvEntry | null {
  if (/^\s*#/.test(line) || /^\s*$/.test(line)) return null
  const m = KV.exec(line)
  if (!m) return null
  return { key: m[1], value: unquote(m[2]) }
}

/** KV entries for display: first-appearance order, last value wins. */
export function parseEnvEntries(text: string): EnvEntry[] {
  const m = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const kv = parseKvLine(line)
    if (kv) m.set(kv.key, kv.value)
  }
  return [...m].map(([key, value]) => ({ key, value }))
}

function needsQuote(value: string): boolean {
  return /[\s#="'`]/.test(value) || value.includes('\n')
}

function formatKv(key: string, value: string): string {
  if (value === '') return `${key}=`
  if (needsQuote(value)) {
    return `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
  }
  return `${key}=${value}`
}

/** Reconcile `desired` into the existing text, preserving comments/blanks + retained-key
 *  positions. Retained key → rewrite in place; missing key → drop; new key → append. */
export function applyEnvEdits(existingText: string, desired: EnvEntry[]): string {
  const desiredMap = new Map(desired.map((e) => [e.key, e.value]))
  const seen = new Set<string>()
  const lines = existingText === '' ? [] : existingText.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    const kv = parseKvLine(line)
    if (!kv) {
      out.push(line)
      continue
    }
    if (seen.has(kv.key)) continue // drop duplicate lines of an already-handled key
    if (desiredMap.has(kv.key)) {
      out.push(formatKv(kv.key, desiredMap.get(kv.key)!))
      seen.add(kv.key)
    } else {
      seen.add(kv.key) // deleted — drop this line (and future dups)
    }
  }
  for (const e of desired) {
    if (!seen.has(e.key)) {
      out.push(formatKv(e.key, e.value))
      seen.add(e.key)
    }
  }
  const result = out.join('\n')
  return result.length && !result.endsWith('\n') ? result + '\n' : result
}

const LABELS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'Anthropic API key',
  OPENAI_API_KEY: 'OpenAI API key',
  DATABASE_URL: 'Database URL',
  PORT: 'Port',
  NODE_ENV: 'Environment',
  JWT_SECRET: 'JWT secret',
  REDIS_URL: 'Redis URL',
  STRIPE_SECRET_KEY: 'Stripe secret key',
  STRIPE_PUBLISHABLE_KEY: 'Stripe publishable key',
  SUPABASE_URL: 'Supabase URL',
  SUPABASE_ANON_KEY: 'Supabase anon key'
}

const ACRONYMS = new Set([
  'API', 'URL', 'URI', 'ID', 'DB', 'JWT', 'SDK', 'HTTP', 'HTTPS', 'SSH', 'AWS',
  'GCP', 'S3', 'IP', 'SSL', 'TLS', 'CORS', 'CDN', 'UUID', 'CI', 'CD'
])

/** Plain-English label for a key: curated map, else humanized (acronyms upper-cased). */
export function labelFor(key: string): string {
  if (LABELS[key]) return LABELS[key]
  const words = key.split('_').filter(Boolean)
  if (words.length === 0) return key
  return words
    .map((w, i) => {
      const up = w.toUpperCase()
      if (ACRONYMS.has(up)) return up
      const lower = w.toLowerCase()
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
    })
    .join(' ')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/env-file.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/shared/env-file.ts src/shared/env-file.test.ts
git commit -m "feat(env-editor): pure env-file parse/reconcile/labels

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Main `env-store.ts` + IPC + preload + types wiring

**Files:**
- Create: `src/main/engine/env-store.ts`
- Modify: `src/shared/types.ts` (`IPC` const + `RendererApi`), `src/main/ipc.ts` (2 handlers), `src/preload/index.ts` (2 methods)

**Interfaces:**
- Consumes: `parseEnvEntries`, `applyEnvEdits`, `EnvEntry` (Task 1); `getCurrentProjectPath` (project-store), `atomicWrite` (atomic-write).
- Produces: `readEnvFile(): Promise<EnvEntry[]>`, `writeEnvFile(desired: EnvEntry[]): Promise<void>`; `window.api.readEnv()` / `window.api.writeEnv(entries)`.

> Thin wiring over the Task-1 tested pure module + fs — verified by `npm run typecheck` (no separate unit test; consistent with how other IPC/fs wrappers in this repo are covered).

- [ ] **Step 1: Create `env-store.ts`**

```ts
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getCurrentProjectPath } from './project-store'
import { atomicWrite } from './atomic-write'
import { parseEnvEntries, applyEnvEdits, type EnvEntry } from '../../shared/env-file'

function envPath(): string {
  return join(getCurrentProjectPath(), '.env')
}

/** Parsed entries of the project-root .env; [] when the file doesn't exist. */
export async function readEnvFile(): Promise<EnvEntry[]> {
  try {
    return parseEnvEntries(await fs.readFile(envPath(), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/** Reconcile `desired` into the current .env (created if absent) preserving comments. */
export async function writeEnvFile(desired: EnvEntry[]): Promise<void> {
  let existing = ''
  try {
    existing = await fs.readFile(envPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await atomicWrite(envPath(), applyEnvEdits(existing, desired))
}
```

- [ ] **Step 2: Add IPC channels + RendererApi types**

In `src/shared/types.ts`: add these two lines near the top imports so `EnvEntry` is usable locally AND re-exported (so other modules can `import type { EnvEntry } from '../shared/types'`):

```ts
import type { EnvEntry } from './env-file'
export type { EnvEntry } from './env-file'
```

In the `IPC` const object, add (near `readRole`/`writeRole`):

```ts
  readEnv: 'env:read',
  writeEnv: 'env:write',
```

In `interface RendererApi`, add (near `readRole`/`writeRole`):

```ts
  readEnv: () => Promise<EnvEntry[]>
  writeEnv: (entries: EnvEntry[]) => Promise<void>
```

- [ ] **Step 3: Add the IPC handlers**

In `src/main/ipc.ts`: add an import `import * as envStore from './engine/env-store'` (near the other `import * as ... from './engine/...'`), and add `EnvEntry` to the type import from `'../shared/types'`. After the `writeRole` handler (line ~68), add:

```ts
  ipcMain.handle(IPC.readEnv, () => envStore.readEnvFile())
  ipcMain.handle(IPC.writeEnv, (_e, entries: EnvEntry[]) => envStore.writeEnvFile(entries))
```

- [ ] **Step 4: Add the preload methods**

In `src/preload/index.ts`: add `EnvEntry` to the type import from `'../shared/types'`, and in the `api` object (near `readRole`/`writeRole`), add:

```ts
  readEnv: () => ipcRenderer.invoke(IPC.readEnv),
  writeEnv: (entries: EnvEntry[]) => ipcRenderer.invoke(IPC.writeEnv, entries),
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/engine/env-store.ts src/shared/types.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat(env-editor): env-store + IPC/preload wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Renderer — `EnvModal` + top-bar button

**Files:**
- Create: `src/renderer/EnvModal.tsx`
- Modify: `src/renderer/App.tsx` (import + `showEnv` state + top-bar button + mount)

**Interfaces:**
- Consumes: `window.api.readEnv()` / `window.api.writeEnv(...)` (Task 2); `labelFor` (Task 1); the `Modal` primitive; `EnvEntry`.

> Renderer JSX — verified by `npm run typecheck` + `npm run lint` + `npm run build` + the on-device smoke (no unit test for JSX, per repo convention).

- [ ] **Step 1: Create `EnvModal.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { Modal } from './Modal'
import { labelFor } from '../shared/env-file'
import type { EnvEntry } from '../shared/types'

export default function EnvModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<EnvEntry[]>([])
  const [revealed, setRevealed] = useState<Record<number, boolean>>({})
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.api.readEnv().then(setRows)
  }, [])

  const setValue = (i: number, value: string): void =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, value } : r)))
  const remove = (i: number): void => setRows((rs) => rs.filter((_, j) => j !== i))
  const add = (): void => {
    const key = newKey.trim()
    if (!key) return
    setRows((rs) => [...rs.filter((r) => r.key !== key), { key, value: newValue }])
    setNewKey('')
    setNewValue('')
  }
  const save = async (close: () => void): Promise<void> => {
    setSaving(true)
    try {
      await window.api.writeEnv(rows)
      close()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="env-title">
      {(close) => (<>
        <div className="modal-header">
          <h2 id="env-title" className="modal-title">Environment variables</h2>
          <div className="modal-desc">
            Edited directly in this project's <code>.env</code> — no AI is involved. (Agents can still read
            <code>.env</code> like any file in the project.)
          </div>
        </div>
        <div className="modal-body">
          {rows.length === 0 && <div className="radio-desc">No variables yet. Add one below.</div>}
          {rows.map((r, i) => (
            <div className="field" key={r.key}>
              <label>{labelFor(r.key)} <span className="path">{r.key}</span></label>
              <div className="gated-control">
                <input
                  type={revealed[i] ? 'text' : 'password'}
                  value={r.value}
                  onChange={(e) => setValue(i, e.target.value)}
                  style={{ flex: 1 }}
                />
                <button className="btn tiny" title={revealed[i] ? 'Hide' : 'Reveal'} aria-label={revealed[i] ? 'Hide value' : 'Reveal value'}
                  onClick={() => setRevealed((s) => ({ ...s, [i]: !s[i] }))}>
                  {revealed[i] ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button className="btn tiny" title="Delete" aria-label={`Delete ${r.key}`} onClick={() => remove(i)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
          <div className="field">
            <label>Add variable</label>
            <div className="gated-control">
              <input placeholder="KEY (e.g. ANTHROPIC_API_KEY)" value={newKey} onChange={(e) => setNewKey(e.target.value)} style={{ flex: 1 }} />
              <input placeholder="value" value={newValue} onChange={(e) => setNewValue(e.target.value)} style={{ flex: 1 }} />
              <button className="btn tiny" title="Add" aria-label="Add variable" onClick={() => add()}><Plus size={14} /></button>
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => close()}>Cancel</button>
          <button className="btn primary" disabled={saving} onClick={() => void save(close)}>Save</button>
        </div>
      </>)}
    </Modal>
  )
}
```

(If the `.path` / `.gated-control` / `.tiny` classes render acceptably is confirmed at the on-device smoke; they are existing classes reused here — do not add new CSS.)

- [ ] **Step 2: Wire the top-bar button + mount in `App.tsx`**

- Add `KeyRound` to the lucide-react import at the top of `App.tsx`.
- Add `import EnvModal from './EnvModal'` with the other modal imports.
- Add state near the other modal toggles (`const [showContext, setShowContext] = useState(false)` etc.): `const [showEnv, setShowEnv] = useState(false)`.
- In the top bar, in the same `topbar-group` as the **Context** button, add after the Context button:

```tsx
          <button className={`btn ${showEnv ? 'active' : ''}`} title="Environment variables (.env) — no AI" onClick={() => setShowEnv(true)}><KeyRound size={14} /> Env</button>
```

- Near the other modal mounts (`{showContext && <ContextModal onClose={() => setShowContext(false)} />}`), add:

```tsx
      {showEnv && <EnvModal onClose={() => setShowEnv(false)} />}
```

- [ ] **Step 3: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/EnvModal.tsx src/renderer/App.tsx
git commit -m "feat(env-editor): EnvModal + top-bar Env button

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Integration gate (controller, after all tasks)

- [ ] `npm run typecheck` — PASS
- [ ] `npm run test` — PASS (note the known `run-store.test.ts` full-suite flake; re-run in isolation if it trips)
- [ ] `npm run lint` — PASS (renderer touched)
- [ ] `npm run build` — PASS
- [ ] Opus whole-branch review — no Critical/Important
- [ ] User on-device smoke: open a project that has a `.env` with a comment → click **Env** in the top bar → confirm rows show friendly labels + raw keys + masked values; reveal/edit a value, add a variable, delete one, **Save**; confirm the on-disk `.env` updated, the comment + untouched lines are preserved, and new vars appended. On a project with no `.env`, adding + Save creates the file.

## Self-review notes (spec coverage)

- Comment-preserving `.env` model → Task 1 (`parseEnvEntries`/`applyEnvEdits`).
- Plain-English labels → Task 1 (`labelFor`).
- Main read/write over project-root `.env` + created-on-save → Task 2 (`env-store.ts`).
- IPC/preload/types (no engine change) → Task 2.
- Top-bar button + modal (masked/reveal/add/edit/delete/save + honesty note) → Task 3.
- No-AI / off-by-nature → the feature adds no engine path and runs only on user action (Tasks 2/3).
