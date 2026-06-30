import { create } from 'zustand'
import { addToast, removeToast, type Toast } from './toasts'
import {
  DEFAULT_LAYOUT, clampInspector, clampDockHeight, clampDockWidth,
  serializeLayout, parseLayout, type LayoutState
} from './layout'
import { activeDockAfterOpenTerminal } from './dock'
import type {
  AgentNodeData,
  Assignment,
  OrchestrationEvent,
  ProjectGraph,
  ResumableRun,
  RunTask,
  StepStatus,
  TaskVerdict
} from '../shared/types'

export type TerminalMode = 'interactive' | 'headless'

export type ConfirmOpts = { title: string; body: string; confirmLabel?: string; danger?: boolean }

export interface TerminalTab {
  id: string
  agentId: string
  agentName: string
  mode: TerminalMode
}

export interface RunState {
  runId: string | null
  running: boolean
  goal: string
  orchestratorId: string | null
  nodeStatus: Record<string, StepStatus>
  nodeTasks: Record<string, string[]>
  plan: RunTask[]
  assignments: Record<string, Assignment[]>
  verdict: Record<string, TaskVerdict>
  reviewAttempt: number
  replans: { attempt: number; reason: string }[]
  handoffs: { askerId: string; peerId: string; ask: string }[]
  userRequests: { askerId: string; question: string }[]
  pendingInterrupt: { question: string; askerName: string; askerId: string } | null
  interruptMinimized: boolean
  memoryUpdated: Record<string, number>
  final: string
  error?: string
  selectedStepId: string | null
}

const emptyRun: RunState = {
  runId: null,
  running: false,
  goal: '',
  orchestratorId: null,
  nodeStatus: {},
  nodeTasks: {},
  plan: [],
  assignments: {},
  verdict: {},
  reviewAttempt: 0,
  replans: [],
  handoffs: [],
  userRequests: [],
  pendingInterrupt: null,
  interruptMinimized: false,
  memoryUpdated: {},
  final: '',
  error: undefined,
  selectedStepId: null
}

interface AppState {
  graph: ProjectGraph | null
  selectedAgentId: string | null
  terminals: TerminalTab[]
  activeDockId: string | null
  run: RunState
  showRunView: boolean
  showHistory: boolean

  setGraph: (g: ProjectGraph | null) => void
  patchPositions: (list: { id: string; position: { x: number; y: number } }[]) => void
  select: (id: string | null) => void
  openTerminal: (agent: AgentNodeData, mode: TerminalMode) => void
  closeTerminal: (id: string) => void
  setActiveDock: (id: string) => void

  beginRun: (runId: string, goal: string, orchestratorId: string) => void
  applyOrchestration: (e: OrchestrationEvent) => void
  selectStep: (id: string) => void
  answerInterrupt: (answer: string) => void
  minimizeInterrupt: (v: boolean) => void
  setShowRunView: (v: boolean) => void
  openHistory: () => void

  agentById: (id: string) => AgentNodeData | undefined

  confirm: { opts: ConfirmOpts; resolve: (v: boolean) => void } | null
  requestConfirm: (opts: ConfirmOpts) => Promise<boolean>
  resolveConfirm: (v: boolean) => void

  resumable: ResumableRun[]
  resumableDismissed: boolean
  refreshResumable: (resetDismissed?: boolean) => Promise<void>
  resumeResumable: (runId: string) => void
  discardResumable: (runId: string) => Promise<void>
  dismissResumableBanner: () => void

  toasts: Toast[]
  notify: (input: { kind: Toast['kind']; message: string }) => string
  dismissToast: (id: string) => void

  layout: LayoutState
  layoutProjectPath: string | null
  loadLayout: (projectPath: string) => void
  setZoneSize: (zone: 'inspector' | 'dock', px: number, viewportH: number) => void
  toggleZoneCollapsed: (zone: 'inspector' | 'dock') => void
  setZonePlacement: (zone: 'inspector' | 'dock', placement: string) => void
}

