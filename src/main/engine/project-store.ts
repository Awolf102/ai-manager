import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AgentKind,
  AgentNodeData,
  CreateAgentInput,
  GraphEdge,
  ProjectGraph,
  ProjectMeta,
  ProjectSettings,
  RunRecord,
  RunSummary
} from '../../shared/types'
import { DEFAULT_MODEL_BY_KIND, DEFAULT_SETTINGS } from '../../shared/types'
import { iconForName } from '../../shared/icons'

const AIM_DIR = '.ai-manager'
const GRAPH_FILE = 'graph.json'
const AGENTS_DIR = 'agents'

let current: { path: string; graph: ProjectGraph } | null = null

// ---------- paths ----------

function aimPath(projectPath: string, ...parts: string[]): string {
  return join(projectPath, AIM_DIR, ...parts)
}

function requireCurrent(): { path: string; graph: ProjectGraph } {
  if (!current) throw new Error('No project is open')
  return current
}

export function getCurrentProjectPath(): string {
  return requireCurrent().path
}

export function getAgent(agentId: string): AgentNodeData {
  const { graph } = requireCurrent()
  const agent = graph.nodes.find((n) => n.id === agentId)
  if (!agent) throw new Error(`Unknown agent: ${agentId}`)
  return agent
}

// ---------- slug helpers ----------

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
  )
}

function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = base
  let i = 2
  while (taken.has(slug)) slug = `${base}-${i++}`
  return slug
}

// ---------- templates ----------

function roleTemplate(name: string, kind: AgentKind): string {
  if (kind === 'orchestrator') {
    return `# Role: ${name} (Orchestrator)

You are the **lead manager** for this project — the top of the chain of command.

## Responsibilities
- Take the user's **goal** and turn it into a clear, ordered plan that, if executed, achieves the goal.
- Verify the plan actually matches the goal before delegating.
- Hand the plan down to your manager(s).
- When work comes back up the chain, **review it against the plan and the goal**. Decide pass/fail and give specific, actionable feedback.

## How you work
- Be concrete: break the goal into tasks a specialist could pick up and finish.
- Prefer the simplest plan that fully satisfies the goal. Cut anything that doesn't serve it.
- If a task genuinely cannot start until another finishes (e.g. the UI needs the API first), mark that dependency so the work runs in the right order — but keep dependencies minimal.
- When reviewing, check correctness first, then completeness against the plan.

## Constraints
- You operate inside this one project folder. All work happens here.
- Your job is plan + review — don't do the workers' implementation yourself unless explicitly asked.
`
  }
  if (kind === 'manager') {
    return `# Role: ${name} (Manager)

You are a **manager** — between the orchestrator and the workers.

## Responsibilities
- Receive the plan (or part of it) from the orchestrator.
- Read the **role** and **track record** (the lessons each worker has recorded from past work) of every worker that reports to you.
- Assign each task to the worker whose role best matches it. When more than one role fits, prefer the worker whose track record shows the most relevant, reliable experience. If no worker's role matches a task, leave it unassigned and report that upward.
- **Assess each task's difficulty and assign a reasoning effort level** (low / medium / high / xhigh / max) to the worker who will do it — harder tasks get more effort; reserve xhigh/max for genuinely hard tasks (they cost more).
- Collect the workers' output and pass it up to the orchestrator for review.

## How you work
- Match tasks to roles literally — don't hand a database task to a UI specialist.
- Keep the orchestrator informed about what was assigned, to whom, and what is blocked.

## Constraints
- You operate inside this one project folder.
- You route and coordinate; the workers do the heavy implementation.
`
  }
  return `# Role: ${name} (Worker)

You are a **specialist worker** — you do the actual implementation.

## Specialty
<!-- Describe what this agent is great at, e.g. databases & data pipelines,
backend systems, or UI/visual design. Edit this to match the role you intend. -->
General-purpose specialist. Edit this section to define your focus.

## Responsibilities
- Accept tasks from your manager that match your specialty.
- Implement them well inside this project folder.
- Report what you did, and flag anything you could not finish.

## How you work
- Before starting, read your memory file for lessons from past tasks and apply them.
- Do the simplest thing that fully solves the task; verify your own work where you can.
- If you build anything that serves a web page, **verify it actually renders** — run it and confirm the entry page and every asset it references (CSS/JS/images) return 200, not just that unit tests pass. A static-path mismatch that 404s assets renders the page unstyled even when the code is correct.

## Constraints
- Only take on tasks that match your specialty. If a task doesn't fit your role, say so rather than attempting it.
`
}

