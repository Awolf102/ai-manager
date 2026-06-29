# Papercuts sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close 10 leftover audit Minor findings (correctness / security / robustness), each small and
independent, without changing off-path behavior.

**Architecture:** Four file-cohesive tasks: (1) shared pure-function correctness, (2) team-brain/import
integrity, (3) project-store security, (4) main-process hardening. Most fixes are unit-tested in existing
`*.test.ts`; the two Electron-config items (CSP) are verified by build + the directive constant.

**Tech Stack:** TypeScript, Vitest, Electron. Pure logic in `src/shared`, engine/main in `src/main`.

**Spec:** `docs/superpowers/specs/2026-06-29-papercuts-sweep-design.md`

## Global Constraints

- **Off-path byte-for-byte:** every fix is a no-op on the unaffected path (non-trailing-slash paths, non-dotfile
  names, non-svg thumbnails, unique memberIds, single-header runs, dev mode for CSP, alive ptys).
- **No new dependencies.** No renderer redesign (UX Minors are deferred to the Orkestr overhaul).
- **Verification gates:** `npm test` (currently 365 green), `npm run typecheck` (node+web), `npm run build`.
- Tasks are file-disjoint and independent; implement in order but any order is safe.

---

## Task 1: shared pure-function correctness (`narrate`, `uniqueContextName`, `cappedFromDisplay`)

**Files:**
- Modify: `src/shared/narrate.ts` (`basename` ~58-62, `host` ~65-68)
- Modify: `src/shared/context-files.ts` (`uniqueContextName` ~15-25)
- Modify: `src/shared/effort.ts` (add `cappedFromDisplay`); `src/renderer/run/RunView.tsx` (line 5 import, line 141)
- Test: `src/shared/narrate.test.ts`, `src/shared/context-files.test.ts`, `src/shared/effort.test.ts`

**Interfaces:**
- Produces: `cappedFromDisplay(assignments: Assignment[], workerId: string): Effort | undefined` in `effort.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `src/shared/narrate.test.ts` (inside `describe('narrateTool', …)`):

```ts
  it('narrates the last segment for a trailing-slash path (not the whole path)', () => {
    expect(narrateTool('Read', { file_path: '/a/b/c/' })).toBe('Reading c')
  })

  it('strips userinfo from a fetched host', () => {
    expect(narrateTool('WebFetch', { url: 'https://user:pass@example.com/page' })).toBe('Fetching example.com')
  })
```

Add to `src/shared/context-files.test.ts`:

```ts
  it('keeps the whole leading-dot name as the stem on collision', () => {
    expect(uniqueContextName(['.env'], '.env')).toBe('.env-2')
  })
```

Add to `src/shared/effort.test.ts` (import `cappedFromDisplay` alongside the existing effort imports):

```ts
describe('cappedFromDisplay', () => {
  const A = (childId: string, effort?: string, assignedEffort?: string) =>
    ({ taskId: 't', childId, reason: 'r', ...(effort ? { effort } : {}), ...(assignedEffort ? { assignedEffort } : {}) }) as unknown as Assignment
  it('returns undefined when the pre-clamp effort is not above the actual effort', () => {
    // task A ran at max (no cap), task B requested xhigh→clamped to max: cappedFrom=xhigh < max → hide
    const as = [A('w', 'max'), A('w', 'max', 'xhigh')]
    expect(cappedFromDisplay(as, 'w')).toBeUndefined()
  })
  it('returns the pre-clamp effort when it is strictly above the actual effort', () => {
    // a genuine cap: ran at low, requested high
    const as = [A('w', 'low', 'high')]
    expect(cappedFromDisplay(as, 'w')).toBe('high')
  })
})
```

(`Assignment` is already imported in `effort.test.ts`; if not, add `import type { Assignment } from './types'`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/shared/narrate.test.ts src/shared/context-files.test.ts src/shared/effort.test.ts`
Expected: the 4 new cases FAIL (`Reading /a/b/c/`, `Fetching user:pass@example.com`, `.env` → `-2.env`,
`cappedFromDisplay` is not a function).

