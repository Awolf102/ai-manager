# R3 — Scheduling edge cases (#22 multi-asker, #26 self-dep, #15 staged writes) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix three independent run-scheduling integrity defects — `deriveOrderDeps` self-dependency (#26),
non-transactional team writes leaving orphans (#15), and discarded same-wave HITL askers (#22).

**Architecture:** Three disjoint-file fixes, one task each. #26 is a one-line filter in a pure function. #15
makes `importTeam`/`applySpawnedTeam` write-then-commit with rollback via two helpers. #22 queues all same-wave
asks and drains them across sequential interrupts (each resuming its own captured session), bounded by the
`maxUserRequests` budget, with over-budget askers auto-continued.

**Tech Stack:** TypeScript, Vitest. Pure logic in `src/shared`, engine in `src/main/engine`.

**Spec:** `docs/superpowers/specs/2026-06-29-scheduling-edge-cases-design.md`

## Global Constraints

- **Off-path byte-for-byte:** #26 only changes output when a worker is shared across ordered teams; #15 happy
  path is byte-for-byte (same files + same `saveGraph` result), rollback only on error; #22 single-asker and
  `maxUserRequests=0` paths are byte-for-byte.
- **#22 budget:** `maxUserRequests` = total user prompts. Present up to the remaining budget; over-budget
  askers auto-continue via `answerResumePrompt('')` (the "did not provide an answer" path) — never re-run fresh.
- **S5 invariant preserved:** the resume capture point still redacts the answer; no raw answer in persisted
  state. `askQueue` carries questions + sessionIds only (never answers) and is checkpoint-only (NOT in
  `RunRecord`/`toRunRecord`).
- Scope: `src/shared/workflow-order.ts`, `src/main/engine/project-store.ts`, `src/main/engine/nodes.ts`,
  `src/shared/types.ts` + their tests. No renderer changes.
- **Verification gates:** `npm test` (currently 359 green), `npm run typecheck` (node+web), `npm run build`.

---

## Task 1: #26 — `deriveOrderDeps` never emits a self-dependency

**Files:**
- Modify: `src/shared/workflow-order.ts` (the dep-building loop, ~lines 55-60)
- Test: `src/shared/workflow-order.test.ts`

**Interfaces:**
- `deriveOrderDeps(edges, orchestratorId, tasks): Record<string, string[]>` — signature unchanged; output no
  longer contains `id` within `out[id]`.

- [ ] **Step 1: Write the failing test**

Add to `src/shared/workflow-order.test.ts` inside `describe('deriveOrderDeps', …)` (the `T`/`E` helpers are at
the top of the file: `T(id, ownerId)`, `E(source, target, order?)`):

```ts
  it('never emits a self-dependency when one worker is shared across two ordered teams', () => {
    // w1 is under BOTH team-1 (order 1) and team-2 (order 2); it owns t1 (in team 2's slot)
    const edges = [E('o', 'w1', 1), E('o', 'w2', 2), E('o', 'w1', 2)]
    const out = deriveOrderDeps(edges, 'o', [T('t1', 'w1'), T('t2', 'w2')])
    for (const [id, deps] of Object.entries(out)) {
      expect(deps).not.toContain(id) // no task depends on itself
    }
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/shared/workflow-order.test.ts -t "self-dependency"`
Expected: FAIL — `out.t1` contains `'t1'` (the shared worker's task appears in both team slots).

- [ ] **Step 3: Filter self-references in the dep loop**

In `src/shared/workflow-order.ts`, change the dep-building loop (currently lines 55-61):

```ts
  const out: Record<string, string[]> = {}
  for (let k = 0; k < teamTasks.length; k++) {
    const earlier = [...new Set(teamTasks.slice(0, k).flat())]
    if (earlier.length === 0) continue
    for (const id of teamTasks[k]) {
      const deps = earlier.filter((e) => e !== id) // never depend on yourself (shared-worker across ordered teams)
      if (deps.length) out[id] = deps
    }
  }
  return out
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/shared/workflow-order.test.ts`
Expected: PASS — the new test + all pre-existing `deriveOrderDeps`/`deriveStages`/`applyOrderClick` tests
(non-shared ordering is unchanged: `earlier` never contained those ids, so the filter is a no-op there).

- [ ] **Step 5: Commit**

```bash
git add src/shared/workflow-order.ts src/shared/workflow-order.test.ts
git commit -m "fix(order): deriveOrderDeps drops self-deps for a worker shared across ordered teams (#26)

A worker under two ordered top-level teams had its task in both the earlier
and current team sets, so out[id] included id itself -> permanent
depsSatisfied=false (only the cycle-guard saved it). Filter e !== id at the
source; the nodes.ts merge site stays clean.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: #15 — transactional team writes (`importTeam` / `applySpawnedTeam`)

**Files:**
- Modify: `src/main/engine/project-store.ts` (add `rollbackDirs` + `commitTeamAdditions`; refactor `importTeam`
  ~lines 765-797 and `applySpawnedTeam` ~lines 799-849)
- Test: `src/main/engine/project-store.test.ts`

**Interfaces:**
- New module-local `async function rollbackDirs(dirs: string[]): Promise<void>` (best-effort removal).
- New module-local `async function commitTeamAdditions(graph: ProjectGraph, writes: { dir: string; role: string; memory: string }[], newNodes: AgentNodeData[], newEdges: GraphEdge[], linkedTeam?: { teamId: string; path: string }): Promise<ProjectGraph>` — writes files, then commits nodes/edges + `saveGraph()`, rolling back everything on any error.
- `importTeam`/`applySpawnedTeam` signatures unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `src/main/engine/project-store.test.ts` a new describe block (the file already imports `fs`,
`existsSync`, `join`, `vi`, `openProject`, `createAgent`, `importTeam`, `applySpawnedTeam`, `exportTeam`, and
has an `async function tmpProject()` helper returning a fresh project dir):

```ts
describe('team-write transactionality (#15)', () => {
  it('applySpawnedTeam: a member file-write failure leaves no orphan dir and an unchanged graph', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    const g = await createAgent({ name: 'Boss', kind: 'orchestrator' })
    const boss = g.nodes.find((n) => n.name === 'Boss')!
    const realWrite = fs.writeFile
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).includes('memory.md')) throw new Error('disk full')
      return (realWrite as any)(p, ...rest)
    }) as any)
    try {
      await expect(
        applySpawnedTeam([{ id: 'm1', name: 'Lead', kind: 'manager', role: '# Role', reportsTo: 'orchestrator' }], boss.id)
      ).rejects.toThrow('disk full')
    } finally {
      spy.mockRestore()
    }
    // no orphan dir for the would-be member, and the persisted graph still has only Boss
    expect(existsSync(join(proj, '.ai-manager', 'agents', 'lead'))).toBe(false)
    const reopened = await openProject(proj)
    expect(reopened.nodes).toHaveLength(1)
    expect(reopened.nodes[0].name).toBe('Boss')
  })

  it('applySpawnedTeam: a saveGraph failure rolls back created dirs and reverts the in-memory graph', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    const g = await createAgent({ name: 'Boss', kind: 'orchestrator' })
    const boss = g.nodes.find((n) => n.name === 'Boss')!
    const realWrite = fs.writeFile
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).includes('graph.json')) throw new Error('graph save failed')
      return (realWrite as any)(p, ...rest)
    }) as any)
    try {
      await expect(
        applySpawnedTeam([{ id: 'm1', name: 'Lead', kind: 'manager', role: '# Role', reportsTo: 'orchestrator' }], boss.id)
      ).rejects.toThrow('graph save failed')
    } finally {
      spy.mockRestore()
    }
    expect(existsSync(join(proj, '.ai-manager', 'agents', 'lead'))).toBe(false) // dir rolled back
    const reopened = await openProject(proj)
    expect(reopened.nodes).toHaveLength(1) // graph reverted (only Boss persisted)
  })

  it('importTeam: a member file-write failure leaves no orphan dir and an unchanged graph', async () => {
    // build a one-member bundle via export from a separate project
    const src = await tmpProject()
    await openProject(src)
    await createAgent({ name: 'Dana', kind: 'worker' })
    const bundle = await exportTeam()

    const proj = await tmpProject()
    await openProject(proj)
    const realWrite = fs.writeFile
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation((async (p: any, ...rest: any[]) => {
      if (String(p).includes('memory.md')) throw new Error('disk full')
      return (realWrite as any)(p, ...rest)
    }) as any)
    try {
      await expect(importTeam(bundle)).rejects.toThrow('disk full')
    } finally {
      spy.mockRestore()
    }
    const reopened = await openProject(proj)
    expect(reopened.nodes).toHaveLength(0) // nothing imported
  })
})
```

> Note: `applySpawnedTeam`/`importTeam` write `role.md` before `memory.md`, so throwing on `memory.md`
> exercises a mid-member failure (role.md already written → its dir must still be rolled back). Throwing on
> `graph.json` (the `atomicWriteWithBackup` temp is `…/graph.json.<pid>.<n>.tmp`, which contains `graph.json`)
> exercises the `saveGraph`-failure branch.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/engine/project-store.test.ts -t "transactionality"`
Expected: FAIL — current code leaves the orphan `lead`/member dir and/or a half-mutated graph (no rollback).

