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
  Effort,
  Interrupt,
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
import { mergeReplan, pendingStageBoundary } from '../../shared/replan'
import { END, type CompiledGraph, type NodeIO, type NodeResult } from './graph'
import {
  applyReflection,
  childrenOf,
  getAgent,
  getEdges,
  getSettings,
  handoffPeersOf,
  hasDesignSystem,
  parentOf,
  readMemory,
  rolesOf,
  updateAgent
} from './project-store'
import { parseHandoff } from '../../shared/handoff'
import { parseAskUser, redactUserAnswer } from '../../shared/ask-user'
import { parseFollowUps, parseFollowUpAsk } from '../../shared/follow-through'
import { clampEffort } from '../../shared/model-caps'
import { capEffort } from '../../shared/token-efficiency'
import { parallelCap } from '../../shared/team-scale'
import { designPreviewPrompt, INSPIRATION_GUIDE } from '../../shared/design-preview'

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
  /** per-run cumulative record of peer handoffs (persisted via NodeIO.collectExtras) */
  handoffs: { askerId: string; peerId: string; ask: string }[]
  /** per-run cumulative record of headless follow-through decisions (persisted via NodeIO.collectExtras) */
  followUps: { workerId: string; summary: string; decision: string }[]
}

export { actingModeFor } from './acting-mode'

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
    userRequestCount: 0,
    followThroughCount: 0,
    final: ''
  }
}

// ---------- the graph ----------

