// Pure prompt-building + output-parsing (with cycle-breaking) for dynamic team spawning.
// No node/DOM imports — unit-tested in plain Node, used by the engine.
import type { AgentKind, SpawnedMember } from './types'

export function spawnTeamPrompt(
  goal: string,
  orchestratorName: string,
  existing: { name: string; kind: AgentKind; role: string }[],
  offered: { id: string; description: string }[] = []
): string {
  const existingList = existing.length
    ? existing.map((a) => `- ${a.name} (${a.kind}): ${a.role.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')
    : '(none yet)'
  const skillsBlock = offered.length
    ? `\n\nAVAILABLE SKILLS (assign the most relevant to each member as a "skills" array of these exact ids — at most 5 per member; omit or use [] if none fit):\n${offered
        .map((s) => `- ${s.id}: ${s.description}`)
        .join('\n')}`
    : ''
  return `You are ${orchestratorName}, the lead orchestrator. Design the team of specialists you need to achieve this goal. Propose each teammate as a worker or a manager, give each a complete role.md, and define who reports to whom.

GOAL:
${goal}

ALREADY ON THE TEAM (do NOT duplicate these specialties — propose only what's missing):
${existingList}${skillsBlock}

Rules:
- Make every specialty DISTINCT and COMPLEMENTARY.
- Create a domain manager when a distinct area of work (a cluster of several related roles or subsystems) would benefit from dedicated review, testing, and accumulated QA expertise — not only when there are many workers. A manager owns reviewing and testing its area, so group several related roles under one QA-capable manager. A manager with a single worker is pure overhead — keep that flat (the worker reports directly to you).
- Each member's "reportsTo" is the "id" of another member you propose, or the literal "orchestrator" (you). A manager may have workers (or managers) reporting to it.
- Each "role" is a complete role.md: a "# Role" title, "## Specialty", "## Responsibilities", "## How you work", "## Constraints".

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "members": [ { "id": "m1", "name": "short name", "kind": "manager|worker", "role": "<full role.md>", "reportsTo": "orchestrator", "skills": [] } ] }
\`\`\``
}

export function parseSpawnedTeam(text: string, validSkillIds: string[] = []): SpawnedMember[] | null {
  const parsed = parseJsonBlock(text)
  const raw = (parsed as { members?: unknown })?.members
  if (!Array.isArray(raw)) return null
  const valid = new Set(validSkillIds)
  const seen = new Set<string>()
  const members: SpawnedMember[] = []
  for (const r of raw) {
    const o = r as { id?: unknown; name?: unknown; kind?: unknown; role?: unknown; reportsTo?: unknown; skills?: unknown }
    const id = String(o.id ?? '').trim()
    const name = String(o.name ?? '').trim()
    const kind = o.kind === 'manager' ? 'manager' : o.kind === 'worker' ? 'worker' : null
    const role = String(o.role ?? '').trim()
    if (!id || seen.has(id) || !name || !kind || !role) continue
    seen.add(id)
    const skills = Array.isArray(o.skills)
      ? [...new Set(o.skills.map((x) => String(x)))].filter((x) => valid.has(x)).slice(0, 5)
      : []
    const member: SpawnedMember = { id, name, kind, role, reportsTo: String(o.reportsTo ?? 'orchestrator').trim() || 'orchestrator' }
    if (skills.length) member.skills = skills
    members.push(member)
  }
  if (members.length === 0) return null
  breakCycles(members)
  return members
}

/** Reset any reportsTo that is unknown, self-referential, or cyclic to "orchestrator". */
function breakCycles(members: SpawnedMember[]): void {
  const byId = new Map(members.map((m) => [m.id, m]))
  for (const m of members) {
    const path = new Set<string>([m.id])
    let cur = m.reportsTo
    while (cur !== 'orchestrator') {
      if (!byId.has(cur) || path.has(cur)) {
        m.reportsTo = 'orchestrator'
        break
      }
      path.add(cur)
      cur = byId.get(cur)!.reportsTo
    }
  }
}

function parseJsonBlock(text: string): unknown {
  const candidates: string[] = []
  const fences = [...text.matchAll(/\x60{3}(?:json)?\s*([\s\S]*?)\x60{3}/gi)]
  if (fences.length) candidates.push(fences[fences.length - 1][1])
  candidates.push(text)
  for (const c of candidates) {
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1))
    } catch {
      // try the next candidate
    }
  }
  return null
}
