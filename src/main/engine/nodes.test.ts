import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runGraph, resumeGraph, type NodeIO } from './graph'
import {
  buildOrchestratorGraph,
  seedRunState,
  maxEffort,
  effortForModel,
  lessonsDigest,
  depsSatisfied,
  normalizeLessonInput,
  hasManagers,
  reviewerIdsOf,
  formatUserRequests,
  type Eng,
  type AgentRunner
} from './nodes'
import type { RunState, TaskState } from '../../shared/types'
import { toRunRecord } from '../../shared/run-state'

// Topology + settings live in a hoisted fake so vi.mock can close over them.
const h = vi.hoisted(() => {
  const mk = (id: string, kind: string) => ({
    id,
    name: id.toUpperCase(),
    slug: id,
    kind,
    icon: '',
    model: 'm',
    permissionMode: 'acceptEdits',
    position: { x: 0, y: 0 }
  })
  return {
    agents: {
      o: mk('o', 'orchestrator'),
      m: mk('m', 'manager'),
      w1: mk('w1', 'worker'),
      w2: mk('w2', 'worker')
    } as Record<string, ReturnType<typeof mk>>,
    children: { o: ['w1', 'w2'], w1: [], w2: [] } as Record<string, string[]>,
    edges: [] as { source: string; target: string; order?: number; kind?: string }[],
    settings: {
      reviewMode: 'once',
      maxRepairAttempts: 1,
      reflection: true,
      autonomy: 'auto',
      adaptiveEffort: true,
      maxReplans: 0,
      maxHandoffs: 0,
      maxUserRequests: 0
    },
    memory: {} as Record<string, string>,
    reflections: [] as { id: string }[]
  }
})

vi.mock('./project-store', () => ({
  getAgent: (id: string) => h.agents[id],
  childrenOf: (id: string) => (h.children[id] ?? []).map((c) => h.agents[c]),
  parentOf: (id: string) => {
    const pid = Object.keys(h.children).find((p) => (h.children[p] ?? []).includes(id))
    return pid ? h.agents[pid] : null
  },
  getEdges: () => h.edges,
  handoffPeersOf: (id: string) =>
    h.edges.filter((e) => e.source === id && e.kind === 'handoff').map((e) => h.agents[e.target]),
  rolesOf: async (ids: string[]) =>
    ids.map((id) => ({ id, name: h.agents[id].name, kind: h.agents[id].kind, role: `role ${id}` })),
  readMemory: async (id: string) => h.memory[id] ?? '',
  getSettings: () => h.settings,
  applyReflection: async (id: string, r: unknown) => {
    h.reflections.push({ id, ...(r as object) } as { id: string })
  },
  updateAgent: async () => {}
}))

function fakeStore() {
  const saved = new Map<string, RunState>()
  return {
    saved,
    async put(s: RunState): Promise<void> {
      saved.set(s.runId, structuredClone(s))
    },
    async get(id: string): Promise<RunState | null> {
      return saved.get(id) ?? null
    }
  }
}

function makeIO(signal: AbortSignal, store: ReturnType<typeof fakeStore>): NodeIO {
  return { signal, emit: () => {}, checkpoint: (s) => store.put(s) }
}

