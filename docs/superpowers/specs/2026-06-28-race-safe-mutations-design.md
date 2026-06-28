# Race-safe mutations — design (fix cycle P2)

**Date:** 2026-06-28
**Source:** Audit `docs/audits/2026-06-27-tool-audit.md` — findings #5 (Critical), #14 (Important), #16 (Important); triage cycle **P2** in `docs/audits/2026-06-27-remediation-cycles.md`. Builds on **P1** (atomic writes).
**Status:** approved design, ready for implementation plan.

## Problem

`project-store` is the single Electron main process, but up to 3 sibling agents run in parallel per wave and its writes are unserialized:

- **#5 (Critical)** — Every graph mutator does an in-memory mutation then `await saveGraph()`. With concurrent mutators, multiple `saveGraph` serializations race the rename: a stale-but-complete snapshot can win the rename and **drop another agent's just-written field** — critically `sessionId` (silently starting a *fresh* agent session, losing all context). `updateAgent` (`project-store.ts:249-262`) is called concurrently from `nodes.ts:313,256,531` via `mapCapped(…, 3, …)`.
- **#14 (Important)** — `applyReflection` (`project-store.ts:543-553`) is a read→`mergeMemory`→write with an `await` between, colliding with `refreshFromTeam`/`autoPullFromTeam` (`:664-709`) and the `writeMemory` IPC (`ipc.ts:65`). Two unsynchronized whole-file `memory.md` RMWs drop one side's content — the exact compounding-memory data the product accretes.
- **#16 (Important)** — `streamAgent` resolves `resume` against `agent.sessionId` read from the live graph node (`agent-runner.ts:119`); a clobbered/stale value resumes the wrong session or starts fresh.

## Goal

Concurrent graph mutations and `memory.md` writes never lose each other's updates. As a consequence, the persisted `sessionId` is reliable, resolving #16.