- [ ] **Step 3: Add the helpers**

In `src/main/engine/project-store.ts`, add near the other team helpers (above `importTeam`). Confirm
`AgentNodeData` and `GraphEdge` are already imported (they are — used throughout); `randomUUID`, `aimPath`,
`AGENTS_DIR`, `join`, `fs`, `saveGraph` are in scope.

```ts
/** Best-effort removal of dirs created during a failed team add (rollback). */
async function rollbackDirs(dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {
      // best-effort: a dir that can't be removed is no worse than the failure we're already handling
    }
  }
}

/** Transactional team add: write all member files, THEN commit nodes/edges + persist. On ANY error
 *  (file write or saveGraph) remove the dirs created here and revert the in-memory graph, then rethrow.
 *  Slugs are uniquified against the in-memory graph by callers, so each `dir` is new — safe to remove. */
async function commitTeamAdditions(
  graph: ProjectGraph,
  writes: { dir: string; role: string; memory: string }[],
  newNodes: AgentNodeData[],
  newEdges: GraphEdge[],
  linkedTeam?: { teamId: string; path: string }
): Promise<ProjectGraph> {
  const createdDirs: string[] = []
  try {
    for (const w of writes) {
      await fs.mkdir(w.dir, { recursive: true })
      createdDirs.push(w.dir)
      await fs.writeFile(join(w.dir, 'role.md'), w.role, 'utf8')
      await fs.writeFile(join(w.dir, 'memory.md'), w.memory, 'utf8')
    }
  } catch (err) {
    await rollbackDirs(createdDirs)
    throw err
  }
  const origNodeLen = graph.nodes.length
  const origEdgeLen = graph.edges.length
  const origLinked = graph.linkedTeam
  graph.nodes.push(...newNodes)
  graph.edges.push(...newEdges)
  if (linkedTeam) graph.linkedTeam = linkedTeam
  try {
    return await saveGraph()
  } catch (err) {
    graph.nodes.length = origNodeLen // push-only → truncation reverts the mutation
    graph.edges.length = origEdgeLen
    graph.linkedTeam = origLinked
    await rollbackDirs(createdDirs)
    throw err
  }
}
```