function memoryTemplate(name: string): string {
  return `# Memory: ${name}

This is your persistent brain. Read it before each task and learn from it. After a
task, record what worked and what didn't so you don't repeat mistakes.

## Lessons
<!-- One bullet per lesson. Keep the sharpest, most reusable insights here. -->
- (none yet)

## Task log
<!-- Newest first. For each task: what you attempted, the outcome, wins, and losses. -->
`
}

// ---------- graph io ----------

async function saveGraph(): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  await fs.mkdir(aimPath(path), { recursive: true })
  await fs.writeFile(aimPath(path, GRAPH_FILE), JSON.stringify(graph, null, 2), 'utf8')
  return graph
}

async function ensureScaffold(projectPath: string): Promise<void> {
  await fs.mkdir(aimPath(projectPath, AGENTS_DIR), { recursive: true })
}

export async function openProject(projectPath: string): Promise<ProjectGraph> {
  await ensureScaffold(projectPath)
  const graphFile = aimPath(projectPath, GRAPH_FILE)
  let graph: ProjectGraph
  if (existsSync(graphFile)) {
    graph = JSON.parse(await fs.readFile(graphFile, 'utf8')) as ProjectGraph
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
  // apply settings defaults for graphs created before this field existed
  graph.settings = { ...DEFAULT_SETTINGS, ...(graph.settings ?? {}) }
  current = { path: projectPath, graph }
  await saveGraph()
  await addRecent(graph.project)
  return graph
}

// ---------- agents ----------

function nextPosition(graph: ProjectGraph): { x: number; y: number } {
  const n = graph.nodes.length
  return { x: 120 + (n % 4) * 240, y: 120 + Math.floor(n / 4) * 160 }
}

export async function createAgent(input: CreateAgentInput): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const taken = new Set(graph.nodes.map((n) => n.slug))
  const slug = uniqueSlug(slugify(input.name), taken)
  const agent: AgentNodeData = {
    id: randomUUID(),
    name: input.name,
    slug,
    kind: input.kind,
    icon: iconForName(input.name, input.kind),
    model: input.model ?? DEFAULT_MODEL_BY_KIND[input.kind],
    permissionMode: input.permissionMode ?? 'acceptEdits',
    position: input.position ?? nextPosition(graph)
  }

  const dir = aimPath(path, AGENTS_DIR, slug)
  await fs.mkdir(dir, { recursive: true })
  const rolePath = join(dir, 'role.md')
  const memPath = join(dir, 'memory.md')
  if (!existsSync(rolePath)) await fs.writeFile(rolePath, roleTemplate(input.name, input.kind), 'utf8')
  if (!existsSync(memPath)) await fs.writeFile(memPath, memoryTemplate(input.name), 'utf8')

  graph.nodes.push(agent)
  return saveGraph()
}

export async function updateAgent(
  partial: Partial<AgentNodeData> & { id: string }
): Promise<ProjectGraph> {
  const { graph } = requireCurrent()
  const node = graph.nodes.find((n) => n.id === partial.id)
  if (!node) throw new Error(`Unknown agent: ${partial.id}`)
  const merged: AgentNodeData = { ...node, ...partial, slug: node.slug } // slug is stable
  // recompute icon from the name unless the caller explicitly set one
  if (partial.name !== undefined && partial.icon === undefined) {
    merged.icon = iconForName(merged.name, merged.kind)
  }
  Object.assign(node, merged)
  return saveGraph()
}

export async function deleteAgent(agentId: string): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const node = graph.nodes.find((n) => n.id === agentId)
  if (!node) return graph
  graph.nodes = graph.nodes.filter((n) => n.id !== agentId)
  graph.edges = graph.edges.filter((e) => e.source !== agentId && e.target !== agentId)
  // remove the agent's app-managed folder
  await fs.rm(aimPath(path, AGENTS_DIR, node.slug), { recursive: true, force: true })
  return saveGraph()
}