- [ ] **Step 3: Fix `narrate.ts`**

Replace `basename` and `host` (`narrate.ts:57-68`):

```ts
/** Last path segment (handles / and \ and a trailing separator), or '' for an empty string. */
function basename(p: string): string {
  if (!p) return ''
  const trimmed = p.replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  return trimmed.split(/[\\/]/).pop() || trimmed
}

/** Best-effort host from a URL via regex (no URL/DOM dependency); drops any userinfo. Falls back to input. */
function host(u: string): string {
  const m = u.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i)
  const authority = m ? m[1] : u
  return authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
}
```

- [ ] **Step 4: Fix `uniqueContextName` (`context-files.ts:18-24`)**

```ts
export function uniqueContextName(existing: string[], original: string): string {
  const taken = new Set(existing)
  if (!taken.has(original)) return original
  const dot = original.lastIndexOf('.')
  // a leading-dot name (".env") has no real extension — treat the whole thing as the stem
  const hasExt = dot > 0
  const stem = hasExt ? original.slice(0, dot) : original
  const ext = hasExt ? original.slice(dot) : ''
  let i = 2
  while (taken.has(`${stem}-${i}${ext}`)) i++
  return `${stem}-${i}${ext}`
}
```

- [ ] **Step 5: Add `cappedFromDisplay` + wire `RunView`**

In `src/shared/effort.ts`, add after `cappedFrom`:

```ts
/** The "capped from" effort to DISPLAY: the pre-clamp effort only when it is strictly above the effort the
 *  worker actually ran at (so the badge never claims a cap down to a lower level). undefined otherwise. */
export function cappedFromDisplay(assignments: Assignment[], workerId: string): Effort | undefined {
  const eff = effortOfWorker(assignments, workerId)
  const capped = cappedFrom(assignments, workerId)
  if (!capped || !eff) return undefined
  return EFFORT_LEVELS.indexOf(capped) > EFFORT_LEVELS.indexOf(eff) ? capped : undefined
}
```

In `src/renderer/run/RunView.tsx`: change the import (line 5) to
`import { effortOfWorker, cappedFromDisplay } from '../../shared/effort'` and line 141 to
`const capped = isLeaf ? cappedFromDisplay(allAssignments, id) : undefined`.

- [ ] **Step 6: Run the tests + full suite + typecheck**

Run: `npx vitest run src/shared/narrate.test.ts src/shared/context-files.test.ts src/shared/effort.test.ts`
→ all pass. Then `npm test` (expect 365 + 4 = 369), `npm run typecheck` → clean.

- [ ] **Step 7: Commit**

```bash
git add src/shared/narrate.ts src/shared/context-files.ts src/shared/effort.ts src/renderer/run/RunView.tsx src/shared/narrate.test.ts src/shared/context-files.test.ts src/shared/effort.test.ts
git commit -m "fix(papercuts): narrate trailing-slash/userinfo, dotfile context name, capped-from display

narrate basename strips a trailing separator; host drops userinfo.
uniqueContextName keeps a leading-dot name whole. New cappedFromDisplay shows
'capped from X' only when X is strictly above the actual effort (no more
'max capped from xhigh'). All pure, unit-tested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: team-brain / import integrity (lessons cap + memberId de-dup)

**Files:**
- Modify: `src/shared/team-brain.ts` (`mergeBrainPush` ~28-50; reuse the 40 cap)
- Modify: `src/shared/team-bundle.ts` (`validateTeamBundle` loop ~113-142)
- Test: `src/shared/team-brain.test.ts`, `src/shared/team-bundle.test.ts`

**Interfaces:**
- No new exported symbols; both functions keep their signatures.

- [ ] **Step 1: Write the failing tests**

Add to `src/shared/team-brain.test.ts` (mirror its existing bundle-builder helpers; a `TeamBundle` needs
`kind:'ai-manager-team', version:1, name, exportedAt, members, edges`):

```ts
  it('caps a brain member lessons union at 40 newest-first on push', () => {
    const member = (id: string, lessons: string[]) => ({ memberId: id, name: id, kind: 'worker' as const, model: 'm', permissionMode: 'acceptEdits' as const, icon: '🤖', position: { x: 0, y: 0 }, role: '', lessons })
    const brain = { kind: 'ai-manager-team' as const, version: 1 as const, name: 'b', exportedAt: 'E', members: [member('w', Array.from({ length: 30 }, (_, i) => `old ${i}`))], edges: [] }
    const proj = { kind: 'ai-manager-team' as const, version: 1 as const, name: 'p', exportedAt: 'E', members: [member('w', Array.from({ length: 30 }, (_, i) => `new ${i}`))], edges: [] }
    const out = mergeBrainPush(brain, proj)
    const merged = out.members.find((m) => m.memberId === 'w')!
    expect(merged.lessons).toHaveLength(40)              // capped (was 30+30=60)
    expect(merged.lessons).toContain('new 29')          // newest kept
    expect(merged.lessons).not.toContain('old 0')       // oldest dropped
  })