- [ ] **Step 4: Refactor `importTeam` to use the helper**

Replace the body of `importTeam` (keep the signature; update the docstring) with:

```ts
/** Add a bundle's team into the open project: new agents (fresh ids, uniquified slugs, seeded memory),
 *  remapped edges. Writes member files first, then commits the graph; rolls everything back on any error. */
export async function importTeam(bundle: TeamBundle, brainPath?: string): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const plan = planTeamImport(bundle, graph.nodes.map((n) => n.slug))
  const idByMember = new Map<string, string>()
  const writes: { dir: string; role: string; memory: string }[] = []
  const newNodes: AgentNodeData[] = []
  for (const m of plan.members) {
    const id = randomUUID()
    idByMember.set(m.memberId, id)
    writes.push({ dir: aimPath(path, AGENTS_DIR, m.slug), role: m.role, memory: m.memory })
    const node: AgentNodeData = {
      id,
      name: m.name,
      slug: m.slug,
      kind: m.kind,
      icon: m.icon,
      model: m.model,
      permissionMode: m.permissionMode,
      memberId: m.memberId,
      position: m.position
    }
    if (m.skills && m.skills.length) node.skills = m.skills
    newNodes.push(node)
  }
  const newEdges: GraphEdge[] = []
  for (const e of plan.edges) {
    const source = idByMember.get(e.source)
    const target = idByMember.get(e.target)
    if (source && target) newEdges.push({ id: `${source}->${target}`, source, target })
  }
  const linkedTeam = bundle.teamId && brainPath ? { teamId: bundle.teamId, path: brainPath } : undefined
  return commitTeamAdditions(graph, writes, newNodes, newEdges, linkedTeam)
}
```

