# Dimension 2 — Code correctness: persistence & concurrency

> **Status: historical — remediated.** This is an internal audit report from the
> 2026-06 review cycle, kept for the record. Every Critical and Important finding
> below has been fixed and merged; see
> [`docs/audits/2026-06-27-remediation-cycles.md`](../2026-06-27-remediation-cycles.md)
> for the per-cycle remediation log. Do not read the findings below as open issues.


**Scope:** Static review of the persistence and concurrency layers — `src/main/engine/project-store.ts` (graph.json / role.md / memory.md / runs / team export-import + brain sync / applySpawnedTeam / context files), `run-store.ts` (durable run checkpoints), `agent-runner.ts` (one SDK `query()` per agent), `pty-manager.ts`, `env.ts`, `auth.ts`, plus the call sites that drive them concurrently (`nodes.ts` wave-loop with sibling cap 3, `orchestrator.ts`, `graph.ts`, `ipc.ts`). The headline pattern: up to 3 sibling agents run in parallel per wave and ALL of them perform read-modify-writes against ONE shared in-memory `graph` object and ONE non-atomic `graph.json` writer (`saveGraph`), with no lock or serialization anywhere. The run-checkpoint store IS atomic and per-run-keyed; the project-graph store is neither. Below, real (data-actually-lost) races are separated from theoretical ones.

---

### [Critical] `saveGraph()` is a non-atomic full-file rewrite shared by all concurrent writers — a crash or interleave can truncate/corrupt graph.json and lose a sibling's write

**Location** `src/main/engine/project-store.ts:152-157` (`saveGraph`), called concurrently from `updateAgent` at `nodes.ts:313`, `nodes.ts:256`, `nodes.ts:531` (and the manual `runHeadless` path `agent-runner.ts:195`).

**What's wrong** `saveGraph` does `await fs.writeFile(aimPath(path, GRAPH_FILE), JSON.stringify(graph, null, 2))` — a direct overwrite of the canonical `graph.json`, NOT the temp-file+rename pattern that `run-store.ts:30-36` correctly uses for checkpoints. Two problems compound:
1. **Non-atomic write:** if the app crashes (or is force-quit — `before-quit` only kills ptys/servers, `index.ts:53-56`) mid-`writeFile`, `graph.json` is left truncated/half-written. On next `openProject` the `JSON.parse` at `project-store.ts:168` throws and is NOT caught, so the entire project fails to open. Unlike `loadRun`/`listRuns` which tolerate corrupt files, `openProject` has no fallback.
2. **Lost-write under concurrency:** during one wave, up to 3 `runGroup`s run in parallel (`nodes.ts:360` `mapCapped(..., MAX_PARALLEL, ...)`). Each finishing worker calls `await updateAgent({ id: ownerId, sessionId })` (`nodes.ts:313`) which mutates the shared `graph` then `saveGraph()`. Because `saveGraph` reads `requireCurrent().graph` (the single live object) and serializes it, an interleaving where two `writeFile`s target the same path can have the OS-level writes race; more importantly any concurrent direct overwrite of the same file with two different in-flight buffers means a reader (`openProject`, or `getRecentProjects`-style readers) can observe a partially-written file.

**Why it matters** `graph.json` is the canonical project topology + per-agent sessionId/model/position. A corrupt write makes the whole project unopenable (no recovery path), and a force-quit during the constant sessionId writes of a live run is a realistic trigger. This is the single most load-bearing file in the app and it is the only major writer that skipped the atomic-rename discipline the codebase already established next door.

**Suggested fix** Make `saveGraph` write to `${GRAPH_FILE}.tmp` then `fs.rename` (mirror `run-store.put`), and wrap the `JSON.parse` in `openProject` in a try/catch that falls back to a `.bak` or an empty graph rather than throwing. Consider serializing all `saveGraph` calls through a single promise chain (see next finding).

---

### [Critical] Concurrent `updateAgent` read-modify-writes on the shared graph have no serialization — a sibling's sessionId/model write can be clobbered (last-write-wins)

**Location** `src/main/engine/project-store.ts:221-234` (`updateAgent` RMW: find node → `Object.assign(node, merged)` → `saveGraph`); concurrent callers `nodes.ts:313` (execute), `nodes.ts:256` (HITL resume), `nodes.ts:531` (repair), all reached through `mapCapped(..., MAX_PARALLEL=3, ...)` (`nodes.ts:45`, `360`, `513`).

