// The orchestration logic as a graph of nodes over a single RunState. Carved out
// of the old linear execute()/delegate() so it can be (a) checkpointed + resumed
// by the graph runtime and (b) tested end-to-end with an injected agent runner.
//
// The ONLY runtime dependency on the Agent SDK is `Eng.runAgent` (the seam):
// production passes `streamAgent`; tests pass a canned fake. project-store is the
// other dependency (topology/settings/memory) — mocked in tests.

import type { WebContents } from 'electron'
import type { StreamAgentOptions } from './agent-runner'
import type {
  Assignment,
  Autonomy,
  Effort,
  OrchestrationEvent,
  PermissionMode,
  RunPhase,
  RunStepRecord,
  RunState,
  RunTask,
  TaskState,
  TaskVerdict
} from '../../shared/types'
import { EFFORT_LEVELS } from '../../shared/types'
import { formatLessonBullet, lessonBullets, parseLessonBullet, type LessonScope } from '../../shared/lessons'
import { deriveOrderDeps, deriveStages } from '../../shared/workflow-order'
import { END, type CompiledGraph, type NodeIO, type NodeResult } from './graph'
import {
  applyReflection,
  childrenOf,
  getAgent,
  getEdges,
  getSettings,
  parentOf,
  readMemory,
  rolesOf,
  updateAgent
} from './project-store'

export const MAX_PARALLEL = 3

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const THINK_DISALLOW = [...EDIT_TOOLS, 'Bash', 'WebFetch', 'WebSearch']

/** The agent-execution seam: matches streamAgent so production injects it directly. */
export type AgentRunner = (opts: StreamAgentOptions) => Promise<{ text: string; sessionId?: string }>

/** Per-run engine dependencies handed to every node. */
export interface Eng {
  wc: WebContents
  abort: AbortController
  runId: string
  runAgent: AgentRunner
  emit: (e: OrchestrationEvent) => void
}

export function actingModeFor(autonomy: Autonomy): PermissionMode {
  if (autonomy === 'full') return 'bypassPermissions'
  if (autonomy === 'cautious') return 'acceptEdits'
  return 'auto'
}

export function seedRunState(args: {
  runId: string
  goal: string
  orchestratorId: string
  actingMode: PermissionMode
  startedAt: string
}): RunState {
  return {
    runId: args.runId,
    goal: args.goal,
    orchestratorId: args.orchestratorId,
    startedAt: args.startedAt,
    updatedAt: args.startedAt,
    status: 'running',
    phase: 'planning',
    cursor: 'plan',
    actingMode: args.actingMode,
    plan: [],
    tasks: {},
    steps: {},
    reviews: [],
    reflections: [],
    repairAttempts: 0,
    replanAttempts: 0,
    replanStageCursor: 0,
    final: ''
  }
}

// ---------- the graph ----------

export function buildOrchestratorGraph(eng: Eng): CompiledGraph {
  return {
    entry: 'plan',
    edges: {
      plan: 'route',
      route: 'execute',
      execute: 'domainReview',
      domainReview: 'integrationReview',
      integrationReview: 'reflect',
      repair: 'domainReview',
      reflect: 'synthesize',
      synthesize: END
    },
    nodes: {
      plan: (s, io) => planNode(s, io, eng),
      route: (s, io) => routeNode(s, io, eng),
      execute: (s, io) => executeNode(s, io, eng),
      domainReview: (s, io) => domainReviewNode(s, io, eng),
      integrationReview: (s, io) => integrationReviewNode(s, io, eng),
      repair: (s, io) => repairNode(s, io, eng),
      reflect: (s, io) => reflectNode(s, io, eng),
      synthesize: (s, io) => synthNode(s, io, eng)
    }
  }
}

// ---------- nodes ----------

async function planNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const steps = { ...state.steps }
  setStatus(eng, steps, state.orchestratorId, 'planning')
  const { tasks: plan, deps } = await planStep(eng, state.goal, state.orchestratorId)
  eng.emit({ runId: eng.runId, type: 'plan', nodeId: state.orchestratorId, tasks: plan })
  steps[state.orchestratorId] = { ...stepBase(state.orchestratorId, steps), tasks: plan }
  const tasks: Record<string, TaskState> = {}
  for (const t of plan) {
    tasks[t.id] = { task: t, ownerId: null, status: 'pending', attempts: 0, output: '' }
    if (deps[t.id]) tasks[t.id].dependsOn = deps[t.id]
  }
  return { patch: { plan, tasks, steps, phase: 'routing' } }
}

async function routeNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const tasks = structuredClone(state.tasks)
  const steps = { ...state.steps }
  // Route only un-owned tasks: the first pass routes everything; a re-plan pass routes
  // just the new/revised tasks, leaving frozen (already-owned) work in place.
  const toRoute = Object.keys(tasks).filter((id) => tasks[id].ownerId === null)
  await routeTasks(eng, tasks, steps, state.orchestratorId, toRoute, true)

  // Top-level edge ordering → task deps + per-task stage (Phase 1 + Phase 2). No-ops when
  // no edge carries an order.
  const owned = Object.values(tasks).map((t) => ({ id: t.task.id, ownerId: t.ownerId }))
  const orderDeps = deriveOrderDeps(getEdges(), state.orchestratorId, owned)
  for (const [taskId, deps] of Object.entries(orderDeps)) {
    const t = tasks[taskId]
    if (!t) continue
    t.dependsOn = [...new Set([...(t.dependsOn ?? []), ...deps])]
  }
  const stages = deriveStages(getEdges(), state.orchestratorId, owned)
  for (const [taskId, stage] of Object.entries(stages)) {
    if (tasks[taskId]) tasks[taskId].stage = stage
  }

  return { patch: { tasks, steps, phase: 'executing' } }
}