- [ ] **Step 5: Refactor `applySpawnedTeam` to use the helper**

Replace the file-writing + node/edge + `saveGraph` portion of `applySpawnedTeam` (the loop body that did
`fs.mkdir`/`fs.writeFile`/`graph.nodes.push`, the edge loop, and the final `return saveGraph()`) so all the
id/slug/layout computation stays but defers writes/commit to the helper. The new tail of the function (keep
everything above `const idByTemp = new Map…` unchanged):

```ts
  const idByTemp = new Map<string, string>()
  const writes: { dir: string; role: string; memory: string }[] = []
  const newNodes: AgentNodeData[] = []
  for (const m of members) {
    const id = randomUUID()
    idByTemp.set(m.id, id)
    const slug = uniqueSlug(slugify(m.name), taken)
    taken.add(slug)
    const d = depthOf(m)
    const col = perDepth.get(d) ?? 0
    perDepth.set(d, col + 1)
    writes.push({ dir: aimPath(path, AGENTS_DIR, slug), role: m.role, memory: memoryTemplate(m.name) })
    const node: AgentNodeData = {
      id,
      name: m.name,
      slug,
      kind: m.kind,
      icon: iconForName(m.name, m.kind),
      model: pickSpawnModel(m, getSettings().autoAssignModels),
      permissionMode: 'acceptEdits',
      position: { x: base.x + col * 220, y: base.y + d * 150 }
    }
    if (m.skills && m.skills.length) node.skills = m.skills
    newNodes.push(node)
  }
  const newEdges: GraphEdge[] = []
  for (const m of members) {
    const childId = idByTemp.get(m.id)!
    const parentId = m.reportsTo === 'orchestrator' ? orchestratorId : idByTemp.get(m.reportsTo)
    if (parentId) newEdges.push({ id: `${parentId}->${childId}`, source: parentId, target: childId })
  }
  return commitTeamAdditions(graph, writes, newNodes, newEdges)
}
```

- [ ] **Step 6: Run the transactionality tests + the existing team tests**

Run: `npx vitest run src/main/engine/project-store.test.ts`
Expected: PASS — the 3 new transactionality tests AND the pre-existing `team export/import round-trip`,
`applySpawnedTeam`, and brain-sync tests (happy path unchanged: same files, same nodes/edges, same `saveGraph`).

- [ ] **Step 7: Run full suite + typecheck + build**

Run: `npm test` (expect 359 + 3 = 362), `npm run typecheck`, `npm run build` — all clean.

- [ ] **Step 8: Commit**

