# Orkestr — Sub-project 4: Goal & Prompt (quick-reuse past prompts)

**Date:** 2026-06-30
**Parent:** `docs/superpowers/specs/2026-06-29-orkestr-overhaul-direction-design.md` (umbrella).
**Builds on:** Foundation tokens; Shell+IA (incl. the goal box focus-to-expand already shipped in polish `2850259`); Run experience; Canvas.
**Status:** Design approved (brainstorm). Ready for implementation planning.

The fifth sub-project of the Orkestr overhaul (decomposition item 4). Its focus-to-expand half already shipped; this adds the remaining piece — a lightweight quick-reuse picker for past prompts.

---

## 1. Goal

Let the user re-grab a previous goal fast: a compact "Recent" picker in the goal bar that lists past run goals as short labels and, on click, drops the chosen goal back into the prompt box. Select-and-insert only — no editing/deleting here (the History tab + its AI overview remain the full record).

Success = clicking "Recent" shows a short, readable list of recent prompts; picking one fills the goal textarea with that goal, ready to edit or run.

---

## 2. Current state

- `GoalBar.tsx` owns the prompt: `const [goal, setGoal] = useState('')`, the auto-growing + focus-to-expand textarea, and the action buttons (Draft roles / Build team / Launch app / Run, plus the Inspector re-open when collapsed).
- Past runs are available via `window.api.listRuns()` → `RunSummary[]` where `RunSummary = { file: string; goal: string; startedAt: string; status: RunStatus; taskCount: number }`. The History view already consumes this.
- There is no quick way to reuse a past goal short of opening History.

---

## 3. Pure helpers (`recent-prompts.ts`)

New `src/renderer/run/recent-prompts.ts` (pure, no React/DOM):
- `promptLabel(goal: string, maxLen?: number): string` — produce a short, single-line label from a goal: take the first non-empty line, collapse internal whitespace, trim; if the result is empty → `'(no goal)'`; if longer than `maxLen` (default 48) → slice to `maxLen` and append `'…'`. Deterministic.
- `recentGoals(runs: { goal: string; startedAt: string }[], cap?: number): string[]` — sort by `startedAt` descending (most recent first), drop empty/whitespace-only goals, **dedup** identical goals keeping the most-recent occurrence, and cap at `cap` (default 12). Returns the goal strings in display order. Deterministic. (Accepts `RunSummary[]` structurally.)

These are the testable core; the component is a thin shell over them.

---

## 4. "Recent" picker (`RecentPrompts.tsx`)

New `src/renderer/run/RecentPrompts.tsx`, rendered inside `GoalBar`:
- A compact button — a clock/history icon labeled "Recent" — placed in the goal bar near the goal tools.
- **On open** (button click): call `window.api.listRuns()`, compute `recentGoals(runs)`, and show a dropdown list. Each row shows `promptLabel(goal)` with the full goal as the `title` (hover). Loading is cheap (a directory read already used by History); load on each open is fine.
- **On pick:** call `onPick(goal)` (wired to GoalBar's `setGoal`) to replace the textarea contents with the chosen goal, then close. (Select-and-insert: it sets the prompt; the user can edit/run.)
- **Dismiss:** click-outside closes the dropdown (same pattern as the Team menu / Recent components elsewhere — a `mousedown` document listener while open).
- **Empty state:** if `recentGoals` is empty, the dropdown shows "No past prompts yet." (button still clickable).
- Props: `RecentPrompts({ onPick }: { onPick: (goal: string) => void })`. GoalBar renders `<RecentPrompts onPick={setGoal} />`.

GoalBar change is limited to importing + rendering the control (passing `setGoal`); the History tab and its AI overview are untouched.

---

## 5. Out of scope

- AI-generated semantic labels (chose the heuristic `promptLabel`); no engine/IPC/token pipeline.
- Editing, renaming, deleting, pinning, or searching past prompts — select-and-insert only.
- Any change to History, run records, or `listRuns`.
- Appending/merging into existing textarea text — picking replaces the prompt (deliberate select).
- The focus-to-expand behavior (already shipped).

---

## 6. Architecture / units

- **`recent-prompts.ts`** — pure `promptLabel` + `recentGoals`; no deps; the TDD'd core.
- **`RecentPrompts.tsx`** — the dropdown shell: loads runs on open, maps through the pure helpers, renders the list, handles pick + click-outside. Self-contained; takes `onPick`.
- **`GoalBar.tsx`** — import + render `<RecentPrompts onPick={setGoal} />`; no other change.
- **`styles.css`** — the Recent button + dropdown styling (Foundation tokens; mirrors the Team-menu dropdown look).

---

## 7. Testing

Per the project pattern (pure logic TDD'd; UI by typecheck + build + live):
- **Unit (TDD)** `recent-prompts.ts`: `promptLabel` (first line only; whitespace collapsed; empty → "(no goal)"; long → truncated with "…"; short → unchanged) and `recentGoals` (sorted most-recent-first by startedAt; empties dropped; duplicates removed keeping the most recent; capped at `cap`).
- **Type/build:** `tsc` + `npm run build` clean. (Executor note: full build ~9 min has dropped subagent connections — run typecheck in-agent; controller runs the build at the integration gate.)
- **Live verify:** with past runs present, click "Recent" → a short deduped list (most recent first, full goal on hover); pick one → the goal box fills with it; click outside → closes; with no past runs → "No past prompts yet."

---

## 8. Acceptance criteria

1. `promptLabel` and `recentGoals` are pure, deterministic, TDD'd (first-line/whitespace/empty/truncate; sort/dedup/drop-empty/cap).
2. A "Recent" control in the goal bar opens a dropdown of recent past-run goals as short labels (full goal on hover), most-recent-first, deduped, capped.
3. Picking a prompt sets the goal textarea to that goal and closes the dropdown; click-outside dismisses; empty state shown when there are no past runs.
4. History tab + AI overview and run records are unchanged; no AI/label pipeline added.
5. `tsc` + build clean; `recent-prompts` unit tests pass; existing tests still pass; live-verified per §7.
6. No out-of-scope changes (no editing/deleting prompts, no History/listRuns changes, no append-merge).
