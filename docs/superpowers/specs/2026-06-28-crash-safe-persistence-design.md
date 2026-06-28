# Crash-safe persistence (atomic writes) — design (fix cycle P1)

**Date:** 2026-06-28
**Source:** Audit `docs/audits/2026-06-27-tool-audit.md` — finding #4 (Critical) + the run-store `.tmp`-leak Minor; triage cycle **P1** in `docs/audits/2026-06-27-remediation-cycles.md`.
**Status:** approved design, ready for implementation plan.

## Problem

`graph.json` is the most load-bearing file in a project (topology + per-agent `sessionId`/`model`/`position` + settings + context). Two defects make it fragile:

- **Non-atomic write** — `saveGraph` (`project-store.ts:152-157`) does a direct `fs.writeFile(graph.json, …)`. A crash/force-quit mid-write (realistic during a live run's constant `sessionId` writes) can leave `graph.json` truncated. Concurrent writers can also interleave bytes.
- **No-fallback read** — `openProject` (`project-store.ts:168`) `JSON.parse`s `graph.json` with no try/catch, so a corrupt/truncated file makes the **entire project unopenable** (the call throws).

`run-store.put` (`run-store.ts:30-36`) already uses the correct atomic temp+rename pattern, but leaks its `.tmp` files when a crash happens mid-write (the `.json` read-filter hides them, but they accumulate on disk forever).

## Goal

- `graph.json` writes are **atomic** (temp + rename) — a crash mid-write can never truncate it, and concurrent writers never interleave bytes.
- `openProject` is **resilient**: a corrupt or missing `graph.json` is recovered from a backup, the bad file is preserved (never silently destroyed), and worst case it opens an empty graph — it never hard-crashes.
- The `run-store` `.tmp` leak is swept.
- DRY: one tested atomic-write helper shared by both stores.

**Non-goal (explicit):** the concurrent **lost-update race** (two `updateAgent`s clobbering each other) is **not** fixed here — that is cycle **P2**. P1 only guarantees each write is atomic/torn-free; it does not serialize writers. P1 strictly improves on today (today's non-atomic `writeFile` can interleave bytes under concurrency; atomic rename cannot).

## Components

### §1 — Shared atomic-write helper (new `src/main/engine/atomic-write.ts`)

Pure node (only `node:fs`), unit-testable like `run-store`.

```ts
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'

let seq = 0
function tmpName(target: string): string {
  return `${target}.${process.pid}.${seq++}.tmp`
}

/** Write `data` to `target` atomically (temp file + rename): a crash mid-write never
 *  leaves a torn file, and concurrent writers never interleave bytes (last rename wins). */
export async function atomicWrite(target: string, data: string): Promise<void> {
  const tmp = tmpName(target)
  await fs.writeFile(tmp, data, 'utf8')
  await fs.rename(tmp, target)
}

/** Like atomicWrite, but first demotes the existing `target` to `${target}.bak`
 *  (a cheap rename — no data copy), keeping one previous good version for recovery. */
export async function atomicWriteWithBackup(target: string, data: string): Promise<void> {
  const tmp = tmpName(target)
  await fs.writeFile(tmp, data, 'utf8')
  if (existsSync(target)) {
    try {
      await fs.rename(target, `${target}.bak`)
    } catch {
      // a concurrent writer may have already moved it; ignore
    }
  }
  await fs.rename(tmp, target)
}
```

### §2 — `saveGraph` becomes atomic + backed-up (`src/main/engine/project-store.ts`)

```ts
async function saveGraph(): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  await fs.mkdir(aimPath(path), { recursive: true })
  await atomicWriteWithBackup(aimPath(path, GRAPH_FILE), JSON.stringify(graph, null, 2))
  return graph
}
```
Every successful save leaves the previous good version in `graph.json.bak`. (Import `atomicWriteWithBackup` from `./atomic-write`.)

### §3 — `openProject` resilient read (`src/main/engine/project-store.ts`)

Replace the read block (`:167-179`) with a corrupt/missing-tolerant read; the rest of `openProject` (settings/context defaults at `:180-182`, `current = …`, the trailing `await saveGraph()`, `addRecent`, `return`) is unchanged.

```ts
  const graphFile = aimPath(projectPath, GRAPH_FILE)
  const bakFile = `${graphFile}.bak`
  let graph: ProjectGraph | null = null

  if (existsSync(graphFile)) {
    try {
      graph = JSON.parse(await fs.readFile(graphFile, 'utf8')) as ProjectGraph
    } catch {
      // corrupt graph.json — preserve it for forensics, then fall back to the backup
      try {
        await fs.rename(graphFile, `${graphFile}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      console.warn(`[project-store] ${GRAPH_FILE} was unreadable; attempting backup recovery.`)
    }
  }
  if (!graph && existsSync(bakFile)) {
    // graph.json was missing (possible crash in the save rename window) or corrupt
    try {
      graph = JSON.parse(await fs.readFile(bakFile, 'utf8')) as ProjectGraph
      console.warn(`[project-store] recovered ${GRAPH_FILE} from ${GRAPH_FILE}.bak.`)
    } catch {
      /* .bak also bad — fall through to an empty graph */
    }
  }
  if (graph) {
    // keep the project path current even if the folder moved
    graph.project = { path: projectPath, name: graph.project?.name || basename(projectPath) }
  } else {
    graph = {
      project: { path: projectPath, name: basename(projectPath) },
      nodes: [],
      edges: [],
      settings: { ...DEFAULT_SETTINGS }
    }
  }
