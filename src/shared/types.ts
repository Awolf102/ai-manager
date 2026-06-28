// Shared types + IPC contract. MUST stay free of node/DOM-only imports so both
// the main and renderer processes can import it.

export type AgentKind = 'orchestrator' | 'manager' | 'worker'

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto'

/** One agent the orchestrator proposes when building a team. `reportsTo` is another
 *  member's temp `id` or the literal "orchestrator" (cycle-free after parsing). */
export interface SpawnedMember {
  id: string
  name: string
  kind: 'manager' | 'worker'
  role: string
  reportsTo: string
  model?: string
  skills?: string[]
}

/** A skill offered by a trusted installed plugin (discovered from ~/.claude/plugins). */
export interface DiscoveredSkill {
  id: string // plugin-qualified id passed to the SDK `skills` option, e.g. 'data:airflow'
  name: string
  description: string
}

/** A trusted installed plugin and its skills, resolved to an on-disk path. */
export interface DiscoveredPlugin {
  id: string // plugin name (the `skills` prefix)
  marketplace: string // marketplace name it came from
  marketplaceRepo: string // the marketplace's GitHub repo (e.g. 'anthropics/...')
  author: string // publisher (marketplace_entry.author.name), '' if unknown
  uniqueInstalls: number // 0 if unknown
  trusted: boolean // always true for surfaced plugins (kept for clarity)
  path: string // on-disk plugin dir containing skills/
  skills: DiscoveredSkill[]
}

export interface AgentNodeData {
  id: string
  name: string
  /** filesystem-safe slug used for .ai-manager/agents/<slug>/ */
  slug: string
  kind: AgentKind
  /** icon key resolved from the name; the renderer maps it to a lucide icon */
  icon: string
  model: string
  permissionMode: PermissionMode
  /** plugin-qualified skill ids this agent may use (see shared/skill-trust) */
  skills?: string[]
  /** last Claude Code session id captured from a headless run (for --resume) */
  sessionId?: string
  /** stable team-member identity that survives export/import (used by the portable-team feature) */
  memberId?: string
  position: { x: number; y: number }
}

export interface GraphEdge {
  id: string
  /** "delegates to": source delegates work to target */
  source: string
  target: string
  /** 1..N execution sequence; consumed only on edges whose source is the run's orchestrator */
  order?: number
  /** edge role: absent/'report' = the reporting tree (routing/order/review); 'handoff' = a lateral consult line (Phase 3) */
  kind?: 'report' | 'handoff'
}

export interface ProjectMeta {
  path: string
  name: string
}

export type ReviewMode = 'none' | 'once' | 'loop'

/** Permission level for the acting steps during an orchestration run. */
export type Autonomy = 'auto' | 'full' | 'cautious'

/** Reasoning-effort level the manager can assign per task (maps to the SDK `effort`). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** Ordered low→max so the engine can pick the highest in a worker's batch. */
export const EFFORT_LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface ProjectSettings {
  /** 'none' = review→memory only, 'once' = +1 repair pass, 'loop' = repair loop */
  reviewMode: ReviewMode
  /** repair attempts when reviewMode === 'loop' */
  maxRepairAttempts: number
  /** write reflections to memory.md after a run */
  reflection: boolean
  /** 'auto' = run safe commands, 'full' = bypass all checks, 'cautious' = edits only */
  autonomy: Autonomy
  /** manager assesses task difficulty and assigns a reasoning effort per task */
  adaptiveEffort: boolean
  /** orchestrator picks each spawned worker's model tier at team build (off = static default) */
  autoAssignModels: boolean
  /** auto pull the linked team brain before a run + push after (B2b) */
  autoSyncTeam: boolean
  /** install-count floor for trusting a non-Anthropic plugin's skills */
  skillInstallThreshold: number
  /** load the always-available curated skills pack for every agent */
  skillsPackEnabled: boolean
  /** override the skills-pack dir; empty = ~/.ai-manager/skills-pack */
  skillsPackPath: string
  /** max proactive mid-run re-plans the orchestrator may perform (0 = off) */
  maxReplans: number
  /** max lateral peer consults a single agent-run may make (0 = off) */
  maxHandoffs: number
  /** max times a worker may pause the run to ask the user a question (0 = off) */
  maxUserRequests: number
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  reviewMode: 'loop',
  maxRepairAttempts: 3,
  reflection: true,
  autonomy: 'auto',
  adaptiveEffort: true,
  autoAssignModels: false,
  autoSyncTeam: false,
  skillInstallThreshold: 100000,
  skillsPackEnabled: true,
  skillsPackPath: '',
  maxReplans: 0,
  maxHandoffs: 0,
  maxUserRequests: 0
}

