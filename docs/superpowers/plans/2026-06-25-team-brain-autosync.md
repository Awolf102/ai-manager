# Automatic Team-Brain Sync (B2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a project is linked to a team brain and the opt-in `autoSyncTeam` setting is on, automatically pull the brain's `[portable]` lessons into the agents at run start and push the run's new lessons back at run finish.

**Architecture:** A new opt-in `ProjectSettings.autoSyncTeam` (default off), two `project-store` helpers (`autoPullFromTeam`/`autoPushToTeam`) that wrap b2a's `refreshFromTeam`/`syncToTeam` and self-gate on the setting + link, plus a shared `readTeamBrain` reader; two best-effort (`try/catch`) hooks in `orchestrator.ts`; and a Settings checkbox. No new merge logic, no IPC changes.

**Tech Stack:** TypeScript, vitest, electron-vite. Commands: `npx vitest run`, `npm run typecheck`, `npm run build`.

## Global Constraints

- **Opt-in, default off:** `ProjectSettings.autoSyncTeam: boolean`, `DEFAULT_SETTINGS.autoSyncTeam = false`. Auto-sync is a no-op unless this is on AND `getLinkedTeam()` is non-null.
- **Pull at run start, push at run finish** (after reflections are already written to `memory.md`).
- **Only `[portable]` lessons travel** — push reuses b2a's `syncToTeam` (portable-only via `buildTeamBundle`); no new filtering.
- **Best-effort:** auto-sync NEVER blocks or fails a run. Helpers swallow their own errors AND the orchestrator wraps each call in `try/catch`.
- **Reuse, don't re-implement:** wrap b2a's `syncToTeam(brainPath, fallbackTeamId)` and `refreshFromTeam(bundle, brainPath)` unchanged.
- **The manual `team:refreshFrom` handler is NOT changed** (it keeps its two distinct error messages); `readTeamBrain` is used only by the auto path.
- **All 103 existing tests must stay green.** The orchestrator hooks + Settings checkbox are verified by `typecheck` + `build` (no orchestrator/renderer harness).
- **Git:** commit per task; append the trailer as the last line (after a blank line): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: `autoSyncTeam` setting + auto-sync helpers (`project-store.ts`)

**Files:**
- Modify: `src/shared/types.ts` (`ProjectSettings.autoSyncTeam` + `DEFAULT_SETTINGS`)
- Modify: `src/main/engine/project-store.ts` (`readTeamBrain`, `autoPullFromTeam`, `autoPushToTeam`)
- Test: `src/main/engine/project-store.test.ts`

**Interfaces:**
- Consumes: existing `getSettings`, `getLinkedTeam`, `syncToTeam`, `refreshFromTeam`, `validateTeamBundle`, `TeamBundle`, `fs` (all in `project-store.ts` from b2a).
- Produces:
  - `ProjectSettings.autoSyncTeam: boolean`
  - `readTeamBrain(path: string): Promise<TeamBundle | null>`
  - `autoPullFromTeam(): Promise<number>` (agents updated; 0 when off / unlinked / failed)
  - `autoPushToTeam(): Promise<void>`

- [ ] **Step 1: Add the setting (`src/shared/types.ts`)**

In `interface ProjectSettings`, add after the `adaptiveEffort: boolean` line:

```ts
  /** auto pull the linked team brain before a run + push after (B2b) */
  autoSyncTeam: boolean
```

In `DEFAULT_SETTINGS`, add after `adaptiveEffort: true` (add a comma to that line):

```ts
  autoSyncTeam: false
```

- [ ] **Step 2: Write the failing tests**

In `src/main/engine/project-store.test.ts`, extend the existing import from `'./project-store'` to add `readTeamBrain, autoPullFromTeam, autoPushToTeam, updateSettings, writeMemory` (any already present can be left as-is), then add:

```ts
describe('auto team-brain sync', () => {
  it('readTeamBrain returns a bundle for a valid file, null otherwise', async () => {
    const path = join(await tmpProject(), 'brain.json')
    expect(await readTeamBrain(path)).toBeNull() // missing
    await fs.writeFile(path, 'not json', 'utf8')
    expect(await readTeamBrain(path)).toBeNull() // invalid JSON
    await fs.writeFile(
      path,
      JSON.stringify({ kind: 'ai-manager-team', version: 1, teamId: 't', name: 'n', exportedAt: 'x', members: [], edges: [] }),
      'utf8'
    )
    expect((await readTeamBrain(path))?.teamId).toBe('t')
  })

  it('auto-sync is gated by the setting (off = no-op, on = push + pull)', async () => {
    const brainPath = join(await tmpProject(), 'brain.aimteam.json')
    await openProject(await tmpProject())
    const g = await createAgent({ name: 'Dana', kind: 'worker' })
    const dana = g.nodes.find((n) => n.name === 'Dana')!
    await writeMemory(dana.id, '# Memory\n\n## Lessons\n- [portable] write tests first\n\n## Task log\n')
    await syncToTeam(brainPath, 'team-1') // creates the brain + links the project

    // Dana learns a new portable lesson locally (not yet pushed)
    await writeMemory(
      dana.id,
      '# Memory\n\n## Lessons\n- [portable] write tests first\n- [portable] verify renders\n\n## Task log\n'
    )

    // setting OFF → both are no-ops
    await autoPushToTeam()
    expect((await readTeamBrain(brainPath))!.members[0].lessons).not.toContain('verify renders')
    expect(await autoPullFromTeam()).toBe(0)

    // setting ON → push sends the new lesson up
    await updateSettings({ autoSyncTeam: true })
    await autoPushToTeam()
    expect((await readTeamBrain(brainPath))!.members[0].lessons).toContain('verify renders')

    // ON → pull merges a brain-only lesson down into the matching agent
    const brain = (await readTeamBrain(brainPath))!
    const withNew = { ...brain, members: brain.members.map((m) => ({ ...m, lessons: [...m.lessons, 'read errors fully'] })) }
    await fs.writeFile(brainPath, JSON.stringify(withNew), 'utf8')
    expect(await autoPullFromTeam()).toBe(1)
    expect(await readMemory(dana.id)).toContain('- [portable] read errors fully')
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/main/engine/project-store.test.ts -t "auto team-brain sync"`
Expected: FAIL — `readTeamBrain` / `autoPullFromTeam` / `autoPushToTeam` are not exported.

- [ ] **Step 4: Implement the helpers (`src/main/engine/project-store.ts`)**

Add these near the other team functions (after `refreshFromTeam`):

```ts
/** Read + validate a team-brain file. Returns null on missing/unreadable/invalid. */
export async function readTeamBrain(path: string): Promise<TeamBundle | null> {
  try {
    const v = validateTeamBundle(JSON.parse(await fs.readFile(path, 'utf8')))
    return v.ok ? v.bundle : null
  } catch {
    return null
  }
}

/** Auto PULL (B2b): if enabled + linked, refresh agents from the linked brain.
 * Returns agents updated (0 when off / unlinked / unreadable / failed). Best-effort. */
export async function autoPullFromTeam(): Promise<number> {
  const link = getLinkedTeam()
  if (!getSettings().autoSyncTeam || !link) return 0
  try {
    const brain = await readTeamBrain(link.path)
    if (!brain) return 0
    const { updated } = await refreshFromTeam(brain, link.path)
    return updated
  } catch {
    return 0
  }
}

/** Auto PUSH (B2b): if enabled + linked, sync this project's portable lessons to the linked brain. Best-effort. */
export async function autoPushToTeam(): Promise<void> {
  const link = getLinkedTeam()
  if (!getSettings().autoSyncTeam || !link) return
  try {
    await syncToTeam(link.path, link.teamId)
  } catch {
    // best-effort: never let auto-sync surface an error
  }
}
```

- [ ] **Step 5: Run the tests, full suite, typecheck**

Run: `npx vitest run src/main/engine/project-store.test.ts` → PASS.
Run: `npx vitest run` → all green. Run: `npm run typecheck` → no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "feat(team): autoSyncTeam setting + auto pull/push helpers"
```

---

### Task 2: Orchestrator hooks (`orchestrator.ts`)

**Files:**
- Modify: `src/main/engine/orchestrator.ts` (`drive` pull hook; `finishRun` push hook; import)

**Interfaces:**
- Consumes: `autoPullFromTeam`, `autoPushToTeam` (from Task 1).

**Note:** the orchestration driver has no unit harness — verified by `typecheck` + `build` + the full suite (which exercises the node graph the driver runs).

- [ ] **Step 1: Extend the project-store import**

In `src/main/engine/orchestrator.ts`, change:

```ts
import { getAgent, getCheckpointDir, getSettings, saveRun } from './project-store'
```

to:

```ts
import {
  autoPullFromTeam,
  autoPushToTeam,
  getAgent,
  getCheckpointDir,
  getSettings,
  saveRun
} from './project-store'
```

- [ ] **Step 2: Add the pull hook in `drive`**

In `drive`, between the initial-checkpoint `try/catch` block and the `const final = await runGraph(...)` line, insert:

```ts
  try {
    await autoPullFromTeam() // B2b: best-effort pull of the linked team brain before the run
  } catch {
    // auto-sync must never block a run
  }