```bash
git add src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "fix(team): make importTeam/applySpawnedTeam transactional with rollback (#15)

Both wrote member role.md/memory.md and pushed graph nodes in a loop, then
saveGraph LAST — a mid-loop file error or saveGraph failure left orphan agent
dirs with no graph node (and a half-mutated in-memory graph). Now: build
nodes/edges with no side effects, write all files (tracking created dirs),
then commit graph + saveGraph; on ANY error remove created dirs and revert
the in-memory graph. Happy path byte-for-byte.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: #22 — queue & drain same-wave HITL askers

**Files:**
- Modify: `src/shared/types.ts` (add `askQueue?` to `RunState`, ~after line 432)
- Modify: `src/main/engine/nodes.ts` (extract `resumeAsker`; rework the resume re-entry + the capture/pause
  block; add `askQueue` to `scrub`)
- Test: `src/main/engine/nodes.test.ts`

**Interfaces:**
- `RunState.askQueue?: { ownerId: string; taskIds: string[]; sessionId?: string; question: string }[]` —
  remaining same-wave asks after `pendingAsk`; checkpoint-only (not in `RunRecord`).
- New module-local `async function resumeAsker(eng: Eng, ask: { ownerId: string; taskIds: string[]; sessionId?: string }, answer: string, actingMode: PermissionMode, tasks: Record<string, TaskState>, steps: Record<string, RunStepRecord>): Promise<void>` — resumes one asker's session with `answer` (empty = no-answer continuation), redacts + captures output into `tasks`/`steps`.

- [ ] **Step 1: Write the failing tests**

Add to `src/main/engine/nodes.test.ts`, in a new describe block near the HITL tests (uses the existing `eng`,
`fakeStore`, `makeIO`, `seedRunState`, `buildOrchestratorGraph`, `runGraph`, `resumeGraph`, and the hoisted `h`
whose default topology is `o → [w1, w2]`). The 2-asker canned agent:

```ts
describe('orchestrator node graph — multiple same-wave askers (#22)', () => {
  function twoAskers() {
    const calls: { agentId: string; kind: string; sessionId?: string; prompt: string }[] = []
    const asked = new Set<string>()
    const runAgent: AgentRunner = async (o) => {
      const p = o.prompt
      const id = o.agentId
      if (p.includes('Produce a concise, ordered list'))
        return { text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"d1"},{"id":"t2","title":"T2","description":"d2"}]}\n```', sessionId: 's-' + id }
      if (p.includes('You route planned tasks'))
        return { text: '```json\n{"assignments":[{"taskId":"t1","childId":"w1","reason":"r"},{"taskId":"t2","childId":"w2","reason":"r"}]}\n```' }
      if (p.includes('The user answered') || p.includes('did not provide an answer')) {
        calls.push({ agentId: id, kind: 'resume', sessionId: o.resumeSessionId, prompt: p })
        return { text: `resumed ${id}`, sessionId: 's2-' + id }
      }
      if (p.includes('You have been assigned')) {
        if ((id === 'w1' || id === 'w2') && !asked.has(id)) {
          asked.add(id)
          calls.push({ agentId: id, kind: 'ask', prompt: p })
          return { text: `\`\`\`ask\n{"question":"Q-${id}"}\n\`\`\``, sessionId: `sess-${id}` }
        }
        calls.push({ agentId: id, kind: 'work', prompt: p })
        return { text: `worked ${id}`, sessionId: 's-' + id }
      }
      if (p.includes('Judge each task'))
        return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""},{"taskId":"t2","verdict":"pass","feedback":""}]}\n```' }
      if (p.includes('final INTEGRATION review'))
        return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""},{"taskId":"t2","verdict":"pass","feedback":""}]}\n```' }
      if (p.includes('Reflect on')) return { text: '```json\n{"win":"w","loss":"","lessons":[]}\n```' }
      if (p.includes('Write a clear final report')) return { text: 'FINAL' }
      return { text: 'unknown' }
    }
    return { runAgent, calls }
  }

  it('budget 2: queues both askers, presents each, and resumes each via its OWN session', async () => {
    h.settings.maxUserRequests = 2
    const { runAgent, calls } = twoAskers()
    const e = eng(runAgent)
    const store = fakeStore()
    const io = makeIO(e.abort.signal, store)
    await runGraph(buildOrchestratorGraph(e), seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }), store, io)
    const mid = await resumeGraph(buildOrchestratorGraph(e), 'run1', store, io, 'answer-one')
    expect(mid.status).toBe('interrupted') // paused again for the 2nd asker
    const final = await resumeGraph(buildOrchestratorGraph(e), 'run1', store, io, 'answer-two')
    expect(final.status).toBe('completed')
    const resumes = calls.filter((c) => c.kind === 'resume')
    expect(resumes.map((r) => r.sessionId).sort()).toEqual(['sess-w1', 'sess-w2']) // own sessions, not fresh
    expect(resumes.find((r) => r.sessionId === 'sess-w1')!.prompt).toContain('answer-one')
    expect(resumes.find((r) => r.sessionId === 'sess-w2')!.prompt).toContain('answer-two')
    expect((final.userRequests ?? []).map((u) => u.askerId).sort()).toEqual(['w1', 'w2'])
  })

  it('budget 1: presents the first asker and auto-continues the overflow asker (no fresh re-run)', async () => {
    h.settings.maxUserRequests = 1
    const { runAgent, calls } = twoAskers()
    const e = eng(runAgent)
    const store = fakeStore()
    const io = makeIO(e.abort.signal, store)
    await runGraph(buildOrchestratorGraph(e), seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }), store, io)
    const final = await resumeGraph(buildOrchestratorGraph(e), 'run1', store, io, 'the-answer')
    expect(final.status).toBe('completed') // no second pause
    const resumes = calls.filter((c) => c.kind === 'resume')
    expect(resumes.map((r) => r.sessionId).sort()).toEqual(['sess-w1', 'sess-w2']) // both resumed own session
    expect(resumes.find((r) => r.sessionId === 'sess-w1')!.prompt).toContain('the-answer')
    expect(resumes.find((r) => r.sessionId === 'sess-w2')!.prompt).toContain('did not provide an answer')
    expect((final.userRequests ?? []).length).toBe(1) // only one question surfaced
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/engine/nodes.test.ts -t "same-wave askers"`
Expected: FAIL — today only `asks[0]` is honored: the 2nd asker is re-run fresh (no `resume` call for
`sess-w2`), `mid.status` is not a second pause, and only one question is recorded.

- [ ] **Step 3: Add `askQueue` to `RunState`**

In `src/shared/types.ts`, after the `pendingAsk?` field (~line 432) add:

```ts
  /** remaining same-wave asks to present after pendingAsk (queue); checkpoint-only, never in History */
  askQueue?: { ownerId: string; taskIds: string[]; sessionId?: string; question: string }[]