/** Recursively assign tasks down to leaf workers (sets ownerId); no execution. */
async function routeTasks(
  eng: Eng,
  tasks: Record<string, TaskState>,
  steps: Record<string, RunStepRecord>,
  nodeId: string,
  taskIds: string[],
  isRoot = false
): Promise<void> {
  if (eng.abort.signal.aborted) return
  const children = childrenOf(nodeId)
  if (children.length === 0) {
    for (const tid of taskIds) tasks[tid].ownerId = nodeId // leaf node owns its tasks
    return
  }
  setStatus(eng, steps, nodeId, 'assigning')
  const childRoles = await rolesOf(children.map((c) => c.id))
  // Enrich each child with a capped digest of its memory.md lessons, so routing
  // weighs track record, not just role text. Read in parallel.
  const childBriefs: ChildBrief[] = await Promise.all(
    childRoles.map(async (c) => ({ ...c, lessons: lessonsDigest(await readMemory(c.id)) }))
  )
  const taskList = taskIds.map((tid) => tasks[tid].task)
  const assignments = await assignStep(eng, nodeId, taskList, childBriefs)
  eng.emit({ runId: eng.runId, type: 'assignments', nodeId, assignments })
  steps[nodeId] = { ...stepBase(nodeId, steps), tasks: taskList, assignments }

  const childIds = new Set(children.map((c) => c.id))
  const byChild = new Map<string, string[]>()
  for (const a of assignments) {
    if (!tasks[a.taskId]) continue
    if (a.effort) tasks[a.taskId].effort = a.effort // leaf-router's assignment wins (recursion order)
    if (a.childId && childIds.has(a.childId)) {
      const list = byChild.get(a.childId) ?? []
      list.push(a.taskId)
      byChild.set(a.childId, list)
    }
    // unmatched (childId null / unknown) → ownerId stays null, surfaced later
  }
  for (const c of children) if (!byChild.has(c.id)) setStatus(eng, steps, c.id, 'skipped')

  for (const [childId, childTaskIds] of byChild) {
    if (childrenOf(childId).length > 0) {
      await routeTasks(eng, tasks, steps, childId, childTaskIds)
    } else {
      for (const tid of childTaskIds) tasks[tid].ownerId = childId
    }
  }

  // A router's only job is routing — mark it done once it has. The root
  // orchestrator stays active for its later review/synthesize phases.
  if (!isRoot && !eng.abort.signal.aborted) setStatus(eng, steps, nodeId, 'done')
}

async function executeNode(state: RunState, io: NodeIO, eng: Eng): Promise<NodeResult> {
  const tasks = structuredClone(state.tasks)
  const steps = { ...state.steps }

  // Execute one worker's batch of ready tasks in a single agent call.
  const runGroup = async (ownerId: string, group: TaskState[]): Promise<void> => {
    if (eng.abort.signal.aborted) return
    const titles = group.map((t) => t.task.title)
    for (const t of group) {
      tasks[t.task.id].status = 'running'
      tasks[t.task.id].attempts += 1
    }
    setStatus(eng, steps, ownerId, 'working', titles)
    const effort = getSettings().adaptiveEffort ? maxEffort(group.map((t) => t.effort)) : undefined
    try {
      const { text, sessionId } = await eng.runAgent({
        wc: eng.wc,
        agentId: ownerId,
        prompt: workerPrompt(state.goal, group.map((t) => t.task)),
        runId: eng.runId,
        stepId: ownerId,
        permissionMode: state.actingMode,
        effort,
        resume: false,
        abort: eng.abort
      })
      if (sessionId) await updateAgent({ id: ownerId, sessionId })
      const out = text || '(no output)'
      for (const t of group) {
        tasks[t.task.id].status = 'done'
        tasks[t.task.id].output = out
      }
      steps[ownerId] = { ...stepBase(ownerId, steps), output: out }
      setStatus(eng, steps, ownerId, eng.abort.signal.aborted ? 'skipped' : 'done', titles)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      for (const t of group) {
        tasks[t.task.id].status = 'done' // executed (with error) → flows into review like before
        tasks[t.task.id].output = `ERROR: ${msg}`
      }
      steps[ownerId] = { ...stepBase(ownerId, steps), output: `ERROR: ${msg}` }
      setStatus(eng, steps, ownerId, 'error', titles)
    }
    await io.checkpoint({ ...state, tasks: structuredClone(tasks), steps: { ...steps }, phase: 'executing' })
  }

  // Wave loop: each wave runs the still-pending tasks whose dependencies have
  // already executed, grouped by worker (one call per worker per wave). Tasks
  // unblocked by a wave run in the next one. With no deps this collapses to a
  // single wave — identical to the old flat reducer.
  while (!eng.abort.signal.aborted) {
    const pending = Object.values(tasks).filter((t) => t.status === 'pending' && t.ownerId)
    if (pending.length === 0) break
    let ready = pending.filter((t) => depsSatisfied(t, tasks))
    // Cycle guard: if work remains but nothing is ready, a dependency cycle (or a
    // dep on an owned task that never executed) is blocking — run the rest anyway
    // so the run can never hang.
    if (ready.length === 0) ready = pending
    const byOwner = new Map<string, TaskState[]>()
    for (const t of ready) {
      const list = byOwner.get(t.ownerId!) ?? []
      list.push(t)
      byOwner.set(t.ownerId!, list)
    }
    await mapCapped([...byOwner.entries()], MAX_PARALLEL, ([ownerId, group]) => runGroup(ownerId, group))
  }

  return { patch: { tasks, steps, phase: 'reviewing' } }
}