**Non-goal / YAGNI:** no explicit per-worker sessionId threading (§3 explains why #5 already closes #16); no per-mutator-body locks (§1's sink serialization is sufficient and re-entrancy-free); memory reads stay lock-free.

## Components

### §0 — Mutex primitive (new `src/main/engine/mutex.ts`, pure, unit-tested)

```ts
/** Serialize async ops: each call runs after the previous settles (success OR failure). */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn, fn)
    tail = result.then(() => {}, () => {}) // swallow so a rejection never breaks the chain
    return result
  }
}

/** Per-key serialization: same key runs one at a time; different keys are independent. */
export function createKeyedMutex(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve()
    const result = prev.then(fn, fn)
    tails.set(key, result.then(() => {}, () => {}))
    return result
  }
}
```
The keyed map grows by distinct key (bounded by agent count — small; no cleanup needed).

### §1 — Serialize graph persistence (#5) (`src/main/engine/project-store.ts`)

```ts
import { createMutex } from './mutex'
const graphSaveMutex = createMutex()

async function saveGraph(): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent() // capture at call time (binds to the open project)
  return graphSaveMutex(async () => {
    await fs.mkdir(aimPath(path), { recursive: true })
    await atomicWriteWithBackup(aimPath(path, GRAPH_FILE), JSON.stringify(graph, null, 2))
    return graph
  })
}
```

**Why this fixes #5 and covers all mutators:** every graph mutator funnels through `saveGraph`, so serializing this one sink serializes the persistence of *all* mutations (`updateAgent`, `setEdges`, `setNodePositions`, `deleteAgent`, `updateSettings`, context-file ops, `applySpawnedTeam`, `importTeam`, `refreshFromTeam`/`syncToTeam`). No two serializations overlap, they run in call order, and each `JSON.stringify(graph)` reflects every in-memory assign made before its turn — so the last write always holds everything; no stale snapshot can win the rename. `updateAgent`'s RMW is synchronous before its `await`, so the sink serialization fully closes its lost-update. Serializing the sink (rather than wrapping each mutator body) avoids the **re-entrancy hazard** of composed mutators (`autoPullFromTeam → refreshFromTeam → saveGraph`).

The two multi-step mutators (`applySpawnedTeam`, `importTeam`) push nodes interleaved with per-member `fs` awaits, so the in-memory graph is transiently partial during those awaits; their final `saveGraph` always persists the complete graph, and they are user actions that don't run concurrently with waves — a benign transient, not separately locked.

### §2 — Serialize `memory.md` writes per agent (#14) (`src/main/engine/project-store.ts`)

```ts
import { createKeyedMutex } from './mutex'
const memoryMutex = createKeyedMutex()

// private, lock-free, atomic — used INSIDE locked sections (no re-entrancy)
async function writeMemoryRaw(agentId: string, content: string): Promise<void> {
  const dir = agentDir(agentId)
  await fs.mkdir(dir, { recursive: true })
  await atomicWrite(join(dir, 'memory.md'), content) // P1 helper: torn-free
}

export async function writeMemory(agentId: string, content: string): Promise<void> {
  await memoryMutex(agentId, () => writeMemoryRaw(agentId, content))
}

export async function applyReflection(agentId: string, r: {win;loss;lessons;label}): Promise<void> {
  await memoryMutex(agentId, async () => {
    const file = join(agentDir(agentId), 'memory.md')
    const content = await readFileOr(file, '')
    const next = mergeMemory(content, r)
    await writeMemoryRaw(agentId, next)
  })
}
```

`refreshFromTeam`'s per-agent read→merge→write is wrapped the same way (lock-free `readMemory` + `mergeLessons` + `writeMemoryRaw`, all inside `memoryMutex(p.agentId, …)`; keep the `updated++` accounting). The IPC `writeMemory` (`ipc.ts:65`) needs no change — it calls the now-locked public `writeMemory`. Reads (`readMemory`, `buildAgentContext`) stay lock-free: whole-file reads against torn-free atomic writes can't observe a partial file.

Result: a reflection, an editor save, and a team-pull on the *same* agent serialize; different agents stay parallel.

### §3 — #16 resolved by §1 (documented; no code change)

`execute` (`nodes.ts:313`) and `repair` (`nodes.ts:531`) both `await updateAgent({ id, sessionId })` before the wave proceeds. With §1 serializing graph writes, that persisted `sessionId` is never clobbered, and because the write is awaited and `repair` is a strictly later node, `streamAgent`'s `resume` reads the correct value. The race is closed without threading. (The explicit-threading alternative — carrying sessionId in `RunState` and passing `resumeSessionId` in repair — is unnecessary surface and is deliberately not done.)

### §4 — P1 follow-up: remove the `atomicWriteWithBackup` TOCTOU (`src/main/engine/atomic-write.ts`)

Drop the `existsSync(target)` check→rename window; rely on the `try/catch` (a missing target just makes the demote rename throw `ENOENT`, which is ignored). Remove the now-unused `existsSync` import.

```ts
export async function atomicWriteWithBackup(target: string, data: string): Promise<void> {
  const tmp = tmpName(target)
  await fs.writeFile(tmp, data, 'utf8')
  try {
    await fs.rename(target, `${target}.bak`) // demote previous version; ENOENT (no prior file) is fine
  } catch {
    // no existing target, or a concurrent writer already moved it — ignore
  }
  await fs.rename(tmp, target)
}
```

## Testing

- **`src/main/engine/mutex.test.ts`** (new, deterministic):
  - `createMutex` runs bodies one at a time with no overlap (an `active` counter is always ≤1) in call order; the chain survives a rejected body (a later call still runs).
  - `createKeyedMutex` serializes same-key calls in call order even when an earlier body yields more (a slow `x1` before a fast `x2` still finishes `x1` first); different keys are independent.
- **`src/main/engine/project-store.test.ts`**:
  - **Memory (deterministic bug-repro):** two concurrent `applyReflection` calls on one agent (lessons "alpha" / "beta") → final `memory.md` contains BOTH. Without §2 the two RMWs read the same base and one lesson is lost, so this test fails on the unfixed code.
  - **Graph (invariant guarantee):** concurrent `updateAgent` setting `sessionId` on three agents → re-open the project → all three sessionIds present. (Guaranteed by §1; the deterministic serialization proof lives in the mutex test.)
- **`src/main/engine/atomic-write.test.ts`**: existing tests stay green after §4 (normal-path behavior unchanged: first write → no `.bak`; second → `.bak` = previous).

## "Off = byte-for-byte"?

N/A — a correctness fix. Single-threaded/sequential callers are unaffected (the mutex runs their bodies immediately in order); only concurrent callers change outcome (now correct).

## Files touched

- `src/main/engine/mutex.ts` — new (`createMutex`, `createKeyedMutex`).
- `src/main/engine/mutex.test.ts` — new.
- `src/main/engine/project-store.ts` — serialize `saveGraph`; `memoryMutex` + `writeMemoryRaw`; lock `writeMemory`/`applyReflection`/`refreshFromTeam` per-agent RMW.
- `src/main/engine/project-store.test.ts` — concurrency tests.
- `src/main/engine/atomic-write.ts` — remove the `existsSync` TOCTOU (§4).