/** A user-attached reference file (image/doc) for the project, available to every agent. */
export interface ContextFile {
  id: string // randomUUID — React key + update/remove handle
  fileName: string // name AS STORED under .ai-manager/context/ (collision-uniquified)
  note: string // optional user note ('' when none)
  addedAt: string // ISO timestamp
  bytes: number // file size, for display
  isImage: boolean // precomputed from the extension
}

export interface ProjectGraph {
  project: ProjectMeta
  nodes: AgentNodeData[]
  edges: GraphEdge[]
  settings: ProjectSettings
  /** the team brain this project syncs portable lessons with (B2 living team) */
  linkedTeam?: { teamId: string; path: string }
  /** user-attached reference files (images/docs) for this project, given to every agent */
  context?: ContextFile[]
}

// ---- IPC payloads ----

export interface CreateAgentInput {
  name: string
  kind: AgentKind
  model?: string
  permissionMode?: PermissionMode
  position?: { x: number; y: number }
}

export interface RunHeadlessInput {
  agentId: string
  prompt: string
  /** resume the agent's prior session if one exists */
  resume?: boolean
}

export interface SpawnPtyInput {
  agentId: string
  cols: number
  rows: number
  /** resume the agent's prior session if one exists */
  resume?: boolean
}

/** A normalized stream chunk emitted from a headless agent run. */
export interface AgentStreamEvent {
  agentId: string
  runId: string
  /** orchestration step this output belongs to (absent for manual runs) */
  stepId?: string
  kind: 'system' | 'assistant' | 'tool_use' | 'tool_result' | 'result' | 'error' | 'stderr'
  /** text already formatted (with ANSI ok) for a terminal pane */
  text: string
  /** present on the final 'result' event */
  sessionId?: string
  isFinal?: boolean
  /** plain-English narration of a tool call (set only on 'tool_use' events) */
  narration?: string
}

export interface PtyDataEvent {
  ptyId: string
  data: string
}

export interface PtyExitEvent {
  ptyId: string
  exitCode: number
}

export interface AuthStatus {
  state: 'ok' | 'logged-out' | 'no-cli' | 'error'
  message?: string
}

// ---- orchestration (Phase 2) ----

export type StepStatus =
  | 'idle'
  | 'planning'
  | 'assigning'
  | 'working'
  | 'reviewing'
  | 'reflecting'
  | 'done'
  | 'error'
  | 'skipped'

export interface TaskVerdict {
  taskId: string
  /** the worker that owns this task, or null if unassigned */
  nodeId: string | null
  verdict: 'pass' | 'fail'
  feedback: string
}

export interface RunTask {
  id: string
  title: string
  description: string
}

export interface Assignment {
  taskId: string
  /** a direct child agent id, or null = no matching child (unassigned) */
  childId: string | null
  /** reasoning effort the manager assigned by assessing the task's difficulty */
  effort?: Effort
  /** the manager's pre-clamp requested effort, recorded only when it was capped to the model */
  assignedEffort?: Effort
  reason: string
}

export interface StartRunInput {
  goal: string
  orchestratorId: string
}

export type RunStatus = 'completed' | 'cancelled' | 'error'