/** The immediate manager that reviews a task (the owner's parent), or the orchestrator. */
function reviewerOf(ownerId: string, orchestratorId: string): string {
  return parentOf(ownerId)?.id ?? orchestratorId
}

// Tier 1 — depth: each leaf task's immediate manager reviews its own group (orchestrator for flat workers).
async function domainReviewNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const settings = getSettings()
  const maxAttempts = maxAttemptsFor(settings)
  const doReview = maxAttempts > 0 || settings.reflection
  const owned = ownedTasks(state)
  if (!doReview || owned.length === 0) return { goto: 'reflect', patch: { phase: 'reflecting' } }

  // review tasks that are executed-but-not-yet-passed (initial run, or just-repaired)
  const toReview = owned.filter((t) => t.status === 'done')
  if (toReview.length === 0) return { goto: 'integrationReview', patch: { phase: 'reviewing' } }

  const tasks = structuredClone(state.tasks)
  const steps = { ...state.steps }

  // group tasks by their immediate manager (the reviewer)
  const groups = new Map<string, TaskState[]>()
  for (const t of toReview) {
    const rid = reviewerOf(t.ownerId!, state.orchestratorId)
    const list = groups.get(rid) ?? []
    list.push(t)
    groups.set(rid, list)
  }

  const recorded: TaskVerdict[] = []
  await mapCapped([...groups.entries()], MAX_PARALLEL, async ([reviewerId, group]) => {
    if (eng.abort.signal.aborted) return
    setStatus(eng, steps, reviewerId, 'reviewing', group.map((t) => t.task.title))
    const items = group.map((t) => ({
      taskId: t.task.id,
      title: t.task.title,
      asked: t.task.description,
      ownerName: getAgent(t.ownerId!).name,
      output: t.output
    }))
    let verdicts: { taskId: string; verdict: 'pass' | 'fail'; feedback: string }[]
    try {
      verdicts = await reviewStep(eng, state.goal, state.actingMode, reviewerId, items)
    } catch {
      return // a reviewer failure leaves its group unreviewed (status stays 'done'); surfaced upward
    }
    for (const v of verdicts) {
      const t = tasks[v.taskId]
      if (!t) continue
      t.verdict = { verdict: v.verdict, feedback: v.feedback }
      t.status = v.verdict === 'pass' ? 'passed' : 'failed'
      recorded.push({ taskId: v.taskId, nodeId: t.ownerId ?? null, verdict: v.verdict, feedback: v.feedback })
    }
    if (!eng.abort.signal.aborted) setStatus(eng, steps, reviewerId, 'done')
  })

  const reviewNo = state.reviews.length + 1
  const reviews = [...state.reviews, { attempt: reviewNo, tasks: recorded }]
  eng.emit({ runId: eng.runId, type: 'verdict', attempt: reviewNo, tasks: recorded })

  const failed = Object.values(tasks).filter((t) => t.ownerId && t.status === 'failed')
  if (failed.length > 0 && state.repairAttempts < maxAttempts && !eng.abort.signal.aborted) {
    return { patch: { tasks, steps, reviews, phase: 'repairing' }, goto: 'repair' }
  }
  return { patch: { tasks, steps, reviews, phase: 'reviewing' }, goto: 'integrationReview' }
}

// Tier 2 — breadth: the orchestrator checks the assembled result vs the plan+goal. Skipped for flat teams.
async function integrationReviewNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const settings = getSettings()
  const maxAttempts = maxAttemptsFor(settings)
  const doReview = maxAttempts > 0 || settings.reflection
  if (!doReview || !hasManagers(state) || ownedTasks(state).length === 0 || eng.abort.signal.aborted) {
    return { goto: 'reflect', patch: { steps: markWorkersDone(eng, state), phase: 'reflecting' } }
  }

  const tasks = structuredClone(state.tasks)
  const steps = { ...state.steps }
  setStatus(eng, steps, state.orchestratorId, 'reviewing')

  const items = ownedTasks(state).map((t) => ({
    taskId: t.task.id,
    title: t.task.title,
    asked: t.task.description,
    ownerName: getAgent(t.ownerId!).name,
    output: t.output
  }))
  let verdicts: { taskId: string; verdict: 'pass' | 'fail'; feedback: string }[]
  try {
    verdicts = await integrationReviewStep(eng, state.goal, state.actingMode, state.orchestratorId, state.plan, items)
  } catch {
    return { goto: 'reflect', patch: { steps: markWorkersDone(eng, state), phase: 'reflecting' } }
  }

  const recorded: TaskVerdict[] = []
  for (const v of verdicts) {
    const t = tasks[v.taskId]
    if (!t) continue
    t.verdict = { verdict: v.verdict, feedback: v.feedback }
    t.status = v.verdict === 'pass' ? 'passed' : 'failed'
    recorded.push({ taskId: v.taskId, nodeId: t.ownerId ?? null, verdict: v.verdict, feedback: v.feedback })
  }
  const reviewNo = state.reviews.length + 1
  const reviews = [...state.reviews, { attempt: reviewNo, tasks: recorded }]
  eng.emit({ runId: eng.runId, type: 'verdict', attempt: reviewNo, tasks: recorded })

  const failed = Object.values(tasks).filter((t) => t.ownerId && t.status === 'failed')
  if (failed.length > 0 && state.repairAttempts < maxAttempts && !eng.abort.signal.aborted) {
    return { patch: { tasks, steps, reviews, phase: 'repairing' }, goto: 'repair' }
  }
  for (const wid of workerIdsOf(tasks)) if (!eng.abort.signal.aborted) setStatus(eng, steps, wid, 'done')
  return { patch: { tasks, steps, reviews, phase: 'reflecting' }, goto: 'reflect' }
}

