// Pure transformation core for the portable-team feature: build a bundle from a
// project's graph + agent files, validate an untrusted bundle, and plan an import.
// No node/DOM imports — unit-tested in plain Node, used by the main process.

import type { AgentKind, AgentNodeData, GraphEdge, PermissionMode } from './types'
import { formatLessonBullet, portableLessons } from './lessons'
import { slugify, uniqueSlug } from './slug'

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

/** Validate untrusted JSON read from disk. */
export function validateTeamBundle(
  raw: unknown
): { ok: true; bundle: TeamBundle } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Not a team bundle (not an object).' }
  const b = raw as Record<string, unknown>
  if (b.kind !== 'ai-manager-team') return { ok: false, error: 'Not an AI Manager team bundle.' }
  if (b.version !== 1) return { ok: false, error: `Unsupported team bundle version: ${String(b.version)}.` }
  if (!Array.isArray(b.members)) return { ok: false, error: 'Team bundle has no members array.' }
  for (const m of b.members) {
    const mm = m as Record<string, unknown>
    if (typeof mm.memberId !== 'string' || typeof mm.name !== 'string' || typeof mm.kind !== 'string') {
      return { ok: false, error: 'Team bundle has a malformed member.' }
    }
  }
  if (b.edges !== undefined && !Array.isArray(b.edges)) return { ok: false, error: 'Team bundle edges are malformed.' }
  return { ok: true, bundle: raw as TeamBundle }
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
      permissionMode: m.permissionMode,
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
