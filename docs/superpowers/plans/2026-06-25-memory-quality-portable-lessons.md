# Memory Quality — Portable vs Project-Specific Lessons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag each reflected lesson as `portable` (general SWE wisdom) or `project` (this-codebase fact), stored inline in `memory.md`, so the routing track-record digest surfaces capability not trivia — and so a future "portable team" (sub-project B) can carry only portable lessons.

**Architecture:** A single new pure module `src/shared/lessons.ts` owns the inline marker convention (`[portable]` / `[project]`). The reflection step classifies lessons and writes marker-tagged bullets; `mergeMemory` dedups by marker-stripped text; the `lessonsDigest` routing reader excludes `project` lessons. No shared-type, store, or `applyReflection`-signature changes — the tag rides inside the existing `lessons: string[]`.

**Tech Stack:** TypeScript, vitest, electron-vite (CJS main + React renderer). Commands: `npx vitest run`, `npm run typecheck`, `npm run build`.

## Global Constraints

- **Binary taxonomy only:** `portable` | `project`. No third tier. When scope is missing/ambiguous/unparseable, default to `project` (conservative — never wrongly transfer).
- **The marker convention lives ONLY in `src/shared/lessons.ts`.** Reflection, merge, routing, and the future B all go through `parseLessonBullet` / `formatLessonBullet`. Do not re-implement the `[scope]` regex anywhere else.
- **No type churn:** `reflectStep` keeps returning `{ win, loss, lessons: string[] }`; `applyReflection`'s signature, the `reflection` `OrchestrationEvent`, `RunRecord`, and `src/renderer/store.ts` are unchanged. The markers ride inside the existing strings.
- **Preserve prompt marker-phrases** that the canned test agent matches: the reflect prompt MUST still contain the literal `Reflect on the work`, and the assign prompt `You route planned tasks`. Do not reword those phrases.
- **Untagged (legacy) handling — deliberate asymmetry:** untagged bullets are *eligible* for the routing digest (no regression for existing memory), but are treated as `project` (not transferred) by the future B. This plan implements only the routing side.
- **All 59 existing tests must stay green.** With no markers present, behavior is unchanged.
- **Renderer has no unit-test harness** (engine + shared are tested; the renderer is not). The one renderer change (HistoryView) is verified by `typecheck` + `build`, consistent with the rest of the renderer.
- **Git:** the project is **not currently a git repository**. The `git commit` step in each task assumes you have run `git init` first; if you choose not to use git, treat each commit step as "checkpoint reached — suite is green" and skip the command.

---

### Task 1: Marker convention module (`shared/lessons.ts`)

**Files:**
- Create: `src/shared/lessons.ts`
- Test: `src/shared/lessons.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no imports).
- Produces:
  - `export type LessonScope = 'portable' | 'project'`
  - `export function parseLessonBullet(raw: string): { scope: LessonScope | null; text: string }` — strips a leading `[portable]`/`[project]` marker (case-insensitive); `scope: null` means untagged/legacy; `text` is trimmed.
  - `export function formatLessonBullet(scope: LessonScope, text: string): string` — returns `"[scope] text"` with `text` trimmed.

- [ ] **Step 1: Write the failing test**

Create `src/shared/lessons.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseLessonBullet, formatLessonBullet } from './lessons'

describe('parseLessonBullet', () => {
  it('parses a portable marker and trims the text', () => {
    expect(parseLessonBullet('[portable]  write a failing test first')).toEqual({
      scope: 'portable',
      text: 'write a failing test first'
    })
  })

  it('parses a project marker case-insensitively', () => {
    expect(parseLessonBullet('[PROJECT] migrations live in db/migrate')).toEqual({
      scope: 'project',
      text: 'migrations live in db/migrate'
    })
  })

  it('returns scope null for an untagged (legacy) bullet', () => {
    expect(parseLessonBullet('verify renders return 200')).toEqual({
      scope: null,
      text: 'verify renders return 200'
    })
  })
})