async function repairNode(state: RunState, io: NodeIO, eng: Eng): Promise<NodeResult> {
  const tasks = structuredClone(state.tasks)
  const steps = { ...state.steps }
  const failed = Object.values(tasks).filter((t) => t.ownerId && t.status === 'failed')

  await mapCapped(failed, MAX_PARALLEL, async (t) => {
    if (eng.abort.signal.aborted) return
    const ownerId = t.ownerId!
    setStatus(eng, steps, ownerId, 'working', [t.task.title])
    tasks[t.task.id].attempts += 1
    const effort = getSettings().adaptiveEffort ? t.effort : undefined
    try {
      const { text, sessionId } = await eng.runAgent({
        wc: eng.wc,
        agentId: ownerId,
        prompt: repairPrompt(state.goal, t.task, t.verdict?.feedback ?? ''),
        runId: eng.runId,
        stepId: ownerId,
        permissionMode: state.actingMode,
        effort,
        resume: true,
        abort: eng.abort
      })
      if (sessionId) await updateAgent({ id: ownerId, sessionId })
      tasks[t.task.id].output = text || tasks[t.task.id].output
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      tasks[t.task.id].output = `[repair failed: ${msg}]`
      setStatus(eng, steps, ownerId, 'error', [t.task.title])
    }
    tasks[t.task.id].status = 'done' // re-executed → eligible for re-review
    tasks[t.task.id].verdict = undefined
    steps[ownerId] = { ...stepBase(ownerId, steps), output: tasks[t.task.id].output }
  })

  await io.checkpoint({ ...state, tasks: structuredClone(tasks), steps: { ...steps }, phase: 'repairing' })
  return { patch: { tasks, steps, phase: 'reviewing', repairAttempts: state.repairAttempts + 1 }, goto: 'domainReview' }
}

async function reflectNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const settings = getSettings()
  const owned = ownedTasks(state)
  if (!settings.reflection || owned.length === 0 || eng.abort.signal.aborted) {
    return { goto: 'synthesize', patch: { phase: 'synthesizing' } }
  }
  const steps = { ...state.steps }
  const reflections = [...state.reflections]
  await mapCapped(workerIdsOf(state.tasks), MAX_PARALLEL, async (wid) => {
    if (eng.abort.signal.aborted) return
    const wTasks = owned.filter((t) => t.ownerId === wid)
    setStatus(eng, steps, wid, 'reflecting', wTasks.map((t) => t.task.title))
    const items = wTasks.map((t) => ({
      title: t.task.title,
      output: t.output,
      review: t.verdict
        ? `${t.verdict.verdict.toUpperCase()}${t.verdict.feedback ? ' — ' + t.verdict.feedback : ''}`
        : 'n/a'
    }))
    const refl = await reflectStep(eng, state.goal, wid, items)
    if (!refl) return
    await applyReflection(wid, { ...refl, label: state.goal.slice(0, 80) })
    reflections.push({ nodeId: wid, ...refl })
    eng.emit({ runId: eng.runId, type: 'reflection', nodeId: wid, ...refl })
    setStatus(eng, steps, wid, 'done')
  })

  // reviewers (managers + the orchestrator's integration pass) reflect on their QA work
  await mapCapped(reviewerIdsOf(state), MAX_PARALLEL, async (rid) => {
    if (eng.abort.signal.aborted) return
    const reviewed =
      rid === state.orchestratorId
        ? owned // the orchestrator integration-reviewed the whole
        : owned.filter((t) => reviewerOf(t.ownerId!, state.orchestratorId) === rid)
    if (reviewed.length === 0) return
    setStatus(eng, steps, rid, 'reflecting', reviewed.map((t) => t.task.title))
    const items = reviewed.map((t) => ({
      title: t.task.title,
      output: t.output,
      review: t.verdict
        ? `${t.verdict.verdict.toUpperCase()}${t.verdict.feedback ? ' — ' + t.verdict.feedback : ''}`
        : 'n/a'
    }))
    const refl = await reflectStep(eng, state.goal, rid, items, qaReflectPrompt)
    if (!refl) return
    await applyReflection(rid, { ...refl, label: state.goal.slice(0, 80) })
    reflections.push({ nodeId: rid, ...refl })
    eng.emit({ runId: eng.runId, type: 'reflection', nodeId: rid, ...refl })
    setStatus(eng, steps, rid, 'done')
  })
  return { patch: { steps, reflections, phase: 'synthesizing' }, goto: 'synthesize' }
}

async function synthNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const steps = { ...state.steps }
  setStatus(eng, steps, state.orchestratorId, 'working')
  const owned = ownedTasks(state)
  const results = owned.length > 0 ? formatResults(state) + formatVerdicts(state) : '(no work was assigned)'
  const final = await synthesizeStep(eng, state.goal, state.actingMode, state.orchestratorId, state.plan, results)
  eng.emit({ runId: eng.runId, type: 'final', text: final })
  setStatus(eng, steps, state.orchestratorId, 'done')
  return { patch: { steps, final, phase: 'done' } }
}

