# Plain-English Run Narration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a whole-run, plain-English activity feed to the Run view that narrates each agent's tool calls (derived deterministically — no model calls), shown above the existing raw terminal.

**Architecture:** A pure `shared/narrate.ts` maps a tool `name`+`input` to a friendly phrase. `agent-runner.ts` attaches that phrase as a new optional `narration?` field on the `tool_use` `AgentStreamEvent`. A new read-only `ActivityFeed.tsx` subscribes to the agent stream, collects narration-bearing events into a capped chronological list, and renders them above the raw terminal in a split right pane. Live-only; no `RunState`/`RunRecord`/engine change.

**Tech Stack:** TypeScript, Electron (main + renderer), React, Zustand, Vitest, xterm.

## Global Constraints

- **No engine behavior change:** the only main-process edit is one computed string attached to a `tool_use` event already being sent. Existing terminal output stays byte-for-byte; no run behaves differently; nothing new is persisted.
- **Live-only:** no changes to `RunState`, `RunRecord`, `toRunRecord`, or History.
- **Always on:** no settings flag. The raw terminal is always present.
- **`narrate.ts` is pure:** no node/DOM imports (unit-tested in plain Node, like `shared/effort.ts`). It must never throw on malformed input.
- **Feed is action-only:** only `tool_use` events carry `narration`; assistant reasoning text, tool results, and lifecycle events do not.
- **Cap:** the feed keeps at most the most recent **200** rows.
- Run tests with `npx vitest run`. Typecheck renderer with `npx tsc -p tsconfig.web.json --noEmit`, main/preload with `npx tsc -p tsconfig.node.json --noEmit`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/narrate.ts` (new) | Pure `narrateTool(name, input)` + `basename`/`host`/`clip` helpers |
| `src/shared/narrate.test.ts` (new) | Per-tool unit tests |
| `src/shared/types.ts` | add `narration?: string` to `AgentStreamEvent` |
| `src/main/engine/agent-runner.ts` | import `narrateTool`, attach `narration` on the `tool_use` emit |
| `src/renderer/run/ActivityFeed.tsx` (new) | The whole-run feed component |
| `src/renderer/run/RunView.tsx` | wrap the right cell in `.run-right`, mount `<ActivityFeed>` |
| `src/renderer/styles.css` | `.run-right`, `.activity-feed`, `.activity-row` styles; make `.run-output` a flex child |

---

### Task 1: Pure `narrateTool` mapper

**Files:**
- Create: `src/shared/narrate.ts`
- Test: `src/shared/narrate.test.ts`

**Interfaces:**
- Produces: `narrateTool(name: string, input: unknown): string` — a short plain-English phrase; never throws.

- [ ] **Step 1: Write the failing test**

Create `src/shared/narrate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { narrateTool } from './narrate'