**What's wrong** `updateAgent` is a classic read-modify-write with an `await` in the middle (`saveGraph` is async). Worker A reads `graph`, mutates node A's `sessionId`, `await saveGraph()` (yields). Worker B interleaves, reads the SAME `graph`, mutates node B's `sessionId`, `await saveGraph()`. Each writes the full graph. Because both mutate the same live `graph` object the in-memory state ends up with both fields IF the mutations land before either serialize — but there is no guarantee of that ordering, and the two `saveGraph` `writeFile`s both serialize whatever the graph looks like at their await point. The on-disk file is whichever `writeFile` finishes last; if A's serialize captured the graph before B mutated, A's write (missing B's sessionId) can land last and persist a stale graph. There is **no lock, mutex, or write-queue** anywhere — `saveGraph` is fire-and-serialize.

**Why it matters** sessionId is what `resume:true` and `resumeSessionId` rely on for repair/handoff/HITL continuity (`agent-runner.ts:118-119`). A clobbered sessionId means a later repair or resume silently starts a FRESH session instead of continuing the worker's context — wrong behavior that looks like the agent "forgot" everything. Persisted model/position can also be lost. This bites specifically when ≥2 siblings finish near-simultaneously, which is the normal case for a parallel wave.

**Suggested fix** Serialize all graph mutations through a single async queue (e.g. chain every `saveGraph` onto a module-level `let writeChain = writeChain.then(...)`), or take an in-process async-mutex around the find→assign→saveGraph critical section so each RMW is atomic with respect to the others.

---

### [Important] Crash-recovery checkpoints are written after every node but NEVER surfaced or auto-resumed — `listResumable` is dead code, so the entire durability feature is inert and checkpoints leak forever

**Location** `run-store.ts:50-68` (`listResumable`, defined + tested but unreferenced), `orchestrator.ts:43-48`/`resumeRun` (only ever called for HITL answers, `ipc.ts:90-92`, `renderer/store.ts:226`), checkpoint writes `graph.ts:93`/`98` + `run-store.put`.

**What's wrong** Every node transition writes a durable checkpoint (`graph.ts:93` `await store.put(state)`), and on graceful finish the checkpoint is removed (`orchestrator.ts:121-125`). The whole point (per the `run-store.ts:5-9` docstring: "a crash mid-run leaves a resumable checkpoint behind") is crash recovery. But `listResumable` — the only API that finds those leftover checkpoints — is called from nowhere in `src/` except its own test (verified by grep: hits only in `run-store.ts` and `run-store.test.ts`). `resumeRun` is wired into IPC but the renderer only calls it via `answerInterrupt` (HITL), never for a crashed run. There is no startup scan, no "resume previous run?" UI.

**Why it matters** Two consequences: (1) the advertised durability/crash-recovery is non-functional — a crash mid-run is unrecoverable from the user's side despite all the checkpoint-writing cost on every transition; (2) every crashed/force-quit run leaves an orphan `runs/.checkpoints/<runId>.json` that is never cleaned up (only graceful completion removes it, `orchestrator.ts:121`), so checkpoints accumulate unboundedly across the lifetime of the project. `listResumable` would skip non-resumable ones but is never invoked.

**Suggested fix** Call `listResumable()` on project open and surface resumable runs in the UI (or auto-prune/auto-offer); at minimum garbage-collect stale `.checkpoints` files older than N days on open so they don't accumulate.

---

### [Important] Parallel `applyReflection` writes to per-agent memory.md are unserialized read-modify-writes; same agent reviewed+working can lose a lesson

**Location** `project-store.ts:511-521` (`applyReflection`: `readFileOr` → `mergeMemory` → `writeFile`), driven in parallel at `nodes.ts:640` (worker reflections) and `nodes.ts:664` (reviewer reflections), both under `mapCapped(..., MAX_PARALLEL, ...)`.