// ---------- Claude steps (use the injected runAgent) ----------

async function planStep(
  eng: Eng,
  goal: string,
  orchestratorId: string
): Promise<{ tasks: RunTask[]; deps: Record<string, string[]> }> {
  const parsed = await runStructured(
    eng,
    orchestratorId,
    planPrompt(goal),
    (v): v is { tasks: unknown[] } => Array.isArray((v as { tasks?: unknown })?.tasks),
    { permissionMode: 'default', disallowedTools: THINK_DISALLOW }
  )
  const raw = parsed.tasks as Record<string, unknown>[]
  const tasks: RunTask[] = raw.map((t, i) => ({
    id: typeof t.id === 'string' && t.id ? t.id : `t${i + 1}`,
    title: String(t.title ?? `Task ${i + 1}`),
    description: String(t.description ?? t.title ?? '')
  }))
  // Parse deps, dropping self-references and ids that aren't real tasks.
  const ids = new Set(tasks.map((t) => t.id))
  const deps: Record<string, string[]> = {}
  raw.forEach((t, i) => {
    const id = tasks[i].id
    const list = Array.isArray(t.dependsOn)
      ? [...new Set(t.dependsOn.map((x) => String(x)))].filter((x) => x !== id && ids.has(x))
      : []
    if (list.length) deps[id] = list
  })
  return { tasks, deps }
}

/** A child node as the router sees it: identity, role text, and a lessons digest. */
type ChildBrief = { id: string; name: string; kind: string; role: string; lessons: string[] }

async function assignStep(
  eng: Eng,
  nodeId: string,
  tasks: RunTask[],
  childRoles: ChildBrief[]
): Promise<Assignment[]> {
  const parsed = await runStructured(
    eng,
    nodeId,
    assignPrompt(tasks, childRoles),
    (v): v is { assignments: unknown[] } => Array.isArray((v as { assignments?: unknown })?.assignments),
    { permissionMode: 'default', disallowedTools: THINK_DISALLOW }
  )
  return (parsed.assignments as Record<string, unknown>[]).map((a) => ({
    taskId: String(a.taskId ?? ''),
    childId: typeof a.childId === 'string' && a.childId !== 'null' ? a.childId : null,
    effort: parseEffort(a.effort),
    reason: String(a.reason ?? '')
  }))
}

async function reviewStep(
  eng: Eng,
  goal: string,
  actingMode: PermissionMode,
  orchestratorId: string,
  items: { taskId: string; title: string; asked: string; ownerName: string; output: string }[]
): Promise<{ taskId: string; verdict: 'pass' | 'fail'; feedback: string }[]> {
  const parsed = await runStructured(
    eng,
    orchestratorId,
    reviewPrompt(goal, items),
    (v): v is { tasks: unknown[] } => Array.isArray((v as { tasks?: unknown })?.tasks),
    { permissionMode: actingMode, disallowedTools: EDIT_TOOLS }
  )
  const byId = new Map<string, { verdict: 'pass' | 'fail'; feedback: string }>()
  for (const t of parsed.tasks as Record<string, unknown>[]) {
    const taskId = String(t.taskId ?? '')
    const verdict = String(t.verdict ?? 'pass').toLowerCase() === 'fail' ? 'fail' : 'pass'
    byId.set(taskId, { verdict, feedback: String(t.feedback ?? '') })
  }
  return items.map((it) => ({
    taskId: it.taskId,
    verdict: byId.get(it.taskId)?.verdict ?? 'pass',
    feedback: byId.get(it.taskId)?.feedback ?? ''
  }))
}

async function integrationReviewStep(
  eng: Eng,
  goal: string,
  actingMode: PermissionMode,
  orchestratorId: string,
  plan: RunTask[],
  items: { taskId: string; title: string; asked: string; ownerName: string; output: string }[]
): Promise<{ taskId: string; verdict: 'pass' | 'fail'; feedback: string }[]> {
  const parsed = await runStructured(
    eng,
    orchestratorId,
    integrationReviewPrompt(goal, plan, items),
    (v): v is { tasks: unknown[] } => Array.isArray((v as { tasks?: unknown })?.tasks),
    { permissionMode: actingMode, disallowedTools: EDIT_TOOLS }
  )
  const byId = new Map<string, { verdict: 'pass' | 'fail'; feedback: string }>()
  for (const t of parsed.tasks as Record<string, unknown>[]) {
    const taskId = String(t.taskId ?? '')
    const verdict = String(t.verdict ?? 'pass').toLowerCase() === 'fail' ? 'fail' : 'pass'
    byId.set(taskId, { verdict, feedback: String(t.feedback ?? '') })
  }
  return items.map((it) => ({
    taskId: it.taskId,
    verdict: byId.get(it.taskId)?.verdict ?? 'pass',
    feedback: byId.get(it.taskId)?.feedback ?? ''
  }))
}