```

Add to `src/shared/team-bundle.test.ts`:

```ts
  it('drops a member with a duplicate memberId (keeps the first) with a warning', () => {
    const raw = {
      kind: 'ai-manager-team', version: 1, name: 't', exportedAt: 'E',
      members: [
        { memberId: 'x', name: 'First', kind: 'worker' },
        { memberId: 'x', name: 'Second', kind: 'worker' }
      ],
      edges: []
    }
    const res = validateTeamBundle(raw)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.bundle.members).toHaveLength(1)
    expect(res.bundle.members[0].name).toBe('First')
    expect(res.warnings.some((w) => w.toLowerCase().includes('duplicate'))).toBe(true)
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/shared/team-brain.test.ts src/shared/team-bundle.test.ts`
Expected: FAIL — merged lessons length 60 (no cap); both `x` members kept (length 2).

- [ ] **Step 3: Cap lessons in `mergeBrainPush` (`team-brain.ts`)**

In `mergeBrainPush`, change the union line so the result is capped newest-first (incoming/new before existing,
to match the read-side `[...fresh, ...existing].slice(0, 40)` ordering). Replace the
`if (existing) existing.lessons = unionLessons(existing.lessons, pm.lessons)` line with:

```ts
    if (existing) existing.lessons = unionLessons(pm.lessons, existing.lessons).slice(0, 40)
```

(Note: `unionLessons(pm.lessons, existing.lessons)` puts the project's newer lessons first; `.slice(0, 40)`
keeps the newest 40, mirroring `mergeLessons`'s `slice(0, 40)` at `team-brain.ts:96`.)

- [ ] **Step 4: Drop duplicate memberIds in `validateTeamBundle` (`team-bundle.ts`)**

Add a `seenIds` set before the members loop (after `const members: TeamMember[] = []`, line 114):

```ts
  const seenIds = new Set<string>()
```

Inside the loop, right after the memberId/name type check (after line 119's closing `}`), add:

```ts
    if (seenIds.has(mm.memberId)) { warnings.push(`${mm.name}: duplicate memberId dropped`); continue }
    seenIds.add(mm.memberId)
