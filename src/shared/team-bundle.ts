// Pure transformation core for the portable-team feature: build a bundle from a
// project's graph + agent files, validate an untrusted bundle, and plan an import.
// No node/DOM imports — unit-tested in plain Node, used by the main process.

import type { AgentKind, AgentNodeData, GraphEdge, PermissionMode } from './types'
import { MODELS, DEFAULT_MODEL_BY_KIND } from './types'
import { formatLessonBullet, portableLessons } from './lessons'
import { slugify, uniqueSlug } from './slug'

const MAX_ROLE_CHARS = 50_000
const MAX_MEMBERS = 200
const MAX_LESSONS = 200
const MAX_LESSON_CHARS = 2_000
const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto']
const AGENT_KINDS: AgentKind[] = ['orchestrator', 'manager', 'worker']
const KNOWN_MODELS: Set<string> = new Set(MODELS.map((m) => m.id))

const POSITION_OFFSET = 48

export interface TeamMember {
  memberId: string
  name: string
  kind: AgentKind
  model: string
  permissionMode: PermissionMode
  skills?: string[]
  icon: string
  position: { x: number; y: number }
  role: string
  lessons: string[] // portable lesson texts, marker stripped
}

export interface TeamBundle {
  kind: 'ai-manager-team'
  version: 1
  /** stable team identity — present in a "team brain"; absent in a plain snapshot */
  teamId?: string
  name: string
  exportedAt: string
  members: TeamMember[]
  edges: { source: string; target: string }[] // by memberId
}

/** A fresh memory.md seeded with portable lessons and an empty task log. */
export function buildSeededMemory(name: string, lessons: string[]): string {
  const body = lessons.length > 0 ? lessons.map((t) => `- ${formatLessonBullet('portable', t)}`).join('\n') : '- (none yet)'
  return `# Memory: ${name}

This is your persistent brain. Read it before each task and learn from it. After a
task, record what worked and what didn't so you don't repeat mistakes.

## Lessons
<!-- One bullet per lesson. Keep the sharpest, most reusable insights here. -->
${body}

## Task log
<!-- Newest first. For each task: what you attempted, the outcome, wins, and losses. -->
`
}