async function reflectStep(
  eng: Eng,
  goal: string,
  workerId: string,
  items: { title: string; output: string; review: string }[],
  buildPrompt: (goal: string, items: { title: string; output: string; review: string }[]) => string = reflectPrompt
): Promise<{ win: string; loss: string; lessons: string[] } | null> {
  if (eng.abort.signal.aborted) return null
  try {
    const parsed = await runStructured(
      eng,
      workerId,
      buildPrompt(goal, items),
      (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
      { permissionMode: 'default', disallowedTools: THINK_DISALLOW }
    )
    const p = parsed as { win?: unknown; loss?: unknown; lessons?: unknown }
    const lessons = Array.isArray(p.lessons)
      ? p.lessons.map(normalizeLessonInput).filter((l): l is string => l !== null).slice(0, 6)
      : []
    return { win: String(p.win ?? '').trim(), loss: String(p.loss ?? '').trim(), lessons }
  } catch {
    return null // reflection failure is non-fatal
  }
}

async function synthesizeStep(
  eng: Eng,
  goal: string,
  actingMode: PermissionMode,
  orchestratorId: string,
  plan: RunTask[],
  results: string
): Promise<string> {
  const { text } = await eng.runAgent({
    wc: eng.wc,
    agentId: orchestratorId,
    prompt: synthPrompt(goal, plan, results),
    runId: eng.runId,
    stepId: orchestratorId,
    permissionMode: actingMode,
    abort: eng.abort
  })
  return text
}

/** Run an agent, parse a JSON block from its output, retrying once. */
async function runStructured<T>(
  eng: Eng,
  agentId: string,
  basePrompt: string,
  validate: (v: unknown) => v is T,
  perm: { permissionMode: PermissionMode; disallowedTools?: string[] }
): Promise<T> {
  let lastText = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    if (eng.abort.signal.aborted) throw new Error('cancelled')
    const prompt = attempt === 0 ? basePrompt : basePrompt + STRICT_REMINDER
    const { text } = await eng.runAgent({
      wc: eng.wc,
      agentId,
      prompt,
      runId: eng.runId,
      stepId: agentId,
      permissionMode: perm.permissionMode,
      disallowedTools: perm.disallowedTools,
      abort: eng.abort
    })
    lastText = text
    const parsed = parseJsonBlock(text)
    if (parsed && validate(parsed)) return parsed
  }
  throw new Error(`${getAgent(agentId).name} did not return valid JSON. Last output:\n${lastText.slice(0, 400)}`)
}

// ---------- state helpers ----------

function maxAttemptsFor(settings: { reviewMode: string; maxRepairAttempts: number }): number {
  return settings.reviewMode === 'none'
    ? 0
    : settings.reviewMode === 'once'
      ? 1
      : Math.max(1, settings.maxRepairAttempts)
}

function ownedTasks(state: RunState): TaskState[] {
  return Object.values(state.tasks).filter((t) => t.ownerId)
}

/** True when at least one owned task's immediate parent is a manager (the team is two-tier). */
export function hasManagers(state: RunState): boolean {
  return ownedTasks(state).some((t) => parentOf(t.ownerId!)?.kind === 'manager')
}

/**
 * The nodes that performed a review this run, for reflection: the manager parents of owned
 * tasks, plus the orchestrator when the integration pass ran (i.e. when managers exist).
 * Empty for flat teams — so flat teams keep worker-only reflection.
 */
export function reviewerIdsOf(state: RunState): string[] {
  const ids = new Set<string>()
  for (const t of ownedTasks(state)) {
    const p = parentOf(t.ownerId!)
    if (p && p.kind === 'manager') ids.add(p.id)
  }
  if (hasManagers(state)) ids.add(state.orchestratorId)
  return [...ids]
}

/**
 * Whether a task is ready to execute — every dependency it must wait on has
 * already run. We only block on deps that are OWNED and not yet executed; unknown
 * ids and unowned (never-executing) deps are ignored so a run can't wait forever.
 */
export function depsSatisfied(t: TaskState, tasks: Record<string, TaskState>): boolean {
  for (const id of t.dependsOn ?? []) {
    const dep = tasks[id]
    if (!dep || !dep.ownerId) continue // unknown id or will-never-run → don't wait on it
    if (dep.status === 'pending' || dep.status === 'running') return false
  }
  return true
}

/** Validate a value from the manager into an Effort level, or undefined. */
function parseEffort(v: unknown): Effort | undefined {
  return EFFORT_LEVELS.includes(v as Effort) ? (v as Effort) : undefined
}

/**
 * Capped digest of the `## Lessons` bullets from an agent's memory.md, for routing.
 * Lets a router weigh a child's track record, not just its role text. Drops the
 * "(none yet)" placeholder and HTML-comment lines, collapses whitespace, truncates
 * each lesson, and caps how many are returned so the routing prompt stays bounded.
 */
export function lessonsDigest(memory: string, maxLessons = 5, maxLen = 160): string[] {
  const out: string[] = []
  for (const bullet of lessonBullets(memory)) {
    if (out.length >= maxLessons) break
    const { scope, text } = parseLessonBullet(bullet)
    if (scope === 'project') continue // project-specific trivia is not a routing signal
    out.push(text.length > maxLen ? text.slice(0, maxLen) + '…' : text)
  }
  return out
}

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

/** The highest effort in a worker's batch (so the hardest task is served), or undefined. */
export function maxEffort(efforts: (Effort | undefined)[]): Effort | undefined {
  const present = efforts.filter((e): e is Effort => !!e)
  if (present.length === 0) return undefined
  return present.reduce((a, b) => (EFFORT_LEVELS.indexOf(b) > EFFORT_LEVELS.indexOf(a) ? b : a))
}

function workerIdsOf(tasks: Record<string, TaskState>): string[] {
  return [...new Set(Object.values(tasks).filter((t) => t.ownerId).map((t) => t.ownerId!))]
}

function markWorkersDone(eng: Eng, state: RunState): Record<string, RunStepRecord> {
  const steps = { ...state.steps }
  for (const wid of workerIdsOf(state.tasks)) if (!eng.abort.signal.aborted) setStatus(eng, steps, wid, 'done')
  return steps
}