export async function setEdges(edges: GraphEdge[]): Promise<ProjectGraph> {
  const { graph } = requireCurrent()
  const ids = new Set(graph.nodes.map((n) => n.id))
  graph.edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  return saveGraph()
}

export async function setNodePositions(
  positions: { id: string; position: { x: number; y: number } }[]
): Promise<void> {
  const { graph } = requireCurrent()
  for (const p of positions) {
    const node = graph.nodes.find((n) => n.id === p.id)
    if (node) node.position = p.position
  }
  await saveGraph()
}

// ---------- role / memory files ----------

function agentDir(agentId: string): string {
  const { path } = requireCurrent()
  return aimPath(path, AGENTS_DIR, getAgent(agentId).slug)
}

async function readFileOr(filePath: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return fallback
  }
}

export async function readRole(agentId: string): Promise<string> {
  return readFileOr(join(agentDir(agentId), 'role.md'), '')
}

export async function writeRole(agentId: string, content: string): Promise<void> {
  await fs.mkdir(agentDir(agentId), { recursive: true })
  await fs.writeFile(join(agentDir(agentId), 'role.md'), content, 'utf8')
}

export async function readMemory(agentId: string): Promise<string> {
  return readFileOr(join(agentDir(agentId), 'memory.md'), '')
}

export async function writeMemory(agentId: string, content: string): Promise<void> {
  await fs.mkdir(agentDir(agentId), { recursive: true })
  await fs.writeFile(join(agentDir(agentId), 'memory.md'), content, 'utf8')
}

/** Read everything the runner/PTY need to launch an agent. */
export async function buildAgentContext(agentId: string): Promise<{
  agent: AgentNodeData
  projectPath: string
  role: string
  memory: string
}> {
  const agent = getAgent(agentId)
  const [role, memory] = await Promise.all([readRole(agentId), readMemory(agentId)])
  return { agent, projectPath: getCurrentProjectPath(), role, memory }
}

// ---------- orchestration helpers ----------

/** Agents this node delegates to (edges where this node is the source). */
export function childrenOf(nodeId: string): AgentNodeData[] {
  const { graph } = requireCurrent()
  const childIds = new Set(graph.edges.filter((e) => e.source === nodeId).map((e) => e.target))
  return graph.nodes.filter((n) => childIds.has(n.id))
}

export function getOrchestrators(): AgentNodeData[] {
  return requireCurrent().graph.nodes.filter((n) => n.kind === 'orchestrator')
}

/** Id, name, kind, and full role text for each given node — for routing prompts. */
export async function rolesOf(
  nodeIds: string[]
): Promise<{ id: string; name: string; kind: AgentKind; role: string }[]> {
  const { graph } = requireCurrent()
  const out: { id: string; name: string; kind: AgentKind; role: string }[] = []
  for (const id of nodeIds) {
    const node = graph.nodes.find((n) => n.id === id)
    if (!node) continue
    out.push({ id: node.id, name: node.name, kind: node.kind, role: await readRole(id) })
  }
  return out
}

/**
 * Directory holding in-flight run checkpoints, kept under the runs folder but in
 * a dot-subdir so listRuns (which only reads `*.json` files) ignores it.
 */
export function getCheckpointDir(): string {
  const { path } = requireCurrent()
  return aimPath(path, 'runs', '.checkpoints')
}

export async function saveRun(record: RunRecord): Promise<void> {
  const { path } = requireCurrent()
  const dir = aimPath(path, 'runs')
  await fs.mkdir(dir, { recursive: true })
  const safe = record.startedAt.replace(/[:.]/g, '-')
  await fs.writeFile(join(dir, `${safe}.json`), JSON.stringify(record, null, 2), 'utf8')
}