**What's wrong** `applyReflection` is a read-modify-write of `memory.md` with an `await` between read and write. The reflect node runs worker reflections in parallel (`nodes.ts:627`) and reviewer reflections in parallel (`nodes.ts:647`). Distinct agents target distinct files, so that subset is safe. BUT the two `mapCapped` passes are sequential (worker pass awaited before reviewer pass, `nodes.ts:627`/`647`), and within a pass each agent id is unique, so a true same-file collision needs an agent that is BOTH a worker-owner AND a reviewer in the same run — which can't normally happen since reviewers are parents. The realer collision: `refreshFromTeam`/`autoPullFromTeam` (`project-store.ts:632-652`, `666-677`) writes the same `memory.md` files via `writeMemory`, and `autoPushToTeam`/`autoPullFromTeam` are best-effort fire-and-forget around a run (`orchestrator.ts:77`, `127`). Combined with a user editing memory via `writeMemory` IPC (`ipc.ts:65`) mid-run, two unsynchronized RMWs on one `memory.md` drop one side's content (last writer wins the whole file).

**Why it matters** memory.md is the agent's persistent brain / track record that routing and future runs depend on (`nodes.ts:190-192`). A lost merge silently discards a just-learned lesson — exactly the data the "compounding team" feature exists to accumulate. Low frequency but real, and silent.

**Suggested fix** Funnel all memory.md writes (`applyReflection`, `writeMemory`, brain pull) for a given agent through a per-file serialized queue, and/or guard renderer-side memory edits while a run is active.

---

### [Important] `importTeam` / `applySpawnedTeam` write role.md+memory.md files BEFORE saving the graph; a failure or crash mid-loop leaves orphaned agent folders with no graph node (and partial team)

**Location** `project-store.ts:708-740` (`importTeam`) and `project-store.ts:744-795` (`applySpawnedTeam`) — both loop creating `agents/<slug>/{role.md,memory.md}` and pushing nodes, then `saveGraph()` only at the very end.

**What's wrong** Both functions `await fs.mkdir`/`fs.writeFile` for each member's files inside the loop while pushing nodes onto the in-memory `graph`, and only persist the graph after the whole loop (`saveGraph()` at `project-store.ts:739` / `794`). The docstring at `707` even claims "Saves the graph LAST for atomicity" — but that is the opposite of atomic: if any `fs.writeFile` throws partway (disk full, permission), or the app crashes mid-loop, the on-disk filesystem has role/memory files for the partially-created members while `graph.json` has NONE of them (never saved). Conversely the in-memory `graph` now holds nodes that were never persisted, so a subsequent unrelated `saveGraph` from a different code path could persist a half-built team. There is also no rollback of the already-written folders.

**Why it matters** A failed import/spawn leaves the project in an inconsistent state: orphan `agents/<slug>/` dirs with no corresponding node (invisible, never cleaned), or a half-applied team. Re-running import then re-uniquifies slugs and duplicates folders. Not data-loss of existing work, but a real corruption/leak of project state under a partial failure.

**Suggested fix** Stage all file writes to a temp area (or accumulate the planned writes), `saveGraph()` first (or last but) only after ALL files succeed, and on any error clean up the folders created so far; wrap the whole operation so the in-memory graph is only mutated if the persist succeeds.

---

### [Important] `streamAgent` resolves the wrong `resume` precedence and a stale on-disk sessionId can be used after a clobbered/concurrent `updateAgent`

**Location** `agent-runner.ts:118-119` (`if (opts.resumeSessionId) ... else if (opts.resume && agent.sessionId)`), where `agent` comes from `buildAgentContext` → `getAgent` → the live in-memory graph (`project-store.ts:299-309`, `55-60`).

**What's wrong** `streamAgent` reads `agent.sessionId` from the live graph at call start. In a parallel wave, the same agent generally isn't run twice concurrently, but the repair node (`nodes.ts:508-545`) and execute node both call `updateAgent({ sessionId })` and then later steps call `streamAgent({ resume: true })` reading that field. Because `updateAgent` is racy (finding above), the `agent.sessionId` read here can be a stale/clobbered value — resume then continues the WRONG session or starts fresh. The handoff path correctly side-steps this by threading `resumeSessionId` explicitly (`nodes.ts:1003`, comment at `agent-runner.ts:72`), which is evidence the authors already know the on-disk read is unreliable — but execute/repair still rely on the racy `agent.sessionId`.

**Why it matters** Wrong-session resume is silent: the agent appears to lose its prior context, redo work, or apply feedback against an unrelated session. Tied to the `updateAgent` race; even without that race, reading sessionId from a graph that another in-flight `updateAgent` is mutating is a torn read.

**Suggested fix** Thread the sessionId returned by the just-completed `runAgent` call directly into the next step (as handoff already does with `resumeSessionId`) instead of round-tripping through the racy shared graph; only persist to graph for cross-run durability.