let counter = 0

function persistLayout(projectPath: string | null, layout: LayoutState): void {
  if (projectPath) localStorage.setItem(`orkestr:layout:${projectPath}`, serializeLayout(layout))
}

export const useStore = create<AppState>((set, get) => ({
  graph: null,
  selectedAgentId: null,
  terminals: [],
  activeDockId: null,
  run: emptyRun,
  showRunView: false,
  showHistory: false,
  resumable: [],
  resumableDismissed: false,

  layout: DEFAULT_LAYOUT,
  layoutProjectPath: null,

  loadLayout: (projectPath) =>
    set((s) => {
      if (s.layoutProjectPath === projectPath) return {}
      const raw = localStorage.getItem(`orkestr:layout:${projectPath}`)
      return { layout: parseLayout(raw), layoutProjectPath: projectPath }
    }),

  setZoneSize: (zone, px, viewportH) =>
    set((s) => {
      const layout: LayoutState = { ...s.layout, [zone]: { ...s.layout[zone] } }
      if (zone === 'inspector') layout.inspector.size = clampInspector(px)
      else layout.dock.size = s.layout.dock.placement === 'right' ? clampDockWidth(px) : clampDockHeight(px, viewportH)
      persistLayout(s.layoutProjectPath, layout)
      return { layout }
    }),

  toggleZoneCollapsed: (zone) =>
    set((s) => {
      const layout: LayoutState = { ...s.layout, [zone]: { ...s.layout[zone], collapsed: !s.layout[zone].collapsed } }
      persistLayout(s.layoutProjectPath, layout)
      return { layout }
    }),

  setZonePlacement: (zone, placement) =>
    set((s) => {
      const layout: LayoutState = { ...s.layout, [zone]: { ...s.layout[zone], placement: placement as never } }
      persistLayout(s.layoutProjectPath, layout)
      return { layout }
    }),

  setGraph: (g) => set({ graph: g }),

  patchPositions: (list) =>
    set((s) => {
      if (!s.graph) return {}
      const map = new Map(list.map((p) => [p.id, p.position]))
      return {
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) =>
            map.has(n.id) ? { ...n, position: map.get(n.id)! } : n
          )
        }
      }
    }),

  select: (id) => set({ selectedAgentId: id }),

  openTerminal: (agent, mode) =>
    set((s) => {
      const id = `term-${++counter}`
      const tab: TerminalTab = { id, agentId: agent.id, agentName: agent.name, mode }
      const activeDockId = activeDockAfterOpenTerminal({
        running: s.run.running,
        currentActive: s.activeDockId,
        newTermId: id
      })
      return { terminals: [...s.terminals, tab], activeDockId }
    }),

  closeTerminal: (id) =>
    set((s) => {
      const terminals = s.terminals.filter((t) => t.id !== id)
      const fallback = terminals.at(-1)?.id ?? (s.showRunView ? 'run' : null)
      const activeDockId = s.activeDockId === id ? fallback : s.activeDockId
      return { terminals, activeDockId }
    }),

  setActiveDock: (id) => set({ activeDockId: id }),

  beginRun: (runId, goal, orchestratorId) =>
    set({
      run: {
        ...emptyRun,
        runId,
        running: true,
        goal,
        orchestratorId,
        nodeStatus: { [orchestratorId]: 'planning' },
        selectedStepId: orchestratorId
      },
      showRunView: true,
      activeDockId: 'run'
    }),

  applyOrchestration: (e) =>
    set((s) => {
      const run = { ...s.run }
      switch (e.type) {
        case 'run-started':
          return {
            run: {
              ...emptyRun,
              runId: e.runId,
              running: true,
              goal: e.goal,
              orchestratorId: e.orchestratorId,
              nodeStatus: { [e.orchestratorId]: 'planning' },
              selectedStepId: e.orchestratorId
            },
            showRunView: true,
            activeDockId: 'run'
          }
        case 'status':
          run.nodeStatus = { ...run.nodeStatus, [e.nodeId]: e.status }
          if (e.taskTitles) run.nodeTasks = { ...run.nodeTasks, [e.nodeId]: e.taskTitles }
          if (e.status === 'planning' || e.status === 'assigning' || e.status === 'working') {
            run.selectedStepId = e.nodeId
          }
          return { run }
        case 'plan':
          run.plan = e.tasks
          return { run }
        case 'assignments':
          run.assignments = { ...run.assignments, [e.nodeId]: e.assignments }
          return { run }
        case 'verdict': {
          const verdict = { ...run.verdict }
          for (const t of e.tasks) verdict[t.taskId] = t
          run.verdict = verdict
          run.reviewAttempt = e.attempt
          return { run }
        }
        case 'replan':
          run.plan = e.tasks
          run.replans = [...run.replans, { attempt: e.attempt, reason: e.reason }]
          return { run }
        case 'handoff':
          run.handoffs = [...run.handoffs, { askerId: e.askerId, peerId: e.peerId, ask: e.ask }]
          return { run }
        case 'interrupt': {
          const pl = e.interrupt.payload as { askerId: string; askerName: string; question: string } | undefined
          run.pendingInterrupt = pl
            ? { question: pl.question, askerName: pl.askerName, askerId: pl.askerId }
            : { question: e.interrupt.prompt, askerName: 'Agent', askerId: '' }
          run.interruptMinimized = false
          run.userRequests = [...run.userRequests, { askerId: run.pendingInterrupt.askerId, question: run.pendingInterrupt.question }]
          return { run }
        }
        case 'reflection':
          run.memoryUpdated = { ...run.memoryUpdated, [e.nodeId]: e.lessons.length }
          return { run }
        case 'final':
          run.final = e.text
          return { run }
        case 'run-finished':
          run.running = false
          run.error = e.error
          return { run }
        default:
          return {}
      }
    }),

  selectStep: (id) => set((s) => ({ run: { ...s.run, selectedStepId: id } })),
  answerInterrupt: (answer) =>
    set((s) => {
      const runId = s.run.runId
      if (runId) void window.api.resumeRun(runId, answer)
      return { run: { ...s.run, pendingInterrupt: null, interruptMinimized: false } }
    }),
  minimizeInterrupt: (v) => set((s) => ({ run: { ...s.run, interruptMinimized: v } })),
  setShowRunView: (v) => set({ showRunView: v }),
  openHistory: () => set({ showHistory: true, activeDockId: 'history' }),

  agentById: (id) => get().graph?.nodes.find((n) => n.id === id),

  confirm: null,
  requestConfirm: (opts) =>
    new Promise<boolean>((resolve) => {
      get().confirm?.resolve(false) // cancel any already-pending confirm before replacing it
      set({ confirm: { opts, resolve } })
    }),
  resolveConfirm: (v) => {
    const c = get().confirm
    if (c) {
      c.resolve(v)
      set({ confirm: null })
    }
  },

  refreshResumable: async (resetDismissed = false) => {
    const resumable = await window.api.listResumable()
    set(resetDismissed ? { resumable, resumableDismissed: false } : { resumable })
  },
  resumeResumable: (runId) =>
    set((s) => {
      void window.api.resumeRun(runId) // no answer → crash-recovery resume
      return {
        resumable: s.resumable.filter((r) => r.runId !== runId),
        showRunView: true,
        showHistory: false,
        activeDockId: 'run'
      }
    }),
  discardResumable: async (runId) => {
    await window.api.discardRun(runId)
    set({ resumable: await window.api.listResumable() })
  },
  dismissResumableBanner: () => set({ resumableDismissed: true }),

  toasts: [],
  notify: ({ kind, message }) => {
    const toast: Toast = { id: crypto.randomUUID(), kind, message, createdAt: Date.now() }
    set((s) => ({ toasts: addToast(s.toasts, toast) }))
    return toast.id
  },
  dismissToast: (id) => set((s) => ({ toasts: removeToast(s.toasts, id) })),
}))
