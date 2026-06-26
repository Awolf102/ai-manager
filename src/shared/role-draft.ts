// Pure prompt-building + output-parsing for orchestrator-drafted agent roles.
// No node/DOM imports — unit-tested in plain Node, used by the engine.
import type { AgentKind } from './types'

export interface DraftRosterAgent {
  id: string
  name: string
  kind: AgentKind
  role: string
}

export function draftRolesPrompt(
  goal: string,
  roster: DraftRosterAgent[],
  edges: { source: string; target: string }[],
  offered: { id: string; description: string }[] = []
): string {
  const nameById = new Map(roster.map((a) => [a.id, a.name]))
  const agents = roster
    .map(
      (a) =>
        `- id: ${a.id}\n  name: ${a.name} (${a.kind})\n  current role: ${a.role.replace(/\s+/g, ' ').slice(0, 400)}`
    )
    .join('\n')
  const topology =
    edges.map((e) => `${nameById.get(e.source) ?? e.source} → ${nameById.get(e.target) ?? e.target}`).join('\n') ||
    '(no reporting links)'
  const skillsBlock = offered.length
    ? `\n\nAVAILABLE SKILLS (optionally assign the most relevant to each agent as a "skills" array of these exact ids — at most 5 each):\n${offered
        .map((s) => `- ${s.id}: ${s.description}`)
        .join('\n')}`
    : ''
  return `You are the lead orchestrator. Draft a tailored role for each specialist on your team so they are well-suited to this goal. Each role becomes that agent's role.md and is reused across future goals, so write a DURABLE specialty (informed by the goal, not narrowly tied to it).

GOAL:
${goal}

YOUR TEAM (write one role per agent; make their specialties DISTINCT and COMPLEMENTARY — no two agents should share the same focus):
${agents}

REPORTING STRUCTURE (source delegates work down to target):
${topology}${skillsBlock}

For each agent, write a COMPLETE role.md in this shape:
# Role: <name> (<Worker|Manager>)

## Specialty
<1-3 sentences naming this agent's distinct focus on this team>

## Responsibilities
- <bullet>
- <bullet>

## How you work
- <bullet>

## Constraints
- You operate inside this one project folder.

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "roles": [ { "agentId": "<id>", "role": "<the full role.md markdown>", "skills": [] } ] }
\`\`\``
}

export function parseDraftedRoles(
  text: string,
  knownIds: string[],
  validSkillIds: string[] = []
): { agentId: string; role: string; skills?: string[] }[] | null {
  const parsed = parseJsonBlock(text)
  const roles = (parsed as { roles?: unknown })?.roles
  if (!Array.isArray(roles)) return null
  const known = new Set(knownIds)
  const valid = new Set(validSkillIds)
  const out: { agentId: string; role: string; skills?: string[] }[] = []
  for (const r of roles) {
    const o = r as { agentId?: unknown; role?: unknown; skills?: unknown }
    const agentId = String(o.agentId ?? '')
    const role = String(o.role ?? '').trim()
    if (!(known.has(agentId) && role)) continue
    const skills = Array.isArray(o.skills)
      ? [...new Set(o.skills.map((x) => String(x)))].filter((x) => valid.has(x)).slice(0, 5)
      : []
    const entry: { agentId: string; role: string; skills?: string[] } = { agentId, role }
    if (skills.length) entry.skills = skills
    out.push(entry)
  }
  return out
}

function parseJsonBlock(text: string): unknown {
  const candidates: string[] = []
  const fences = [...text.matchAll(/\x60{3}(?:json)?\s*([\s\S]*?)\x60{3}/gi)]
  // (\x60 = backtick; matches a ```json … ``` fenced block without literal backticks here)
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