```

Behavior table:
| `graph.json` | `.bak` | Result | Warn? |
|---|---|---|---|
| valid | — | use it | no |
| corrupt | valid | preserve corrupt as `.corrupt-<ts>`, recover from `.bak` | yes |
| corrupt | corrupt/absent | preserve corrupt, open **empty** | yes |
| absent | valid | recover from `.bak` (crash-in-save-window) | yes |
| absent | absent | open **empty** (fresh project) | **no** (preserves current silent behavior) |

The trailing `await saveGraph()` then re-persists the in-memory graph: when recovering (graph.json was renamed away) it writes a fresh `graph.json` without demoting (target absent), leaving the recovered `.bak` intact.

### §4 — `run-store` hygiene (`src/main/engine/run-store.ts`)

- `put` uses the shared helper (drop the inline `seq`/tmp logic):
  ```ts
  async function put(state: RunState): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    await atomicWrite(fileFor(state.runId), JSON.stringify(state, null, 2))
  }
  ```
- Add an exported sweep and fire it once at store creation (init time — before any run, so it won't race a live `put`):
  ```ts
  export async function sweepTmpFiles(dir: string): Promise<void> {
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      return // dir not created yet
    }
    await Promise.all(
      files.filter((f) => f.endsWith('.tmp')).map((f) => fs.rm(join(dir, f), { force: true }))
    )
  }
  // inside createRunStore(dir):
  void sweepTmpFiles(dir) // best-effort cleanup of orphaned temp files from a prior crash
  ```

## Error handling

- Every fs failure on the recovery path is caught and degrades (preserve-corrupt rename failure → ignored; `.bak` parse failure → empty). `openProject` cannot throw on a bad file.
- Surfacing is `console.warn` only — the in-app error surface is audit #28, deferred to the Phase-2 overhaul. The corrupt file is always preserved on disk (`*.corrupt-<ts>`) for manual recovery.

## Testing

- **`src/main/engine/atomic-write.test.ts`** (new):
  - `atomicWrite` writes the content to the target and leaves no `.tmp` behind.
  - `atomicWriteWithBackup` on a fresh target writes it with **no** `.bak`; a second call leaves `.bak` = the first content and the target = the second content.
- **`src/main/engine/project-store.test.ts`**:
  - corrupt `graph.json` + valid `.bak` → `openProject` returns the `.bak` graph; a `*.corrupt-*` file exists; `graph.json` exists again afterward (re-saved).
  - corrupt `graph.json` + no `.bak` → opens an empty graph (no throw).
  - fresh project (neither file) → opens empty, no `*.corrupt-*` created.
  - after two `saveGraph`s (e.g. two `updateAgent`s), `graph.json.bak` exists and parses.
- **`src/main/engine/run-store.test.ts`**:
  - a pre-seeded orphan `*.tmp` in the dir is removed by `sweepTmpFiles`; `put`/`get` still round-trip.

## "Off = byte-for-byte"?

N/A — a reliability fix. The on-disk steady state is identical (`graph.json` holds the same JSON) plus a `graph.json.bak` sidecar; reads of a valid file behave exactly as before.

## Files touched

- `src/main/engine/atomic-write.ts` — new helper (`atomicWrite`, `atomicWriteWithBackup`).
- `src/main/engine/atomic-write.test.ts` — new tests.
- `src/main/engine/project-store.ts` — `saveGraph` atomic+backup; `openProject` resilient read; import the helper.
- `src/main/engine/project-store.test.ts` — recovery tests.
- `src/main/engine/run-store.ts` — `put` via `atomicWrite`; `sweepTmpFiles` + fire-on-create.
- `src/main/engine/run-store.test.ts` — sweep test.
