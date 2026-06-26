import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AgentKind,
  AgentNodeData,
  ContextFile,
  CreateAgentInput,
  GraphEdge,
  ProjectGraph,
  ProjectMeta,
  ProjectSettings,
  RunRecord,
  RunSummary,
  SpawnedMember
} from '../../shared/types'
import { DEFAULT_MODEL_BY_KIND, DEFAULT_SETTINGS } from '../../shared/types'
import { iconForName } from '../../shared/icons'
import { slugify, uniqueSlug } from '../../shared/slug'
import { isImageName, uniqueContextName } from '../../shared/context-files'
import { parseLessonBullet } from '../../shared/lessons'
import { buildTeamBundle, planTeamImport, validateTeamBundle, type TeamBundle } from '../../shared/team-bundle'
import { mergeBrainPush, planBrainPull, mergeLessons } from '../../shared/team-brain'
import type { DraftRosterAgent } from '../../shared/role-draft'

const AIM_DIR = '.ai-manager'
const GRAPH_FILE = 'graph.json'
const AGENTS_DIR = 'agents'
const CONTEXT_DIR = 'context'

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

export function getGraph(): ProjectGraph {
  return requireCurrent().graph
}

export function getAgent(agentId: string): AgentNodeData {
  const { graph } = requireCurrent()
  const agent = graph.nodes.find((n) => n.id === agentId)
  if (!agent) throw new Error(`Unknown agent: ${agentId}`)
  return agent
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
- **Review and test your team's output in your domain against the goal.** Don't trust a worker's report — run the app/tests and verify it actually works. You own testing, so your workers can focus on building.
- For anything that fails, give specific, actionable feedback and have the worker fix it. Hand well-tested, less-buggy work up to the orchestrator.
- After a run, reflect on what your review caught so your future reviews get sharper.

## How you work
- Match tasks to roles literally — don't hand a database task to a UI specialist.
- Keep the orchestrator informed about what was assigned, to whom, and what is blocked.
- When reviewing, verify behavior in your domain first (run it), then completeness against what was asked.

## Constraints
- You operate inside this one project folder.
- You route, review, and test; the workers do the heavy implementation. Don't edit their files — review and give feedback instead.
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
  graph.context = graph.context ?? []
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
  context: ContextFile[]
}> {
  const agent = getAgent(agentId)
  const [role, memory] = await Promise.all([readRole(agentId), readMemory(agentId)])
  return { agent, projectPath: getCurrentProjectPath(), role, memory, context: getContextFiles() }
}

// ---------- context files ----------

/** The user's attached reference files for this project. */
export function getContextFiles(): ContextFile[] {
  return requireCurrent().graph.context ?? []
}

/** Copy each source path into .ai-manager/context/ and record it (note ''). Unreadable paths are skipped. */
export async function addContextFiles(sourcePaths: string[]): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const dir = aimPath(path, CONTEXT_DIR)
  await fs.mkdir(dir, { recursive: true })
  graph.context = graph.context ?? []
  for (const src of sourcePaths) {
    try {
      const stat = await fs.stat(src)
      if (!stat.isFile()) continue
      const fileName = uniqueContextName(graph.context.map((c) => c.fileName), basename(src))
      await fs.copyFile(src, join(dir, fileName))
      graph.context.push({
        id: randomUUID(),
        fileName,
        note: '',
        addedAt: new Date().toISOString(),
        bytes: stat.size,
        isImage: isImageName(fileName)
      })
    } catch {
      // skip unreadable / missing source; the rest still add
    }
  }
  return saveGraph()
}

/** Edit an attached file's note. */
export async function updateContextFile(id: string, patch: { note?: string }): Promise<ProjectGraph> {
  const { graph } = requireCurrent()
  const entry = (graph.context ?? []).find((c) => c.id === id)
  if (entry && patch.note !== undefined) entry.note = patch.note
  return saveGraph()
}

/** Remove an attached file: delete the copy (tolerate a missing file) and drop the entry. */
export async function removeContextFile(id: string): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const entry = (graph.context ?? []).find((c) => c.id === id)
  if (entry) {
    await fs.rm(aimPath(path, CONTEXT_DIR, entry.fileName), { force: true })
    graph.context = (graph.context ?? []).filter((c) => c.id !== id)
  }
  return saveGraph()
}

