# Memory Quality — Portable vs Project-Specific Lessons (sub-project A)

**Date:** 2026-06-25
**Status:** Approved design, ready for implementation planning
**Roadmap:** Compounding-team work, part (a). Part (b) "portable team across folders" is a
separate later spec that builds on this one.

## Motivation

Each worker accumulates `lessons` in its `memory.md` via the reflection step. Today every lesson
is an undifferentiated bullet. Two problems follow:

1. **Negative transfer (the reason this is the foundation for the portable team, B).** When we
   later carry a team's memory to a *new* project folder, project-specific quirks ("the API key is
   in `config/secrets.json`") would travel along and pollute the new project. We must be able to
   separate reusable wisdom from local facts before B is safe to build.
2. **Routing noise (the payoff we cash in now).** The routing track-record digest built in roadmap
   item #1 (`lessonsDigest`) feeds a child's recent lessons to its manager as a capability signal.
   A portable lesson ("I always verify a page's assets return 200") is a great signal; a project
   fact is noise. Tagging lets routing read capability, not trivia.

## Goals

- Classify each new lesson as **`portable`** or **`project`** at reflection time.
- Store the tag inline in `memory.md` so the file stays human-readable and self-describing.
- Make the routing digest (`lessonsDigest`) surface portable (and legacy-untagged) lessons and
  exclude project-specific ones.
- Centralize the marker convention in one tested module so reflection, merge, routing, and the
  future B all agree on it.

## Non-goals (explicitly out of scope)

- **Sub-project B** (carrying a roster + memories across project folders) — separate spec.
- The **Stage-3 human-approval gate** on memory writes — still deferred.
- A **third taxonomy tier** (e.g. "stack-specific") — YAGNI; binary only. Can revisit.
- **Bulk migration** of existing `memory.md` files — handled gracefully at read time instead.
- Any **UI for editing/curating tags** beyond the small HistoryView display tweak below.
- Changing how a worker's own `memory.md` is injected into its prompt (markers stay visible to the
  agent — harmless and mildly informative).

## Taxonomy

Two scopes, defined for the model and for code:

- **`portable`** — general software-engineering wisdom that would help on *any* project:
  testing/verification/debugging habits, process rules, review reflexes. Travels across projects.
- **`project`** — a fact or convention specific to *this* codebase or goal: file paths, build/run
  commands, config locations, domain rules, repo-specific library quirks. Does *not* transfer.

**Conservative default:** when scope is missing, ambiguous, or unparseable, treat as `project`.
(Cheap to under-share a lesson; expensive to wrongly transfer one.)

## Architecture

### New module: `src/shared/lessons.ts` (single source of truth)

Pure, no node/DOM imports (sibling of `shared/effort.ts` / `shared/run-state.ts`), unit-tested in
plain Node. Defines the marker convention exactly once.

```ts
export type LessonScope = 'portable' | 'project'

/** Parse a lesson bullet's leading scope marker. `null` scope = legacy/untagged. */
export function parseLessonBullet(raw: string): { scope: LessonScope | null; text: string }
//   "[portable] write a failing test first" -> { scope: 'portable', text: 'write a failing test first' }
//   "[PROJECT]  migrations in db/migrate"   -> { scope: 'project',  text: 'migrations in db/migrate' }
//   "verify renders return 200"             -> { scope: null,       text: 'verify renders return 200' }

/** Render a lesson with its marker, for writing into memory.md. */
export function formatLessonBullet(scope: LessonScope, text: string): string
//   ('portable', 'write a failing test first') -> "[portable] write a failing test first"
```

Marker match is case-insensitive and tolerant of surrounding whitespace; `text` is trimmed.

### Reflection (`src/main/engine/nodes.ts`)

- **`reflectPrompt`** — ask for lessons as objects carrying a `scope`, with the criteria above and
  an explicit "when unsure, use `project`". New JSON shape:

  ```json
  { "win": "...", "loss": "...", "lessons": [ { "text": "...", "scope": "portable" } ] }
  ```

- **`normalizeLessonInput(raw): string | null`** — new small exported helper (unit-tested, like
  `maxEffort`/`lessonsDigest`). Maps one raw model lesson to a marker string:
  - object `{ text, scope }` → `formatLessonBullet(scope==='portable' ? 'portable' : 'project', text)`
    (so any non-`portable` scope, including missing/garbage, collapses to `project`).
  - bare string `"foo"` → if it already starts with a valid marker, keep as-is; else
    `formatLessonBullet('project', 'foo')`.
  - empty/whitespace text → `null` (dropped).

- **`reflectStep`** — replace its `lessons` parse with
  `p.lessons.map(normalizeLessonInput).filter(Boolean).slice(0, 6)`. Return type is **unchanged**
  (`{ win, loss, lessons: string[] }`) — the strings now simply carry markers. Therefore
  `reflectNode`, the `reflection` `OrchestrationEvent`, `RunRecord.reflections`, `applyReflection`,
  and the store all keep `lessons: string[]` with **no type changes**.

### Storage & merge (`src/main/engine/project-store.ts`)

`applyReflection` receives marker-bearing strings and writes them as `## Lessons` bullets exactly as
today — **its signature and the file structure are unchanged**. One change inside `mergeMemory`:

- **Dedup by text, ignoring the marker.** Today dedup compares the normalized full bullet. Change
  it to compare `parseLessonBullet(bullet).text` (normalized) so a re-learned lesson doesn't get
  stored twice merely because its scope differs. On a text collision the existing bullet wins (its
  scope is preserved); this also means a lesson never silently flips scope on re-learn.
- Caps (40 lessons / 30 log entries), newest-first ordering, and `(none yet)` placeholder handling
  are unchanged.
- To enable testing, **`export` `mergeMemory`** from `project-store.ts`.

### Routing use (`src/main/engine/nodes.ts` — `lessonsDigest`)

`lessonsDigest` becomes marker-aware:

- For each `## Lessons` bullet, `parseLessonBullet` it.
- **Exclude** bullets with scope `project`.
- **Include** scope `portable` **and** scope `null` (legacy/untagged) — see "Untagged handling".
- Emit the stripped `text` (not the marker) into the routing prompt, keeping the existing
  `maxLessons` / `maxLen` caps and `(none yet)` filtering.

### History display (`src/renderer/run/HistoryView.tsx`)

Minor polish: when rendering reflected lessons, show `parseLessonBullet(l).text` instead of the raw
string so the `[portable]`/`[project]` marker isn't shown verbatim. (Optional faint scope label is
not required.)

## Untagged (legacy) handling — the deliberate asymmetry

Existing `memory.md` files have untagged bullets. Rather than migrate them:

- **Routing (low stakes — a hint):** untagged lessons are **eligible** (treated like portable).
  Rationale: today *all* a team's lessons feed routing; excluding untagged would blank the digest
  for existing teams until they re-reflect. Lenient = no regression.
- **Cross-project transfer for B (high stakes — pollutes a new project):** untagged will be treated
  as **`project`** (not transferred). Conservative.

This asymmetry is intentional and documented here so B inherits the rule. Memory self-heals: new
reflections are tagged, so the untagged population shrinks with use.

## Data flow (one reflection)

1. Worker reflects → model returns `lessons: [{ text, scope }]`.
2. `reflectStep` → `normalizeLessonInput` each → `["[portable] ...", "[project] ..."]`.
3. `reflectNode` → `applyReflection(workerId, { win, loss, lessons, label })`; also emits the
   `reflection` event and records it (lessons carry markers, as plain strings — no type change).
4. `mergeMemory` writes them under `## Lessons`, deduping by text.
5. Next run, the worker's manager routes: `lessonsDigest(workerMemory)` returns portable + untagged
   texts → injected as the track record (project facts filtered out).

## Testing

- **`src/shared/lessons.test.ts`** (new): `parseLessonBullet` (portable, project, case-insensitive,
  whitespace, untagged→null), `formatLessonBullet`, round-trip.
- **`src/main/engine/nodes.test.ts`** (extend):
  - `lessonsDigest`: portable included + marker stripped; `project` excluded; untagged included
    (legacy not regressed); caps still honored.
  - `normalizeLessonInput`: object→marker; `portable` preserved; missing/garbage scope→`project`;
    bare string→`project`; already-marked string kept; empty→`null`.
  - Update the canned agent's reflect JSON to the new `{text, scope}` object form (the e2e/manager
    tests only assert reflection `nodeId`s/counts, so they keep passing).
- **`src/main/engine/project-store.test.ts`** (new, small harness): `vi.mock('electron')` to satisfy
  the top-level `import { app } from 'electron'`; test the exported `mergeMemory` for (a) writing
  marker bullets, (b) dedup-by-text across differing scopes (existing wins), (c) cap preserved.

All existing tests must stay green; with no tags present, `lessonsDigest` and `mergeMemory` behave
as before (untagged path).

## File-by-file change summary

| File | Change |
|------|--------|
| `src/shared/lessons.ts` | **new** — `LessonScope`, `parseLessonBullet`, `formatLessonBullet` |
| `src/shared/lessons.test.ts` | **new** — convention tests |
| `src/main/engine/nodes.ts` | `reflectPrompt` (ask for scope), `normalizeLessonInput` (new, exported), `reflectStep` (use it), `lessonsDigest` (marker-aware filter) |
| `src/main/engine/project-store.ts` | `export mergeMemory`; dedup-by-text (marker-stripped) |
| `src/main/engine/project-store.test.ts` | **new** — `mergeMemory` tests w/ mocked electron |
| `src/main/engine/nodes.test.ts` | extend `lessonsDigest` tests; add `normalizeLessonInput` tests; update canned reflect JSON |
| `src/renderer/run/HistoryView.tsx` | strip marker when displaying reflected lessons |

No changes to `src/shared/types.ts`, `src/renderer/store.ts`, `applyReflection`'s signature, the
`reflection` event shape, or `RunRecord`.

## Risks / edge cases

- **Model ignores the scope field** → `normalizeLessonInput` defaults to `project` (safe).
- **Mixed-scope duplicate text** → dedup keeps the first/existing scope; no oscillation.
- **A genuinely portable lesson mislabeled `project`** → it just won't feed routing / won't transfer;
  the human can edit `memory.md` by hand (it's plain markdown). Acceptable; the Stage-3 approval gate
  (deferred) is the future formal correction path.
- **Legacy-untagged asymmetry** is the one subtlety; documented above and inherited by B.
