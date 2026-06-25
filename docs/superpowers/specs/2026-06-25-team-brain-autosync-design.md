# Living Team — Automatic Brain Sync (sub-project B2b)

**Date:** 2026-06-25
**Status:** Approved design, ready for implementation planning
**Roadmap:** Compounding-team work, part (b2b). A thin, opt-in automation layer over **b2a** (manual
team-brain sync). Builds on A (portable/project lesson tagging) and B1/B2a.

## Motivation

B2a lets a user manually **Sync to team** (push) and **Refresh from team** (pull) against a shared
"team brain" file. B2b makes that hands-off: when a project is linked to a brain and auto-sync is on,
each run **pulls** the brain's latest portable lessons before working and **pushes** the lessons it
learned afterward — so a team's general (portable-only) knowledge compounds across every project it
touches without anyone pressing a button. Only `[portable]` lessons ever travel (the brain is built
via `portableLessons`), so project-specific facts never leak between projects.

## Goals

- When **linked** to a team brain **and** `autoSyncTeam` is on: **pull at run start** (refresh agents
  from the brain) and **push at run finish** (sync newly-learned portable lessons back).
- Reuse b2a's `syncToTeam`/`refreshFromTeam` and A's portable-only filter unchanged — no new merge or
  sync logic.
- Auto-sync is **best-effort**: it can never block or fail a run.

## Non-goals (out of scope)

- Syncing at any moment other than the two run boundaries.
- Per-agent or selective auto-sync; choosing which lessons sync (push is always portable-only).
- Any conflict handling beyond b2a's union + dedup-by-text merge.
- A live progress indicator for auto-sync (it's silent; the linked-team indicator already shows the link).

## Decisions locked in brainstorming

- **(A)** `autoSyncTeam` default **off** (opt-in) — auto-writing to a shared file each run is a real
  side effect; the user enables it per project once they trust the manual flow.
- **(B)** Triggers: **pull at run start**, **push at run finish** (after reflections are written).
- **(C)** Auto-sync failures are **best-effort** — caught and logged; the run proceeds normally.

## Architecture

A new opt-in setting, two small `project-store` helpers that wrap b2a's sync, and two `orchestrator.ts`
call sites. No renderer changes beyond a Settings checkbox.

### Setting — `src/shared/types.ts`

Add `autoSyncTeam: boolean` to `ProjectSettings` (and `false` to `DEFAULT_SETTINGS`). Old graphs get
the default via the existing `openProject` `{ ...DEFAULT_SETTINGS, ...graph.settings }` merge.

### Helpers — `src/main/engine/project-store.ts`

```ts
/** Read + validate a team-brain file. Returns null on missing/unreadable/invalid. */
export async function readTeamBrain(path: string): Promise<TeamBundle | null>

/** PULL if enabled + linked: refresh agents from the linked brain. Returns agents updated (0 if off/unlinked/failed). */
export async function autoPullFromTeam(): Promise<number>

/** PUSH if enabled + linked: sync this project's portable lessons back to the linked brain. */
export async function autoPushToTeam(): Promise<void>
```

- `readTeamBrain` centralizes the read→`JSON.parse`→`validateTeamBundle` sequence (the manual
  `team:refreshFrom` IPC handler is refactored to reuse it — a small DRY win, behavior unchanged).
- `autoPullFromTeam`: if `getSettings().autoSyncTeam` and `getLinkedTeam()` (call it `link`), then
  `readTeamBrain(link.path)`; if a bundle comes back, `refreshFromTeam(bundle, link.path)` and return
  its `updated` count. Otherwise return `0`. Its own errors are caught → return `0` (best-effort).
- `autoPushToTeam`: if enabled and linked, `syncToTeam(link.path, link.teamId)`. Errors caught →
  no-op. (Reuses b2a's portable-only `syncToTeam`.)

### Hooks — `src/main/engine/orchestrator.ts`

- **Pull:** at the very start of `startRun` (before the graph drives), `await autoPullFromTeam()`,
  wrapped in `try/catch`. Because it merges into each agent's `memory.md` and agent memory is injected
  per session at run time, the pulled lessons are in effect for this run.
- **Push:** in `finishRun` (after the graph reaches END, so the run's reflections are already written
  to `memory.md`), `await autoPushToTeam()`, wrapped in `try/catch`.
- Both helpers self-gate on the setting + link, so the orchestrator calls them unconditionally; the
  `try/catch` guarantees an auto-sync error never propagates into the run.

### Settings UI — `src/renderer/SettingsModal.tsx`

A checkbox bound to `autoSyncTeam`: **"Auto-sync team brain — pull lessons before a run, push after"**
(mirrors the existing `reflection`/`adaptiveEffort` checkboxes). Updates via the existing
`updateSettings` path.

## Data flow (one run, auto-sync on + linked)

`startRun` → `autoPullFromTeam` (read+validate brain → `refreshFromTeam` merges portable lessons into
agents) → graph runs (agents work with the merged lessons; reflection writes new portable lessons) →
`finishRun` → `autoPushToTeam` (`syncToTeam` pushes the new portable lessons into the brain).

## Error handling

- **Off / not linked:** both helpers no-op (return `0` / nothing).
- **Brain file missing/moved/unreadable/invalid:** `readTeamBrain` → `null` → pull no-ops; a push to a
  missing path fails inside `syncToTeam` and is caught → no-op. Either way the run is unaffected.
- **Any thrown error in pull/push:** caught in the helper and again in the orchestrator `try/catch`;
  the run starts/finishes normally.

## Testing

- `src/main/engine/project-store.test.ts` (extend): `readTeamBrain` (valid file → bundle; missing path
  → null; invalid JSON/bundle → null). `autoPullFromTeam`/`autoPushToTeam` gating — with `autoSyncTeam`
  off → no-op (no file written / `0`); with it on + a linked brain → pull merges a lesson into a
  matching agent and push writes the brain (a temp-project round-trip like b2a's).
- The orchestrator hooks (call sites + `try/catch`) and the Settings checkbox are verified by
  `typecheck` + `build`.

## File-by-file summary

| File | Change |
|------|--------|
| `src/shared/types.ts` | `ProjectSettings.autoSyncTeam` + `DEFAULT_SETTINGS.autoSyncTeam = false` |
| `src/main/engine/project-store.ts` | `readTeamBrain`, `autoPullFromTeam`, `autoPushToTeam`; refactor the manual refresh handler's read to reuse `readTeamBrain` |
| `src/main/ipc.ts` | `team:refreshFrom` handler reads via `readTeamBrain` (DRY; behavior unchanged) |
| `src/main/engine/orchestrator.ts` | `autoPullFromTeam()` at `startRun` start; `autoPushToTeam()` at `finishRun`; both in `try/catch` |
| `src/main/engine/project-store.test.ts` | extend — `readTeamBrain` + auto-pull/push gating round-trip |
| `src/renderer/SettingsModal.tsx` | `autoSyncTeam` checkbox |

No changes to the merge logic, the team-bundle format, or the renderer beyond the settings checkbox.

## Risks / edge cases

- **A linked brain file moved/deleted:** auto-pull/push silently no-op; the manual buttons re-link via
  their dialogs. No run impact, no data loss.
- **Latency:** pull adds one brain read + per-agent memory merge at run start; push adds one brain
  write at finish. Small relative to a run; both off the critical correctness path.
- **A run with no reflections** (e.g. reflection disabled, or no owned tasks): push finds no new
  portable lessons → the brain is unchanged (idempotent). Harmless.
- **Concurrent projects pushing to one brain:** single-user app, one project open at a time; b2a's
  union-merge already handles accumulation. Out of scope to lock.