export function buildOrchestratorGraph(eng: Eng): CompiledGraph {
  const gate = getSettings().designPreview && !hasDesignSystem()
  return {
    entry: 'plan',
    edges: {
      plan: 'route',
      route: gate ? 'designPreviewGate' : 'execute',
      ...(gate ? { designPreviewGate: 'execute' } : {}),
      execute: 'domainReview',
      replan: 'execute',
      escalate: 'reflect',
      domainReview: 'integrationReview',
      integrationReview: 'reflect',
      repair: 'domainReview',
      reflect: 'synthesize',
      synthesize: END
    },
    nodes: {
      plan: (s, io) => planNode(s, io, eng),
      route: (s, io) => routeNode(s, io, eng),
      ...(gate ? { designPreviewGate: (s, io) => designPreviewGateNode(s, io, eng) } : {}),
      execute: (s, io) => executeNode(s, io, eng),
      replan: (s, io) => replanNode(s, io, eng),
      escalate: (s, io) => escalateNode(s, io, eng),
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
      abort: eng.abort,
      modelOverride: workerModelOverride(getSettings())
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

/** Resume a follow-through asker with the user's decision (or Skip). Records the resolution
 *  as a followUp (cycle-1 surfacing) and does NOT scrub — a scope decision isn't a secret. */
export async function resumeFollowUpAsk(
  eng: Eng,
  item: { ownerId: string; taskIds: string[]; sessionId?: string; summary?: string },
  answer: string,
  actingMode: PermissionMode,
  tasks: Record<string, TaskState>,
  steps: Record<string, RunStepRecord>
): Promise<void> {
  const owned = item.taskIds.map((id) => tasks[id]).filter(Boolean)
  const titles = owned.map((t) => t.task.title)
  const decision = answer.trim() || '(skipped — the worker proceeded with a reasonable assumption)'
  setStatus(eng, steps, item.ownerId, 'working', titles)
  try {
    const r = await eng.runAgent({
      wc: eng.wc,
      agentId: item.ownerId,
      prompt: answerResumePrompt(answer),
      runId: eng.runId,
      stepId: item.ownerId,
      permissionMode: actingMode,
      resume: true,
      resumeSessionId: item.sessionId,
      abort: eng.abort,
      modelOverride: workerModelOverride(getSettings())
    })
    if (r.sessionId) await updateAgent({ id: item.ownerId, sessionId: r.sessionId })
    const out = r.text || '(no output)'
    for (const t of owned) {
      t.status = 'done'
      t.output = out
    }
    steps[item.ownerId] = { ...stepBase(item.ownerId, steps), output: out }
    setStatus(eng, steps, item.ownerId, eng.abort.signal.aborted ? 'skipped' : 'done', titles)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    for (const t of owned) {
      t.status = 'done'
      t.output = `ERROR: ${msg}`
    }
    steps[item.ownerId] = { ...stepBase(item.ownerId, steps), output: `ERROR: ${msg}` }
    setStatus(eng, steps, item.ownerId, 'error', titles)
  }
  eng.followUps.push({ workerId: item.ownerId, summary: item.summary ?? '', decision })
  eng.emit({ runId: eng.runId, type: 'follow-up', workerId: item.ownerId, summary: item.summary ?? '', decision })
}

interface DesignDecision {
  decision: 'approve' | 'changes'
  feedback?: string
}

/** Run one focused orchestrator acting-call to (re)write design-preview.html. Throws on agent error. */
async function generateDesignPreview(eng: Eng, state: RunState, feedback?: string): Promise<void> {
  const s = getSettings()
  const guide = s.usePreMadeInspirationGuide ? INSPIRATION_GUIDE : ''
  const fb = feedback
    ? `\n\nThe user requested changes to the previous preview: ${feedback}\nProduce a revised design-preview.html that addresses this.`
    : ''
  await eng.runAgent({
    wc: eng.wc,
    agentId: state.orchestratorId,
    prompt: designPreviewPrompt(state.goal, guide) + fb,
    runId: eng.runId,
    stepId: state.orchestratorId,
    permissionMode: state.actingMode,
    abort: eng.abort
  })
}

/**
 * Design-preview approval gate. On fresh entry (or a 'changes' resume) it generates
 * a preview and pauses (interrupt). On an 'approve' resume it records approval and
 * proceeds to execute. Fails open (→ execute) if generation throws — never blocks a build.
 */
async function designPreviewGateNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const decision = state.resumeInput as DesignDecision | undefined
  if (decision?.decision === 'approve') {
    return { patch: { resumeInput: undefined, designPreviewApproved: true, phase: 'executing' }, goto: 'execute' }
  }
  const steps = { ...state.steps }
  setStatus(eng, steps, state.orchestratorId, 'working')
  const feedback = decision?.decision === 'changes' ? decision.feedback : undefined
  try {
    await generateDesignPreview(eng, state, feedback)
  } catch {
    // fail-open: a preview failure must never block the build
    return { patch: { resumeInput: undefined, steps, phase: 'executing' }, goto: 'execute' }
  }
  const iteration = (state.designPreviewIteration ?? 0) + 1
  return {
    patch: { resumeInput: undefined, steps, designPreviewIteration: iteration, phase: 'previewing' },
    interrupt: { kind: 'design-preview', prompt: 'Review the design preview', payload: { iteration } }
  }
}

async function executeNode(state: RunState, io: NodeIO, eng: Eng): Promise<NodeResult> {
  const tasks = structuredClone(state.tasks)
  const steps = { ...state.steps }
  const maxUserRequests = getSettings().maxUserRequests ?? 0
  let userRequestCount = state.userRequestCount ?? 0
  const maxFollowThrough = getSettings().maxFollowThrough ?? 0
  let followThroughCount = state.followThroughCount ?? 0
  const userRequests = [...(state.userRequests ?? [])]
  // collected when a worker asks during a wave (one is chosen to pause on)
  const asks: { ownerId: string; taskIds: string[]; sessionId?: string; question: string; source: 'ask-user' | 'follow-through'; summary?: string; options?: string[] }[] = []
  const asksAvailable = (): boolean => maxUserRequests > 0 && userRequestCount < maxUserRequests
  const followThroughAskAvailable = (): boolean => getSettings().followThrough === 'ask' && followThroughCount < maxFollowThrough
  // cleared on EVERY return so a consumed answer never persists (sensitive)
  const scrub = { resumeInput: undefined, pendingAsk: undefined, askQueue: undefined } as Partial<RunState>

  // ── RE-ENTRY: a human answered (or skipped). Resume the asking worker, then drain any queued asks. ──
  if (state.resumeInput !== undefined && state.pendingAsk) {
    const answer = String(state.resumeInput ?? '')
    if (state.pendingAsk.source === 'follow-through') {
      await resumeFollowUpAsk(eng, state.pendingAsk, answer, state.actingMode, tasks, steps)
      followThroughCount += 1
    } else {
      await resumeAsker(eng, state.pendingAsk, answer, state.actingMode, tasks, steps)
      userRequestCount += 1
    }
    await io.checkpoint({ ...state, ...scrub, tasks: structuredClone(tasks), steps: { ...steps }, userRequestCount, followThroughCount, phase: 'executing', ...(io.collectExtras?.() ?? {}) })
    const queue = state.askQueue ?? []
    if (queue.length > 0) {
      const [next, ...rest] = queue
      if (next.source !== 'follow-through') userRequests.push({ askerId: next.ownerId, question: next.question })
      return {
        patch: {
          resumeInput: undefined,
          tasks,
          steps,
          userRequestCount,
          followThroughCount,
          ...(userRequests.length ? { userRequests } : {}),
          pendingAsk: next,
          askQueue: rest.length ? rest : undefined,
          phase: 'executing'
        },
        interrupt: interruptFor(next)
      }
    }
  }

  // Execute one worker's batch of ready tasks in a single agent call.
  const runGroup = async (ownerId: string, group: TaskState[]): Promise<void> => {
    if (eng.abort.signal.aborted) return
    const titles = group.map((t) => t.task.title)
    for (const t of group) {
      tasks[t.task.id].status = 'running'
      tasks[t.task.id].attempts += 1
    }
    setStatus(eng, steps, ownerId, 'working', titles)
    const es = getSettings()
    const effort = es.adaptiveEffort || es.effortThrift ? maxEffort(group.map((t) => t.effort)) : undefined
    try {
      const base: StreamAgentOptions = {
        wc: eng.wc,
        agentId: ownerId,
        prompt: workerPrompt(state.goal, group.map((t) => t.task), es.lightPrompts, es.visionMode, state.designPreviewApproved === true) + (asksAvailable() ? askUserSection() : '') + (es.followThrough === 'headless' ? followThroughSection() : '') + (es.followThrough === 'ask' ? followThroughAskSection() : ''),
        runId: eng.runId,
        stepId: ownerId,
        permissionMode: state.actingMode,
        effort,
        resume: false,
        abort: eng.abort,
        modelOverride: workerModelOverride(es)
      }
      const { text, sessionId } = await runWithHandoffs(
        eng,
        base,
        consultFor(ownerId, state.goal, state.actingMode)
      )
      // ── HEADLESS FOLLOW-THROUGH: record inferred features (no pause). ──
      if (es.followThrough === 'headless') {
        for (const fu of parseFollowUps(text)) {
          eng.followUps.push({ workerId: ownerId, summary: fu.summary, decision: fu.decision })
          eng.emit({ runId: eng.runId, type: 'follow-up', workerId: ownerId, summary: fu.summary, decision: fu.decision })
        }
      }
      // ── FOLLOW-THROUGH ASK: a worker wants the user to decide an under-specified feature → pause. ──
      if (followThroughAskAvailable()) {
        const fa = parseFollowUpAsk(text)
        if (fa) {
          for (const t of group) tasks[t.task.id].status = 'pending'
          asks.push({ ownerId, taskIds: group.map((t) => t.task.id), sessionId, question: fa.question, source: 'follow-through', summary: fa.summary, options: fa.options })
          return
        }
      }
      // ── ASK DETECTION: a worker asked → leave its group pending, record the ask. ──
      if (asksAvailable()) {
        const req = parseAskUser(text)
        if (req) {
          for (const t of group) tasks[t.task.id].status = 'pending'
          asks.push({ ownerId, taskIds: group.map((t) => t.task.id), sessionId, question: req.question, source: 'ask-user' })
          return
        }
      }
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
        tasks[t.task.id].status = 'done'
        tasks[t.task.id].output = `ERROR: ${msg}`
      }
      steps[ownerId] = { ...stepBase(ownerId, steps), output: `ERROR: ${msg}` }
      setStatus(eng, steps, ownerId, 'error', titles)
    }
    await io.checkpoint({ ...state, ...scrub, tasks: structuredClone(tasks), steps: { ...steps }, userRequestCount, phase: 'executing', ...(io.collectExtras?.() ?? {}) })
  }

  // Wave loop: each wave runs the still-pending tasks whose dependencies have
  // already executed, grouped by worker (one call per worker per wave). Tasks
  // unblocked by a wave run in the next one. With no deps this collapses to a
  // single wave — identical to the old flat reducer.
  while (!eng.abort.signal.aborted) {
    const pending = Object.values(tasks).filter((t) => t.status === 'pending' && t.ownerId)
    if (pending.length === 0) break
    // Phase 2: when enabled, pause at an ordered-stage boundary so the orchestrator can
    // re-plan the not-yet-run work before it runs. When off, this never fires → byte-for-byte.
    const maxReplans = getSettings().maxReplans ?? 0
    if (maxReplans > 0 && state.replanAttempts < maxReplans) {
      const boundary = pendingStageBoundary(tasks, state.replanStageCursor)
      if (boundary != null) {
        return { patch: { ...scrub, tasks, steps, userRequestCount, followThroughCount, ...(userRequests.length ? { userRequests } : {}), replanStageCursor: boundary, phase: 'replanning' }, goto: 'replan' }
      }
    }
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
    await mapCapped([...byOwner.entries()], parallelCap(getSettings()), ([ownerId, group]) => runGroup(ownerId, group))

    // ── Workers asked during this wave → queue them; present up to the per-source budget. ──
    if (asks.length > 0 && !eng.abort.signal.aborted) {
      asks.sort((a, b) => state.plan.findIndex((p) => p.id === a.taskIds[0]) - state.plan.findIndex((p) => p.id === b.taskIds[0]))
      const hitlRemaining = maxUserRequests - userRequestCount
      const ftRemaining = maxFollowThrough - followThroughCount
      const present: typeof asks = []
      const overflow: typeof asks = []
      let hitlTaken = 0
      let ftTaken = 0
      for (const a of asks) {
        if (a.source === 'follow-through') {
          if (ftTaken < ftRemaining) { present.push(a); ftTaken += 1 } else overflow.push(a)
        } else {
          if (hitlTaken < hitlRemaining) { present.push(a); hitlTaken += 1 } else overflow.push(a)
        }
      }
      // over-budget askers: resume best-effort with no answer — never re-run fresh, never lost
      for (const ask of overflow) {
        if (ask.source === 'follow-through') await resumeFollowUpAsk(eng, ask, '', state.actingMode, tasks, steps)
        else await resumeAsker(eng, ask, '', state.actingMode, tasks, steps)
      }
      const [head, ...rest] = present
      if (head.source !== 'follow-through') userRequests.push({ askerId: head.ownerId, question: head.question })
      return {
        patch: {
          resumeInput: undefined,
          tasks,
          steps,
          userRequestCount,
          followThroughCount,
          ...(userRequests.length ? { userRequests } : {}),
          pendingAsk: head,
          askQueue: rest.length ? rest : undefined,
          phase: 'executing'
        },
        interrupt: interruptFor(head)
      }
    }
  }

  return { patch: { ...scrub, tasks, steps, userRequestCount, followThroughCount, ...(userRequests.length ? { userRequests } : {}), phase: 'reviewing' } }
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
  await mapCapped([...groups.entries()], parallelCap(getSettings()), async ([reviewerId, group]) => {
    if (eng.abort.signal.aborted) return
    setStatus(eng, steps, reviewerId, 'reviewing', group.map((t) => t.task.title))
    const items = group.map((t) => ({
      taskId: t.task.id,
      title: t.task.title,
      asked: t.task.description,
      ownerName: getAgent(t.ownerId!).name,
      output: t.output
    }))
    let verdicts: { taskId: string; verdict: 'pass' | 'fail'; feedback: string; disposition: 'repair' | 'replan' }[]
    try {
      verdicts = await reviewStep(eng, state.goal, state.actingMode, reviewerId, items)
    } catch {
      return // a reviewer failure leaves its group unreviewed (status stays 'done'); surfaced upward
    }
    for (const v of verdicts) {
      const t = tasks[v.taskId]
      if (!t) continue
      t.verdict = { verdict: v.verdict, feedback: v.feedback, disposition: v.disposition }
      t.status = v.verdict === 'pass' ? 'passed' : 'failed'
      recorded.push({ taskId: v.taskId, nodeId: t.ownerId ?? null, verdict: v.verdict, feedback: v.feedback })
    }
    if (!eng.abort.signal.aborted) setStatus(eng, steps, reviewerId, 'done')
  })

  const reviewNo = state.reviews.length + 1
  const reviews = [...state.reviews, { attempt: reviewNo, tasks: recorded }]
  eng.emit({ runId: eng.runId, type: 'verdict', attempt: reviewNo, tasks: recorded })

  const failed = Object.values(tasks).filter((t) => t.ownerId && t.status === 'failed')
  const maxReplans = getSettings().maxReplans ?? 0
  const misScoped = failed.filter((t) => t.verdict?.disposition === 'replan')
  // any replan-flagged failure escalates the WHOLE not-passed set (escalateNode re-derives the failed tasks)
  if (maxReplans > 0 && misScoped.length > 0 && state.replanAttempts < maxReplans && !eng.abort.signal.aborted) {
    return { patch: { tasks, steps, reviews, phase: 'replanning' }, goto: 'escalate' }
  }
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
  let verdicts: { taskId: string; verdict: 'pass' | 'fail'; feedback: string; disposition: 'repair' | 'replan' }[]
  try {
    verdicts = await integrationReviewStep(eng, state.goal, state.actingMode, state.orchestratorId, state.plan, items)
  } catch {
    return { goto: 'reflect', patch: { steps: markWorkersDone(eng, state), phase: 'reflecting' } }
  }

  const recorded: TaskVerdict[] = []
  for (const v of verdicts) {
    const t = tasks[v.taskId]
    if (!t) continue
    t.verdict = { verdict: v.verdict, feedback: v.feedback, disposition: v.disposition }
    t.status = v.verdict === 'pass' ? 'passed' : 'failed'
    recorded.push({ taskId: v.taskId, nodeId: t.ownerId ?? null, verdict: v.verdict, feedback: v.feedback })
  }
  const reviewNo = state.reviews.length + 1
  const reviews = [...state.reviews, { attempt: reviewNo, tasks: recorded }]
  eng.emit({ runId: eng.runId, type: 'verdict', attempt: reviewNo, tasks: recorded })

  const failed = Object.values(tasks).filter((t) => t.ownerId && t.status === 'failed')
  const maxReplans = getSettings().maxReplans ?? 0
  const misScoped = failed.filter((t) => t.verdict?.disposition === 'replan')
  // any replan-flagged failure escalates the WHOLE not-passed set (escalateNode re-derives the failed tasks)
  if (maxReplans > 0 && misScoped.length > 0 && state.replanAttempts < maxReplans && !eng.abort.signal.aborted) {
    return { patch: { tasks, steps, reviews, phase: 'replanning' }, goto: 'escalate' }
  }
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

  await mapCapped(failed, parallelCap(getSettings()), async (t) => {
    if (eng.abort.signal.aborted) return
    const ownerId = t.ownerId!
    setStatus(eng, steps, ownerId, 'working', [t.task.title])
    tasks[t.task.id].attempts += 1
    const rs = getSettings()
    const effort = rs.adaptiveEffort || rs.effortThrift ? t.effort : undefined
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
        abort: eng.abort,
        modelOverride: workerModelOverride(rs)
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

  await io.checkpoint({ ...state, tasks: structuredClone(tasks), steps: { ...steps }, phase: 'repairing', ...(io.collectExtras?.() ?? {}) })
  return { patch: { tasks, steps, phase: 'reviewing', repairAttempts: state.repairAttempts + 1 }, goto: 'domainReview' }
}

/**
 * Apply a re-plan/escalation decision into the run: merge the revised tasks (replacing
 * `replaceIds`, or pending when undefined), bump the shared replanAttempts, reset the
 * repair budget, record + emit the `replan`, and goto route. `extraPatch` lets a caller
 * carry extra state (Phase-2 proactive carries replanStageCursor).
 */
function applyReplanDecision(
  state: RunState,
  eng: Eng,
  decision: { reason: string; tasks: RunTask[]; deps: Record<string, string[]> },
  replaceIds?: string[],
  extraPatch: Partial<RunState> = {}
): NodeResult {
  const { plan, tasks } = mergeReplan(state.plan, structuredClone(state.tasks), decision, replaceIds)
  const attempt = state.replanAttempts + 1
  const replans = [...(state.replans ?? []), { attempt, reason: decision.reason }]
  eng.emit({ runId: eng.runId, type: 'replan', attempt, reason: decision.reason, tasks: plan })
  return {
    patch: { plan, tasks, replans, replanAttempts: attempt, repairAttempts: 0, phase: 'replanning', ...extraPatch },
    goto: 'route'
  }
}

// Phase 2 — proactive re-plan: at an ordered-stage boundary the orchestrator may rewrite
// the not-yet-run plan based on what came back. GOAL IS NEVER TOUCHED. No-op when off.
async function replanNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const maxReplans = getSettings().maxReplans ?? 0
  if (maxReplans <= 0 || state.replanAttempts >= maxReplans || eng.abort.signal.aborted) {
    return { goto: 'execute' }
  }
  // executeNode already advanced replanStageCursor to this boundary before routing here.
  const boundary = state.replanStageCursor
  const owned = ownedTasks(state)
  const executed = owned.filter((t) => t.status !== 'pending')
  const pending = owned.filter((t) => t.status === 'pending')

  let decision: { replan: boolean; reason: string; tasks: RunTask[]; deps: Record<string, string[]> }
  try {
    decision = await replanStep(eng, state.goal, state.orchestratorId, executed, pending)
  } catch {
    return { goto: 'execute', patch: { replanStageCursor: boundary } } // a parse failure = decline
  }
  if (!decision.replan) {
    return { goto: 'execute', patch: { replanStageCursor: boundary } }
  }

  return applyReplanDecision(state, eng, decision, undefined, { replanStageCursor: boundary })
}

// v2 escalation — reactive: a reviewer flagged a failed task as MIS-SCOPED, so the
// orchestrator re-breaks-up the failed work (passed frozen). Reuses the shared apply
// helper + the `replan` surfacing. Bounded by the shared replanAttempts < maxReplans.
async function escalateNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const maxReplans = getSettings().maxReplans ?? 0
  const owned = ownedTasks(state)
  const passed = owned.filter((t) => t.status === 'passed')
  const failed = owned.filter((t) => t.status === 'failed')
  if (maxReplans <= 0 || state.replanAttempts >= maxReplans || failed.length === 0 || eng.abort.signal.aborted) {
    return { patch: { steps: markWorkersDone(eng, state), phase: 'reflecting' } } // → reflect (static edge)
  }
  let decision: { reason: string; tasks: RunTask[]; deps: Record<string, string[]> }
  try {
    decision = await escalateStep(eng, state.goal, state.orchestratorId, passed, failed)
  } catch {
    return { patch: { steps: markWorkersDone(eng, state), phase: 'reflecting' } } // parse failure = give up
  }
  if (decision.tasks.length === 0) {
    return { patch: { steps: markWorkersDone(eng, state), phase: 'reflecting' } }
  }
  return applyReplanDecision(state, eng, decision, failed.map((t) => t.task.id))
}

async function reflectNode(state: RunState, _io: NodeIO, eng: Eng): Promise<NodeResult> {
  const settings = getSettings()
  const owned = ownedTasks(state)
  if (!settings.reflection || owned.length === 0 || eng.abort.signal.aborted) {
    return { goto: 'synthesize', patch: { phase: 'synthesizing' } }
  }
  const steps = { ...state.steps }
  const reflections = [...state.reflections]
  await mapCapped(workerIdsOf(state.tasks), parallelCap(getSettings()), async (wid) => {
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
  await mapCapped(reviewerIdsOf(state), parallelCap(getSettings()), async (rid) => {
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
  const results =
    (owned.length > 0 ? formatResults(state) + formatVerdicts(state) : '(no work was assigned)') +
    formatUserRequests(state) +
    formatFollowUps(state)
  const final = await synthesizeStep(eng, state.goal, state.actingMode, state.orchestratorId, state.plan, results)
  eng.emit({ runId: eng.runId, type: 'final', text: final })
  setStatus(eng, steps, state.orchestratorId, 'done')
  return { patch: { steps, final, phase: 'done' } }
}

// ---------- Claude steps (use the injected runAgent) ----------

/** Parse a raw task array (from a plan or replan JSON) into RunTask[] + sanitized deps
 *  (dedup, drop self-references and ids that aren't real tasks). idPrefix names auto-ids. */
function parseTasksAndDeps(
  raw: Record<string, unknown>[],
  idPrefix: string
): { tasks: RunTask[]; deps: Record<string, string[]> } {
  const tasks: RunTask[] = raw.map((t, i) => ({
    id: typeof t.id === 'string' && t.id ? t.id : `${idPrefix}${i + 1}`,
    title: String(t.title ?? `Task ${i + 1}`),
    description: String(t.description ?? t.title ?? '')
  }))
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

async function planStep(
  eng: Eng,
  goal: string,
  orchestratorId: string
): Promise<{ tasks: RunTask[]; deps: Record<string, string[]> }> {
  const parsed = await runStructured(
    eng,
    orchestratorId,
    planPrompt(goal, getSettings().largeTeamMode, getSettings().visionMode),
    (v): v is { tasks: unknown[] } => Array.isArray((v as { tasks?: unknown })?.tasks),
    { permissionMode: 'default', disallowedTools: THINK_DISALLOW }
  )
  const raw = parsed.tasks as Record<string, unknown>[]
  return parseTasksAndDeps(raw, 't')
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
    assignPrompt(tasks, childRoles, getSettings().lightPrompts),
    (v): v is { assignments: unknown[] } => Array.isArray((v as { assignments?: unknown })?.assignments),
    { permissionMode: 'default', disallowedTools: THINK_DISALLOW }
  )
  const validChildIds = new Set(childRoles.map((c) => c.id))
  return (parsed.assignments as Record<string, unknown>[]).map((a) => {
    const childId = typeof a.childId === 'string' && a.childId !== 'null' ? a.childId : null
    const model = childId && validChildIds.has(childId) ? getAgent(childId).model : undefined
    const requested = parseEffort(a.effort)
    const s = getSettings()
    const effort = assignEffort({ model, requested, adaptive: s.adaptiveEffort, thrift: s.effortThrift, ceiling: s.effortThriftCeiling })
    const out: Assignment = { taskId: String(a.taskId ?? ''), childId, effort, reason: String(a.reason ?? '') }
    if (requested && effort && requested !== effort) out.assignedEffort = requested
    return out
  })
}

async function reviewStep(
  eng: Eng,
  goal: string,
  actingMode: PermissionMode,
  orchestratorId: string,
  items: { taskId: string; title: string; asked: string; ownerName: string; output: string }[]
): Promise<{ taskId: string; verdict: 'pass' | 'fail'; feedback: string; disposition: 'repair' | 'replan' }[]> {
  const allowReplan = (getSettings().maxReplans ?? 0) > 0
  const parsed = await runStructured(
    eng,
    orchestratorId,
    reviewPrompt(goal, items, allowReplan),
    (v): v is { tasks: unknown[] } => Array.isArray((v as { tasks?: unknown })?.tasks),
    { permissionMode: actingMode, disallowedTools: EDIT_TOOLS },
    consultFor(orchestratorId, goal, actingMode)
  )
  const byId = new Map<string, { verdict: 'pass' | 'fail'; feedback: string; disposition: 'repair' | 'replan' }>()
  for (const t of parsed.tasks as Record<string, unknown>[]) {
    const taskId = String(t.taskId ?? '')
    const verdict = String(t.verdict ?? 'pass').toLowerCase() === 'fail' ? 'fail' : 'pass'
    const disposition = String(t.disposition ?? 'repair').toLowerCase() === 'replan' ? 'replan' : 'repair'
    byId.set(taskId, { verdict, feedback: String(t.feedback ?? ''), disposition })
  }
  return items.map((it) => ({
    taskId: it.taskId,
    verdict: byId.get(it.taskId)?.verdict ?? 'pass',
    feedback: byId.get(it.taskId)?.feedback ?? '',
    disposition: byId.get(it.taskId)?.disposition ?? 'repair'
  }))
}

async function integrationReviewStep(
  eng: Eng,
  goal: string,
  actingMode: PermissionMode,
  orchestratorId: string,
  plan: RunTask[],
  items: { taskId: string; title: string; asked: string; ownerName: string; output: string }[]
): Promise<{ taskId: string; verdict: 'pass' | 'fail'; feedback: string; disposition: 'repair' | 'replan' }[]> {
  const allowReplan = (getSettings().maxReplans ?? 0) > 0
  const parsed = await runStructured(
    eng,
    orchestratorId,
    integrationReviewPrompt(goal, plan, items, allowReplan),
    (v): v is { tasks: unknown[] } => Array.isArray((v as { tasks?: unknown })?.tasks),
    { permissionMode: actingMode, disallowedTools: EDIT_TOOLS },
    consultFor(orchestratorId, goal, actingMode)
  )
  const byId = new Map<string, { verdict: 'pass' | 'fail'; feedback: string; disposition: 'repair' | 'replan' }>()
  for (const t of parsed.tasks as Record<string, unknown>[]) {
    const taskId = String(t.taskId ?? '')
    const verdict = String(t.verdict ?? 'pass').toLowerCase() === 'fail' ? 'fail' : 'pass'
    const disposition = String(t.disposition ?? 'repair').toLowerCase() === 'replan' ? 'replan' : 'repair'
    byId.set(taskId, { verdict, feedback: String(t.feedback ?? ''), disposition })
  }
  return items.map((it) => ({
    taskId: it.taskId,
    verdict: byId.get(it.taskId)?.verdict ?? 'pass',
    feedback: byId.get(it.taskId)?.feedback ?? '',
    disposition: byId.get(it.taskId)?.disposition ?? 'repair'
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

async function replanStep(
  eng: Eng,
  goal: string,
  orchestratorId: string,
  executed: TaskState[],
  pending: TaskState[]
): Promise<{ replan: boolean; reason: string; tasks: RunTask[]; deps: Record<string, string[]> }> {
  const parsed = await runStructured(
    eng,
    orchestratorId,
    replanPrompt(goal, executed, pending),
    (v): v is Record<string, unknown> => typeof v === 'object' && v !== null && 'replan' in v,
    { permissionMode: 'default', disallowedTools: THINK_DISALLOW }
  )
  const p = parsed as { replan?: unknown; reason?: unknown; tasks?: unknown }
  const reason = String(p.reason ?? '')
  if (p.replan !== true) return { replan: false, reason, tasks: [], deps: {} }
  const raw = Array.isArray(p.tasks) ? (p.tasks as Record<string, unknown>[]) : []
  const { tasks, deps } = parseTasksAndDeps(raw, 'r')
  return { replan: true, reason, tasks, deps }
}

async function escalateStep(
  eng: Eng,
  goal: string,
  orchestratorId: string,
  passed: TaskState[],
  failed: TaskState[]
): Promise<{ reason: string; tasks: RunTask[]; deps: Record<string, string[]> }> {
  const parsed = await runStructured(
    eng,
    orchestratorId,
    escalatePrompt(goal, passed, failed),
    (v): v is { tasks: unknown[] } => Array.isArray((v as { tasks?: unknown })?.tasks),
    { permissionMode: 'default', disallowedTools: THINK_DISALLOW }
  )
  const p = parsed as { reason?: unknown; tasks?: unknown }
  const raw = Array.isArray(p.tasks) ? (p.tasks as Record<string, unknown>[]) : []
  const { tasks, deps } = parseTasksAndDeps(raw, 'e')
  return { reason: String(p.reason ?? 'mis-scoped tasks re-planned'), tasks, deps }
}

/** Per-agent-run consult config; null = handoffs off / no peers (→ a plain single call). */
interface Consult {
  peers: { id: string; name: string }[]
  max: number
  asker: string
  goal: string
  actingMode: PermissionMode
}

/** Build a Consult for an agent, or null when handoffs are off or it has no peers. */
function consultFor(agentId: string, goal: string, actingMode: PermissionMode): Consult | null {
  const max = getSettings().maxHandoffs ?? 0
  if (max <= 0) return null
  const peers = handoffPeersOf(agentId).map((p) => ({ id: p.id, name: p.name }))
  if (peers.length === 0) return null
  return { peers, max, asker: agentId, goal, actingMode }
}

function handoffSection(peers: { id: string; name: string }[]): string {
  const list = peers.map((p) => `- ${p.name} (id: ${p.id})`).join('\n')
  return `\n\nYou may CONSULT these connected teammates for help while you work:
${list}
To consult one, reply with ONLY this block and nothing else:
\`\`\`handoff
{ "to": "<teammate name or id>", "ask": "<exactly what you need from them>" }
\`\`\`
You'll receive their answer and can then continue. Consult only when it genuinely helps; otherwise just finish normally.`
}

function peerConsultPrompt(askerName: string, goal: string, ask: string): string {
  return `Your teammate ${askerName} is working toward this goal:
${goal}

They have asked for your help:
${ask}

Provide exactly what they need, concisely, using your expertise. You may read files and do focused work to answer, but keep it scoped to their request.`
}

function resumePrompt(peerName: string, answer: string): string {
  return `Your teammate ${peerName} responded to your request:

${answer}

Continue your task using this. If you need another consult, emit another handoff block; otherwise finish and report what you did.`
}

function askUserSection(): string {
  return `\n\nYou may ASK THE USER one question if you are blocked on information only they can provide (a decision, a missing detail, a preference). To ask, reply with ONLY this block and nothing else:
\`\`\`ask
{ "question": "<exactly what you need from the user>" }
\`\`\`
Do NOT ask for secrets (API keys, passwords) — those belong in environment files. Ask only when genuinely blocked; otherwise just finish normally.`
}

function answerResumePrompt(answer: string): string {
  if (answer.trim() === '') {
    return `The user did not provide an answer. Make a reasonable assumption and proceed best-effort. When finished, briefly report what you did and note the assumption you made.`
  }
  return `The user answered your question:

${answer}

Continue your task using this. When finished, briefly report what you changed.`
}

/**
 * Run an agent, letting it CONSULT connected peers (Phase 3). With no consult config
 * (off / no peers) this is a single un-augmented runAgent call → byte-for-byte. The
 * dispatched peer's answer is TERMINAL (never re-parsed) so there are no cycles.
 */
async function runWithHandoffs(
  eng: Eng,
  base: StreamAgentOptions,
  consult: Consult | null
): Promise<{ text: string; sessionId?: string }> {
  if (!consult) return eng.runAgent(base)
  let result = await eng.runAgent({ ...base, prompt: base.prompt + handoffSection(consult.peers) })
  for (let n = 0; n < consult.max && !eng.abort.signal.aborted; n++) {
    const req = parseHandoff(result.text, consult.peers)
    if (!req) break
    const peer = consult.peers.find((p) => p.id === req.peerId)!
    eng.emit({ runId: eng.runId, type: 'handoff', askerId: consult.asker, peerId: peer.id, ask: req.ask })
    eng.handoffs.push({ askerId: consult.asker, peerId: peer.id, ask: req.ask })
    eng.emit({ runId: eng.runId, type: 'status', nodeId: peer.id, status: 'working', taskTitles: [req.ask] })
    let answer: string
    try {
      const r = await eng.runAgent({
        wc: eng.wc,
        agentId: peer.id,
        prompt: peerConsultPrompt(getAgent(consult.asker).name, consult.goal, req.ask),
        runId: eng.runId,
        stepId: peer.id,
        permissionMode: consult.actingMode,
        resume: false,
        abort: eng.abort
      })
      answer = r.text || '(no answer)'
      eng.emit({ runId: eng.runId, type: 'status', nodeId: peer.id, status: 'done' })
    } catch (err) {
      answer = `ERROR: ${err instanceof Error ? err.message : String(err)}`
      eng.emit({ runId: eng.runId, type: 'status', nodeId: peer.id, status: 'error' })
    }
    // resume the ASKER's in-run session with the peer's answer (peer sessionId is NOT persisted)
    result = await eng.runAgent({ ...base, prompt: resumePrompt(peer.name, answer), resume: true, resumeSessionId: result.sessionId })
  }
  return result
}

/** Run an agent, parse a JSON block from its output, retrying once. */
async function runStructured<T>(
  eng: Eng,
  agentId: string,
  basePrompt: string,
  validate: (v: unknown) => v is T,
  perm: { permissionMode: PermissionMode; disallowedTools?: string[] },
  consult: Consult | null = null
): Promise<T> {
  let lastText = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    if (eng.abort.signal.aborted) throw new Error('cancelled')
    const prompt = attempt === 0 ? basePrompt : basePrompt + STRICT_REMINDER
    const base: StreamAgentOptions = {
      wc: eng.wc,
      agentId,
      prompt,
      runId: eng.runId,
      stepId: agentId,
      permissionMode: perm.permissionMode,
      disallowedTools: perm.disallowedTools,
      abort: eng.abort
    }
    const { text } = attempt === 0 ? await runWithHandoffs(eng, base, consult) : await eng.runAgent(base)
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

/** True when at least one owned task's immediate parent is a manager or director (an intermediate review tier exists). */
export function hasManagers(state: RunState): boolean {
  return ownedTasks(state).some((t) => {
    const k = parentOf(t.ownerId!)?.kind
    return k === 'manager' || k === 'director'
  })
}

/**
 * The nodes that performed a review this run, for reflection: the manager or director parents
 * of owned tasks, plus the orchestrator when the integration pass ran (i.e. when an intermediate
 * tier exists). Empty for flat teams — so flat teams keep worker-only reflection.
 */
export function reviewerIdsOf(state: RunState): string[] {
  const ids = new Set<string>()
  for (const t of ownedTasks(state)) {
    const p = parentOf(t.ownerId!)
    if (p && (p.kind === 'manager' || p.kind === 'director')) ids.add(p.id)
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

/** The effort to record/dispatch for an assignment: clamp to the worker's model
 *  when adaptive effort is on and a worker was chosen; otherwise the request as-is. */
export function effortForModel(
  model: string | undefined,
  requested: Effort | undefined,
  adaptiveEnabled: boolean
): Effort | undefined {
  if (!adaptiveEnabled || !model) return requested
  return clampEffort(model, requested)
}

/** The final per-assignment effort: model-clamp the router's requested effort,
 *  then (when thrift is on and a worker/model is known) cap it DOWN to the
 *  ceiling — clamped back to what the model supports. Thrift forces an effort
 *  even when adaptive routing is off. thrift off => identical to effortForModel. */
export function assignEffort(args: {
  model: string | undefined
  requested: Effort | undefined
  adaptive: boolean
  thrift: boolean
  ceiling: Effort
}): Effort | undefined {
  let effort = effortForModel(args.model, args.requested, args.adaptive)
  if (args.thrift && args.model) {
    const base = effort ?? args.requested ?? args.ceiling
    effort = clampEffort(args.model, capEffort(base, args.ceiling))
  }
  return effort
}

/** The model override to dispatch WORKER steps on when cheap-model-workers is on
 *  (managers/orchestrator never get an override). undefined => byte-for-byte. */
export function workerModelOverride(s: { cheapModelWorkers: boolean; cheapModelTier: string }): string | undefined {
  return s.cheapModelWorkers ? s.cheapModelTier : undefined
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

/** Synthesis-visible summary of HITL consultations — questions only (S5-safe; never the answer). */
export function formatUserRequests(state: RunState): string {
  const reqs = state.userRequests ?? []
  if (reqs.length === 0) return ''
  const lines = reqs.map((r) => {
    let name: string
    try {
      name = getAgent(r.askerId).name
    } catch {
      name = r.askerId
    }
    return `- ${name} paused to ask the user: "${r.question}". The user provided an answer, which ${name} incorporated into its work. (The answer itself is redacted from this record.)`
  })
  return `\n\n## User consultations during this run\n${lines.join('\n')}\nThese questions were answered by the user during the run and the answers were incorporated — report them as resolved, not as open questions or placeholder assumptions.`
}

export function followThroughSection(): string {
  return `\n\nFOLLOW-THROUGH: If you encounter a feature whose intended behavior was not clearly specified (for example a button or control with no described action), do NOT leave a bare placeholder. Infer the most reasonable behavior from the overall goal and surrounding context, implement it fully, and keep working — do not stop or ask. Record each such decision by including a block of exactly this form (in addition to your normal report):
\`\`\`followup
{ "summary": "<what was under-specified>", "decision": "<what you built and why>" }
\`\`\`
You may include more than one followup block if you made several such decisions.`
}

export function followThroughAskSection(): string {
  return `\n\nFOLLOW-THROUGH (ask): If you encounter a feature whose intended behavior was not clearly specified (for example a button or control with no described action), do NOT assume — pause and ask the user. Reply with ONLY this block and nothing else:
\`\`\`followup
{ "summary": "<what is under-specified>", "question": "<what you need decided>", "options": ["<option 1>", "<option 2>"] }
\`\`\`
Propose 2–4 concrete options you'd recommend. Ask only for genuinely under-specified features; otherwise finish normally.`
}

/** Build the pause interrupt for a collected ask item, by source. */
export function interruptFor(item: {
  ownerId: string
  question: string
  source?: 'ask-user' | 'follow-through'
  summary?: string
  options?: string[]
}): Interrupt {
  const askerName = getAgent(item.ownerId).name
  if (item.source === 'follow-through') {
    return {
      kind: 'follow-through',
      prompt: item.question,
      payload: { askerId: item.ownerId, askerName, summary: item.summary ?? '', question: item.question, options: item.options ?? [] }
    }
  }
  return {
    kind: 'ask-user',
    prompt: item.question,
    payload: { askerId: item.ownerId, askerName, question: item.question }
  }
}

/** Synthesis section listing headless follow-through decisions, so the final report
 *  treats inferred features as completed scope. '' when none (byte-for-byte off). */
export function formatFollowUps(state: RunState): string {
  const fus = state.followUps ?? []
  if (fus.length === 0) return ''
  const lines = fus.map((f) => {
    let name: string
    try {
      name = getAgent(f.workerId).name
    } catch {
      name = f.workerId
    }
    return `- ${name} built the following for an under-specified part: "${f.summary}" → "${f.decision}".`
  })
  return `\n\n## Features clarified during the build\n${lines.join('\n')}\nThese were reasonable assumptions made and implemented during the run. Report them as completed, intended scope — not as open questions or gaps.`
}

// ---------- prompts (ported verbatim from the original engine) ----------

const STRICT_REMINDER =
  '\n\nIMPORTANT: Your previous reply could not be parsed. Reply with ONLY the JSON code block described above — no prose before or after.'

export function planPrompt(goal: string, largeTeam = false, vision = false): string {
  const scale = largeTeam
    ? `\n\nThis is a LARGE team. Plan at a BROAD, PROGRAM level: produce a small number (~3–8) of high-level workstreams, each of which a director or manager can own and break down further with their own team. Prefer few broad tasks over many fine-grained ones.`
    : ''
  const visionScale = vision
    ? `\n\nThis is a CREATIVE / DESIGN project — plan design deliverables (brand direction, UX flows, wireframes, visual comps, copy, and content structure), not code modules.`
    : ''
  return `You are planning work to achieve the user's goal for this project. You may READ files to inform the plan, but do NOT make any changes.

GOAL:
${goal}${scale}${visionScale}

Produce a concise, ordered list of concrete tasks that together fully achieve the goal. Each task should be self-contained and suitable to hand to a single specialist. Prefer the smallest set of tasks that covers the goal.

A task may optionally declare "dependsOn": an array of the ids of tasks that MUST be finished before it can start (e.g. a frontend task that needs the backend API to exist first). Add a dependency ONLY when a task genuinely cannot begin until another is done — most tasks have none, so use [] or omit it. Never create a cycle.

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "tasks": [ { "id": "t1", "title": "short title", "description": "what to do, in enough detail for a specialist", "dependsOn": [] } ] }
\`\`\``
}

export function assignPrompt(tasks: RunTask[], childRoles: ChildBrief[], light = false): string {
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
  if (light) {
    return `Route each task to the ONE specialist whose role best fits (prefer relevant track record); childId null if none fit. Also assign an effort level (low|medium|high|xhigh|max) per task by difficulty — reserve xhigh/max for genuinely hard work. Do NOT edit files.

SPECIALISTS:
${specialists}

TASKS:
${taskList}

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "assignments": [ { "taskId": "t1", "childId": "<specialist id, or null>", "effort": "low|medium|high|xhigh|max", "reason": "why" } ] }
\`\`\``
  }
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

export function workerPrompt(goal: string, tasks: RunTask[], light = false, vision = false, designApproved = false): string {
  const list = tasks.map((t, i) => `${i + 1}. ${t.title}\n   ${t.description}`).join('\n\n')
  const designNote = designApproved
    ? ' An approved design-system preview is at design-preview.html — build the UI to match its palette, type, and components.'
    : ''
  if (light) {
    const qa = vision
      ? 'If your work is a design, brand, or copy deliverable, evaluate it against the creative intent — check visual hierarchy, brand and tonal consistency, and typographic craft — before reporting success.'
      : 'If your work serves web pages, actually run it and confirm the entry page AND every asset it references return 200 before reporting success.'
    return `Team goal: ${goal}

Complete the following task(s) in this project folder, making the necessary changes. Apply any relevant lessons from your memory.

${list}

${qa}${designNote} When finished, briefly report what you changed and flag anything you could not complete.`
  }
  const qa = vision
    ? 'If your work is a design, brand, or copy deliverable, do not rely on "it looks right" — evaluate it against the creative intent: check visual hierarchy, brand and tonal consistency, typographic craft, and that it reads as intended for its audience. Don\'t report success until the deliverable holds together.'
    : 'If your work is a web app or anything that serves pages, do not rely on unit tests or "the code looks right" — actually run it and load the entry page: confirm it returns 200 AND every asset it references (CSS, JS, images) also returns 200. A static-path or route mismatch that 404s assets makes the page render as unstyled, broken HTML even when your code is correct. Don\'t report success until the page renders fully.'
  return `You are working as part of a team to achieve this overall goal:
${goal}

You have been assigned the following task(s). Complete them in this project folder, making the necessary changes. Apply any relevant lessons from your memory.

${list}

${qa}${designNote}

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

function replanPrompt(goal: string, executed: TaskState[], pending: TaskState[]): string {
  const done = executed
    .map((t) => `- ${t.task.title}: ${t.task.description}\n  result: ${t.output.replace(/\s+/g, ' ').slice(0, 1200)}`)
    .join('\n')
  const remaining = pending.map((t) => `- id: ${t.task.id} — ${t.task.title}: ${t.task.description}`).join('\n')
  return `You are the lead for this project. The GOAL below is FIXED and must NOT change — never modify, reinterpret, or expand it.

GOAL (immutable):
${goal}

An earlier stage of the plan has finished. Here is the COMPLETED work and what it produced:
${done || '(nothing completed yet)'}

Here is the REMAINING, not-yet-started plan:
${remaining || '(nothing remaining)'}

Based ONLY on what the completed work actually revealed, decide whether the remaining plan should change — for example its findings contradict an assumption the plan was built on, point to a materially better approach, or surface something the goal needs that the plan is missing. Re-plan ONLY if you are confident it will materially improve the outcome toward the goal; otherwise keep the plan as-is.

Rules:
- The completed work is DONE — never recreate or redo it. Its changes are already on the filesystem and the remaining tasks can build on them.
- You may add, remove, revise, or split the REMAINING tasks only.
- Do NOT change the goal.
- You may READ files to inform the decision, but make no changes.

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "replan": true, "reason": "why, one sentence", "tasks": [ { "id": "t2", "title": "short title", "description": "what to do", "dependsOn": [] } ] }
\`\`\`
Set "replan" to false (and "tasks" to []) to keep the remaining plan unchanged.`
}

function reviewPrompt(
  goal: string,
  items: { taskId: string; title: string; asked: string; ownerName: string; output: string }[],
  allowReplan = false
): string {
  const list = items
    .map(
      (it) =>
        `- taskId: ${it.taskId}\n  title: ${it.title}\n  asked: ${it.asked}\n  done by: ${it.ownerName}\n  result: ${it.output.replace(/\s+/g, ' ').slice(0, 1200)}`
    )
    .join('\n')
  const dispoLine = allowReplan
    ? `\n\nFor each "fail", also set "disposition": "repair" if the task is correctly scoped but the implementation is buggy or incomplete (re-running it can fix it), or "replan" if the TASK ITSELF is mis-scoped — the plan broke the work down wrong and it should be re-broken-up rather than re-run. Default to "repair" when unsure.`
    : ''
  const schema = allowReplan
    ? `{ "tasks": [ { "taskId": "t1", "verdict": "pass", "feedback": "required when fail", "disposition": "repair or replan (only when fail)" } ] }`
    : `{ "tasks": [ { "taskId": "t1", "verdict": "pass", "feedback": "required when fail" } ] }`
  return `You are reviewing your team's work against the goal. You may READ files and RUN the app/commands to verify (start a server, curl an endpoint, run the tests) — you just must not edit files.

GOAL:
${goal}

Judge each task below: did the result actually accomplish what was asked, in service of the goal? Mark "pass" or "fail". For any "fail", give specific, actionable feedback the worker can use to fix it.

If the work is a web app or anything that serves pages, do NOT trust unit tests or the worker's report alone — run it: start the app, request the entry URL, and confirm it returns 200 AND every asset it references (CSS, JS, images) also returns 200. A common silent failure is assets 404ing from a static-path/route mismatch, which makes the page render as unstyled HTML even though the code is correct. Fail the task if the page does not render fully.${dispoLine}

TASKS TO REVIEW:
${list}

Reply with ONLY this JSON code block (no other text):
\`\`\`json
${schema}
\`\`\``
}

function integrationReviewPrompt(
  goal: string,
  plan: RunTask[],
  items: { taskId: string; title: string; asked: string; ownerName: string; output: string }[],
  allowReplan = false
): string {
  const planList = plan.map((t, i) => `${i + 1}. ${t.title} — ${t.description}`).join('\n')
  const list = items
    .map(
      (it) =>
        `- taskId: ${it.taskId}\n  title: ${it.title}\n  by: ${it.ownerName}\n  result: ${it.output.replace(/\s+/g, ' ').slice(0, 1200)}`
    )
    .join('\n')
  const dispoLine = allowReplan
    ? `\n\nFor each "fail", also set "disposition": "repair" if the task is correctly scoped but the implementation is buggy or incomplete (re-running it can fix it), or "replan" if the TASK ITSELF is mis-scoped — the plan broke the work down wrong and it should be re-broken-up rather than re-run. Default to "repair" when unsure. If a task is mis-scoped (the plan broke it down wrong), mark it fail with disposition "replan" and it will be re-broken-up.`
    : ''
  const replanNote = allowReplan
    ? ''
    : ' If the plan itself is missing something needed for the goal, note it in the feedback of the most related task (it will be surfaced; you cannot re-plan here).'
  const schema = allowReplan
    ? `{ "tasks": [ { "taskId": "t1", "verdict": "pass", "feedback": "required when fail", "disposition": "repair or replan (only when fail)" } ] }`
    : `{ "tasks": [ { "taskId": "t1", "verdict": "pass", "feedback": "required when fail" } ] }`
  return `You are doing the final INTEGRATION review of your team's assembled work. Your managers already reviewed each piece for domain correctness — your job is the BROADER check: do the pieces fit together, is anything missing or off-goal, does the integrated whole actually satisfy the plan and the goal? You may READ files and RUN the integrated app to verify — you just must not edit files.

GOAL:
${goal}

THE PLAN:
${planList}

THE ASSEMBLED RESULT (per task):
${list}

Assess each task for whether it fits the integrated whole and serves the goal. Mark "pass" or "fail"; for any "fail" give specific, actionable feedback the worker can use.${replanNote}${dispoLine}

Reply with ONLY this JSON code block (no other text):
\`\`\`json
${schema}
\`\`\``
}

function escalatePrompt(goal: string, passed: TaskState[], failed: TaskState[]): string {
  const kept = passed.map((t) => `- ${t.task.title}: ${t.task.description}`).join('\n')
  const broken = failed
    .map((t) => `- id: ${t.task.id} — ${t.task.title}: ${t.task.description}\n  why it failed review: ${(t.verdict?.feedback ?? '').replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n')
  return `You are the lead for this project. The GOAL below is FIXED and must NOT change — never modify, reinterpret, or expand it.

GOAL (immutable):
${goal}

Your team COMPLETED and PASSED this work — keep it, do NOT redo it (its changes are already on the filesystem):
${kept || '(none)'}

These tasks did NOT pass review because they are MIS-SCOPED — the plan broke the work down incorrectly, so simply re-running them will not help:
${broken}

Re-break-up ONLY the mis-scoped work into a corrected set of tasks: split, merge, drop, or add tasks so the failed portion can actually be done. Keep it the smallest set that fixes the breakdown. Do NOT touch the passed work or the goal. You may READ files to inform the breakdown, but make no changes.

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "reason": "why the old breakdown was wrong, one sentence", "tasks": [ { "id": "e1", "title": "short title", "description": "what to do", "dependsOn": [] } ] }
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