/** Events streamed from the orchestration engine to the renderer. */
export type OrchestrationEvent =
  | { runId: string; type: 'run-started'; orchestratorId: string; goal: string }
  | { runId: string; type: 'status'; nodeId: string; status: StepStatus; taskTitles?: string[] }
  | { runId: string; type: 'plan'; nodeId: string; tasks: RunTask[] }
  | { runId: string; type: 'assignments'; nodeId: string; assignments: Assignment[] }
  | { runId: string; type: 'verdict'; attempt: number; tasks: TaskVerdict[] }
  | { runId: string; type: 'replan'; attempt: number; reason: string; tasks: RunTask[] }
  | { runId: string; type: 'handoff'; askerId: string; peerId: string; ask: string }
  | { runId: string; type: 'interrupt'; interrupt: Interrupt }
  | {
      runId: string
      type: 'reflection'
      nodeId: string
      win: string
      loss: string
      lessons: string[]
    }
  | { runId: string; type: 'final'; text: string }
  | { runId: string; type: 'run-finished'; status: RunStatus; error?: string }

export interface RunStepRecord {
  nodeId: string
  nodeName: string
  kind: AgentKind
  status: StepStatus
  tasks?: RunTask[]
  assignments?: Assignment[]
  output?: string
}

export interface RunRecord {
  runId: string
  goal: string
  orchestratorId: string
  startedAt: string
  finishedAt: string
  status: RunStatus
  plan: RunTask[]
  steps: RunStepRecord[]
  reviews: { attempt: number; tasks: TaskVerdict[] }[]
  reflections: { nodeId: string; win: string; loss: string; lessons: string[] }[]
  replans?: { attempt: number; reason: string }[]
  handoffs?: { askerId: string; peerId: string; ask: string }[]
  userRequests?: { askerId: string; question: string }[]
  final: string
  error?: string
}

export interface RunSummary {
  file: string
  goal: string
  startedAt: string
  status: RunStatus
  taskCount: number
}

/** How to launch + open the app the agents built. Produced by the detection
 *  agent, edited in the preview, replayed by the server runtime. */
export interface RunManifest {
  type: 'web' | 'static' | 'cli' | 'library' | 'unknown'
  startCommand: string
  port?: number
  path?: string
  notes?: string
}

export type ServerStatus = 'starting' | 'running' | 'exited' | 'error'
export interface ServerLogEvent {
  serverId: string
  data: string
}
export interface ServerStatusEvent {
  serverId: string
  status: ServerStatus
}
export interface ServerReadyEvent {
  serverId: string
  url: string
}

// ---- durable run state (checkpointing) ----

export type RunPhase =
  | 'planning'
  | 'routing'
  | 'executing'
  | 'reviewing'
  | 'repairing'
  | 'replanning'
  | 'reflecting'
  | 'synthesizing'
  | 'done'

/** Live status of an in-flight or finished run (a superset of RunStatus). */
export type LiveRunStatus = 'running' | 'interrupted' | 'completed' | 'cancelled' | 'error'

export type TaskExecStatus = 'pending' | 'running' | 'done' | 'failed' | 'passed'

/** A request to pause the run for human input (Stage 3 — the runtime carries it now). */
export interface Interrupt {
  kind: string
  prompt: string
  payload?: unknown
}

export interface TaskState {
  task: RunTask
  /** worker that owns this task, or null if unassigned */
  ownerId: string | null
  status: TaskExecStatus
  /** times a worker has run this task (initial run + repairs) */
  attempts: number
  /** latest worker output for the task */
  output: string
  /** review outcome; `disposition` (fail only) = 'repair' (buggy, re-run) | 'replan' (mis-scoped, re-break-up). Default 'repair'. */
  verdict?: { verdict: 'pass' | 'fail'; feedback: string; disposition?: 'repair' | 'replan' }
  /** reasoning effort assigned by the routing manager (maps to the SDK `effort`) */
  effort?: Effort
  /** task ids that must finish first (Stage 4 — unused in Stage 1) */
  dependsOn?: string[]
  /** Phase-1 ordered-stage of this task (0/undefined = unordered); set in routeNode */
  stage?: number
}

/**
 * The full, serializable state of an orchestration run. Written to a checkpoint
 * after every transition so a run survives a crash and can later be resumed.
 * A superset of RunRecord (which is the read-only History projection).
 */