describe('formatLessonBullet', () => {
  it('renders the marker and trims the text', () => {
    expect(formatLessonBullet('portable', '  write tests first ')).toBe('[portable] write tests first')
  })

  it('round-trips through parseLessonBullet', () => {
    expect(parseLessonBullet(formatLessonBullet('project', 'api key in config'))).toEqual({
      scope: 'project',
      text: 'api key in config'
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/lessons.test.ts`
Expected: FAIL — `Failed to resolve import "./lessons"` (module doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/lessons.ts`:

```ts
// The portable/project-specific lesson marker convention — the SINGLE source of
// truth. Pure (no node/DOM imports) so it's unit-testable in plain Node and usable
// by both the engine and the renderer. Reflection, mergeMemory, lessonsDigest, and
// the future portable-team all go through these helpers.

export type LessonScope = 'portable' | 'project'

const SCOPE_MARKER = /^\[(portable|project)\]\s*/i

/** Strip a leading `[portable]`/`[project]` marker. `scope: null` = untagged/legacy. */
export function parseLessonBullet(raw: string): { scope: LessonScope | null; text: string } {
  const m = raw.match(SCOPE_MARKER)
  if (m) return { scope: m[1].toLowerCase() as LessonScope, text: raw.slice(m[0].length).trim() }
  return { scope: null, text: raw.trim() }
}

/** Render a lesson with its marker, for writing into memory.md. */
export function formatLessonBullet(scope: LessonScope, text: string): string {
  return `[${scope}] ${text.trim()}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/lessons.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` → Expected: no errors.

```bash
git add src/shared/lessons.ts src/shared/lessons.test.ts
git commit -m "feat(memory): add portable/project lesson marker convention"
```

---

### Task 2: Make `lessonsDigest` marker-aware (routing read side)

**Files:**
- Modify: `src/main/engine/nodes.ts` (the existing exported `lessonsDigest`, and add the `shared/lessons` import)
- Test: `src/main/engine/nodes.test.ts` (extend the existing `describe('lessonsDigest')`)

**Interfaces:**
- Consumes: `parseLessonBullet` from Task 1.
- Produces: unchanged signature `lessonsDigest(memory: string, maxLessons?, maxLen?): string[]` — now excludes `[project]` lessons and returns marker-stripped text for `portable` + untagged.

- [ ] **Step 1: Write the failing tests**

In `src/main/engine/nodes.test.ts`, inside the existing `describe('lessonsDigest', () => { ... })` block, add these cases:

```ts
  it('excludes project-specific lessons and strips the marker from portable ones', () => {
    const mem = '## Lessons\n- [portable] verify renders return 200\n- [project] api key in config/secrets.json\n'
    expect(lessonsDigest(mem)).toEqual(['verify renders return 200'])
  })

  it('keeps untagged (legacy) lessons eligible for routing', () => {
    const mem = '## Lessons\n- [portable] write tests first\n- old untagged lesson\n- [project] local quirk\n'
    expect(lessonsDigest(mem)).toEqual(['write tests first', 'old untagged lesson'])
  })

  it('matches the marker case-insensitively', () => {
    expect(lessonsDigest('## Lessons\n- [PORTABLE] reusable rule\n')).toEqual(['reusable rule'])
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/engine/nodes.test.ts -t "lessonsDigest"`
Expected: FAIL — the first new test gets `['verify renders return 200', 'api key in config/secrets.json']` (project not excluded, marker not stripped).

- [ ] **Step 3: Add the import**

At the top of `src/main/engine/nodes.ts`, add to the imports (next to the other `../../shared/*` imports):

```ts
import { parseLessonBullet } from '../../shared/lessons'
```

- [ ] **Step 4: Update `lessonsDigest`**

Replace the body of the existing `lessonsDigest` loop so it parses the marker, drops `project`, and emits stripped text. The full function becomes:

```ts
export function lessonsDigest(memory: string, maxLessons = 5, maxLen = 160): string[] {
  const lines = memory.split('\n')
  const start = lines.findIndex((l) => /^##\s+lessons\s*$/i.test(l.trim()))
  if (start === -1) return []
  const out: string[] = []
  for (let i = start + 1; i < lines.length && out.length < maxLessons; i++) {
    const raw = lines[i].trim()
    if (/^##\s+/.test(raw)) break // next section
    if (!raw.startsWith('- ')) continue
    const bullet = raw
      .slice(2)
      .replace(/<!--.*?-->/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!bullet || /^\(none yet\)$/i.test(bullet)) continue
    const { scope, text } = parseLessonBullet(bullet)
    if (scope === 'project') continue // project-specific trivia is not a routing signal
    out.push(text.length > maxLen ? text.slice(0, maxLen) + '…' : text)
  }
  return out
}
```

- [ ] **Step 5: Run the whole nodes suite to verify pass**

Run: `npx vitest run src/main/engine/nodes.test.ts`
Expected: PASS (all `lessonsDigest` tests incl. the originals, plus the rest of the file).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` → Expected: no errors.

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(memory): lessonsDigest excludes project-specific lessons from routing"
```

---

### Task 3: Classify lessons at reflection time (`normalizeLessonInput`, `reflectStep`, `reflectPrompt`)

**Files:**
- Modify: `src/main/engine/nodes.ts` (add `normalizeLessonInput`; update `reflectStep` and `reflectPrompt`; extend the `shared/lessons` import)
- Test: `src/main/engine/nodes.test.ts` (add `describe('normalizeLessonInput')`; update the canned agent's reflect JSON)

**Interfaces:**
- Consumes: `formatLessonBullet`, `LessonScope` from Task 1.
- Produces: `export function normalizeLessonInput(raw: unknown): string | null` — maps one raw lesson from the reflect JSON to a marker-tagged bullet string (or `null` to drop it). `reflectStep` still returns `{ win, loss, lessons: string[] }` (now marker-tagged).

- [ ] **Step 1: Write the failing tests**

In `src/main/engine/nodes.test.ts`, add a new top-level `describe` (e.g. after the `lessonsDigest` block) and import `normalizeLessonInput`:

First extend the existing import from `'./nodes'` to include `normalizeLessonInput`:

```ts
import {
  buildOrchestratorGraph,
  seedRunState,
  maxEffort,
  lessonsDigest,
  depsSatisfied,
  normalizeLessonInput,
  type Eng,
  type AgentRunner
} from './nodes'
```

Then add:

```ts
describe('normalizeLessonInput', () => {
  it('formats an object with an explicit portable scope', () => {
    expect(normalizeLessonInput({ text: 'write tests first', scope: 'portable' })).toBe(
      '[portable] write tests first'
    )
  })

  it('defaults a missing or unknown scope to project', () => {
    expect(normalizeLessonInput({ text: 'local quirk' })).toBe('[project] local quirk')
    expect(normalizeLessonInput({ text: 'local quirk', scope: 'banana' })).toBe('[project] local quirk')
  })

  it('treats a bare string as a project lesson', () => {
    expect(normalizeLessonInput('learned something')).toBe('[project] learned something')
  })

  it('keeps an already-tagged string as-is', () => {
    expect(normalizeLessonInput('[portable] already tagged')).toBe('[portable] already tagged')
  })

  it('drops empty or non-lesson input', () => {
    expect(normalizeLessonInput({ text: '   ' })).toBeNull()
    expect(normalizeLessonInput('')).toBeNull()
    expect(normalizeLessonInput(42)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/engine/nodes.test.ts -t "normalizeLessonInput"`
Expected: FAIL — `normalizeLessonInput is not a function`.

- [ ] **Step 3: Add the import and the helper**

Extend the `shared/lessons` import in `src/main/engine/nodes.ts` (created in Task 2) to:

```ts
import { formatLessonBullet, parseLessonBullet, type LessonScope } from '../../shared/lessons'
```

Add `normalizeLessonInput` near `lessonsDigest` (it's exported, like `maxEffort`):

```ts
/** Normalize one raw lesson from a reflect JSON into a marker-tagged bullet, or null to drop it. */
export function normalizeLessonInput(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return null
    if (/^\[(portable|project)\]/i.test(text)) return text // already tagged → keep
    return formatLessonBullet('project', text) // bare/legacy string → conservative
  }
  if (raw && typeof raw === 'object') {
    const o = raw as { text?: unknown; scope?: unknown }
    const text = String(o.text ?? '').trim()
    if (!text) return null
    const scope: LessonScope = o.scope === 'portable' ? 'portable' : 'project'
    return formatLessonBullet(scope, text)
  }
  return null
}
```

- [ ] **Step 4: Wire it into `reflectStep`**

In `reflectStep`, replace the `lessons` parse line. Find:

```ts
    const lessons = Array.isArray(p.lessons)
      ? p.lessons.map((x) => String(x).trim()).filter(Boolean).slice(0, 6)
      : []
```

Replace with:

```ts
    const lessons = Array.isArray(p.lessons)
      ? p.lessons.map(normalizeLessonInput).filter((l): l is string => l !== null).slice(0, 6)
      : []
```

- [ ] **Step 5: Update `reflectPrompt` to ask for a scope**

In `reflectPrompt`, replace the `lessons:` bullet and the JSON block. Find:

```ts
- lessons: 1-4 short, reusable rules for your future self — especially how to avoid repeating any mistake the reviewer flagged.

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "win": "...", "loss": "...", "lessons": ["..."] }
\`\`\``
```

Replace with:

```ts
- lessons: 1-4 short, reusable rules for your future self — especially how to avoid repeating any mistake the reviewer flagged. For EACH lesson set a "scope":
    - "portable": general software-engineering wisdom that would help on ANY project (testing, verification, debugging, review habits).
    - "project": a fact or convention specific to THIS codebase or goal (file paths, commands, config locations, domain quirks) that would NOT transfer elsewhere.
  When unsure, use "project".

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "win": "...", "loss": "...", "lessons": [ { "text": "...", "scope": "portable" } ] }
\`\`\``
```

(The literal phrase `Reflect on the work` earlier in this prompt is unchanged — do not touch it.)

- [ ] **Step 6: Update the canned agent's reflect JSON in the test**

In `src/main/engine/nodes.test.ts`, in the shared `cannedAgent()` helper, find:

```ts
    if (p.includes('Reflect on the work')) {
      rec('reflect')
      return { text: '```json\n{"win":"w","loss":"l","lessons":["learned"]}\n```' }
    }
```

Replace the returned JSON with the new object form (exercises the object path):

```ts
    if (p.includes('Reflect on the work')) {
      rec('reflect')
      return {
        text: '```json\n{"win":"w","loss":"l","lessons":[{"text":"learned","scope":"portable"}]}\n```'
      }
    }
```

- [ ] **Step 7: Run the whole nodes suite to verify pass**

Run: `npx vitest run src/main/engine/nodes.test.ts`
Expected: PASS — `normalizeLessonInput` tests pass; the e2e/manager/resume/dep tests still pass (they assert reflection `nodeId`s/counts, not lesson content).

- [ ] **Step 8: Typecheck + commit**

Run: `npm run typecheck` → Expected: no errors.

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "feat(memory): classify reflected lessons as portable/project"
```

---

### Task 4: Dedup by text in `mergeMemory` (`project-store.ts`)

**Files:**
- Modify: `src/main/engine/project-store.ts` (add the `shared/lessons` import; `export` `mergeMemory`; dedup by marker-stripped text)
- Test: `src/main/engine/project-store.test.ts` (new — mocks `electron`)

**Interfaces:**
- Consumes: `parseLessonBullet` from Task 1.
- Produces: `export function mergeMemory(content: string, r: { win: string; loss: string; lessons: string[]; label: string }): string` — writes new marker-tagged lessons under `## Lessons`, deduping by marker-stripped text (existing bullet wins on a text collision).

- [ ] **Step 1: Write the failing tests**

Create `src/main/engine/project-store.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

// project-store.ts imports `app` from electron at module top; mock it so the module
// loads in plain Node. mergeMemory itself touches neither electron nor the fs.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import { mergeMemory } from './project-store'

describe('mergeMemory — tagged lessons', () => {
  it('writes a new tagged lesson as a bullet under ## Lessons', () => {
    const next = mergeMemory('', {
      win: '',
      loss: '',
      lessons: ['[portable] write a failing test first'],
      label: 'goal'
    })
    expect(next).toContain('- [portable] write a failing test first')
  })

  it('dedups a re-learned lesson by text even when its scope tag differs', () => {
    const base = '# Memory\n\n## Lessons\n- [portable] verify renders return 200\n\n## Task log\n'
    const next = mergeMemory(base, {
      win: '',
      loss: '',
      lessons: ['[project] verify renders return 200'],
      label: 'goal'
    })
    const occurrences = (next.match(/verify renders return 200/g) || []).length
    expect(occurrences).toBe(1) // not duplicated; existing [portable] bullet wins
    expect(next).toContain('- [portable] verify renders return 200')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/engine/project-store.test.ts`
Expected: FAIL — `mergeMemory` is not exported (`mergeMemory is not a function`).

- [ ] **Step 3: Add the import and export `mergeMemory`**

In `src/main/engine/project-store.ts`, add to the imports (next to `import { iconForName } from '../../shared/icons'`):

```ts
import { parseLessonBullet } from '../../shared/lessons'
```

Change the declaration `function mergeMemory(` to `export function mergeMemory(`.

- [ ] **Step 4: Run tests — first test passes, dedup test still fails**

Run: `npx vitest run src/main/engine/project-store.test.ts`
Expected: the "writes a new tagged lesson" test PASSES; the "dedups by text" test still FAILS (`expected 2 to be 1`) — current dedup compares the whole bullet, so different markers aren't deduped.

- [ ] **Step 5: Dedup by marker-stripped text**

In `mergeMemory`, update the `## Lessons` section transform. Find:

```ts
  // Lessons: merge new bullets newest-first, dedupe, cap 40
  text = replaceSection(text, /^##\s+Lessons\s*$/im, (body) => {
    const existing = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- ') && !/\(none yet\)/i.test(l))
    const fresh = lessons
      .map((l) => `- ${l.trim()}`)
      .filter(
        (l) =>
          l.length > 2 &&
          !existing.some((e) => norm(e).includes(norm(l)) || norm(l).includes(norm(e)))
      )
    return [...fresh, ...existing].slice(0, 40).join('\n')
  })
```

Replace with (compares by marker-stripped text):

```ts
  // Lessons: merge new bullets newest-first, dedupe BY TEXT (ignoring the scope
  // marker so a re-learned lesson isn't stored twice), cap 40
  text = replaceSection(text, /^##\s+Lessons\s*$/im, (body) => {
    const existing = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- ') && !/\(none yet\)/i.test(l))
    const existingTexts = existing.map((e) => norm(parseLessonBullet(e.slice(2)).text))
    const fresh = lessons
      .map((l) => `- ${l.trim()}`)
      .filter((l) => {
        if (l.length <= 2) return false
        const lt = norm(parseLessonBullet(l.slice(2)).text)
        return !existingTexts.some((e) => e.includes(lt) || lt.includes(e))
      })
    return [...fresh, ...existing].slice(0, 40).join('\n')
  })
```

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run src/main/engine/project-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npx vitest run` → Expected: all green.
Run: `npm run typecheck` → Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "feat(memory): mergeMemory dedups lessons by text across scope tags"
```

---

### Task 5: Strip the marker when displaying lessons in History (`HistoryView.tsx`)

**Files:**
- Modify: `src/renderer/run/HistoryView.tsx` (add the `shared/lessons` import; strip the marker in the reflected-lessons list)

**Interfaces:**
- Consumes: `parseLessonBullet` from Task 1.
- Produces: nothing new (display-only).

**Note:** The renderer has no unit-test harness, so this task is verified by `typecheck` + `build` (consistent with the rest of the renderer). No unit test.

- [ ] **Step 1: Add the import**

In `src/renderer/run/HistoryView.tsx`, add next to `import { effortByTask } from '../../shared/effort'`:

```ts
import { parseLessonBullet } from '../../shared/lessons'
```

- [ ] **Step 2: Strip the marker in the lessons list**

Find:

```tsx
              {r.lessons.length > 0 && (
                <ul>
                  {r.lessons.map((l, j) => (
                    <li key={j}>{l}</li>
                  ))}
                </ul>
              )}
```

Replace with:

```tsx
              {r.lessons.length > 0 && (
                <ul>
                  {r.lessons.map((l, j) => (
                    <li key={j}>{parseLessonBullet(l).text}</li>
                  ))}
                </ul>
              )}
```

- [ ] **Step 3: Verify typecheck + build**

Run: `npm run typecheck` → Expected: no errors.
Run: `npm run build` → Expected: builds clean.

- [ ] **Step 4: Run the full test suite (regression guard)**

Run: `npx vitest run` → Expected: all green (this change touches no tested code).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/run/HistoryView.tsx
git commit -m "feat(memory): strip scope marker when displaying lessons in History"
```

---

## Final verification

After all five tasks:

- [ ] Run: `npx vitest run` → all tests green (59 existing + the new `lessons`, `lessonsDigest`, `normalizeLessonInput`, and `mergeMemory` tests).
- [ ] Run: `npm run typecheck` → no errors.
- [ ] Run: `npm run build` → clean.
- [ ] **Live smoke (manual):** run a goal, let a worker reflect, open `.ai-manager/agents/<slug>/memory.md` and confirm new lessons carry `[portable]`/`[project]` markers; on the next run, confirm the routing digest (manager's assign step) only carries portable/untagged lessons. Confirm History shows lessons without the raw marker.

## Self-review notes (coverage)

- Spec §1 taxonomy + single source of truth → Task 1.
- Spec §2 classification (reflectPrompt/reflectStep/normalize) → Task 3.
- Spec §3 storage & merge (dedup-by-text, export) → Task 4.
- Spec §4 routing payoff (lessonsDigest) → Task 2.
- Spec §4 untagged-eligible-for-routing → Task 2 (the "keeps untagged eligible" test).
- Spec §5 testing (lessons.test, nodes.test extensions, project-store.test) → Tasks 1–4.
- Spec §6 HistoryView marker strip → Task 5.
- Spec §6 "no shared-type/store/applyReflection-signature changes" → honored (markers ride in `string[]`).
- Spec "no bulk migration" → honored (untagged handled at read time; nothing rewrites existing files).