export async function listRuns(): Promise<RunSummary[]> {
  const { path } = requireCurrent()
  const dir = aimPath(path, 'runs')
  let files: string[]
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const out: RunSummary[] = []
  for (const file of files) {
    try {
      const rec = JSON.parse(await fs.readFile(join(dir, file), 'utf8')) as RunRecord
      out.push({
        file,
        goal: rec.goal,
        startedAt: rec.startedAt,
        status: rec.status,
        taskCount: rec.plan?.length ?? 0
      })
    } catch {
      // skip corrupt run files
    }
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)) // newest first
  return out
}

export async function loadRun(file: string): Promise<RunRecord | null> {
  const { path } = requireCurrent()
  const safe = basename(file) // guard against path traversal
  try {
    return JSON.parse(await fs.readFile(aimPath(path, 'runs', safe), 'utf8')) as RunRecord
  } catch {
    return null
  }
}

// ---------- settings ----------

export function getSettings(): ProjectSettings {
  return requireCurrent().graph.settings
}

export async function updateSettings(patch: Partial<ProjectSettings>): Promise<ProjectGraph> {
  const { graph } = requireCurrent()
  graph.settings = { ...graph.settings, ...patch }
  return saveGraph()
}

// ---------- memory reflection merge ----------

export async function applyReflection(
  agentId: string,
  r: { win: string; loss: string; lessons: string[]; label: string }
): Promise<void> {
  const dir = agentDir(agentId)
  const file = join(dir, 'memory.md')
  const content = await readFileOr(file, '')
  const next = mergeMemory(content, r)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(file, next, 'utf8')
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function replaceSection(
  text: string,
  headerRe: RegExp,
  transform: (body: string) => string
): string {
  const lines = text.split('\n')
  const hIdx = lines.findIndex((l) => headerRe.test(l))
  if (hIdx === -1) return text
  let end = lines.length
  for (let i = hIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i
      break
    }
  }
  const body = lines.slice(hIdx + 1, end).join('\n')
  const newBody = transform(body).trim()
  const rebuilt = [...lines.slice(0, hIdx + 1), '', newBody, '', ...lines.slice(end)]
  return rebuilt.join('\n').replace(/\n{3,}/g, '\n\n')
}

function mergeMemory(
  content: string,
  { win, loss, lessons, label }: { win: string; loss: string; lessons: string[]; label: string }
): string {
  let text = content && content.trim() ? content : '# Memory\n\n## Lessons\n\n## Task log\n'
  if (!/^##\s+Lessons/im.test(text)) text += '\n## Lessons\n'
  if (!/^##\s+Task log/im.test(text)) text += '\n## Task log\n'

  // Lessons: merge new bullets newest-first, dedupe, cap 40
  text = replaceSection(text, /^##\s+Lessons\s*$/im, (body) => {
    const existing = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- ') && !/\(none yet\)/i.test(l))
    const fresh = lessons
      .map((l) => `- ${l.trim()}`)
      .filter(
        (l) =>
          l.length > 2 &&
          !existing.some((e) => norm(e).includes(norm(l)) || norm(l).includes(norm(e)))
      )
    return [...fresh, ...existing].slice(0, 40).join('\n')
  })

  // Task log: prepend dated entry, cap 30 entries
  const date = new Date().toISOString().slice(0, 10)
  const entry = `### ${date} — ${label}\n- Win: ${win || '—'}\n- Loss: ${loss || '—'}`
  text = replaceSection(text, /^##\s+Task log\s*$/im, (body) => {
    const blocks = body
      .split(/\n(?=###\s)/)
      .map((p) => p.trim())
      .filter((p) => p.startsWith('###'))
    return [entry, ...blocks].slice(0, 30).join('\n\n')
  })

  return text.trimEnd() + '\n'
}

// ---------- recent projects ----------

function recentsFile(): string {
  return join(app.getPath('userData'), 'recent-projects.json')
}

export async function getRecentProjects(): Promise<ProjectMeta[]> {
  return JSON.parse(await readFileOr(recentsFile(), '[]')) as ProjectMeta[]
}

async function addRecent(meta: ProjectMeta): Promise<void> {
  const list = await getRecentProjects()
  const next = [meta, ...list.filter((m) => m.path !== meta.path)].slice(0, 10)
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(recentsFile(), JSON.stringify(next, null, 2), 'utf8')
}