/** Build a portable bundle from the live graph + each agent's role/memory files. */
export function buildTeamBundle(args: {
  name: string
  exportedAt: string
  nodes: AgentNodeData[]
  edges: GraphEdge[]
  files: Record<string, { role: string; memory: string }>
}): TeamBundle {
  const memberIdByNode = new Map(args.nodes.map((n) => [n.id, n.memberId ?? n.id]))
  const members: TeamMember[] = args.nodes.map((n) => {
    const f = args.files[n.id] ?? { role: '', memory: '' }
    const member: TeamMember = {
      memberId: memberIdByNode.get(n.id)!,
      name: n.name,
      kind: n.kind,
      model: n.model,
      permissionMode: n.permissionMode,
      icon: n.icon,
      position: n.position,
      role: f.role,
      lessons: portableLessons(f.memory)
    }
    if (n.skills && n.skills.length) member.skills = n.skills
    return member
  })
  const edges = args.edges
    .filter((e) => memberIdByNode.has(e.source) && memberIdByNode.has(e.target))
    .map((e) => ({ source: memberIdByNode.get(e.source)!, target: memberIdByNode.get(e.target)! }))
  return { kind: 'ai-manager-team', version: 1, name: args.name, exportedAt: args.exportedAt, members, edges }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function finite(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Validate AND normalize untrusted JSON read from disk. On success returns a fully-typed,
 *  bounded bundle plus human-readable warnings about anything clamped/dropped. Never throws
 *  on member field access downstream. */
export function validateTeamBundle(
  raw: unknown
): { ok: true; bundle: TeamBundle; warnings: string[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Not a team bundle (not an object).' }
  const b = raw as Record<string, unknown>
  if (b.kind !== 'ai-manager-team') return { ok: false, error: 'Not an AI Manager team bundle.' }
  if (b.version !== 1) return { ok: false, error: `Unsupported team bundle version: ${String(b.version)}.` }
  if (!Array.isArray(b.members)) return { ok: false, error: 'Team bundle has no members array.' }
  if (b.members.length > MAX_MEMBERS) return { ok: false, error: `Team bundle has too many members (>${MAX_MEMBERS}).` }
  if (b.edges !== undefined && !Array.isArray(b.edges)) return { ok: false, error: 'Team bundle edges are malformed.' }

  const warnings: string[] = []
  const members: TeamMember[] = []
  for (const m of b.members) {
    const mm = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
    if (typeof mm.memberId !== 'string' || typeof mm.name !== 'string') {
      return { ok: false, error: 'Team bundle has a member missing memberId/name.' }
    }
    if (!AGENT_KINDS.includes(mm.kind as AgentKind)) {
      return { ok: false, error: `Team bundle member "${mm.name}" has an invalid kind.` }
    }
    const kind = mm.kind as AgentKind
    let model = str(mm.model)
    if (!KNOWN_MODELS.has(model)) { model = DEFAULT_MODEL_BY_KIND[kind]; warnings.push(`${mm.name}: unknown model → ${model}`) }
    let permissionMode = mm.permissionMode as PermissionMode
    if (!PERMISSION_MODES.includes(permissionMode)) { warnings.push(`${mm.name}: unknown permissionMode → acceptEdits`); permissionMode = 'acceptEdits' }
    let role = str(mm.role)
    if (role.length > MAX_ROLE_CHARS) { role = role.slice(0, MAX_ROLE_CHARS); warnings.push(`${mm.name}: role truncated to ${MAX_ROLE_CHARS} chars`) }
    const rawLessons = Array.isArray(mm.lessons) ? mm.lessons : []
    const lessons = rawLessons.filter((l) => typeof l === 'string').slice(0, MAX_LESSONS).map((l) => (l as string).slice(0, MAX_LESSON_CHARS))
    if (rawLessons.length > lessons.length) warnings.push(`${mm.name}: lessons capped to ${MAX_LESSONS}`)
    const pos = (mm.position && typeof mm.position === 'object' ? mm.position : {}) as Record<string, unknown>
    const member: TeamMember = {
      memberId: mm.memberId, name: mm.name, kind, model, permissionMode,
      icon: str(mm.icon, '🤖'),
      position: { x: finite(pos.x), y: finite(pos.y) },
      role, lessons
    }
    if (Array.isArray(mm.skills)) { const s = mm.skills.filter((x): x is string => typeof x === 'string'); if (s.length) member.skills = s }
    members.push(member)
  }
  const edges = (Array.isArray(b.edges) ? b.edges : [])
    .filter((e) => e && typeof e === 'object' && typeof (e as Record<string, unknown>).source === 'string' && typeof (e as Record<string, unknown>).target === 'string')
    .map((e) => ({ source: (e as Record<string, string>).source, target: (e as Record<string, string>).target }))
  const bundle: TeamBundle = {
    kind: 'ai-manager-team', version: 1, name: str(b.name, 'Imported team'),
    exportedAt: str(b.exportedAt), members, edges
  }
  if (typeof b.teamId === 'string') bundle.teamId = b.teamId
  return { ok: true, bundle, warnings }
}

/** Renderer-facing preview of an import (members + validation warnings). Roles shown for review. */
export function previewOf(bundle: TeamBundle, warnings: string[]): {
  members: { name: string; kind: AgentKind; role: string }[]
  warnings: string[]
} {
  return { members: bundle.members.map((m) => ({ name: m.name, kind: m.kind, role: m.role })), warnings }
}

export interface PlannedMember {
  memberId: string
  name: string
  slug: string
  kind: AgentKind
  model: string
  permissionMode: PermissionMode
  skills?: string[]
  icon: string
  position: { x: number; y: number }
  role: string
  memory: string
}

/** Plan an import into a project: per-member fields (slug uniquified, position
 * offset, memory seeded) and edges still keyed by memberId. The caller assigns
 * fresh node ids and remaps the edges. */
export function planTeamImport(
  bundle: TeamBundle,
  existingSlugs: string[]
): { members: PlannedMember[]; edges: { source: string; target: string }[] } {
  const taken = new Set(existingSlugs)
  const members: PlannedMember[] = bundle.members.map((m) => {
    const slug = uniqueSlug(slugify(m.name), taken)
    taken.add(slug)
    const planned: PlannedMember = {
      memberId: m.memberId,
      name: m.name,
      slug,
      kind: m.kind,
      model: m.model,
      permissionMode: 'acceptEdits', // force safe mode — never honor a bundle's permissionMode (#17)
      icon: m.icon,
      position: { x: m.position.x + POSITION_OFFSET, y: m.position.y + POSITION_OFFSET },
      role: m.role,
      memory: buildSeededMemory(m.name, m.lessons)
    }
    if (m.skills && m.skills.length) planned.skills = m.skills
    return planned
  })
  return { members, edges: bundle.edges }
}