```

- [ ] **Step 5: Run the tests + full suite + typecheck**

Run: `npx vitest run src/shared/team-brain.test.ts src/shared/team-bundle.test.ts` → pass. Then `npm test`
(expect +2), `npm run typecheck` → clean. (The existing round-trip/import tests use unique memberIds, so they
are unaffected.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/team-brain.ts src/shared/team-bundle.ts src/shared/team-brain.test.ts src/shared/team-bundle.test.ts
git commit -m "fix(papercuts): cap pushed brain lessons at 40; drop duplicate memberIds on import

mergeBrainPush now caps a member's unioned lessons at 40 newest-first
(mirrors the read-side cap; the brain no longer grows unbounded).
validateTeamBundle drops a member whose memberId duplicates an earlier one
(keeps the first, warns) so colliding ids can't mis-wire edges or collapse
brain members.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: project-store security (SVG thumbnails + auto-sync path re-validation)

**Files:**
- Modify: `src/main/engine/project-store.ts` (`contextThumbnail` ~418-430; `autoPullFromTeam`/`autoPushToTeam`
  ~666-688 or the `readTeamBrain`/`syncToTeam` they call)
- Test: `src/main/engine/project-store.test.ts` (or `project-store.context.test.ts` for the thumbnail)

**Interfaces:**
- No signature changes. A new module-local `async function isValidBrainPath(p: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

Add to `src/main/engine/project-store.test.ts` (it has `openProject`, `tmpProject`, `addContextFiles`,
`contextThumbnail`, `fs`, `join`; for the auto-sync test it has `updateSettings`, `autoPushToTeam`, and the
linked-team plumbing — mirror the existing brain-sync tests' setup):

```ts
describe('papercuts: project-store security', () => {
  it('contextThumbnail returns null for an .svg (no inline svg data URL)', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    const svg = join(proj, 'logo.svg')
    await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8')
    const g = await addContextFiles([svg])
    const entry = g.graph.context!.find((c) => c.fileName.endsWith('.svg'))!
    expect(await contextThumbnail(entry.id)).toBeNull()
  })

  it('autoPushToTeam skips writing when the linked brain path is missing or not .json', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    // link a brain path that does not exist, enable auto-sync
    await updateSettings({ autoSyncTeam: true })
    // (use the project-store API the existing brain-sync tests use to set graph.linkedTeam to a bogus path)
    // Then: autoPushToTeam must NOT throw and must NOT create the file.
    const bogus = join(proj, 'nope.json')
    // link via syncToTeam to a real path first, then point linkedTeam at a deleted path — see note below.
    await autoPushToTeam() // unlinked or invalid → no-op
    expect(existsSync(bogus)).toBe(false)
  })
})
```

> Implementer note for the auto-sync test: `autoPushToTeam` is already a no-op when unlinked, so to genuinely
> exercise the *new* guard, link a brain (via the same API the existing `team brain sync` describe uses —
> `syncToTeam(path, teamId)` then confirm `getLinkedTeam()`), then make the linked path invalid (delete it or
> point it at a non-`.json` path) and assert `autoPushToTeam()` neither throws nor recreates it. If wiring a
> genuine linked-then-invalidated path is awkward in the harness, assert the new `isValidBrainPath` helper
> directly (export it for the test) — the guard is the deliverable; bind the test to whichever is clean.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/engine/project-store.test.ts -t "project-store security"`
Expected: the thumbnail test FAILS (returns an `image/svg+xml` data URL, not null).

- [ ] **Step 3: Skip SVG in `contextThumbnail`**

In `contextThumbnail` (`project-store.ts:418`), add an early `.svg` guard. Replace the body's guard +
mime line:

```ts
export async function contextThumbnail(id: string): Promise<string | null> {
  const { path, graph } = requireCurrent()
  const entry = (graph.context ?? []).find((c) => c.id === id)
  if (!entry || !entry.isImage || entry.bytes > 5_000_000) return null
  const ext = entry.fileName.slice(entry.fileName.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'svg') return null // never hand an attacker-influenced SVG to the renderer as an <img src>
  try {
    const buf = await fs.readFile(aimPath(path, CONTEXT_DIR, entry.fileName))
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
```

(`ContextModal.tsx` already handles a `null` thumbnail — it shows the generic file affordance; verify it does
and leave it unchanged.)

- [ ] **Step 4: Re-validate the linked path before auto-sync**

Add a module-local helper near the team-sync functions:

```ts
/** True when `p` is an existing regular .json file — guards auto-sync against a moved/redirected link. */
async function isValidBrainPath(p: string): Promise<boolean> {
  if (!p.toLowerCase().endsWith('.json')) return false
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}
```

In `autoPullFromTeam` (after `const brain = ...`? no — guard the path first): add the path check at the top of
both auto functions, right after the `if (!getSettings().autoSyncTeam || !link) return …` line:

```ts
    if (!(await isValidBrainPath(link.path))) return 0 // (autoPull: return 0; autoPush: return)
```

For `autoPushToTeam` use `return` (it returns void). Both stay best-effort (no throw, no notice — matching
today's silent best-effort contract; the guard simply prevents writing to/reading a relocated or non-`.json`
target). Manual `syncTeam`/`refreshTeam` via dialog are unchanged.

- [ ] **Step 5: Run the tests + full suite + typecheck**

Run: `npx vitest run src/main/engine/project-store.test.ts` → pass. Then `npm test`, `npm run typecheck` →
clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "fix(papercuts): skip svg thumbnails; re-validate linked brain path before auto-sync

contextThumbnail returns null for .svg (no inline image/svg+xml data URL to
the renderer). autoPull/autoPushToTeam skip when the linked brain path is
missing or not a regular .json file, instead of blindly reading/overwriting a
relocated or redirected target.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: main-process hardening (writePty guard, per-run header gate, production CSP)

**Files:**
- Modify: `src/main/engine/pty-manager.ts` (`writePty` ~59-61)
- Modify: `src/main/engine/orchestrator.ts` (`makeDeps` `runAgent` wrapper ~80)
- Modify: `src/main/index.ts` (`app.whenReady` / a new CSP setup ~38-44)
- Test: `src/main/engine/pty-manager.test.ts` (create if absent) and/or a pure header-gate helper test

**Interfaces:**
- New module-local pure `function headerGate(seen: Set<string>, agentId: string, explicit?: boolean): boolean`
  in `orchestrator.ts` (exported for test): returns whether to print the header, mutating `seen`.

- [ ] **Step 1: Write the failing tests**

Header gate — add `src/main/engine/orchestrator.header.test.ts` (pure, no Electron):

```ts
import { describe, it, expect } from 'vitest'
import { headerGate } from './orchestrator'

describe('headerGate', () => {
  it('prints the header only on the first call per agent in a run', () => {
    const seen = new Set<string>()
    expect(headerGate(seen, 'a')).toBe(true)
    expect(headerGate(seen, 'a')).toBe(false)
    expect(headerGate(seen, 'b')).toBe(true)
  })
  it('respects an explicit header choice', () => {
    const seen = new Set<string>()
    expect(headerGate(seen, 'a', false)).toBe(false) // explicit false wins
    expect(headerGate(seen, 'a')).toBe(true)         // still first real print for a
  })
})
```

writePty — add `src/main/engine/pty-manager.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { writePty } from './pty-manager'

describe('writePty', () => {
  it('does not throw for an unknown/dead pty id', () => {
    expect(() => writePty('no-such-pty', 'x')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/engine/orchestrator.header.test.ts src/main/engine/pty-manager.test.ts`
Expected: header test FAILS (`headerGate` not exported); the writePty test passes already for an *unknown* id
(the optional-chain handles a missing entry) — it guards against the post-exit throw, so keep it as a
regression guard (note this in the report).

- [ ] **Step 3: Guard `writePty` (`pty-manager.ts:59-61`)**

```ts
export function writePty(ptyId: string, data: string): void {
  try {
    sessions.get(ptyId)?.proc.write(data)
  } catch {
    // pty may have exited between the keystroke and onExit deleting the session — drop it
  }
}
```

- [ ] **Step 4: Add `headerGate` + wire the orchestrator `runAgent` wrapper**

In `src/main/engine/orchestrator.ts`, add the exported helper (top-level):

```ts
/** Whether to print an agent's "▶ name · model" banner: once per agentId per run (or an explicit choice). */
export function headerGate(seen: Set<string>, agentId: string, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit
  if (seen.has(agentId)) return false
  seen.add(agentId)
  return true
}
```

In `makeDeps`, wrap `streamAgent` so the header is gated per run. Replace the `runAgent: streamAgent` field in
the `eng` literal (`orchestrator.ts:80`) with a wrapper that owns a per-run `Set`:

```ts
  const headersPrinted = new Set<string>()
  const runAgent: Eng['runAgent'] = (opts) =>
    streamAgent({ ...opts, header: headerGate(headersPrinted, opts.agentId, opts.header) })
  const eng: Eng = { wc, abort, runId, runAgent, emit: emitFn, handoffs: [] }
```

(`StreamAgentOptions.header?: boolean` already exists — `agent-runner.ts:101` reads it; `role-drafter`/
`manifest-detector` call `streamAgent` directly and are unaffected. `headersPrinted` lives per `makeDeps` call
= per run/resume.)

- [ ] **Step 5: Add a production-only CSP (`main/index.ts`)**

In `src/main/index.ts`, import `session` from electron and set a CSP header in production only. Change the
import line and add the CSP in `app.whenReady` BEFORE `createWindow()`:

```ts
import { app, BrowserWindow, shell, session } from 'electron'
```

```ts
app.whenReady().then(() => {
  ensureLoginPath()
  // Production-only CSP (defense-in-depth). Skipped in dev so Vite HMR/websocket are untouched.
  if (!process.env.ELECTRON_RENDERER_URL) {
    const CSP =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } })
    })
  }
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
```

- [ ] **Step 6: Run tests + typecheck + build (build is the CSP gate)**

Run: `npx vitest run src/main/engine/orchestrator.header.test.ts src/main/engine/pty-manager.test.ts` → pass.
Then `npm test` (expect the new tests), `npm run typecheck` → clean, and `npm run build` → clean.

- [ ] **Step 7: Manual CSP smoke (note in report, do not block on it)**

The implementer cannot launch the Electron app here; record in the report that the CSP is production-only and
the directive set allows: `'self'` scripts/styles/connect, `data:` images (context thumbnails), and
`'unsafe-inline'` styles (xterm/React inject styles). Flag for the controller that a one-time manual prod-build
launch should confirm the renderer loads, terminals work, and context thumbnails render.

- [ ] **Step 8: Commit**

```bash
git add src/main/engine/pty-manager.ts src/main/engine/orchestrator.ts src/main/index.ts src/main/engine/orchestrator.header.test.ts src/main/engine/pty-manager.test.ts
git commit -m "fix(papercuts): guard writePty; per-run terminal header; production CSP

writePty wraps the write in try/catch (a keystroke after pty exit can throw).
The orchestrator runAgent wrapper prints an agent's banner once per run via a
headerGate, not on every sub-step. A production-only CSP (onHeadersReceived,
skipped in dev) hardens the renderer.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (before the whole-branch review)

- [ ] `npm test` — full suite green (365 + ~9 new).
- [ ] `npm run typecheck` (node+web) clean; `npm run build` clean.
- [ ] Diff sweep for the Global Constraints: each fix is a no-op on its unaffected path; no UX redesign; CSP is
      production-gated.

---

## Self-Review (against the spec)

**Spec coverage:** narrate (T1), uniqueContextName (T1), cappedFromDisplay (T1), mergeBrainPush cap (T2),
memberId de-dup (T2), contextThumbnail SVG (T3), brain-path re-validate (T3), writePty (T4), header gate (T4),
CSP (T4) — all 10 mapped. Dropped items (`setStatus`, `effortByTask`) correctly absent. ✓

**Placeholder scan:** the only soft spot is the Task-3 auto-sync test's linked-path setup, which is flagged
with a concrete fallback (assert `isValidBrainPath` directly) — not a silent TODO; the guard is the concrete
deliverable.

**Type consistency:** `cappedFromDisplay(assignments, workerId)` used identically in `effort.ts` + `RunView`;
`headerGate(seen, agentId, explicit?)` used identically in the test + `makeDeps`; `isValidBrainPath(p)` local
to project-store; no signature changes to `mergeBrainPush`/`validateTeamBundle`/`contextThumbnail`/`writePty`.