```

- [ ] **Step 4: Extract `resumeAsker` + clear `askQueue` in `scrub`**

In `src/main/engine/nodes.ts`, add this module-local helper (place it just above `executeNode`):

```ts
/** Resume one asking worker's session with `answer` (empty = "no answer; use judgment"); redact + capture
 *  its output into its tasks/steps. Used by the HITL resume, the queue drain, and over-budget auto-continue. */
async function resumeAsker(
  eng: Eng,
  ask: { ownerId: string; taskIds: string[]; sessionId?: string },
  answer: string,
  actingMode: PermissionMode,
  tasks: Record<string, TaskState>,
  steps: Record<string, RunStepRecord>
): Promise<void> {
  const owned = ask.taskIds.map((id) => tasks[id]).filter(Boolean)
  const titles = owned.map((t) => t.task.title)
  setStatus(eng, steps, ask.ownerId, 'working', titles)
  try {
    const r = await eng.runAgent({
      wc: eng.wc,
      agentId: ask.ownerId,
      prompt: answerResumePrompt(answer),
      runId: eng.runId,
      stepId: ask.ownerId,
      permissionMode: actingMode,
      resume: true,
      resumeSessionId: ask.sessionId,
      abort: eng.abort
    })
    if (r.sessionId) await updateAgent({ id: ask.ownerId, sessionId: r.sessionId })
    const out = redactUserAnswer(r.text || '(no output)', answer)
    for (const t of owned) {
      t.status = 'done'
      t.output = out
    }
    steps[ask.ownerId] = { ...stepBase(ask.ownerId, steps), output: out }
    setStatus(eng, steps, ask.ownerId, eng.abort.signal.aborted ? 'skipped' : 'done', titles)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    for (const t of owned) {
      t.status = 'done'
      t.output = `ERROR: ${msg}`
    }
    steps[ask.ownerId] = { ...stepBase(ask.ownerId, steps), output: `ERROR: ${msg}` }
    setStatus(eng, steps, ask.ownerId, 'error', titles)
  }
}
```

Update the `scrub` declaration (currently line 237) to also clear `askQueue`:

```ts
  const scrub = { resumeInput: undefined, pendingAsk: undefined, askQueue: undefined } as Partial<RunState>
```

- [ ] **Step 5: Rework the resume re-entry block (drain the queue)**

Replace the resume re-entry block (currently lines 239-277, from `// ── RE-ENTRY:` through its closing `}`) with:

```ts
  // ── RE-ENTRY: a human answered (or skipped). Resume the asking worker, then drain any queued asks. ──
  if (state.resumeInput !== undefined && state.pendingAsk) {
    await resumeAsker(eng, state.pendingAsk, String(state.resumeInput ?? ''), state.actingMode, tasks, steps)
    userRequestCount += 1
    await io.checkpoint({ ...state, ...scrub, tasks: structuredClone(tasks), steps: { ...steps }, userRequestCount, phase: 'executing', ...(io.collectExtras?.() ?? {}) })
    const queue = state.askQueue ?? []
    if (queue.length > 0) {
      const [next, ...rest] = queue
      userRequests.push({ askerId: next.ownerId, question: next.question })
      return {
        patch: {
          resumeInput: undefined,
          tasks,
          steps,
          userRequestCount,
          ...(userRequests.length ? { userRequests } : {}),
          pendingAsk: next,
          askQueue: rest.length ? rest : undefined,
          phase: 'executing'
        },
        interrupt: {
          kind: 'ask-user',
          prompt: next.question,
          payload: { askerId: next.ownerId, askerName: getAgent(next.ownerId).name, question: next.question }
        }
      }
    }
  }
```

- [ ] **Step 6: Rework the capture/pause block (queue + budget + overflow)**

