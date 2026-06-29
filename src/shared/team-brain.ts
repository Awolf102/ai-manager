// Pure merge core for the living-team (team brain) feature. No node/DOM imports.
import type { AgentNodeData } from './types'
import type { TeamBundle } from './team-bundle'
import { formatLessonBullet, lessonBullets, parseLessonBullet } from './lessons'

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// Dedup is intentional EXACT normalized-text equality (not the substring rule
// `mergeMemory` uses): the team-brain sync is a second writer into an agent's
// memory, and exact-match avoids silently swallowing distinct-but-overlapping
// lessons. Keep it exact — do not "align" it with mergeMemory's `includes` rule.
function unionLessons(existing: string[], incoming: string[]): string[] {
  const out = [...existing]
  const seen = new Set(existing.map(norm))
  for (const l of incoming) {
    const n = norm(l)
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(l)
  }
  return out
}

/** PUSH merge: union each project member's lessons into the matching brain member
 * (by memberId); add project members absent from the brain (growth); brain-only
 * members untouched; union edges. The brain's teamId is preserved. */
export function mergeBrainPush(brain: TeamBundle, projectBundle: TeamBundle): TeamBundle {
  const members = brain.members.map((m) => ({ ...m }))
  const byId = new Map(members.map((m) => [m.memberId, m]))
  for (const pm of projectBundle.members) {
    const existing = byId.get(pm.memberId)
    if (existing) existing.lessons = unionLessons(pm.lessons, existing.lessons).slice(0, 40)
    else {
      const copy = { ...pm }
      members.push(copy)
      byId.set(copy.memberId, copy)
    }
  }
  const key = (e: { source: string; target: string }): string => `${e.source}|${e.target}`
  const edges = [...brain.edges]
  const seen = new Set(brain.edges.map(key))
  for (const e of projectBundle.edges) {
    const k = key(e)
    if (!seen.has(k)) { seen.add(k); edges.push(e) }
  }
  return { ...brain, members, edges }
}

/** PULL plan: for each brain member with a matching project node (by memberId,
 * id fallback), the portable lesson texts to merge into that agent. */
export function planBrainPull(
  brain: TeamBundle,
  nodes: AgentNodeData[]
): { agentId: string; lessons: string[] }[] {
  const out: { agentId: string; lessons: string[] }[] = []
  for (const m of brain.members) {
    const node = nodes.find((n) => (n.memberId ?? n.id) === m.memberId)
    if (node) out.push({ agentId: node.id, lessons: m.lessons })
  }
  return out
}

function replaceLessonsSection(memory: string, bullets: string[]): string {
  const body = bullets.map((b) => `- ${b}`).join('\n')
  const lines = memory.split('\n')
  const hIdx = lines.findIndex((l) => /^##\s+lessons\s*$/i.test(l.trim()))
  if (hIdx === -1) {
    const sep = memory.length === 0 || memory.endsWith('\n') ? '' : '\n'
    return `${memory}${sep}\n## Lessons\n${body}\n`
  }
  let end = lines.length
  for (let i = hIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) { end = i; break }
  }
  return [...lines.slice(0, hIdx + 1), '', body, '', ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n')
}

/** Merge new portable lesson texts into memory.md's `## Lessons` as `- [portable] …`,
 * dedup-by-text against existing bullets, newest-first, cap 40. Task log + other
 * sections untouched. Returns the original string when nothing is new. */
export function mergeLessons(memory: string, newPortableTexts: string[]): string {
  const existing = lessonBullets(memory)
  const seen = new Set(existing.map((b) => norm(parseLessonBullet(b).text)))
  const fresh: string[] = []
  for (const t of newPortableTexts) {
    const text = t.trim()
    const n = norm(text)
    if (!n || seen.has(n)) continue
    seen.add(n)
    fresh.push(formatLessonBullet('portable', text))
  }
  if (fresh.length === 0) return memory
  return replaceLessonsSection(memory, [...fresh, ...existing].slice(0, 40))
}