---

### [Important] `auth.ts` and `env.ts` shell out with `${shell} -lic '...'` / pass full `process.env`; a hostile or noisy login shell can break detection or leak, and `resolveClaudeBin` runs a login shell on a hot path

**Location** `env.ts:21` (`execSync(\`${shell} -lic 'printf "%s" "$PATH"'\`)`), `env.ts:60` (`command -v claude`), `auth.ts:13-18` (`execFile(bin, [...], { env: process.env })`).

**What's wrong** Several edge cases:
1. `env.ts:21` parses PATH by taking the LAST line that `.includes('/')` (`env.ts:26-30`). If the user's `.zshrc`/`.zprofile` prints anything containing `/` AFTER the PATH (very common: `nvm`, `direnv`, `pyenv`, MOTD, `Last login: ...`), the wrong line is taken as PATH, breaking `claude` resolution entirely. The `printf` has no delimiter/sentinel to isolate the value.
2. `resolveClaudeBin` (`env.ts:50-75`) is called on EVERY `spawnPty` (`pty-manager.ts:38`) and every `checkAuth`. When the three hardcoded paths miss, it runs a 5s-timeout login shell synchronously (`env.ts:59-64`) — a blocking `execSync` on the main process per pty spawn. Repeated terminal opens each pay this cost and block the event loop.
3. `auth.ts:16` passes the full `process.env` to the claude probe; combined with the PATH-recovery mutation of `process.env.PATH` (`env.ts:31`/`46`), if PATH recovery picked a wrong line the auth probe inherits it.

**Why it matters** Items 1+2 mean a perfectly-authenticated user can get a spurious `no-cli`/`logged-out` (auth.ts:22-23) or a multi-second UI hang per terminal on machines whose login shell is chatty — a realistic, hard-to-diagnose support issue. `resolveClaudeBin`'s result is not cached (unlike `ensureLoginPath`'s `applied` guard), so the cost recurs.

**Suggested fix** Emit a unique sentinel around the value (`printf 'AIM_PATH_START%sAIM_PATH_END' "$PATH"`) and extract between markers instead of last-line heuristics; memoize `resolveClaudeBin`'s result like `ensureLoginPath` does; consider `-ic` only if `-lic` is needed and cache aggressively.

---

### [Minor] `run-store.put` temp-file name is unique per-process+seq but orphan `.tmp` files leak on crash and are never cleaned

**Location** `run-store.ts:32-35` (`const tmp = \`${target}.${process.pid}.${seq++}.tmp\`; writeFile(tmp); rename(tmp, target)`).

**What's wrong** The temp+rename is correct and the `pid.seq` naming avoids concurrent-put collisions for one run. But if the process dies between `writeFile(tmp)` and `rename`, the `.tmp` file is orphaned forever — `listResumable`/`listRuns` filter to `.json` so they're ignored, but nothing ever deletes them. Over many crashes these accumulate in `.checkpoints`.

**Why it matters** Pure disk leak, no correctness impact; trivial but unbounded over time.

**Suggested fix** On `createRunStore`/project open, sweep `*.tmp` in the dir and unlink them.

---

### [Minor] `setStatus` rebuilds the step record from `stepBase` and drops previously-recorded `tasks`/`assignments`/`output` on the step

**Location** `nodes.ts:1160-1169` (`setStatus` → `steps[nodeId] = { ...stepBase(nodeId, steps), status }`) vs the richer records written at `nodes.ts:137`, `196`, `262`, `319`.

**What's wrong** `setStatus` spreads only `stepBase` (which returns `steps[nodeId] ?? {idle base}`) plus `status` — it preserves the existing record if present (good), but several call sites write a fresh `{ ...stepBase, output }` (`nodes.ts:319`) and then a later `setStatus(...'done')` spreads the existing record so `output` survives. However `stepBase` returns the EXISTING record only when present; the initial `setStatus(...,'working')` BEFORE the run (`nodes.ts:285`) overwrites any prior `tasks`/`assignments` snapshot from routing (`nodes.ts:196`) because the working status record `{...stepBase, status}` keeps prior fields — actually it preserves them. The real smell: status transitions and content writes both mutate `steps[nodeId]` by full-object replacement, so ordering between the parallel `setStatus` emits (`eng.emit` at `nodes.ts:1168`) and the checkpointed `steps` snapshot can show a status that doesn't match the content yet. Cosmetic/ordering only.