/** Canned agent: routes by a stable marker phrase in each prompt. */
function cannedAgent() {
  const calls: { agentId: string; kind: string; effort?: string }[] = []
  let reviewRound = 0
  const runAgent: AgentRunner = async (opts) => {
    const p = opts.prompt
    const id = opts.agentId
    const rec = (kind: string) => calls.push({ agentId: id, kind })
    if (p.includes('Produce a concise, ordered list')) {
      rec('plan')
      return {
        text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"do t1"},{"id":"t2","title":"T2","description":"do t2"}]}\n```',
        sessionId: 's-' + id
      }
    }
    if (p.includes('You route planned tasks')) {
      rec('route')
      // assign each task round-robin to whichever specialists this router was offered
      const childIds = [...p.matchAll(/- id: (\S+)\n\s+name:/g)].map((mm) => mm[1])
      const taskIds = [...p.matchAll(/- id: (t\d+) —/g)].map((mm) => mm[1])
      const assignments = taskIds.map((tid, i) => ({
        taskId: tid,
        childId: childIds[i % childIds.length] ?? null,
        effort: i === 0 ? 'max' : 'low', // pretend the hardest task is t1
        reason: 'r'
      }))
      return { text: '```json\n' + JSON.stringify({ assignments }) + '\n```' }
    }
    if (p.includes('You have been assigned the following task')) {
      calls.push({ agentId: id, kind: 'work', effort: opts.effort })
      return { text: `worked ${id}`, sessionId: 's-' + id }
    }
    if (p.includes('final INTEGRATION review')) {
      rec('integration')
      return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""},{"taskId":"t2","verdict":"pass","feedback":""}]}\n```' }
    }
    if (p.includes('Judge each task')) {
      reviewRound++
      rec('review' + reviewRound)
      return reviewRound === 1
        ? {
            text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""},{"taskId":"t2","verdict":"fail","feedback":"fix it"}]}\n```'
          }
        : { text: '```json\n{"tasks":[{"taskId":"t2","verdict":"pass","feedback":""}]}\n```' }
    }
    if (p.includes('did not pass review')) {
      rec('repair')
      return { text: `repaired ${id}`, sessionId: 's-' + id }
    }
    if (p.includes('Reflect on your REVIEW work')) {
      rec('qaReflect')
      return { text: '```json\n{"win":"caught a bug","loss":"","lessons":[{"text":"run the app","scope":"portable"}]}\n```' }
    }
    if (p.includes('Reflect on the work')) {
      rec('reflect')
      return {
        text: '```json\n{"win":"w","loss":"l","lessons":[{"text":"learned","scope":"portable"}]}\n```'
      }
    }
    if (p.includes('Write a clear final report')) {
      rec('synth')
      return { text: 'FINAL REPORT' }
    }
    rec('unknown')
    return { text: 'unknown' }
  }
  return { runAgent, calls }
}

function eng(runAgent: AgentRunner): Eng {
  return {
    wc: {} as Eng['wc'],
    abort: new AbortController(),
    runId: 'run1',
    runAgent,
    emit: () => {},
    handoffs: []
  }
}

describe('orchestrator node graph — end to end', () => {
  it('plans, routes, executes, reviews, repairs a failure, reflects, and synthesizes', async () => {
    const { runAgent, calls } = cannedAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const init = seedRunState({
      runId: 'run1',
      goal: 'build it',
      orchestratorId: 'o',
      actingMode: 'auto',
      startedAt: 'S'
    })
    const out = await runGraph(
      buildOrchestratorGraph(e),
      init,
      store,
      makeIO(e.abort.signal, store)
    )

    expect(out.status).toBe('completed')
    expect(out.final).toBe('FINAL REPORT')
    // routing assigned each task to the matching worker
    expect(out.tasks.t1.ownerId).toBe('w1')
    expect(out.tasks.t2.ownerId).toBe('w2')
    // t2 failed first review, was repaired, then passed
    expect(out.tasks.t1.status).toBe('passed')
    expect(out.tasks.t2.status).toBe('passed')
    expect(out.tasks.t2.attempts).toBe(2) // executed once + repaired once
    expect(out.tasks.t1.attempts).toBe(1)
    expect(out.reviews.length).toBe(2)
    // both workers reflected
    expect(out.reflections.map((r) => r.nodeId).sort()).toEqual(['w1', 'w2'])
    // only the failed task was repaired
    expect(calls.filter((c) => c.kind === 'repair').map((c) => c.agentId)).toEqual(['w2'])
  })

  it("injects each child's lessons digest into the routing prompt", async () => {
    h.memory = {
      w1: '# Memory\n\n## Lessons\n- prefer parameterized SQL\n- (none yet)\n\n## Task log\n',
      w2: '## Lessons\n<!-- comment -->\n- serve CSS with static_url_path=""\n'
    }
    try {
      const { runAgent } = cannedAgent()
      const prompts: string[] = []
      const recording: AgentRunner = async (opts) => {
        prompts.push(opts.prompt)
        return runAgent(opts)
      }
      const e = eng(recording)
      const store = fakeStore()
      const out = await runGraph(
        buildOrchestratorGraph(e),
        seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
        store,
        makeIO(e.abort.signal, store)
      )
      expect(out.status).toBe('completed')
      const routePrompt = prompts.find((p) => p.includes('You route planned tasks'))
      expect(routePrompt).toBeDefined()
      expect(routePrompt).toContain('prefer parameterized SQL')
      expect(routePrompt).toContain('serve CSS with static_url_path=""')
      expect(routePrompt).not.toContain('(none yet)')
      // routing still works (children parsed) so each task lands on a worker
      expect(out.tasks.t1.ownerId).toBe('w1')
      expect(out.tasks.t2.ownerId).toBe('w2')
    } finally {
      h.memory = {}
    }
  })

  it('runs a dependent task only after its dependency has executed', async () => {
    const order: string[] = []
    const runAgent: AgentRunner = async (opts) => {
      const p = opts.prompt
      if (p.includes('Produce a concise, ordered list'))
        return {
          text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"d"},{"id":"t2","title":"T2","description":"d","dependsOn":["t1"]}]}\n```'
        }
      if (p.includes('You route planned tasks'))
        return {
          text: '```json\n{"assignments":[{"taskId":"t1","childId":"w1","effort":"high","reason":"r"},{"taskId":"t2","childId":"w2","effort":"high","reason":"r"}]}\n```'
        }
      if (p.includes('You have been assigned the following task')) {
        // delay the dependency (w1/t1) so that WITHOUT gating, the dependent (w2/t2)
        // would finish first — making the ordering assertion a real test of the gate.
        if (opts.agentId === 'w1') await new Promise((r) => setTimeout(r, 15))
        order.push(opts.agentId)
        return { text: `worked ${opts.agentId}` }
      }
      if (p.includes('Judge each task'))
        return {
          text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""},{"taskId":"t2","verdict":"pass","feedback":""}]}\n```'
        }
      if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
      if (p.includes('Write a clear final report')) return { text: 'DONE' }
      return { text: '' }
    }
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    expect(out.tasks.t2.dependsOn).toEqual(['t1']) // parsed from the plan onto the task
    expect(out.tasks.t1.dependsOn).toBeUndefined()
    expect(order).toEqual(['w1', 'w2']) // dependency ran to completion before the dependent started
  })

  it('does not deadlock on a circular dependency (cycle guard runs the rest)', async () => {
    const order: string[] = []
    const runAgent: AgentRunner = async (opts) => {
      const p = opts.prompt
      if (p.includes('Produce a concise, ordered list'))
        return {
          text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"d","dependsOn":["t2"]},{"id":"t2","title":"T2","description":"d","dependsOn":["t1"]}]}\n```'
        }
      if (p.includes('You route planned tasks'))
        return {
          text: '```json\n{"assignments":[{"taskId":"t1","childId":"w1","effort":"high","reason":"r"},{"taskId":"t2","childId":"w2","effort":"high","reason":"r"}]}\n```'
        }
      if (p.includes('You have been assigned the following task')) {
        order.push(opts.agentId)
        return { text: 'ok' }
      }
      if (p.includes('Judge each task'))
        return {
          text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""},{"taskId":"t2","verdict":"pass","feedback":""}]}\n```'
        }
      if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
      if (p.includes('Write a clear final report')) return { text: 'DONE' }
      return { text: '' }
    }
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    expect(out.tasks.t1.status).toBe('passed')
    expect(out.tasks.t2.status).toBe('passed')
    expect(order.sort()).toEqual(['w1', 'w2']) // both executed despite the cycle
  })

  it('resumes from a mid-execute checkpoint, re-running only unfinished workers', async () => {
    const store = fakeStore()
    // crash state: t1 finished, t2 never ran, cursor parked at execute
    const t1: TaskState = {
      task: { id: 't1', title: 'T1', description: 'do t1' },
      ownerId: 'w1',
      status: 'done',
      attempts: 1,
      output: 'worked w1'
    }
    const t2: TaskState = {
      task: { id: 't2', title: 'T2', description: 'do t2' },
      ownerId: 'w2',
      status: 'pending',
      attempts: 0,
      output: ''
    }
    const crashed: RunState = {
      ...seedRunState({
        runId: 'run1',
        goal: 'build it',
        orchestratorId: 'o',
        actingMode: 'auto',
        startedAt: 'S'
      }),
      cursor: 'execute',
      plan: [t1.task, t2.task],
      tasks: { t1, t2 }
    }
    await store.put(crashed)

    // permissive agent: pass everything on review so the run completes
    const calls: { agentId: string; kind: string }[] = []
    const runAgent: AgentRunner = async (opts) => {
      const p = opts.prompt
      if (p.includes('You have been assigned the following task')) {
        calls.push({ agentId: opts.agentId, kind: 'work' })
        return { text: `worked ${opts.agentId}` }
      }
      if (p.includes('Judge each task'))
        return { text: '```json\n{"tasks":[{"taskId":"t2","verdict":"pass","feedback":""}]}\n```' }
      if (p.includes('Reflect on the work'))
        return { text: '```json\n{"win":"w","loss":"","lessons":[]}\n```' }
      if (p.includes('Write a clear final report')) return { text: 'DONE' }
      return { text: '' }
    }
    const e = eng(runAgent)
    const out = await resumeGraph(
      buildOrchestratorGraph(e),
      'run1',
      store,
      makeIO(e.abort.signal, store)
    )

    expect(out.status).toBe('completed')
    // w1 was already done → NOT re-run; only w2 executed on resume
    expect(calls.filter((c) => c.kind === 'work').map((c) => c.agentId)).toEqual(['w2'])
    expect(out.tasks.t1.output).toBe('worked w1') // preserved from before the crash
    expect(out.tasks.t2.status).toBe('passed')
  })

  it('runs each worker at the effort the manager assigned (adaptive effort on)', async () => {
    const { runAgent, calls } = cannedAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    const work = calls.filter((c) => c.kind === 'work')
    expect(work.find((c) => c.agentId === 'w1')?.effort).toBe('max') // t1 → max
    expect(work.find((c) => c.agentId === 'w2')?.effort).toBe('low') // t2 → low
    expect(out.tasks.t1.effort).toBe('max') // persisted on the task
    expect(out.tasks.t2.effort).toBe('low')
  })

  it('sets no effort when adaptiveEffort is off', async () => {
    h.settings.adaptiveEffort = false
    try {
      const { runAgent, calls } = cannedAgent()
      const e = eng(runAgent)
      const store = fakeStore()
      await runGraph(
        buildOrchestratorGraph(e),
        seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
        store,
        makeIO(e.abort.signal, store)
      )
      expect(calls.filter((c) => c.kind === 'work').every((c) => c.effort === undefined)).toBe(true)
    } finally {
      h.settings.adaptiveEffort = true
    }
  })

  it('stamps each task with its ordered stage and sequences by canvas order', async () => {
    h.edges = [
      { source: 'o', target: 'w1', order: 1 },
      { source: 'o', target: 'w2', order: 2 }
    ]
    try {
      const { runAgent } = cannedAgent()
      const e = eng(runAgent)
      const store = fakeStore()
      const out = await runGraph(
        buildOrchestratorGraph(e),
        seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
        store,
        makeIO(e.abort.signal, store)
      )
      expect(out.status).toBe('completed')
      expect(out.tasks.t1.stage).toBe(1)
      expect(out.tasks.t2.stage).toBe(2)
      // Phase-1 ordering still derives the dependency (t2 after t1)
      expect(out.tasks.t2.dependsOn).toContain('t1')
    } finally {
      h.edges = []
    }
  })
})

describe('orchestrator node graph — manager layer', () => {
  // o -> m (manager) -> w1, w2
  beforeEach(() => {
    h.children = { o: ['m'], m: ['w1', 'w2'], w1: [], w2: [] }
  })
  afterEach(() => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
  })

  it('marks an intermediate manager done after routing (not stuck on "assigning")', async () => {
    const { runAgent } = cannedAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'build it', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    // the manager routed the orchestrator's tasks down to w1/w2…
    expect(out.tasks.t1.ownerId).toBe('w1')
    expect(out.tasks.t2.ownerId).toBe('w2')
    // …and must report done, not hang on "assigning"
    expect(out.steps.m.status).toBe('done')
  })
})

describe('seedRunState', () => {
  it('seeds the re-plan counters at zero', () => {
    const s = seedRunState({ runId: 'r', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' })
    expect(s.replanAttempts).toBe(0)
    expect(s.replanStageCursor).toBe(0)
  })
})

describe('maxEffort', () => {
  it('returns the highest effort present, or undefined when none', () => {
    expect(maxEffort([])).toBeUndefined()
    expect(maxEffort([undefined, undefined])).toBeUndefined()
    expect(maxEffort(['low', 'max', 'high'])).toBe('max')
    expect(maxEffort(['low', undefined, 'medium'])).toBe('medium')
  })
})

describe('lessonsDigest', () => {
  it('returns [] when there is no Lessons section', () => {
    expect(lessonsDigest('')).toEqual([])
    expect(lessonsDigest('# Memory\n\n## Task log\n- did stuff')).toEqual([])
  })

  it('extracts bullets only from the Lessons section, stopping at the next heading', () => {
    const mem = '# Memory\n\n## Lessons\n- prefer parameterized SQL\n- ship CSS correctly\n\n## Task log\n- not a lesson\n'
    expect(lessonsDigest(mem)).toEqual(['prefer parameterized SQL', 'ship CSS correctly'])
  })

  it('ignores the "(none yet)" placeholder and HTML comment lines', () => {
    const mem = '## Lessons\n<!-- one bullet per lesson -->\n- (none yet)\n'
    expect(lessonsDigest(mem)).toEqual([])
  })

  it('collapses whitespace within a lesson', () => {
    expect(lessonsDigest('## Lessons\n-   run\tthe   app\n')).toEqual(['run the app'])
  })

  it('caps the number of lessons returned', () => {
    const mem = '## Lessons\n' + Array.from({ length: 10 }, (_, i) => `- L${i}`).join('\n')
    expect(lessonsDigest(mem, 3)).toEqual(['L0', 'L1', 'L2'])
  })

  it('truncates an over-long lesson with an ellipsis', () => {
    const [out] = lessonsDigest(`## Lessons\n- ${'x'.repeat(300)}`, 5, 50)
    expect(out.length).toBe(51) // 50 chars + ellipsis
    expect(out.endsWith('…')).toBe(true)
  })

  it('excludes project-specific lessons and strips the marker from portable ones', () => {
    const mem = '## Lessons\n- [portable] verify renders return 200\n- [project] api key in config/secrets.json\n'
    expect(lessonsDigest(mem)).toEqual(['verify renders return 200'])
  })

  it('keeps untagged (legacy) lessons eligible for routing', () => {
    const mem = '## Lessons\n- [portable] write tests first\n- old untagged lesson\n- [project] local quirk\n'
    expect(lessonsDigest(mem)).toEqual(['write tests first', 'old untagged lesson'])
  })

  it('matches the marker case-insensitively', () => {
    expect(lessonsDigest('## Lessons\n- [PORTABLE] reusable rule\n')).toEqual(['reusable rule'])
  })
})