export interface RunState {
  runId: string
  goal: string
  orchestratorId: string
  startedAt: string
  updatedAt: string
  status: LiveRunStatus
  phase: RunPhase
  /** resume pointer — coarse phase marker now, the graph node in Stage 2 */
  cursor: string
  actingMode: PermissionMode
  plan: RunTask[]
  /** taskId -> per-task execution state */
  tasks: Record<string, TaskState>
  /** nodeId -> run-view step record */
  steps: Record<string, RunStepRecord>
  reviews: { attempt: number; tasks: TaskVerdict[] }[]
  reflections: { nodeId: string; win: string; loss: string; lessons: string[] }[]
  repairAttempts: number
  /** proactive re-plans performed this run (bounds the outer loop) */
  replanAttempts: number
  /** highest ordered-stage boundary already offered for re-plan (ask-once) */
  replanStageCursor: number
  /** one entry per performed re-plan, for the Run view + History */
  replans?: { attempt: number; reason: string }[]
  /** lateral peer consults performed this run, for the Run view + History */
  handoffs?: { askerId: string; peerId: string; ask: string }[]
  /** asks the user made this run, recorded for the run view + History (questions only — never answers) */
  userRequests?: { askerId: string; question: string }[]
  /** bounds worker→user questions this run (mirrors replanAttempts) */
  userRequestCount: number
  /** the worker waiting on a user answer; carries its session id across resume (never the answer) */
  pendingAsk?: { ownerId: string; taskIds: string[]; sessionId?: string; question: string }
  final: string
  error?: string
  /** set when the run paused for human input (Stage 3) */
  pendingInterrupt?: Interrupt
  /** human decision injected on resume; the paused node reads then clears it (Stage 3) */
  resumeInput?: unknown
}

// ---- constants ----

export const MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }
] as const

export const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'auto'
]

export const AGENT_KINDS: AgentKind[] = ['orchestrator', 'manager', 'worker']

export const DEFAULT_MODEL_BY_KIND: Record<AgentKind, string> = {
  orchestrator: 'claude-opus-4-8',
  manager: 'claude-opus-4-8',
  worker: 'claude-sonnet-4-6'
}

/** Channel names — single source of truth for main + preload. */
export const IPC = {
  pickProjectFolder: 'project:pick',
  openProject: 'project:open',
  getRecentProjects: 'project:recents',
  createAgent: 'agent:create',
  updateAgent: 'agent:update',
  deleteAgent: 'agent:delete',
  setEdges: 'graph:setEdges',
  setNodePositions: 'graph:setPositions',
  updateSettings: 'settings:update',
  readRole: 'role:read',
  writeRole: 'role:write',
  readMemory: 'memory:read',
  writeMemory: 'memory:write',
  runHeadless: 'run:headless',
  cancelHeadless: 'run:cancel',
  agentStream: 'run:stream',
  spawnPty: 'pty:spawn',
  writePty: 'pty:write',
  resizePty: 'pty:resize',
  killPty: 'pty:kill',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  startRun: 'run:start',
  stopRun: 'run:stop',
  resumeRun: 'run:resume',
  orchestration: 'run:orchestration',
  checkAuth: 'auth:check',
  listRuns: 'runs:list',
  loadRun: 'runs:load',
  exportTeam: 'team:export',
  importTeam: 'team:import',
  syncTeam: 'team:syncTo',
  refreshTeam: 'team:refreshFrom',
  draftRoles: 'roles:draft',
  spawnTeam: 'team:spawn',
  applySpawn: 'team:applySpawn',
  detectManifest: 'manifest:detect',
  launchServer: 'server:launch',
  stopServer: 'server:stop',
  openPath: 'app:openPath',
  serverLog: 'server:log',
  serverStatus: 'server:status',
  serverReady: 'server:ready',
  addContext: 'context:add',
  updateContext: 'context:update',
  removeContext: 'context:remove',
  contextThumbnail: 'context:thumbnail',
  listSkills: 'skills:list'
} as const