```

So the relevant section reads:

```ts
  try {
    await store.put(state) // initial checkpoint — survives a crash during planning
  } catch {
    // non-fatal
  }
  try {
    await autoPullFromTeam() // B2b: best-effort pull of the linked team brain before the run
  } catch {
    // auto-sync must never block a run
  }
  const final = await runGraph(buildOrchestratorGraph(eng), state, store, io)
  await finishRun(wc, final, store)
```

- [ ] **Step 3: Add the push hook in `finishRun`**

In `finishRun`, after the `store.remove` `try/catch` block and before the `emit(wc, { ... type: 'run-finished' ... })` line, insert:

```ts
  try {
    await autoPushToTeam() // B2b: best-effort push of this run's new portable lessons to the team brain
  } catch {
    // auto-sync must never break finishing a run
  }
```

So the tail of `finishRun` reads:

```ts
  try {
    await store.remove(final.runId)
  } catch {
    // ignore
  }
  try {
    await autoPushToTeam() // B2b: best-effort push of this run's new portable lessons to the team brain
  } catch {
    // auto-sync must never break finishing a run
  }
  emit(wc, { runId: final.runId, type: 'run-finished', status: toRunStatus(final.status), error: final.error })
```

(The early `if (final.status === 'interrupted') return` at the top of `finishRun` is unchanged — no push on an interrupt.)

- [ ] **Step 4: Verify typecheck + build + suite**

Run: `npm run typecheck` → no errors. Run: `npm run build` → clean. Run: `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/orchestrator.ts
git commit -m "feat(team): auto pull at run start + push at run finish (best-effort)"
```

---

### Task 3: Settings checkbox (`SettingsModal.tsx`)

**Files:**
- Modify: `src/renderer/SettingsModal.tsx`

**Interfaces:**
- Consumes: `ProjectSettings.autoSyncTeam` (Task 1); existing `update(patch)` / `s` (settings).

**Note:** renderer has no unit harness — verified by `typecheck` + `build`.

- [ ] **Step 1: Add the checkbox**

In `src/renderer/SettingsModal.tsx`, immediately after the `adaptiveEffort` checkbox `<div className="field">…</div>` block (the one labeled "Adaptive effort — managers assign reasoning effort by task difficulty"), insert:

```tsx
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.autoSyncTeam}
              onChange={(e) => void update({ autoSyncTeam: e.target.checked })}
            />
            Auto-sync team brain — pull lessons before a run, push after
          </label>
        </div>
```

- [ ] **Step 2: Verify typecheck + build + suite**

Run: `npm run typecheck` → no errors. Run: `npm run build` → clean. Run: `npx vitest run` → all green.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/SettingsModal.tsx
git commit -m "feat(team): auto-sync team brain settings toggle"
```

---

## Final verification

- [ ] `npx vitest run` → all green (103 existing + the new `readTeamBrain` + gating tests).
- [ ] `npm run typecheck` → no errors. `npm run build` → clean.
- [ ] **Live smoke (manual):** link a project to a team brain (b2a Sync to team), turn ON "Auto-sync team brain" in Settings, run a goal → confirm (a) before the run the agents picked up the brain's latest lessons, and (b) after the run the brain file gained any new `[portable]` lessons the run produced. Toggle the setting OFF → confirm a run neither reads nor writes the brain. Confirm a missing/moved brain file does not break a run.

## Self-review notes (spec coverage)

- `autoSyncTeam` opt-in (default off) → Task 1 (types.ts).
- Pull at run start / push at run finish → Task 2 (`drive` / `finishRun` hooks).
- Best-effort (helpers swallow errors + orchestrator try/catch) → Task 1 (helper try/catch) + Task 2 (hook try/catch).
- Portable-only / reuse b2a sync → Task 1 (`autoPushToTeam` calls `syncToTeam`; `autoPullFromTeam` calls `refreshFromTeam`).
- `readTeamBrain` (valid → bundle, else null), used only by the auto path (manual handler unchanged) → Task 1.
- Settings checkbox → Task 3.
- Gating (off → no-op; on + linked → sync) → Task 1 test.
