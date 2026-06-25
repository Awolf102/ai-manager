import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runGraph, resumeGraph, type NodeIO } from './graph'
import {
  buildOrchestratorGraph,
  seedRunState,
  maxEffort,
  lessonsDigest,
  depsSatisfied,
  normalizeLessonInput,
  type Eng,
  type AgentRunner
} from './nodes'
import type { RunState, TaskState } from '../../shared/types'

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
    settings: {
      reviewMode: 'once',
      maxRepairAttempts: 1,
      reflection: true,
      autonomy: 'auto',
      adaptiveEffort: true
    },
    memory: {} as Record<string, string>,
    reflections: [] as { id: string }[]
  }
})

vi.mock('./project-store', () => ({
  getAgent: (id: string) => h.agents[id],
  childrenOf: (id: string) => (h.children[id] ?? []).map((c) => h.agents[c]),
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
    emit: () => {}
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