**Why it matters** Run-view step records can momentarily show a stale status vs output during parallel waves; no persisted-data correctness loss. Minor.

**Suggested fix** Have `setStatus` patch only the `status` field (`steps[nodeId] = { ...steps[nodeId] ?? base, status }`) which it largely does; ensure content-writing call sites never drop fields by patching rather than reconstructing.

---

### [Minor] `addRecent` read-modify-writes `recent-projects.json` non-atomically and can race two windows / rapid opens

**Location** `project-store.ts:807-812` (`addRecent`: `getRecentProjects` → splice → `fs.writeFile`), called from `openProject` (`project-store.ts:184`).

**What's wrong** Same non-atomic RMW pattern as `saveGraph` but for the global recents list in `userData`. Two app windows (or fast successive opens) can interleave read→write and lose an entry; a crash mid-write corrupts it, though `getRecentProjects` reads via `readFileOr` with `'[]'` fallback (`project-store.ts:804`) so corruption degrades gracefully to "empty recents" rather than a throw.

**Why it matters** Cosmetic (recents list), self-healing on corruption. Low impact.

**Suggested fix** Temp+rename write; minor.

---

### [Minor] `pty-manager` resize/write after exit relies on map deletion timing; `cleanEnv` copies the whole env to every pty

**Location** `pty-manager.ts:48-54` (`onExit` deletes from `sessions`), `pty-manager.ts:59-71` (`writePty`/`resizePty` look up `sessions`), `pty-manager.ts:12-18` (`cleanEnv`).

**What's wrong** Lifecycle is mostly sound: `onExit` deletes the session and `resizePty` try/catches a post-exit resize (`pty-manager.ts:66-70`). But `writePty` (`pty-manager.ts:59-61`) does NOT try/catch `proc.write` — a write that races the exit-handler deletion (data arrives after `kill` but before `onExit` fires) can throw on a dead pty. The listeners (`onData`/`onExit`) are registered once and node-pty cleans them on exit, so no listener leak. `cleanEnv` rebuilds the full `process.env` map per spawn (fine) but inherits the possibly-wrong recovered PATH.

**Why it matters** A stray throw from `writePty` is swallowed at the IPC `.on` boundary (no handler), so worst case a keystroke is lost on an exiting terminal. Very minor.

**Suggested fix** Wrap `proc.write` in try/catch like `resizePty` already does.


## Verification

Adversarial re-check of each finding against the cited source (read 2026-06-27).

### d2-persistence-concurrency-1 — CONFIRMED [Critical]
`saveGraph` (project-store.ts:152-157) writes graph.json directly via `fs.writeFile` with no temp+rename, unlike run-store.put (run-store.ts:32-35) which does temp+rename. `openProject` (project-store.ts:168) does `JSON.parse(await fs.readFile(...))` with no try/catch and no fallback — a truncated graph.json throws and the project is unopenable. Called from nodes.ts via updateAgent on the parallel wave path. Real and Critical.

### d2-persistence-concurrency-2 — CONFIRMED [Critical]
`updateAgent` (project-store.ts:221-234) does find→`Object.assign(node, merged)`→`await saveGraph()` with no lock. Driven concurrently from nodes.ts:256,313,531 inside mapCapped with MAX_PARALLEL=3 (nodes.ts:360). The `await` inside saveGraph yields the event loop; two siblings each serialize the whole shared `graph` object, so the later writer's snapshot can omit the earlier writer's just-set sessionId → last-write-wins drop of a sibling's sessionId, silently breaking resume/repair. Real and Critical.

### d2-persistence-concurrency-3 — CONFIRMED [Important]
A checkpoint is written every transition via io.checkpoint→store.put (orchestrator.ts:64,72). `listResumable` (run-store.ts:50-68) is referenced ONLY in run-store.ts itself and run-store.test.ts (grep confirms zero production callers). `resumeRun` (orchestrator.ts:43; ipc.ts:90-92) is wired only to the HITL run:resume(answer) path — crash-recovery resume is never triggered by the app. finishRun removes the checkpoint only on graceful terminal states (orchestrator.ts:121-125), so crashed-run checkpoints leak and are never swept. Durability machinery is effectively inert. Real and Important.