describe('normalizeLessonInput', () => {
  it('formats an object with an explicit portable scope', () => {
    expect(normalizeLessonInput({ text: 'write tests first', scope: 'portable' })).toBe(
      '[portable] write tests first'
    )
  })

  it('defaults a missing or unknown scope to project', () => {
    expect(normalizeLessonInput({ text: 'local quirk' })).toBe('[project] local quirk')
    expect(normalizeLessonInput({ text: 'local quirk', scope: 'banana' })).toBe('[project] local quirk')
  })

  it('treats a bare string as a project lesson', () => {
    expect(normalizeLessonInput('learned something')).toBe('[project] learned something')
  })

  it('keeps an already-tagged string as-is', () => {
    expect(normalizeLessonInput('[portable] already tagged')).toBe('[portable] already tagged')
  })

  it('drops empty or non-lesson input', () => {
    expect(normalizeLessonInput({ text: '   ' })).toBeNull()
    expect(normalizeLessonInput('')).toBeNull()
    expect(normalizeLessonInput(42)).toBeNull()
  })
})

describe('depsSatisfied', () => {
  const mk = (
    id: string,
    ownerId: string | null,
    status: TaskState['status'],
    dependsOn?: string[]
  ): TaskState => ({ task: { id, title: id, description: '' }, ownerId, status, attempts: 0, output: '', dependsOn })

  it('is satisfied when the task has no dependencies', () => {
    expect(depsSatisfied(mk('t2', 'w2', 'pending'), {})).toBe(true)
  })

  it('is NOT satisfied while an owned dependency is still pending or running', () => {
    const tasks = { t1: mk('t1', 'w1', 'pending'), t2: mk('t2', 'w2', 'pending', ['t1']) }
    expect(depsSatisfied(tasks.t2, tasks)).toBe(false)
    tasks.t1.status = 'running'
    expect(depsSatisfied(tasks.t2, tasks)).toBe(false)
  })

  it('is satisfied once the dependency has executed', () => {
    const tasks = { t1: mk('t1', 'w1', 'done'), t2: mk('t2', 'w2', 'pending', ['t1']) }
    expect(depsSatisfied(tasks.t2, tasks)).toBe(true)
  })

  it('does not wait on a dependency that will never run (unowned) or is unknown', () => {
    const tasks = { t1: mk('t1', null, 'pending'), t2: mk('t2', 'w2', 'pending', ['t1', 'ghost']) }
    expect(depsSatisfied(tasks.t2, tasks)).toBe(true)
  })
})

describe('hasManagers / reviewerIdsOf', () => {
  const stateWith = (tasks: Record<string, { ownerId: string | null }>): RunState => ({
    ...seedRunState({ runId: 'r', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
    tasks: Object.fromEntries(
      Object.entries(tasks).map(([id, t]) => [
        id,
        { task: { id, title: id, description: '' }, ownerId: t.ownerId, status: 'done', attempts: 1, output: '' }
      ])
    ) as RunState['tasks']
  })

  it('flat team: no managers, no reviewers', () => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
    const s = stateWith({ t1: { ownerId: 'w1' }, t2: { ownerId: 'w2' } })
    expect(hasManagers(s)).toBe(false)
    expect(reviewerIdsOf(s).sort()).toEqual([])
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
  })

  it('two-tier: the manager parent + the orchestrator are reviewers', () => {
    h.children = { o: ['m'], m: ['w1', 'w2'], w1: [], w2: [] }
    const s = stateWith({ t1: { ownerId: 'w1' }, t2: { ownerId: 'w2' } })
    expect(hasManagers(s)).toBe(true)
    expect(reviewerIdsOf(s).sort()).toEqual(['m', 'o'])
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
  })
})

describe('two-tier review', () => {
  afterEach(() => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
  })

  it('manager domain-reviews its subtree, orchestrator integration-reviews, with a repair loop', async () => {
    h.children = { o: ['m'], m: ['w1', 'w2'], w1: [], w2: [] }
    const { runAgent, calls } = cannedAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    // domain review ran AS THE MANAGER (m), not the orchestrator
    expect(calls.some((c) => c.kind.startsWith('review') && c.agentId === 'm')).toBe(true)
    expect(calls.some((c) => c.kind.startsWith('review') && c.agentId === 'o')).toBe(false)
    // integration review ran as the orchestrator
    expect(calls.some((c) => c.kind === 'integration' && c.agentId === 'o')).toBe(true)
    // t2 failed domain review, was repaired by its worker, then passed
    expect(out.tasks.t1.status).toBe('passed')
    expect(out.tasks.t2.status).toBe('passed')
    expect(out.tasks.t2.attempts).toBe(2)
    expect(out.repairAttempts).toBe(1)
    // reviews = 2 domain rounds + 1 integration
    expect(out.reviews.length).toBe(3)
  })

  it('flat team: no integration pass (byte-for-byte today)', async () => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
    const { runAgent, calls } = cannedAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    expect(calls.some((c) => c.kind === 'integration')).toBe(false) // no managers → no integration pass
    expect(out.reviews.length).toBe(2) // two domain rounds only
    expect(out.tasks.t2.attempts).toBe(2)
  })

  it('managers and the orchestrator reflect on their QA work; workers reflect on implementation', async () => {
    h.children = { o: ['m'], m: ['w1', 'w2'], w1: [], w2: [] }
    const { runAgent, calls } = cannedAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    // workers + manager + orchestrator all reflected
    expect(out.reflections.map((r) => r.nodeId).sort()).toEqual(['m', 'o', 'w1', 'w2'])
    // the manager + orchestrator used the QA reflect prompt; workers used the implementation reflect
    expect(calls.filter((c) => c.kind === 'qaReflect').map((c) => c.agentId).sort()).toEqual(['m', 'o'])
    expect(calls.filter((c) => c.kind === 'reflect').map((c) => c.agentId).sort()).toEqual(['w1', 'w2'])
  })

  it('flat team: only workers reflect (no QA reflection)', async () => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
    const { runAgent, calls } = cannedAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    expect(out.reflections.map((r) => r.nodeId).sort()).toEqual(['w1', 'w2'])
    expect(calls.some((c) => c.kind === 'qaReflect')).toBe(false)
  })
})