function stepBase(nodeId: string, steps: Record<string, RunStepRecord>): RunStepRecord {
  const node = getAgent(nodeId)
  return steps[nodeId] ?? { nodeId, nodeName: node.name, kind: node.kind, status: 'idle' }
}

function setStatus(
  eng: Eng,
  steps: Record<string, RunStepRecord>,
  nodeId: string,
  status: RunStepRecord['status'],
  taskTitles?: string[]
): void {
  steps[nodeId] = { ...stepBase(nodeId, steps), status }
  eng.emit({ runId: eng.runId, type: 'status', nodeId, status, taskTitles })
}

async function mapCapped<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return results
}

function parseJsonBlock(text: string): unknown {
  const candidates: string[] = []
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
  if (fences.length) candidates.push(fences[fences.length - 1][1])
  candidates.push(text)
  for (const c of candidates) {
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1))
    } catch {
      // try next candidate
    }
  }
  return null
}

function formatResults(state: RunState): string {
  return state.plan
    .map((t) => {
      const ts = state.tasks[t.id]
      const name = ts?.ownerId ? getAgent(ts.ownerId).name : 'unassigned'
      const out = ts?.output || '(not done)'
      return `### ${t.title} — ${name}\n${out}`
    })
    .join('\n\n')
}

function formatVerdicts(state: RunState): string {
  const lines = state.plan
    .map((t) => {
      const v = state.tasks[t.id]?.verdict
      if (!v) return null
      return `- ${t.title}: ${v.verdict.toUpperCase()}${v.feedback ? ' — ' + v.feedback : ''}`
    })
    .filter((l): l is string => l !== null)
  return lines.length ? `\n\n## Review verdicts\n${lines.join('\n')}` : ''
}

// ---------- prompts (ported verbatim from the original engine) ----------

const STRICT_REMINDER =
  '\n\nIMPORTANT: Your previous reply could not be parsed. Reply with ONLY the JSON code block described above — no prose before or after.'

function planPrompt(goal: string): string {
  return `You are planning work to achieve the user's goal for this project. You may READ files to inform the plan, but do NOT make any changes.

GOAL:
${goal}

Produce a concise, ordered list of concrete tasks that together fully achieve the goal. Each task should be self-contained and suitable to hand to a single specialist. Prefer the smallest set of tasks that covers the goal.

A task may optionally declare "dependsOn": an array of the ids of tasks that MUST be finished before it can start (e.g. a frontend task that needs the backend API to exist first). Add a dependency ONLY when a task genuinely cannot begin until another is done — most tasks have none, so use [] or omit it. Never create a cycle.

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "tasks": [ { "id": "t1", "title": "short title", "description": "what to do, in enough detail for a specialist", "dependsOn": [] } ] }
\`\`\``
}

function assignPrompt(tasks: RunTask[], childRoles: ChildBrief[]): string {
  const specialists = childRoles
    .map((c) => {
      const head = `- id: ${c.id}\n  name: ${c.name} (${c.kind})\n  role: ${c.role.replace(/\s+/g, ' ').slice(0, 600)}`
      const track = c.lessons.length
        ? `\n  track record (lessons from past work):\n${c.lessons.map((l) => `    • ${l}`).join('\n')}`
        : ''
      return head + track
    })
    .join('\n')
  const taskList = tasks.map((t) => `- id: ${t.id} — ${t.title}: ${t.description}`).join('\n')
  return `You route planned tasks to the specialists who report to you. For each specialist you can see their role AND their track record (lessons they've recorded from past work). Assign every task to the ONE specialist whose role best matches it — and when more than one role fits, prefer the specialist whose track record shows the most relevant, reliable experience for that task. If no specialist fits a task, set childId to null. Do NOT make changes to files.

For EACH task, also assess its difficulty and assign a reasoning "effort" level for the specialist who will do it:
- low: trivial / boilerplate
- medium: simple, well-defined
- high: normal engineering work (default)
- xhigh: tricky, ambiguous, or wide-reaching
- max: hardest — deep reasoning, subtle correctness, or high stakes
Be economical — reserve xhigh/max for genuinely hard tasks (they cost more).

SPECIALISTS:
${specialists}

TASKS:
${taskList}

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "assignments": [ { "taskId": "t1", "childId": "<specialist id, or null>", "effort": "low|medium|high|xhigh|max", "reason": "why" } ] }
\`\`\``
}

function workerPrompt(goal: string, tasks: RunTask[]): string {
  const list = tasks.map((t, i) => `${i + 1}. ${t.title}\n   ${t.description}`).join('\n\n')
  return `You are working as part of a team to achieve this overall goal:
${goal}

You have been assigned the following task(s). Complete them in this project folder, making the necessary changes. Apply any relevant lessons from your memory.

${list}

If your work is a web app or anything that serves pages, do not rely on unit tests or "the code looks right" — actually run it and load the entry page: confirm it returns 200 AND every asset it references (CSS, JS, images) also returns 200. A static-path or route mismatch that 404s assets makes the page render as unstyled, broken HTML even when your code is correct. Don't report success until the page renders fully.

When finished, briefly report what you changed and flag anything you could not complete.`
}

function synthPrompt(goal: string, plan: RunTask[], results: string): string {
  const planList = plan.map((t) => `- ${t.title}: ${t.description}`).join('\n')
  return `You are the lead for this project. Your team has executed the plan for this goal:
${goal}

The plan was:
${planList}

Here is what came back from the team:
${results}

Write a clear final report: what was accomplished, how it maps to the goal, and anything still missing or needing follow-up. If a small, obviously-safe final integration is needed, you may do it.`
}