### d2-persistence-concurrency-4 — CONFIRMED [Important]
`applyReflection` (project-store.ts:511-521) does readFileOr→mergeMemory→`await fs.writeFile` with an await between read and write. `refreshFromTeam` (project-store.ts:640-648) and `writeMemory` (ipc.ts:65) write the same memory.md. Concurrent auto-pull/auto-push (orchestrator.ts:77,127) or a renderer memory edit during a run can interleave on the read→write gap and drop a whole-file writer's content (whole-file replace, no merge across writers). Real and Important.

### d2-persistence-concurrency-5 — CONFIRMED [Important]
`importTeam` (project-store.ts:708-740) and `applySpawnedTeam` (project-store.ts:744-795) both loop `fs.mkdir`/`fs.writeFile` for role.md+memory.md and `graph.nodes.push` BEFORE the single `saveGraph()` at the end. A throw/crash mid-loop leaves on-disk agent folders with no graph node (or a half-mutated in-memory graph) and there is no rollback, despite the "Saves the graph LAST for atomicity" comment (project-store.ts:706-707) — file writes are not part of that atomicity. Real and Important.

### d2-persistence-concurrency-6 — CONFIRMED [Important]
execute/repair read `agent.sessionId` (agent-runner.ts:119) where `agent` comes from buildAgentContext→getAgent (agent-runner.ts:88; project-store.ts:306,55-60), which returns the LIVE graph node by reference — the same object updateAgent mutates via Object.assign. Combined with finding-2's last-write-wins, a sibling can clobber sessionId before another step reads it, resuming the wrong session or starting fresh. The handoff path threads resumeSessionId explicitly (agent-runner.ts:118; nodes.ts:1003) to avoid exactly this, but execute/repair still round-trip the racy field. (Note: Node is single-threaded so a torn mid-statement read is impossible; the real risk is a stale/clobbered value, which is what the finding's impact rests on.) Real and Important.

### d2-persistence-concurrency-7 — ADJUSTED → [Minor]
Two sub-claims. (a) The PATH last-line heuristic (env.ts:26-30: split lines, keep those containing '/', `.pop()`) is real and genuinely fragile against a chatty .zshrc — confirmed. (b) The description "resolveClaudeBin runs an uncached blocking login shell per pty spawn ... on every spawnPty/checkAuth with no caching" is MATERIALLY OVERSTATED: resolveClaudeBin (env.ts:50-75) short-circuits on existsSync of ~/.local/bin/claude, /opt/homebrew/bin/claude, /usr/local/bin/claude (env.ts:51-57) and only falls to execSync when claude is in a NON-standard location — the common install never hits the shell. Also ensureLoginPath IS one-time cached via the `applied` flag (env.ts:6,16), contradicting the implied per-spawn cost. The execSync-per-spawn path is real but conditional/edge-case; the heuristic break is a niche startup failure. Net impact is Minor, not Important.

### d2-persistence-concurrency-8 — CONFIRMED [Minor]
run-store.put (run-store.ts:30-35) correctly does writeFile(tmp)→rename(tmp,target), but a crash between the two leaves `<runId>.<pid>.<seq>.tmp` and nothing in run-store.ts ever sweeps `.tmp` files. Unbounded disk leak over repeated crashes; low impact. Real and Minor.

### d2-persistence-concurrency-9 — CONFIRMED [Minor]
`setStatus` (nodes.ts:1160-1169) full-replaces `steps[nodeId]` with `{ ...stepBase(...), status }`; content writes (nodes.ts:137,319) likewise full-replace. stepBase reads the current steps[nodeId], so parallel-wave owners mutating the shared `steps` object can momentarily surface a status without the not-yet-written output. Run-view cosmetic only — no persisted-data loss. Real and Minor.

### d2-persistence-concurrency-10 — CONFIRMED [Minor]
`addRecent` (project-store.ts:807-812) reads→splices→writes recent-projects.json non-atomically (same pattern as saveGraph) from openProject (project-store.ts:184). Two windows/fast opens can lose an entry, but readFileOr('[]') fallback (project-store.ts:804) makes corruption self-healing. Real and Minor.

### d2-persistence-concurrency-11 — CONFIRMED [Minor]
`writePty` (pty-manager.ts:59-61) calls `sessions.get(ptyId)?.proc.write(data)` with no try/catch, unlike `resizePty` (pty-manager.ts:63-71) which guards. A keystroke arriving after kill but before onExit deletes the session (pty-manager.ts:51-54) can throw on a dead pty, swallowed at the IPC boundary; worst case a lost keystroke. Real and Minor.