describe('top-level edge ordering', () => {
  afterEach(() => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
    h.edges = []
  })

  it('runs an earlier-ordered team before a later one (derived from edge order)', async () => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
    h.edges = [
      { source: 'o', target: 'w1', order: 1 },
      { source: 'o', target: 'w2', order: 2 }
    ]
    const order: string[] = []
    const runAgent: AgentRunner = async (opts) => {
      const p = opts.prompt
      if (p.includes('Produce a concise, ordered list'))
        return {
          text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"d"},{"id":"t2","title":"T2","description":"d"}]}\n```'
        }
      if (p.includes('You route planned tasks'))
        return {
          text: '```json\n{"assignments":[{"taskId":"t1","childId":"w1","effort":"high","reason":"r"},{"taskId":"t2","childId":"w2","effort":"high","reason":"r"}]}\n```'
        }
      if (p.includes('You have been assigned the following task')) {
        // delay w1 so that WITHOUT ordering, w2 would finish first
        if (opts.agentId === 'w1') await new Promise((r) => setTimeout(r, 15))
        order.push(opts.agentId)
        return { text: `worked ${opts.agentId}` }
      }
      if (p.includes('Judge each task'))
        return {
          text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""},{"taskId":"t2","verdict":"pass","feedback":""}]}\n```'
        }
      if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
      if (p.includes('Write a clear final report')) return { text: 'DONE' }
      return { text: '' }
    }
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    expect(out.tasks.t2.dependsOn).toEqual(['t1']) // order → dep
    expect(order).toEqual(['w1', 'w2']) // earlier team executed first despite the delay
  })

  it('adds no deps when edges carry no order (today behavior)', async () => {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
    h.edges = [
      { source: 'o', target: 'w1' },
      { source: 'o', target: 'w2' }
    ]
    const { runAgent } = cannedAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const out = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(out.status).toBe('completed')
    expect(out.tasks.t1.dependsOn).toBeUndefined()
    expect(out.tasks.t2.dependsOn).toBeUndefined()
  })
})