/** A base64 data-URL thumbnail for an image entry under the size cap, else null. */
export async function contextThumbnail(id: string): Promise<string | null> {
  const { path, graph } = requireCurrent()
  const entry = (graph.context ?? []).find((c) => c.id === id)
  if (!entry || !entry.isImage || entry.bytes > 5_000_000) return null
  try {
    const buf = await fs.readFile(aimPath(path, CONTEXT_DIR, entry.fileName))
    const ext = entry.fileName.slice(entry.fileName.lastIndexOf('.') + 1).toLowerCase()
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

// ---------- orchestration helpers ----------

/** Agents this node delegates to (edges where this node is the source). */
export function childrenOf(nodeId: string): AgentNodeData[] {
  const { graph } = requireCurrent()
  const childIds = new Set(graph.edges.filter((e) => e.source === nodeId).map((e) => e.target))
  return graph.nodes.filter((n) => childIds.has(n.id))
}

/** The single node this one reports to (source of the edge targeting it), or null for a root. */
export function parentOf(nodeId: string): AgentNodeData | null {
  const { graph } = requireCurrent()
  const edge = graph.edges.find((e) => e.target === nodeId)
  if (!edge) return null
  return graph.nodes.find((n) => n.id === edge.source) ?? null
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

/** Non-orchestrator agents (id/name/kind + current role) and the graph edges — for role drafting. */
export async function rosterForDrafting(): Promise<{ agents: DraftRosterAgent[]; edges: GraphEdge[] }> {
  const { graph } = requireCurrent()
  const agents: DraftRosterAgent[] = []
  for (const n of graph.nodes) {
    if (n.kind === 'orchestrator') continue
    agents.push({ id: n.id, name: n.name, kind: n.kind, role: await readRole(n.id) })
  }
  return { agents, edges: graph.edges }
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

export function mergeMemory(
  content: string,
  { win, loss, lessons, label }: { win: string; loss: string; lessons: string[]; label: string }
): string {
  let text = content && content.trim() ? content : '# Memory\n\n## Lessons\n\n## Task log\n'
  if (!/^##\s+Lessons/im.test(text)) text += '\n## Lessons\n'
  if (!/^##\s+Task log/im.test(text)) text += '\n## Task log\n'

  // Lessons: merge new bullets newest-first, dedupe BY TEXT (ignoring the scope
  // marker so a re-learned lesson isn't stored twice), cap 40
  text = replaceSection(text, /^##\s+Lessons\s*$/im, (body) => {
    const existing = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- ') && !/\(none yet\)/i.test(l))
    const existingTexts = existing.map((e) => norm(parseLessonBullet(e.slice(2)).text))
    const fresh = lessons
      .map((l) => `- ${l.trim()}`)
      .filter((l) => {
        if (l.length <= 2) return false
        const lt = norm(parseLessonBullet(l.slice(2)).text)
        return !existingTexts.some((e) => e.includes(lt) || lt.includes(e))
      })
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

// ---------- portable team (export / import) ----------

export function getLinkedTeam(): { teamId: string; path: string } | null {
  return requireCurrent().graph.linkedTeam ?? null
}

/** PUSH: this project's portable lessons into the brain file at brainPath. */
export async function syncToTeam(
  brainPath: string,
  fallbackTeamId: string
): Promise<{ brain: TeamBundle; graph: ProjectGraph }> {
  const { graph } = requireCurrent()
  for (const n of graph.nodes) if (!n.memberId) n.memberId = n.id
  const files: Record<string, { role: string; memory: string }> = {}
  for (const n of graph.nodes) files[n.id] = { role: await readRole(n.id), memory: await readMemory(n.id) }
  const projectBundle = buildTeamBundle({
    name: graph.project.name,
    exportedAt: new Date().toISOString(),
    nodes: graph.nodes,
    edges: graph.edges,
    files
  })
  let existing: TeamBundle | null = null
  try {
    const v = validateTeamBundle(JSON.parse(await fs.readFile(brainPath, 'utf8')))
    if (v.ok) existing = v.bundle
  } catch {
    existing = null // fresh brain
  }
  const teamId = existing?.teamId ?? fallbackTeamId
  const base: TeamBundle = existing
    ? { ...existing, teamId }
    : { kind: 'ai-manager-team', version: 1, teamId, name: graph.project.name, exportedAt: new Date().toISOString(), members: [], edges: [] }
  const brain: TeamBundle = { ...mergeBrainPush(base, projectBundle), teamId, exportedAt: new Date().toISOString() }
  await fs.writeFile(brainPath, JSON.stringify(brain, null, 2), 'utf8')
  graph.linkedTeam = { teamId, path: brainPath }
  const saved = await saveGraph()
  return { brain, graph: saved }
}

/** PULL: merge the brain's portable lessons into matching agents' memory.md. */
export async function refreshFromTeam(
  brain: TeamBundle,
  brainPath: string
): Promise<{ updated: number; graph: ProjectGraph }> {
  const { graph } = requireCurrent()
  const teamId = brain.teamId ?? randomUUID()
  if (!brain.teamId) await fs.writeFile(brainPath, JSON.stringify({ ...brain, teamId }, null, 2), 'utf8')
  let updated = 0
  for (const p of planBrainPull(brain, graph.nodes)) {
    if (p.lessons.length === 0) continue
    const memory = await readMemory(p.agentId)
    const next = mergeLessons(memory, p.lessons)
    if (next !== memory) {
      await writeMemory(p.agentId, next)
      updated++
    }
  }
  graph.linkedTeam = { teamId, path: brainPath }
  const saved = await saveGraph()
  return { updated, graph: saved }
}

/** Read + validate a team-brain file. Returns null on missing/unreadable/invalid. */
export async function readTeamBrain(path: string): Promise<TeamBundle | null> {
  try {
    const v = validateTeamBundle(JSON.parse(await fs.readFile(path, 'utf8')))
    return v.ok ? v.bundle : null
  } catch {
    return null
  }
}

/** Auto PULL (B2b): if enabled + linked, refresh agents from the linked brain.
 * Returns agents updated (0 when off / unlinked / unreadable / failed). Best-effort. */
export async function autoPullFromTeam(): Promise<number> {
  try {
    const link = getLinkedTeam()
    if (!getSettings().autoSyncTeam || !link) return 0
    const brain = await readTeamBrain(link.path)
    if (!brain) return 0
    const { updated } = await refreshFromTeam(brain, link.path)
    return updated
  } catch {
    return 0
  }
}

/** Auto PUSH (B2b): if enabled + linked, sync this project's portable lessons to the linked brain. Best-effort. */
export async function autoPushToTeam(): Promise<void> {
  try {
    const link = getLinkedTeam()
    if (!getSettings().autoSyncTeam || !link) return
    await syncToTeam(link.path, link.teamId)
  } catch {
    // best-effort: never let auto-sync surface an error
  }
}

/** Snapshot the open project's team into a portable bundle (portable lessons only). */
export async function exportTeam(): Promise<TeamBundle> {
  const { graph } = requireCurrent()
  const files: Record<string, { role: string; memory: string }> = {}
  for (const n of graph.nodes) {
    files[n.id] = { role: await readRole(n.id), memory: await readMemory(n.id) }
  }
  return buildTeamBundle({
    name: graph.project.name,
    exportedAt: new Date().toISOString(),
    nodes: graph.nodes,
    edges: graph.edges,
    files
  })
}

/** Add a bundle's team into the open project: new agents (fresh ids, uniquified
 * slugs, seeded memory), remapped edges. Saves the graph LAST for atomicity. */
export async function importTeam(bundle: TeamBundle, brainPath?: string): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const plan = planTeamImport(bundle, graph.nodes.map((n) => n.slug))
  const idByMember = new Map<string, string>()
  for (const m of plan.members) {
    const id = randomUUID()
    idByMember.set(m.memberId, id)
    const dir = aimPath(path, AGENTS_DIR, m.slug)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'role.md'), m.role, 'utf8')
    await fs.writeFile(join(dir, 'memory.md'), m.memory, 'utf8')
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
    graph.nodes.push(node)
  }
  for (const e of plan.edges) {
    const source = idByMember.get(e.source)
    const target = idByMember.get(e.target)
    if (source && target) graph.edges.push({ id: `${source}->${target}`, source, target })
  }
  if (bundle.teamId && brainPath) graph.linkedTeam = { teamId: bundle.teamId, path: brainPath }
  return saveGraph()
}

/** Create the orchestrator's proposed team: new agents (fresh ids, uniquified slugs,
 * proposed roles, fresh memory), wired by reportsTo, laid out under the orchestrator. */
export async function applySpawnedTeam(
  members: SpawnedMember[],
  orchestratorId: string
): Promise<ProjectGraph> {
  const { path, graph } = requireCurrent()
  const base = graph.nodes.find((n) => n.id === orchestratorId)?.position ?? { x: 120, y: 120 }
  const byTemp = new Map(members.map((m) => [m.id, m]))
  const depthOf = (m: SpawnedMember): number => {
    let d = 1
    let cur = m.reportsTo
    let hops = 0
    while (cur !== 'orchestrator' && byTemp.has(cur) && hops++ < members.length) {
      d++
      cur = byTemp.get(cur)!.reportsTo
    }
    return d
  }
  const perDepth = new Map<number, number>()
  const taken = new Set(graph.nodes.map((n) => n.slug))
  const idByTemp = new Map<string, string>()
  for (const m of members) {
    const id = randomUUID()
    idByTemp.set(m.id, id)
    const slug = uniqueSlug(slugify(m.name), taken)
    taken.add(slug)
    const d = depthOf(m)
    const col = perDepth.get(d) ?? 0
    perDepth.set(d, col + 1)
    const dir = aimPath(path, AGENTS_DIR, slug)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'role.md'), m.role, 'utf8')
    await fs.writeFile(join(dir, 'memory.md'), memoryTemplate(m.name), 'utf8')
    graph.nodes.push({
      id,
      name: m.name,
      slug,
      kind: m.kind,
      icon: iconForName(m.name, m.kind),
      model: DEFAULT_MODEL_BY_KIND[m.kind],
      permissionMode: 'acceptEdits',
      position: { x: base.x + col * 220, y: base.y + d * 150 }
    })
  }
  for (const m of members) {
    const childId = idByTemp.get(m.id)!
    const parentId = m.reportsTo === 'orchestrator' ? orchestratorId : idByTemp.get(m.reportsTo)
    if (parentId) graph.edges.push({ id: `${parentId}->${childId}`, source: parentId, target: childId })
  }
  return saveGraph()
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