/** The typed API the preload bridge exposes on window.api. */
export interface RendererApi {
  pickProjectFolder: () => Promise<ProjectGraph | null>
  openProject: (path: string) => Promise<ProjectGraph | null>
  getRecentProjects: () => Promise<ProjectMeta[]>
  createAgent: (input: CreateAgentInput) => Promise<ProjectGraph>
  updateAgent: (agent: Partial<AgentNodeData> & { id: string }) => Promise<ProjectGraph>
  deleteAgent: (agentId: string) => Promise<ProjectGraph>
  setEdges: (edges: GraphEdge[]) => Promise<ProjectGraph>
  setNodePositions: (positions: { id: string; position: { x: number; y: number } }[]) => Promise<void>
  updateSettings: (patch: Partial<ProjectSettings>) => Promise<ProjectGraph>
  readRole: (agentId: string) => Promise<string>
  writeRole: (agentId: string, content: string) => Promise<void>
  readMemory: (agentId: string) => Promise<string>
  writeMemory: (agentId: string, content: string) => Promise<void>
  runHeadless: (input: RunHeadlessInput) => Promise<{ runId: string }>
  cancelHeadless: (runId: string) => Promise<void>
  onAgentStream: (cb: (e: AgentStreamEvent) => void) => () => void
  spawnPty: (input: SpawnPtyInput) => Promise<{ ptyId: string }>
  writePty: (ptyId: string, data: string) => void
  resizePty: (ptyId: string, cols: number, rows: number) => void
  killPty: (ptyId: string) => void
  onPtyData: (cb: (e: PtyDataEvent) => void) => () => void
  onPtyExit: (cb: (e: PtyExitEvent) => void) => () => void
  startRun: (input: StartRunInput) => Promise<{ runId: string }>
  stopRun: (runId: string) => Promise<void>
  resumeRun: (runId: string, answer: string) => Promise<void>
  onOrchestration: (cb: (e: OrchestrationEvent) => void) => () => void
  checkAuth: () => Promise<AuthStatus>
  listRuns: () => Promise<RunSummary[]>
  loadRun: (file: string) => Promise<RunRecord | null>
  exportTeam: () => Promise<{ saved: boolean; path?: string }>
  importTeam: () => Promise<{ imported: boolean; graph?: ProjectGraph; error?: string }>
  syncToTeam: () => Promise<{ synced: boolean; graph?: ProjectGraph; teamPath?: string }>
  refreshFromTeam: () => Promise<{ refreshed: boolean; graph?: ProjectGraph; updated?: number; error?: string }>
  draftRoles: (input: { goal: string; orchestratorId: string }) => Promise<{
    ok: boolean
    drafts?: { agentId: string; name: string; role: string; skills?: string[] }[]
    error?: string
  }>
  spawnTeam: (input: { goal: string; orchestratorId: string }) => Promise<{
    ok: boolean
    members?: SpawnedMember[]
    error?: string
  }>
  applySpawnedTeam: (input: { members: SpawnedMember[]; orchestratorId: string }) => Promise<ProjectGraph>,
  detectManifest: (input: { goal: string; orchestratorId: string }) => Promise<{
    ok: boolean
    manifest?: RunManifest
    error?: string
  }>
  launchServer: (input: { startCommand: string; port?: number; path?: string }) => Promise<{ serverId: string }>
  stopServer: (serverId: string) => void
  openProjectPath: () => void
  addContext: (paths?: string[]) => Promise<{ graph: ProjectGraph; skipped: string[] }>
  updateContext: (id: string, note: string) => Promise<ProjectGraph>
  removeContext: (id: string) => Promise<ProjectGraph>
  contextThumbnail: (id: string) => Promise<string | null>
  getPathForFile: (file: File) => string
  listSkills: () => Promise<DiscoveredPlugin[]>
  onServerLog: (cb: (e: ServerLogEvent) => void) => () => void
  onServerStatus: (cb: (e: ServerStatusEvent) => void) => () => void
  onServerReady: (cb: (e: ServerReadyEvent) => void) => () => void
}