describe('orchestrator node graph — peer handoffs (worker site)', () => {
  // one task t1 -> w1; w1 may consult w2 via a handoff edge.
  function fake(order: string[], capture: { ask?: string }, w2Answer: string) {
    const runAgent: AgentRunner = async (opts) => {
      const p = opts.prompt
      if (p.includes('Produce a concise, ordered list'))
        return { text: '```json\n{"tasks":[{"id":"t1","title":"Build UI","description":"build the ui"}]}\n```' }
      if (p.includes('You route planned tasks'))
        return { text: '```json\n{"assignments":[{"taskId":"t1","childId":"w1","effort":"high","reason":"r"}]}\n```' }
      if (p.includes('responded to your request')) {
        order.push('w1-resume')
        return { text: 'Built the UI using the teal palette', sessionId: 's-w1' }
      }
      if (p.includes('You have been assigned')) {
        order.push('w1-task')
        return p.includes('You may CONSULT')
          ? { text: '```handoff\n{"to":"W2","ask":"expressive colorful UI ideas"}\n```', sessionId: 's-w1' }
          : { text: 'Built the UI (no consult)', sessionId: 's-w1' }
      }
      if (p.includes('asked for your help')) {
        order.push('w2-consult')
        capture.ask = p
        return { text: w2Answer }
      }
      if (p.includes('Judge each task'))
        return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
      if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
      if (p.includes('Write a clear final report')) return { text: 'DONE' }
      return { text: '' }
    }
    return runAgent
  }

  function run(runAgent: AgentRunner, events: unknown[]) {
    const e = eng(runAgent)
    ;(e as { emit: (ev: unknown) => void }).emit = (ev) => events.push(ev)
    const store = fakeStore()
    const io: NodeIO = {
      signal: e.abort.signal,
      emit: (ev) => events.push(ev),
      checkpoint: (s) => store.put(s),
      collectExtras: () => (e.handoffs.length ? { handoffs: [...e.handoffs] } : {})
    }
    return runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      io
    )
  }

  it('a worker consults a connected peer and continues with the answer', async () => {
    h.edges = [{ source: 'w1', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 1
    try {
      const order: string[] = []
      const capture: { ask?: string } = {}
      const events: unknown[] = []
      const out = await run(fake(order, capture, 'Use a teal/amber palette'), events)
      expect(out.status).toBe('completed')
      expect(order).toEqual(['w1-task', 'w2-consult', 'w1-resume']) // consult happened mid-task
      expect(capture.ask).toContain('expressive colorful UI ideas') // ask threaded to the peer
      expect(out.tasks.t1.output).toBe('Built the UI using the teal palette') // resumed output
      const handoffs = (events as { type: string; askerId: string; peerId: string; ask: string }[]).filter(
        (ev) => ev.type === 'handoff'
      )
      expect(handoffs).toEqual([{ runId: 'run1', type: 'handoff', askerId: 'w1', peerId: 'w2', ask: 'expressive colorful UI ideas' }])
    } finally {
      h.edges = []
      h.settings.maxHandoffs = 0
    }
  })

  it('off control: maxHandoffs=0 → no consult, byte-for-byte', async () => {
    h.edges = [{ source: 'w1', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 0
    try {
      const order: string[] = []
      const events: unknown[] = []
      const out = await run(fake(order, {}, 'unused'), events)
      expect(out.status).toBe('completed')
      expect(order).toEqual(['w1-task']) // worker ran once, not augmented, no consult
      expect(out.tasks.t1.output).toBe('Built the UI (no consult)')
      expect((events as { type: string }[]).some((ev) => ev.type === 'handoff')).toBe(false)
    } finally {
      h.edges = []
      h.settings.maxHandoffs = 0
    }
  })

  it('caps consults at maxHandoffs (asker keeps asking)', async () => {
    h.edges = [{ source: 'w1', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 1
    try {
      const order: string[] = []
      const events: unknown[] = []
      // w2's answer is itself a handoff block; the resumed worker also re-asks — but the cap is 1.
      const out = await run(fake(order, {}, '```handoff\n{"to":"W2","ask":"again"}\n```'), events)
      expect(out.status).toBe('completed')
      expect(order.filter((o) => o === 'w2-consult')).toHaveLength(1) // exactly one consult
      const handoffs = (events as { type: string }[]).filter((ev) => ev.type === 'handoff')
      expect(handoffs).toHaveLength(1)
    } finally {
      h.edges = []
      h.settings.maxHandoffs = 0
    }
  })

  it('peer answer is terminal: a handoff block in the peer reply is not re-dispatched', async () => {
    h.edges = [{ source: 'w1', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 3 // budget to spare; terminal-peer is what prevents a second consult
    try {
      const order: string[] = []
      const events: unknown[] = []
      // w2 replies with a handoff-looking block; the worker's RESUME then finishes normally.
      const out = await run(fake(order, {}, '```handoff\n{"to":"W2","ask":"chain"}\n```'), events)
      expect(out.status).toBe('completed')
      expect(order).toEqual(['w1-task', 'w2-consult', 'w1-resume']) // peer reply NOT re-parsed
      expect((events as { type: string }[]).filter((ev) => ev.type === 'handoff')).toHaveLength(1)
    } finally {
      h.edges = []
      h.settings.maxHandoffs = 0
    }
  })

  it('threads the asker\'s in-run sessionId into the resume call (not a stale on-disk session)', async () => {
    h.edges = [{ source: 'w1', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 1
    try {
      let capturedResumeSessionId: string | undefined = undefined
      const runAgent: AgentRunner = async (opts) => {
        const p = opts.prompt
        if (p.includes('Produce a concise, ordered list'))
          return { text: '```json\n{"tasks":[{"id":"t1","title":"Build UI","description":"build the ui"}]}\n```' }
        if (p.includes('You route planned tasks'))
          return { text: '```json\n{"assignments":[{"taskId":"t1","childId":"w1","effort":"high","reason":"r"}]}\n```' }
        if (p.includes('You have been assigned') && p.includes('You may CONSULT')) {
          // asker's first call returns a handoff request with a known sessionId
          return { text: '```handoff\n{"to":"W2","ask":"palette?"}\n```', sessionId: 's-w1-1' }
        }
        if (p.includes('asked for your help'))
          return { text: 'Use teal.' }
        if (p.includes('responded to your request')) {
          // capture the resumeSessionId that was threaded into this call
          capturedResumeSessionId = opts.resumeSessionId
          return { text: 'Built UI with teal.' }
        }
        if (p.includes('Judge each task'))
          return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
        if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Write a clear final report')) return { text: 'DONE' }
        return { text: '' }
      }
      const events: unknown[] = []
      const out = await run(runAgent, events)
      expect(out.status).toBe('completed')
      // The resume call must have received the asker's in-run session from the first call
      expect(capturedResumeSessionId).toBe('s-w1-1')
    } finally {
      h.edges = []
      h.settings.maxHandoffs = 0
    }
  })

  it('persists the handoff into run state + the run record', async () => {
    h.edges = [{ source: 'w1', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 1
    try {
      const events: unknown[] = []
      const out = await run(fake([], {}, 'Use a teal/amber palette'), events)
      expect(out.handoffs).toEqual([{ askerId: 'w1', peerId: 'w2', ask: 'expressive colorful UI ideas' }])
      expect(toRunRecord(out).handoffs).toEqual([{ askerId: 'w1', peerId: 'w2', ask: 'expressive colorful UI ideas' }])
    } finally {
      h.edges = []
    }
  })

  it('off (maxHandoffs=0): no handoffs key on the record', async () => {
    h.settings.maxHandoffs = 0
    const events: unknown[] = []
    const out = await run(fake([], {}, 'x'), events)
    expect(out.handoffs ?? []).toEqual([])
    expect('handoffs' in toRunRecord(out)).toBe(false)
  })

  it('emits working + done status for the consulted peer', async () => {
    h.edges = [{ source: 'w1', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 1
    try {
      const events: { type: string; nodeId?: string; status?: string }[] = []
      await run(fake([], {}, 'Use a teal/amber palette'), events as unknown[])
      const peerStatuses = events.filter((e) => e.type === 'status' && e.nodeId === 'w2').map((e) => e.status)
      expect(peerStatuses).toContain('working')
      expect(peerStatuses).toContain('done')
    } finally {
      h.edges = []
    }
  })

  it('combined: a worker consults a peer then pauses to ask the user; handoff persists across pause→resume with no double-count, answer never leaks', async () => {
    // Scenario: w1 is assigned t1.
    //   Call 1 (You have been assigned + You may CONSULT): emits handoff block → H1 dispatched, w2 answers.
    //   Call 2 (resumed post-handoff, prompt has "responded to your request"): emits ask block → run pauses.
    //   Call 3 (HITL resume, prompt has "The user answered"): w1 completes t1.
    h.edges = [{ source: 'w1', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 1
    h.settings.maxUserRequests = 1
    const SECRET = 'SecretAnswer42'
    try {
      const order: string[] = []
      let w1FirstDone = false
      const runAgent: AgentRunner = async (opts) => {
        const p = opts.prompt
        // plan
        if (p.includes('Produce a concise, ordered list'))
          return { text: '```json\n{"tasks":[{"id":"t1","title":"Build UI","description":"build the ui"}]}\n```' }
        // route
        if (p.includes('You route planned tasks'))
          return { text: '```json\n{"assignments":[{"taskId":"t1","childId":"w1","effort":"high","reason":"r"}]}\n```' }
        // w2 peer answer
        if (p.includes('asked for your help')) {
          order.push('w2-consult')
          return { text: 'Use a teal palette' }
        }
        // w1 resumed with peer answer → emits ask block
        if (p.includes('responded to your request')) {
          order.push('w1-post-handoff')
          return { text: '```ask\n{"question":"Which shade of teal?"}\n```', sessionId: 's-w1-resumed' }
        }
        // w1 resumed with HITL answer → finishes
        if (p.includes('The user answered')) {
          order.push('w1-hitl-resume')
          return { text: `Done: used ${p.includes(SECRET) ? 'the answer' : 'unknown'}`, sessionId: 's-w1-final' }
        }
        // w1 first call → handoff request
        if (p.includes('You have been assigned') && !w1FirstDone) {
          w1FirstDone = true
          order.push('w1-task')
          return { text: '```handoff\n{"to":"W2","ask":"color palette ideas"}\n```', sessionId: 's-w1-1' }
        }
        if (p.includes('Judge each task'))
          return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
        if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Write a clear final report')) return { text: 'DONE' }
        return { text: '' }
      }

      // Build the eng+store manually so we can call resumeGraph on the same store.
      const e = eng(runAgent)
      ;(e as { emit: (ev: unknown) => void }).emit = (ev: unknown) => {}
      const store = fakeStore()
      const io: NodeIO = {
        signal: e.abort.signal,
        emit: () => {},
        checkpoint: (s) => store.put(s),
        collectExtras: () => (e.handoffs.length ? { handoffs: [...e.handoffs] } : {})
      }

      // Phase 1: run until paused for the user question.
      const paused = await runGraph(
        buildOrchestratorGraph(e),
        seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
        store,
        io
      )

      // The handoff fired and the ask block paused the run.
      expect(order).toEqual(['w1-task', 'w2-consult', 'w1-post-handoff'])
      expect(paused.status).toBe('interrupted')
      expect(paused.pendingInterrupt?.kind).toBe('ask-user')
      expect(paused.pendingInterrupt?.prompt).toBe('Which shade of teal?')

      // The handoff is persisted into the paused checkpoint.
      const saved = await store.get('run1')
      expect(saved?.handoffs).toEqual([{ askerId: 'w1', peerId: 'w2', ask: 'color palette ideas' }])

      // Phase 2: resume with the user's answer.
      const final = await resumeGraph(buildOrchestratorGraph(e), 'run1', store, io, SECRET)

      expect(order).toEqual(['w1-task', 'w2-consult', 'w1-post-handoff', 'w1-hitl-resume'])
      expect(final.status).toBe('completed')

      // Handoffs still exactly one entry — no double-count, no loss across pause→resume.
      expect(final.handoffs).toEqual([{ askerId: 'w1', peerId: 'w2', ask: 'color palette ideas' }])

      // The answer never appears in any persisted field.
      expect(JSON.stringify(final)).not.toContain(SECRET)
    } finally {
      h.edges = []
      h.settings.maxHandoffs = 0
      h.settings.maxUserRequests = 0
    }
  })
})

describe('orchestrator node graph — peer handoffs (review site)', () => {
  it('a manager consults a peer during domain review, then returns its verdict', async () => {
    // two-tier: o -> m -> w1 ; m may consult w2 via a handoff edge.
    h.children = { o: ['m'], m: ['w1'], w1: [], w2: [] }
    h.edges = [{ source: 'm', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 1
    try {
      const order: string[] = []
      const events: unknown[] = []
      const runAgent: AgentRunner = async (opts) => {
        const p = opts.prompt
        if (p.includes('Produce a concise, ordered list'))
          return { text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"d"}]}\n```' }
        if (p.includes('You route planned tasks')) {
          const childIds = [...p.matchAll(/- id: (\S+)\n\s+name:/g)].map((mm) => mm[1])
          return { text: '```json\n{"assignments":[{"taskId":"t1","childId":"' + (childIds[0] ?? 'w1') + '","effort":"high","reason":"r"}]}\n```' }
        }
        if (p.includes('You have been assigned')) return { text: 'did t1', sessionId: 's-w1' }
        if (p.includes('responded to your request')) {
          order.push('m-resume')
          return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
        }
        if (p.includes('Judge each task')) {
          order.push('m-review')
          return { text: '```handoff\n{"to":"W2","ask":"is this compliant?"}\n```' }
        }
        if (p.includes('asked for your help')) {
          order.push('w2-consult')
          return { text: 'Yes, compliant.' }
        }
        if (p.includes('final INTEGRATION review'))
          return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
        if (p.includes('Reflect on your REVIEW work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Write a clear final report')) return { text: 'DONE' }
        return { text: '' }
      }
      const e = eng(runAgent)
      ;(e as { emit: (ev: unknown) => void }).emit = (ev) => events.push(ev)
      const store = fakeStore()
      const out = await runGraph(
        buildOrchestratorGraph(e),
        seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
        store,
        makeIO(e.abort.signal, store)
      )
      expect(out.status).toBe('completed')
      expect(order).toEqual(['m-review', 'w2-consult', 'm-resume']) // consult mid-review, then verdict
      expect(out.tasks.t1.status).toBe('passed') // verdict still parsed after the consult
      const handoffs = (events as { type: string; askerId: string; peerId: string }[]).filter(
        (ev) => ev.type === 'handoff'
      )
      expect(handoffs).toEqual([{ runId: 'run1', type: 'handoff', askerId: 'm', peerId: 'w2', ask: 'is this compliant?' }])
    } finally {
      h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
      h.edges = []
      h.settings.maxHandoffs = 0
    }
  })

  it('persists a review-site handoff into the record', async () => {
    h.children = { o: ['m'], m: ['w1'], w1: [], w2: [] }
    h.edges = [{ source: 'm', target: 'w2', kind: 'handoff' }]
    h.settings.maxHandoffs = 1
    try {
      const runAgent: AgentRunner = async (opts) => {
        const p = opts.prompt
        if (p.includes('Produce a concise, ordered list'))
          return { text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"d"}]}\n```' }
        if (p.includes('You route planned tasks')) {
          const childIds = [...p.matchAll(/- id: (\S+)\n\s+name:/g)].map((mm) => mm[1])
          return { text: '```json\n{"assignments":[{"taskId":"t1","childId":"' + (childIds[0] ?? 'w1') + '","effort":"high","reason":"r"}]}\n```' }
        }
        if (p.includes('You have been assigned')) return { text: 'did t1', sessionId: 's-w1' }
        if (p.includes('responded to your request'))
          return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
        if (p.includes('Judge each task'))
          return { text: '```handoff\n{"to":"W2","ask":"is this compliant?"}\n```' }
        if (p.includes('asked for your help')) return { text: 'Yes, compliant.' }
        if (p.includes('final INTEGRATION review'))
          return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
        if (p.includes('Reflect on your REVIEW work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Write a clear final report')) return { text: 'DONE' }
        return { text: '' }
      }
      const e = eng(runAgent)
      const store = fakeStore()
      const io: NodeIO = {
        signal: e.abort.signal,
        emit: () => {},
        checkpoint: (s) => store.put(s),
        collectExtras: () => (e.handoffs.length ? { handoffs: [...e.handoffs] } : {})
      }
      const out = await runGraph(
        buildOrchestratorGraph(e),
        seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
        store,
        io
      )
      expect(out.handoffs?.length).toBeGreaterThan(0)
      expect(toRunRecord(out).handoffs).toEqual(out.handoffs)
      expect(out.handoffs).toEqual([{ askerId: 'm', peerId: 'w2', ask: 'is this compliant?' }])
    } finally {
      h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
      h.edges = []
      h.settings.maxHandoffs = 0
    }
  })
})

describe('orchestrator node graph — v2 escalation (mis-scoped re-plan)', () => {
  // two-tier: o -> m -> w1 ; manager m reviews w1's work.
  function setupTwoTier() {
    h.children = { o: ['m'], m: ['w1'], w1: [], w2: [] }
  }
  function restore() {
    h.children = { o: ['w1', 'w2'], w1: [], w2: [] }
    h.settings.maxReplans = 0
  }
  function run(runAgent: AgentRunner, events: unknown[]) {
    const e = eng(runAgent)
    ;(e as { emit: (ev: unknown) => void }).emit = (ev) => events.push(ev)
    const store = fakeStore()
    return runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
  }
  // route by parsing child ids from the prompt (matches routePrompt format), like cannedAgent
  function routeJSON(prompt: string): string {
    const childIds = [...prompt.matchAll(/- id: (\S+)\n\s+name:/g)].map((m) => m[1])
    const taskIds = [...prompt.matchAll(/- id: (\w+) —/g)].map((m) => m[1])
    const assignments = taskIds.map((tid) => ({ taskId: tid, childId: childIds[0] ?? null, effort: 'high', reason: 'r' }))
    return '```json\n' + JSON.stringify({ assignments }) + '\n```'
  }

  it('a domain reviewer flags a mis-scoped task → escalate re-breaks it up', async () => {
    setupTwoTier()
    h.settings.maxReplans = 1
    try {
      const order: string[] = []
      const events: unknown[] = []
      let escalatePrompt = ''
      const runAgent: AgentRunner = async (opts) => {
        const p = opts.prompt
        if (p.includes('Produce a concise, ordered list'))
          return { text: '```json\n{"tasks":[{"id":"t1","title":"Build it","description":"too broad"}]}\n```' }
        if (p.includes('You route planned tasks')) return { text: routeJSON(p) }
        if (p.includes('You have been assigned')) { order.push(opts.agentId); return { text: `did ${[...p.matchAll(/\d+\. (\w+)/g)].length ? 'task' : ''}`, sessionId: 's' } }
        if (p.includes('MIS-SCOPED')) { escalatePrompt = p; order.push('escalate'); return { text: '```json\n{"reason":"t1 was too broad","tasks":[{"id":"e1","title":"E1","description":"do e1","dependsOn":[]}]}\n```' } }
        if (p.includes('Judge each task')) {
          // fail t1 as mis-scoped on the first review; pass e1 after the re-plan
          return p.includes('taskId: e1')
            ? { text: '```json\n{"tasks":[{"taskId":"e1","verdict":"pass","feedback":""}]}\n```' }
            : { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"fail","feedback":"mis-scoped, split it","disposition":"replan"}]}\n```' }
        }
        if (p.includes('final INTEGRATION review'))
          return { text: '```json\n{"tasks":[{"taskId":"e1","verdict":"pass","feedback":""}]}\n```' }
        if (p.includes('Reflect on your REVIEW work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Write a clear final report')) return { text: 'DONE' }
        return { text: '' }
      }
      const out = await run(runAgent, events)
      expect(out.status).toBe('completed')
      expect(order).toContain('escalate')
      expect(escalatePrompt).toContain('t1') // the failed task was handed to the escalate step
      expect(out.tasks.t1).toBeUndefined() // mis-scoped task replaced
      expect(out.tasks.e1?.status).toBe('passed') // re-broken-up task ran + passed
      expect(out.replanAttempts).toBe(1)
      const replans = (events as { type: string; reason: string }[]).filter((ev) => ev.type === 'replan')
      expect(replans).toHaveLength(1)
      expect(replans[0].reason).toBe('t1 was too broad')
    } finally {
      restore()
    }
  })

  it('off control: maxReplans=0 → no disposition asked, a fail repairs (byte-for-byte)', async () => {
    setupTwoTier()
    h.settings.maxReplans = 0
    try {
      const order: string[] = []
      const events: unknown[] = []
      let reviewPromptText = ''
      const runAgent: AgentRunner = async (opts) => {
        const p = opts.prompt
        if (p.includes('Produce a concise, ordered list'))
          return { text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"d"}]}\n```' }
        if (p.includes('You route planned tasks')) return { text: routeJSON(p) }
        if (p.includes('You have been assigned')) { order.push('work'); return { text: 'did t1', sessionId: 's' } }
        if (p.includes('did not pass review')) { order.push('repair'); return { text: 'fixed t1', sessionId: 's' } }
        if (p.includes('Judge each task')) { reviewPromptText = p; return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"' + (order.includes('repair') ? 'pass' : 'fail') + '","feedback":"x"}]}\n```' } }
        if (p.includes('final INTEGRATION review')) return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
        if (p.includes('MIS-SCOPED')) { order.push('escalate'); return { text: '```json\n{"reason":"x","tasks":[]}\n```' } }
        if (p.includes('Reflect on your REVIEW work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Write a clear final report')) return { text: 'DONE' }
        return { text: '' }
      }
      const out = await run(runAgent, events)
      expect(out.status).toBe('completed')
      expect(reviewPromptText).not.toContain('disposition') // prompt unchanged when off
      expect(order).toContain('repair') // a fail repaired as today
      expect(order).not.toContain('escalate')
      expect((events as { type: string }[]).some((ev) => ev.type === 'replan')).toBe(false)
    } finally {
      restore()
    }
  })

  it('a fail with disposition=repair repairs, does not escalate', async () => {
    setupTwoTier()
    h.settings.maxReplans = 1
    try {
      const order: string[] = []
      const events: unknown[] = []
      const runAgent: AgentRunner = async (opts) => {
        const p = opts.prompt
        if (p.includes('Produce a concise, ordered list'))
          return { text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"d"}]}\n```' }
        if (p.includes('You route planned tasks')) return { text: routeJSON(p) }
        if (p.includes('You have been assigned')) { order.push('work'); return { text: 'did t1', sessionId: 's' } }
        if (p.includes('did not pass review')) { order.push('repair'); return { text: 'fixed', sessionId: 's' } }
        if (p.includes('Judge each task')) return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"' + (order.includes('repair') ? 'pass' : 'fail') + '","feedback":"x","disposition":"repair"}]}\n```' }
        if (p.includes('final INTEGRATION review')) return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
        if (p.includes('MIS-SCOPED')) { order.push('escalate'); return { text: '```json\n{"reason":"x","tasks":[]}\n```' } }
        if (p.includes('Reflect')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
        if (p.includes('Write a clear final report')) return { text: 'DONE' }
        return { text: '' }
      }
      const out = await run(runAgent, events)
      expect(out.status).toBe('completed')
      expect(order).toContain('repair')
      expect(order).not.toContain('escalate')
      expect(out.replanAttempts).toBe(0)
    } finally {
      restore()
    }
  })
})

describe('orchestrator node graph — proactive re-plan', () => {
  // research = w1 (stage 1), build = w2 (stage 2), sequenced by canvas order.
  const orderedEdges = [
    { source: 'o', target: 'w1', order: 1 },
    { source: 'o', target: 'w2', order: 2 }
  ]

  // A fake that assigns t1->w1, t2->w2 on every route, records work order, and runs the
  // given replan decision when the orchestrator is asked to re-plan.
  function fake(order: string[], replan: () => object) {
    const runAgent: AgentRunner = async (opts) => {
      const p = opts.prompt
      if (p.includes('Produce a concise, ordered list'))
        return {
          text: '```json\n{"tasks":[{"id":"t1","title":"Research","description":"research db"},{"id":"t2","title":"Build","description":"use postgres"}]}\n```'
        }
      if (p.includes('You route planned tasks')) {
        const taskIds = [...p.matchAll(/- id: (t\d+) —/g)].map((mm) => mm[1])
        const map: Record<string, string> = { t1: 'w1', t2: 'w2' }
        const assignments = taskIds.map((tid) => ({ taskId: tid, childId: map[tid] ?? 'w1', effort: 'high', reason: 'r' }))
        return { text: '```json\n' + JSON.stringify({ assignments }) + '\n```' }
      }
      if (p.includes('Based ONLY on what the completed work actually revealed')) {
        order.push('replan')
        return { text: '```json\n' + JSON.stringify(replan()) + '\n```' }
      }
      if (p.includes('You have been assigned the following task')) {
        order.push(opts.agentId)
        return { text: `worked ${opts.agentId}` }
      }
      if (p.includes('Judge each task'))
        return {
          text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""},{"taskId":"t2","verdict":"pass","feedback":""}]}\n```'
        }
      if (p.includes('Reflect on the work')) return { text: '```json\n{"win":"","loss":"","lessons":[]}\n```' }
      if (p.includes('Write a clear final report')) return { text: 'DONE' }
      return { text: '' }
    }
    return runAgent
  }

  function run(runAgent: AgentRunner, events: unknown[]) {
    const e = eng(runAgent)
    ;(e as { emit: (ev: unknown) => void }).emit = (ev) => events.push(ev)
    const store = fakeStore()
    return runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
  }

  it('does not pause or re-plan when maxReplans is 0 (byte-for-byte)', async () => {
    h.edges = orderedEdges
    h.settings.maxReplans = 0
    try {
      const order: string[] = []
      const events: unknown[] = []
      const out = await run(fake(order, () => ({ replan: false })), events)
      expect(out.status).toBe('completed')
      expect(order).toEqual(['w1', 'w2']) // sequenced, but NO replan pause
      expect(out.replanAttempts).toBe(0)
      expect((events as { type: string }[]).some((ev) => ev.type === 'replan')).toBe(false)
    } finally {
      h.edges = []
      h.settings.maxReplans = 0
    }
  })

  it('pauses at the stage boundary and rewrites the not-yet-run plan', async () => {
    h.edges = orderedEdges
    h.settings.maxReplans = 1
    try {
      const order: string[] = []
      const events: unknown[] = []
      const replanPrompts: string[] = []
      const runAgent: AgentRunner = async (opts) => {
        if (opts.prompt.includes('Based ONLY on what the completed work actually revealed'))
          replanPrompts.push(opts.prompt)
        return fake(order, () => ({
          replan: true,
          reason: 'research shows supabase is better',
          tasks: [{ id: 't2', title: 'Build', description: 'use supabase', dependsOn: [] }]
        }))(opts)
      }
      const out = await run(runAgent, events)
      expect(out.status).toBe('completed')
      expect(order).toEqual(['w1', 'replan', 'w2']) // research -> re-plan -> build
      expect(replanPrompts[0]).toContain('worked w1') // re-plan saw the research output
      expect(out.tasks.t2.task.description).toBe('use supabase') // build re-planned
      expect(out.replanAttempts).toBe(1)
      expect(out.replans).toEqual([{ attempt: 1, reason: 'research shows supabase is better' }])
      const replanEvents = (events as { type: string; tasks: { id: string }[] }[]).filter((ev) => ev.type === 'replan')
      expect(replanEvents).toHaveLength(1)
      expect(replanEvents[0].tasks.map((t) => t.id)).toEqual(['t1', 't2']) // full new plan
    } finally {
      h.edges = []
      h.settings.maxReplans = 0
    }
  })

  it('declines: asks once, then resumes the original plan unchanged', async () => {
    h.edges = orderedEdges
    h.settings.maxReplans = 1
    try {
      const order: string[] = []
      const events: unknown[] = []
      const out = await run(fake(order, () => ({ replan: false, reason: 'plan still holds', tasks: [] })), events)
      expect(out.status).toBe('completed')
      expect(order).toEqual(['w1', 'replan', 'w2']) // paused + asked, then ran the original build
      expect(out.tasks.t2.task.description).toBe('use postgres') // unchanged
      expect(out.replanAttempts).toBe(0)
      expect(out.replans ?? []).toEqual([])
      expect((events as { type: string }[]).some((ev) => ev.type === 'replan')).toBe(false)
    } finally {
      h.edges = []
      h.settings.maxReplans = 0
    }
  })

  it('offers each boundary at most once (does not re-ask after resuming)', async () => {
    h.edges = orderedEdges
    h.settings.maxReplans = 2 // budget for 2, but there is only one boundary
    try {
      const order: string[] = []
      const events: unknown[] = []
      const out = await run(
        fake(order, () => ({
          replan: true,
          reason: 'always re-plan',
          tasks: [{ id: 't2', title: 'Build', description: 'use supabase', dependsOn: [] }]
        })),
        events
      )
      expect(out.status).toBe('completed')
      expect(out.replanAttempts).toBe(1) // NOT 2 — the boundary is offered once (cursor)
      expect(order.filter((o) => o === 'replan')).toHaveLength(1)
    } finally {
      h.edges = []
      h.settings.maxReplans = 0
    }
  })
})

describe('HITL user requests (Stage 3)', () => {
  // Restore the off-default so this block can't leak maxUserRequests into a later suite.
  afterEach(() => {
    h.settings.maxUserRequests = 0
  })

  // A worker (w1) asks once on its first work call, then completes on resume.
  // Plan→route reuse the canned shapes; only the work/resume calls are bespoke.
  function askingAgent(opts?: { echoAnswerOnResume?: boolean }) {
    const calls: { agentId: string; kind: string; prompt: string }[] = []
    let w1Asked = false
    const runAgent: AgentRunner = async (agentOpts) => {
      const p = agentOpts.prompt
      const id = agentOpts.agentId
      if (p.includes('Produce a concise, ordered list')) {
        return {
          text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"do t1"},{"id":"t2","title":"T2","description":"do t2"}]}\n```',
          sessionId: 's-' + id
        }
      }
      if (p.includes('You route planned tasks')) {
        const childIds = [...p.matchAll(/- id: (\S+)\n\s+name:/g)].map((m) => m[1])
        const taskIds = [...p.matchAll(/- id: (t\d+) —/g)].map((m) => m[1])
        const assignments = taskIds.map((tid, i) => ({
          taskId: tid, childId: childIds[i % childIds.length] ?? null, reason: 'r'
        }))
        return { text: '```json\n' + JSON.stringify({ assignments }) + '\n```' }
      }
      if (p.includes('The user answered') || p.includes('did not provide an answer')) {
        calls.push({ agentId: id, kind: 'resume', prompt: p })
        const text = opts?.echoAnswerOnResume ? `resumed ${id}: ${p}` : `resumed ${id}`
        return { text, sessionId: 's2-' + id }
      }
      if (p.includes('You have been assigned the following task')) {
        if (id === 'w1' && !w1Asked) {
          w1Asked = true
          calls.push({ agentId: id, kind: 'ask', prompt: p })
          return { text: '```ask\n{"question":"Which color?"}\n```', sessionId: 'sess-w1' }
        }
        calls.push({ agentId: id, kind: 'work', prompt: p })
        return { text: `worked ${id}`, sessionId: 's-' + id }
      }
      // reviews / reflect / synth → pass-through so the run can finish
      if (p.includes('Judge each task')) return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""},{"taskId":"t2","verdict":"pass","feedback":""}]}\n```' }
      if (p.includes('final INTEGRATION review')) return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""},{"taskId":"t2","verdict":"pass","feedback":""}]}\n```' }
      if (p.includes('Reflect on')) return { text: '```json\n{"win":"w","loss":"","lessons":[]}\n```' }
      if (p.includes('Write a clear final report')) return { text: 'FINAL' }
      return { text: 'unknown' }
    }
    return { runAgent, calls }
  }

  it('off (maxUserRequests=0): an ask block is treated as ordinary output', async () => {
    h.settings.maxUserRequests = 0
    const { runAgent } = askingAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const final = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      makeIO(e.abort.signal, store)
    )
    expect(final.status).toBe('completed')
    expect(final.pendingInterrupt).toBeUndefined()
    expect(final.pendingAsk).toBeUndefined()
    // the ask text became the worker's output (not a pause)
    expect(final.tasks['t1'].output).toContain('ask')
  })

  it('on: a worker ask pauses the run with an interrupt + pendingAsk', async () => {
    h.settings.maxUserRequests = 2
    const events: { type: string }[] = []
    const { runAgent } = askingAgent()
    const e: Eng = { ...eng(runAgent), emit: (ev) => events.push(ev) }
    const store = fakeStore()
    const io: NodeIO = { signal: e.abort.signal, emit: (ev) => events.push(ev), checkpoint: (s) => store.put(s) }
    const final = await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      io
    )
    expect(final.status).toBe('interrupted')
    expect(final.pendingInterrupt?.kind).toBe('ask-user')
    expect(final.pendingInterrupt?.prompt).toBe('Which color?')
    expect(final.pendingAsk?.ownerId).toBe('w1')
    expect(final.pendingAsk?.sessionId).toBe('sess-w1')
    expect(final.pendingAsk?.taskIds).toContain('t1')
    expect(final.userRequests).toEqual([{ askerId: 'w1', question: 'Which color?' }])
    // the asking task is left pending; the answer is nowhere in state
    expect(final.tasks['t1'].status).toBe('pending')
  })

  it('resume with an answer continues the asking worker and finishes; no answer persisted', async () => {
    h.settings.maxUserRequests = 2
    const { runAgent, calls } = askingAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const io = makeIO(e.abort.signal, store)
    await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      io
    )
    const final = await resumeGraph(buildOrchestratorGraph(e), 'run1', store, io, 'Use teal')
    expect(final.status).toBe('completed')
    expect(final.userRequestCount).toBe(1)
    expect(final.pendingAsk).toBeUndefined()
    expect(final.resumeInput).toBeUndefined()
    // the asker was resumed via its captured session with the answer
    const resume = calls.find((c) => c.kind === 'resume' && c.agentId === 'w1')
    expect(resume).toBeTruthy()
    expect(resume!.prompt).toContain('Use teal')
    // the raw answer never lands in persisted run state (questions are fine; answers are not)
    const persisted = JSON.stringify(final) // includes steps[].output — redacted as of S5
    expect(persisted).not.toContain('Use teal')
  })

  it('redacts an echoed answer from the asking worker\'s persisted output', async () => {
    h.settings.maxUserRequests = 2
    const { runAgent } = askingAgent({ echoAnswerOnResume: true })
    const e = eng(runAgent)
    const store = fakeStore()
    const io = makeIO(e.abort.signal, store)
    await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      io
    )
    const secret = 'TealSecret123' // >= 6 chars, unique
    const final = await resumeGraph(buildOrchestratorGraph(e), 'run1', store, io, secret)
    expect(final.status).toBe('completed')
    // the worker echoed the answer, but the persisted output is redacted
    expect(final.tasks['t1'].output).toContain('[user answer redacted]')
    expect(final.tasks['t1'].output).not.toContain(secret)
    // the raw answer appears NOWHERE in persisted state — INCLUDING steps[].output
    expect(JSON.stringify(final)).not.toContain(secret)
  })

  it('skip (empty answer) resumes best-effort and finishes', async () => {
    h.settings.maxUserRequests = 2
    const { runAgent, calls } = askingAgent()
    const e = eng(runAgent)
    const store = fakeStore()
    const io = makeIO(e.abort.signal, store)
    await runGraph(
      buildOrchestratorGraph(e),
      seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }),
      store,
      io
    )
    const final = await resumeGraph(buildOrchestratorGraph(e), 'run1', store, io, '')
    expect(final.status).toBe('completed')
    const resume = calls.find((c) => c.kind === 'resume' && c.agentId === 'w1')
    expect(resume!.prompt).toContain('did not provide an answer')
  })

  it('after resume, synthesis sees the captured reply and acknowledges the answer (no leak)', async () => {
    h.settings.maxUserRequests = 2
    let synthPromptSeen = ''
    let w1Asked = false
    const runAgent: AgentRunner = async (o) => {
      const p = o.prompt
      if (p.includes('Produce a concise, ordered list'))
        return { text: '```json\n{"tasks":[{"id":"t1","title":"T1","description":"do t1"}]}\n```', sessionId: 's-' + o.agentId }
      if (p.includes('You route planned tasks'))
        return { text: '```json\n{"assignments":[{"taskId":"t1","childId":"w1","reason":"r"}]}\n```' }
      if (p.includes('You have been assigned')) {
        if (o.agentId === 'w1' && !w1Asked) {
          w1Asked = true
          return { text: '```ask\n{"question":"Which package manager?"}\n```', sessionId: 'sess-w1' }
        }
        return { text: `worked ${o.agentId}`, sessionId: 's-' + o.agentId }
      }
      if (p.includes('The user answered') || p.includes('did not provide an answer'))
        return { text: 'Installed deps and wrote the CLI per the manager you chose.', sessionId: 's2-w1' }
      if (p.includes('Judge each task'))
        return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
      if (p.includes('final INTEGRATION review'))
        return { text: '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```' }
      if (p.includes('Reflect on')) return { text: '```json\n{"win":"w","loss":"","lessons":[]}\n```' }
      if (p.includes('Write a clear final report')) { synthPromptSeen = p; return { text: 'FINAL' } }
      return { text: 'unknown' }
    }
    const e = eng(runAgent)
    const store = fakeStore()
    const io = makeIO(e.abort.signal, store)
    await runGraph(buildOrchestratorGraph(e), seedRunState({ runId: 'run1', goal: 'g', orchestratorId: 'o', actingMode: 'auto', startedAt: 'S' }), store, io)
    const secret = 'pnpm v9 exactly'
    const final = await resumeGraph(buildOrchestratorGraph(e), 'run1', store, io, secret)

    expect(final.status).toBe('completed')
    // (a) the resumed reply is captured into the durable task output — NOT the pre-resume ask
    expect(final.tasks['t1'].output).toContain('Installed deps and wrote the CLI')
    expect(final.tasks['t1'].output).not.toContain('Which package manager?')
    // (b) synthesis was handed the consultation section (so it can report it resolved)
    expect(synthPromptSeen).not.toBe('') // synth actually ran — guards the no-leak assert below
    expect(synthPromptSeen).toContain('## User consultations during this run')
    expect(synthPromptSeen).toContain('Which package manager?')
    // (c) the raw answer never reaches synthesis or any persisted state (S5)
    expect(synthPromptSeen).not.toContain(secret)
    expect(JSON.stringify(final)).not.toContain(secret)
  })
})

describe('effortForModel', () => {
  it('clamps a requested effort to the worker model when adaptive is on', () => {
    expect(effortForModel('claude-sonnet-4-6', 'xhigh', true)).toBe('max')
    expect(effortForModel('claude-haiku-4-5', 'high', true)).toBeUndefined()
    expect(effortForModel('claude-opus-4-8', 'xhigh', true)).toBe('xhigh')
  })
  it('passes the requested effort through unchanged when adaptive is off', () => {
    expect(effortForModel('claude-sonnet-4-6', 'xhigh', false)).toBe('xhigh')
  })
  it('passes through unchanged when there is no assigned model (childId null)', () => {
    expect(effortForModel(undefined, 'xhigh', true)).toBe('xhigh')
  })
})

describe('formatUserRequests', () => {
  it('returns empty string when there are no user requests', () => {
    expect(formatUserRequests({ userRequests: [] } as unknown as RunState)).toBe('')
    expect(formatUserRequests({} as unknown as RunState)).toBe('')
  })

  it('summarizes each consultation by asker name + question, marking it resolved', () => {
    const out = formatUserRequests({
      userRequests: [{ askerId: 'w1', question: 'Which package manager?' }]
    } as unknown as RunState)
    expect(out).toContain('## User consultations during this run')
    expect(out).toContain('W1') // getAgent('w1').name from the hoisted fake
    expect(out).toContain('Which package manager?')
    expect(out).toContain('provided an answer')
    expect(out).toContain('redacted from this record')
    expect(out).toContain('resolved') // the directive travels inside the section
  })

  it('never contains an answer — only the question is an input', () => {
    const out = formatUserRequests({
      userRequests: [{ askerId: 'w1', question: 'pick a color' }]
    } as unknown as RunState)
    expect(out).not.toContain('teal') // no answer field exists to leak
  })

  it('falls back to the askerId when the agent is unknown (deleted/renamed)', () => {
    // h.agents has no 'ghost' entry, so getAgent('ghost') returns undefined → .name throws
    const out = formatUserRequests({
      userRequests: [{ askerId: 'ghost', question: 'Q' }]
    } as unknown as RunState)
    expect(out).toContain('ghost')
    expect(out).toContain('Q')
  })
})