function reviewPrompt(
  goal: string,
  items: { taskId: string; title: string; asked: string; ownerName: string; output: string }[]
): string {
  const list = items
    .map(
      (it) =>
        `- taskId: ${it.taskId}\n  title: ${it.title}\n  asked: ${it.asked}\n  done by: ${it.ownerName}\n  result: ${it.output.replace(/\s+/g, ' ').slice(0, 1200)}`
    )
    .join('\n')
  return `You are reviewing your team's work against the goal. You may READ files and RUN the app/commands to verify (start a server, curl an endpoint, run the tests) — you just must not edit files.

GOAL:
${goal}

Judge each task below: did the result actually accomplish what was asked, in service of the goal? Mark "pass" or "fail". For any "fail", give specific, actionable feedback the worker can use to fix it.

If the work is a web app or anything that serves pages, do NOT trust unit tests or the worker's report alone — run it: start the app, request the entry URL, and confirm it returns 200 AND every asset it references (CSS, JS, images) also returns 200. A common silent failure is assets 404ing from a static-path/route mismatch, which makes the page render as unstyled HTML even though the code is correct. Fail the task if the page does not render fully.

TASKS TO REVIEW:
${list}

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "tasks": [ { "taskId": "t1", "verdict": "pass", "feedback": "required when fail" } ] }
\`\`\``
}

function integrationReviewPrompt(
  goal: string,
  plan: RunTask[],
  items: { taskId: string; title: string; asked: string; ownerName: string; output: string }[]
): string {
  const planList = plan.map((t, i) => `${i + 1}. ${t.title} — ${t.description}`).join('\n')
  const list = items
    .map(
      (it) =>
        `- taskId: ${it.taskId}\n  title: ${it.title}\n  by: ${it.ownerName}\n  result: ${it.output.replace(/\s+/g, ' ').slice(0, 1200)}`
    )
    .join('\n')
  return `You are doing the final INTEGRATION review of your team's assembled work. Your managers already reviewed each piece for domain correctness — your job is the BROADER check: do the pieces fit together, is anything missing or off-goal, does the integrated whole actually satisfy the plan and the goal? You may READ files and RUN the integrated app to verify — you just must not edit files.

GOAL:
${goal}

THE PLAN:
${planList}

THE ASSEMBLED RESULT (per task):
${list}

Assess each task for whether it fits the integrated whole and serves the goal. Mark "pass" or "fail"; for any "fail" give specific, actionable feedback the worker can use. If the plan itself is missing something needed for the goal, note it in the feedback of the most related task (it will be surfaced; you cannot re-plan here).

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "tasks": [ { "taskId": "t1", "verdict": "pass", "feedback": "required when fail" } ] }
\`\`\``
}

function repairPrompt(goal: string, task: RunTask, feedback: string): string {
  return `Your previous attempt at this task did not pass review. Fix it now in the project folder.

OVERALL GOAL: ${goal}

TASK: ${task.title}
${task.description}

REVIEWER FEEDBACK (address this specifically):
${feedback || '(none provided)'}

When done, briefly report what you changed to address the feedback.`
}

function reflectPrompt(goal: string, items: { title: string; output: string; review: string }[]): string {
  const list = items
    .map(
      (it) =>
        `- task: ${it.title}\n  result: ${it.output.replace(/\s+/g, ' ').slice(0, 800)}\n  review: ${it.review}`
    )
    .join('\n')
  return `Reflect on the work you just did so you improve next time. Do NOT change any files — just reflect.

OVERALL GOAL: ${goal}

YOUR TASK(S), RESULT, AND THE REVIEWER'S VERDICT:
${list}

Capture, honestly and concisely:
- win: the single most useful thing that worked.
- loss: the main thing that went wrong or fell short (empty string if nothing did).
- lessons: 1-4 short, reusable rules for your future self — especially how to avoid repeating any mistake the reviewer flagged. For EACH lesson set a "scope":
    - "portable": general software-engineering wisdom that would help on ANY project (testing, verification, debugging, review habits).
    - "project": a fact or convention specific to THIS codebase or goal (file paths, commands, config locations, domain quirks) that would NOT transfer elsewhere.
  When unsure, use "project".

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "win": "...", "loss": "...", "lessons": [ { "text": "...", "scope": "portable" } ] }
\`\`\``
}

function qaReflectPrompt(goal: string, items: { title: string; output: string; review: string }[]): string {
  const list = items
    .map(
      (it) =>
        `- task: ${it.title}\n  result: ${it.output.replace(/\s+/g, ' ').slice(0, 800)}\n  your verdict: ${it.review}`
    )
    .join('\n')
  return `Reflect on your REVIEW work this run so your future reviews get sharper. Do NOT change any files — just reflect.

OVERALL GOAL: ${goal}

THE WORK YOU REVIEWED, AND YOUR VERDICT:
${list}

Capture, honestly and concisely:
- win: the most useful thing your review caught or did well.
- loss: the main thing you missed or could check better next time (empty string if none).
- lessons: 1-4 short, reusable QA rules for your future self — what to TEST or VERIFY in your domain, common failure modes to watch for, what "good" looks like. For EACH lesson set a "scope":
    - "portable": general QA/testing/review wisdom that helps on ANY project.
    - "project": a fact specific to THIS codebase or goal (what to check here, where things live).
  When unsure, use "project".

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "win": "...", "loss": "...", "lessons": [ { "text": "...", "scope": "portable" } ] }
\`\`\``
}