describe('narrateTool', () => {
  it('uses the Bash description when present', () => {
    expect(narrateTool('Bash', { command: 'npm test', description: 'Run the test suite' }))
      .toBe('Run the test suite')
  })

  it('falls back to the Bash command when there is no description', () => {
    expect(narrateTool('Bash', { command: 'npm test' })).toBe('Running `npm test`')
  })

  it('handles Bash with neither description nor command', () => {
    expect(narrateTool('Bash', {})).toBe('Running a command')
  })

  it('clips a very long Bash command', () => {
    const cmd = 'echo ' + 'x'.repeat(200)
    const out = narrateTool('Bash', { command: cmd })
    expect(out.startsWith('Running `echo ')).toBe(true)
    expect(out.endsWith('`')).toBe(true)
    expect(out.length).toBeLessThan(95) // 80-char clip + "Running ``"
  })

  it('reads with a basename from a nested path', () => {
    expect(narrateTool('Read', { file_path: '/home/u/proj/src/app.tsx' })).toBe('Reading app.tsx')
  })

  it('edits with a basename (Edit + MultiEdit)', () => {
    expect(narrateTool('Edit', { file_path: 'src/styles.css' })).toBe('Editing styles.css')
    expect(narrateTool('MultiEdit', { file_path: 'src/x.ts' })).toBe('Editing x.ts')
  })

  it('handles a Windows-style path separator', () => {
    expect(narrateTool('Write', { file_path: 'C:\\Users\\me\\notes.md' })).toBe('Writing notes.md')
  })

  it('narrates NotebookEdit from notebook_path', () => {
    expect(narrateTool('NotebookEdit', { notebook_path: 'a/b/analysis.ipynb' }))
      .toBe('Editing analysis.ipynb')
  })

  it('quotes a Grep pattern', () => {
    expect(narrateTool('Grep', { pattern: 'TODO' })).toBe('Searching for "TODO"')
  })

  it('narrates Glob', () => {
    expect(narrateTool('Glob', { pattern: '**/*.ts' })).toBe('Finding files: **/*.ts')
  })

  it('extracts the host for WebFetch', () => {
    expect(narrateTool('WebFetch', { url: 'https://docs.example.com/x/y' }))
      .toBe('Fetching docs.example.com')
  })

  it('falls back to the raw url when WebFetch has no scheme', () => {
    expect(narrateTool('WebFetch', { url: 'example.com/page' })).toBe('Fetching example.com/page')
  })

  it('clips a WebSearch query', () => {
    expect(narrateTool('WebSearch', { query: 'how to center a div' }))
      .toBe('Searching the web: how to center a div')
  })

  it('narrates TodoWrite', () => {
    expect(narrateTool('TodoWrite', { todos: [] })).toBe('Updating the task list')
  })

  it('narrates Task with and without a description', () => {
    expect(narrateTool('Task', { description: 'Find the bug' }))
      .toBe('Delegating to a subagent: Find the bug')
    expect(narrateTool('Task', {})).toBe('Delegating to a subagent')
  })

  it('narrates an MCP tool by server + tool', () => {
    expect(narrateTool('mcp__github__create_issue', {})).toBe('Using create_issue (github)')
  })

  it('narrates an unknown tool by name', () => {
    expect(narrateTool('Frobnicate', { x: 1 })).toBe('Using Frobnicate')
  })

  it('never throws on malformed input', () => {
    expect(() => narrateTool('Read', null)).not.toThrow()
    expect(() => narrateTool('Bash', 'not-an-object')).not.toThrow()
    expect(narrateTool('Read', null)).toBe('Reading a file')
    expect(narrateTool('Edit', 42)).toBe('Editing a file')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/narrate.test.ts`
Expected: FAIL — cannot resolve `./narrate`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/narrate.ts`:

```ts
// Pure derivation of a plain-English activity phrase from a Claude Code tool call.
// No node/DOM imports — unit-tested in plain Node (like shared/effort.ts). Never throws.

export function narrateTool(name: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')

  switch (name) {
    case 'Bash': {
      const desc = str(o.description).trim()
      if (desc) return desc
      const cmd = str(o.command).trim()
      return cmd ? `Running \`${clip(cmd, 80)}\`` : 'Running a command'
    }
    case 'Read':
      return `Reading ${basename(str(o.file_path)) || 'a file'}`
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${basename(str(o.file_path)) || 'a file'}`
    case 'Write':
      return `Writing ${basename(str(o.file_path)) || 'a file'}`
    case 'NotebookEdit':
      return `Editing ${basename(str(o.notebook_path)) || 'a notebook'}`
    case 'Grep': {
      const p = str(o.pattern).trim()
      return p ? `Searching for "${clip(p, 60)}"` : 'Searching files'
    }
    case 'Glob': {
      const p = str(o.pattern).trim()
      return p ? `Finding files: ${clip(p, 60)}` : 'Finding files'
    }
    case 'WebFetch': {
      const u = str(o.url).trim()
      return u ? `Fetching ${host(u)}` : 'Fetching a page'
    }
    case 'WebSearch': {
      const q = str(o.query).trim()
      return q ? `Searching the web: ${clip(q, 60)}` : 'Searching the web'
    }
    case 'TodoWrite':
      return 'Updating the task list'
    case 'Task': {
      const d = str(o.description).trim()
      return d ? `Delegating to a subagent: ${clip(d, 60)}` : 'Delegating to a subagent'
    }
    default:
      if (name.startsWith('mcp__')) {
        const parts = name.split('__')
        const server = parts[1] ?? ''
        const tool = parts.slice(2).join('__') || name
        return server ? `Using ${tool} (${server})` : `Using ${tool}`
      }
      return `Using ${name}`
  }
}

/** Last path segment (handles / and \), or '' for an empty string. */
function basename(p: string): string {
  if (!p) return ''
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** Best-effort host from a URL via regex (no URL/DOM dependency). Falls back to the input. */
function host(u: string): string {
  const m = u.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i)
  return m ? m[1] : u
}

/** Truncate with an ellipsis when longer than n. */
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/narrate.test.ts`
Expected: PASS (18 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/narrate.ts src/shared/narrate.test.ts
git commit -m "feat(narration): pure narrateTool tool-call mapper"
```

End the commit message with this trailer (own line, after a blank line):
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 2: Wire `narration` onto the `tool_use` stream event

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/engine/agent-runner.ts`

**Interfaces:**
- Consumes: `narrateTool` (Task 1).
- Produces: `AgentStreamEvent.narration?: string` (set only on `kind === 'tool_use'` events).

- [ ] **Step 1: Add the field to `AgentStreamEvent` in `src/shared/types.ts`**

Find the `AgentStreamEvent` interface (the normalized stream chunk; has `agentId`, `runId`, `stepId?`, `kind`, `text`, `sessionId?`, `isFinal?`). Add, after `isFinal?: boolean`:

```ts
  /** plain-English narration of a tool call (set only on 'tool_use' events) */
  narration?: string
```

- [ ] **Step 2: Attach it in `src/main/engine/agent-runner.ts`**

Add the import near the other `shared/` imports (e.g. below the `skills-pack` import):

```ts
import { narrateTool } from '../../shared/narrate'
```

Find the `tool_use` emit in `streamAgent` (currently):

```ts
          } else if (block.type === 'tool_use') {
            send('tool_use', `\x1b[36m⚙ ${block.name}\x1b[0m ${oneLine(JSON.stringify(block.input))}\r\n`)
          }
```

Replace it with (adds the third `extra` arg; the `send` helper already spreads `extra` into the event):

```ts
          } else if (block.type === 'tool_use') {
            send('tool_use', `\x1b[36m⚙ ${block.name}\x1b[0m ${oneLine(JSON.stringify(block.input))}\r\n`,
              { narration: narrateTool(block.name, block.input) })
          }
```

- [ ] **Step 3: Typecheck main + preload**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full suite (no behavior change expected)**

Run: `npx vitest run`
Expected: PASS — all existing suites green (the new field is additive; nothing reads it yet).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/engine/agent-runner.ts
git commit -m "feat(narration): attach narration to tool_use stream events"
```

End the commit message with the `Co-Authored-By` trailer (as in Task 1).

---

### Task 3: `ActivityFeed` component + Run-view split layout

**Files:**
- Create: `src/renderer/run/ActivityFeed.tsx`
- Modify: `src/renderer/run/RunView.tsx`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: `AgentStreamEvent.narration` (Task 2), `window.api.onAgentStream`, the store's `graph` + `selectStep` + `run.runId`.
- Produces: `<ActivityFeed runId={string | null} />` rendered above `.run-output`.

- [ ] **Step 1: Create `src/renderer/run/ActivityFeed.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import type { AgentStreamEvent } from '../../shared/types'

interface FeedRow {
  id: number
  agentId: string
  text: string
  time: string
}

const MAX_ROWS = 200

function hhmmss(d: Date): string {
  return d.toTimeString().slice(0, 8)
}

/** Whole-run, plain-English activity feed. Live-only: collects narration-bearing
 *  stream events, capped + cleared per run. Clicking a row selects that agent. */
export default function ActivityFeed({ runId }: { runId: string | null }) {
  const graph = useStore((s) => s.graph)
  const selectStep = useStore((s) => s.selectStep)
  const [rows, setRows] = useState<FeedRow[]>([])
  const counter = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  // subscribe once to the agent stream; keep only narration-bearing events
  useEffect(() => {
    const unsub = window.api.onAgentStream((e: AgentStreamEvent) => {
      if (!e.narration) return
      const row: FeedRow = {
        id: ++counter.current,
        agentId: e.agentId,
        text: e.narration,
        time: hhmmss(new Date())
      }
      setRows((prev) => {
        const next = [...prev, row]
        return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next
      })
    })
    return () => unsub()
  }, [])

  // clear when a new run starts
  useEffect(() => {
    setRows([])
  }, [runId])

  // keep pinned to the newest row
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows])

  const nameOf = (id: string): string => graph?.nodes.find((n) => n.id === id)?.name ?? id

  return (
    <div className="activity-feed" ref={listRef}>
      {rows.length === 0 ? (
        <div className="activity-empty">No activity yet.</div>
      ) : (
        rows.map((r) => (
          <div
            key={r.id}
            className="activity-row"
            title={r.text}
            onClick={() => selectStep(r.agentId)}
          >
            <span className="activity-time">{r.time}</span>
            <span className="activity-agent">{nameOf(r.agentId)}</span>
            <span className="activity-text">{r.text}</span>
          </div>
        ))
      )}
    </div>
  )
}
```

- [ ] **Step 2: Mount it in `src/renderer/run/RunView.tsx`**

Add the import near the top (below the existing imports):

```tsx
import ActivityFeed from './ActivityFeed'
```

Find the JSX return's right cell (currently the last child of `.runview`):

```tsx
      <div className="run-output" ref={hostRef} />
    </div>
  )
```

Replace it with the wrapped version:

```tsx
      <div className="run-right">
        <ActivityFeed runId={run.runId} />
        <div className="run-output" ref={hostRef} />
      </div>
    </div>
  )
```

(`run` is already in scope via `const run = useStore((s) => s.run)`.)

- [ ] **Step 3: Add styles in `src/renderer/styles.css`**

Append (uses the existing theme vars `--panel`, `--border`, `--muted`, `--text`, `--accent`):

```css
.run-right {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.activity-feed {
  flex: 0 0 38%;
  overflow-y: auto;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  padding: 4px 0;
  font-size: 12px;
}
.activity-empty {
  padding: 8px 12px;
  color: var(--muted);
}
.activity-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 2px 12px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}
.activity-row:hover {
  background: rgba(255, 255, 255, 0.04);
}
.activity-time {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  flex: none;
}
.activity-agent {
  color: var(--accent);
  font-weight: 600;
  flex: none;
}
.activity-text {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
}
```

Then update the existing `.run-output` rule so it fills the remaining space as a flex child. Find:

```css
.run-output {
  overflow: hidden;
  padding: 6px 8px;
  background: #0b0c10;
}
```

Replace with:

```css
.run-output {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 6px 8px;
  background: #0b0c10;
}
```

- [ ] **Step 4: Typecheck the renderer**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: no errors.

- [ ] **Step 5: Build smoke (confirm the renderer bundles)**

Run: `npm run build`
Expected: builds clean (main + preload + renderer).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/run/ActivityFeed.tsx src/renderer/run/RunView.tsx src/renderer/styles.css
git commit -m "feat(narration): whole-run activity feed in the Run view"
```

End the commit message with the `Co-Authored-By` trailer (as in Task 1).

---

### Task 4: Whole-branch verification + review

**Files:** none (verification only).

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: PASS — all suites green (was 247 + the 18 new narrate tests).

- [ ] **Step 2: Both typechecks**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx tsc -p tsconfig.web.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Whole-branch review**

Dispatch a code review of the full `feat/run-narration` diff against `main`. Review focus:
- `narrateTool` never throws and covers the documented tools; the test asserts real behavior.
- The `agent-runner` change is purely additive (existing terminal text unchanged; `narration` only on `tool_use`).
- `ActivityFeed` clears per run, caps at 200, subscribes/unsubscribes cleanly (no leaked listeners), and click-to-select works; the xterm still fits in its now-smaller flex box (the existing `ResizeObserver` handles it).
- No `RunState`/`RunRecord`/engine-control change; live-only holds.

Address any Critical/Important findings via `superpowers:receiving-code-review`, then re-run Step 1.

---

## Self-Review (completed by plan author)

**Spec coverage:** mapper (Task 1) ✓; `narration?` field + agent-runner attach (Task 2) ✓; ActivityFeed + split layout + CSS (Task 3) ✓; verification/review (Task 4) ✓. All four locked decisions map to the Global Constraints + Tasks 2/3. Live-only / always-on / action-only / cap-200 all enforced. ✓

**Type consistency:** `narrateTool(name: string, input: unknown): string`, `AgentStreamEvent.narration?: string`, `<ActivityFeed runId={string | null} />` — used identically across Tasks 1/2/3. ✓

**Placeholder scan:** every code step shows complete code; no TBD/TODO/"handle edge cases". ✓