Replace the capture/pause block (currently lines 364-378, from `// ── A worker asked during this wave` through
its closing `}`) with:

```ts
    // ── Workers asked during this wave → queue them; present up to the user-request budget. ──
    if (asks.length > 0 && !eng.abort.signal.aborted) {
      asks.sort((a, b) => state.plan.findIndex((p) => p.id === a.taskIds[0]) - state.plan.findIndex((p) => p.id === b.taskIds[0]))
      const slots = Math.max(1, maxUserRequests - userRequestCount) // remaining budget (>=1 while asks fired)
      const present = asks.slice(0, slots)
      const overflow = asks.slice(slots)
      // over-budget askers: resume their captured session with no answer — never re-run fresh, never lost
      for (const ask of overflow) await resumeAsker(eng, ask, '', state.actingMode, tasks, steps)
      const [head, ...rest] = present
      userRequests.push({ askerId: head.ownerId, question: head.question })
      return {
        patch: {
          resumeInput: undefined,
          tasks,
          steps,
          userRequestCount,
          ...(userRequests.length ? { userRequests } : {}),
          pendingAsk: head,
          askQueue: rest.length ? rest : undefined,
          phase: 'executing'
        },
        interrupt: {
          kind: 'ask-user',
          prompt: head.question,
          payload: { askerId: head.ownerId, askerName: getAgent(head.ownerId).name, question: head.question }
        }
      }
    }
```

- [ ] **Step 7: Run the #22 tests + the existing HITL tests**

Run: `npx vitest run src/main/engine/nodes.test.ts`
Expected: PASS — the 2 new multi-asker tests AND every pre-existing HITL test (single-asker, off,
redact-echoed-answer, resume-continues) stays green. The single-asker path is byte-for-byte: `present=[a0]`,
`askQueue` undefined, one pause, one resume, empty queue → falls through exactly as before; `resumeAsker`'s body
is the old inline block verbatim.

- [ ] **Step 8: Run full suite + typecheck + build**

Run: `npm test`, `npm run typecheck`, `npm run build` — all clean.

- [ ] **Step 9: Commit**

```bash
git add src/shared/types.ts src/main/engine/nodes.ts src/main/engine/nodes.test.ts
git commit -m "fix(hitl): queue & drain multiple same-wave askers, bounded by budget (#22)

A parallel wave could have several workers emit ask blocks; only asks[0] was
honored and the rest were discarded (their sessions re-run fresh, questions
lost). Now: persist all same-wave asks (new RunState.askQueue, checkpoint-only),
present each up to maxUserRequests across sequential interrupts (each resumes
its OWN captured session via the extracted resumeAsker), and auto-continue
over-budget askers with the no-answer prompt. Single-asker + maxUserRequests=0
byte-for-byte; S5 redaction intact.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (before the whole-branch review)

- [ ] `npm test` — full suite green (359 + 5 new = 364).
- [ ] `npm run typecheck` (node + web) clean; `npm run build` clean.
- [ ] Re-read the diff for the Global Constraints: #26 no-op for non-shared ordering; #15 happy path
      byte-for-byte; #22 single-asker + `maxUserRequests=0` byte-for-byte; `askQueue` never in `RunRecord`; no
      raw answer in persisted state.

---

## Self-Review (against the spec)

**Spec coverage:**
- §#26 (self-filter in `deriveOrderDeps`) → Task 1. ✓
- §#15 (write-then-commit + rollback helpers; refactor both functions) → Task 2. ✓
- §#22 (queue-drain bounded by budget; overflow auto-continue; `askQueue` state; `resumeAsker`) → Task 3. ✓
- §Tests (each finding's cases) → Tasks 1-3 test steps. ✓
- §Non-goals (mutual-dep depth, crash-atomicity, concurrency, renderer) → untouched. ✓
- §Constraints (off-path byte-for-byte; S5; `askQueue` checkpoint-only) → Task 2 happy-path tests + Task 3
  single-asker/off tests + the field doc. ✓

**Placeholder scan:** none — all steps carry concrete code + commands.

**Type consistency:** `resumeAsker` signature is used identically in the resume block and the overflow loop;
`askQueue` element shape matches `pendingAsk`; `commitTeamAdditions`/`rollbackDirs` signatures match their call
sites in `importTeam`/`applySpawnedTeam`; `AgentNodeData`/`GraphEdge`/`ProjectGraph` are existing types.
