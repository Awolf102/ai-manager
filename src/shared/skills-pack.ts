// Pure assembly of the always-available "skills pack" SDK options. No node/DOM imports.
import type { SkillSdkOptions } from './skill-trust'

export const SKILLS_PACK_PLUGIN_ID = 'ai-manager-skills-pack'

/** SDK options for the pack from discovered skill names. null when path or names are empty. */
export function packSkillOptions(packPath: string, skillNames: string[]): SkillSdkOptions | null {
  if (!packPath || skillNames.length === 0) return null
  return {
    plugins: [{ type: 'local', path: packPath, skipMcpDiscovery: true }],
    skills: skillNames.map((n) => `${SKILLS_PACK_PLUGIN_ID}:${n}`)
  }
}

/** Merge two option sets (either may be null), de-duping plugin paths and skill ids. */
export function mergeSkillOptions(
  a: SkillSdkOptions | null,
  b: SkillSdkOptions | null
): SkillSdkOptions | null {
  if (!a) return b
  if (!b) return a
  const byPath = new Map<string, SkillSdkOptions['plugins'][number]>()
  for (const p of [...a.plugins, ...b.plugins]) byPath.set(p.path, p)
  return { plugins: [...byPath.values()], skills: [...new Set([...a.skills, ...b.skills])] }
}

/** Reminder appended to an agent's prompt when the pack ships the Playwright skill. */
export function headlessNote(skillNames: string[]): string {
  return skillNames.some((n) => n.toLowerCase().includes('playwright'))
    ? '\n\nWhen using the playwright-skill, always launch browsers headless (`headless: true`) — you run in a headless environment with no display.'
    : ''
}

/** Combine per-agent options with the pack; returns merged options + the headless note. */
export function assembleAgentSkills(
  perAgent: SkillSdkOptions | null,
  packPath: string,
  packNames: string[]
): { options: SkillSdkOptions | null; note: string } {
  return {
    options: mergeSkillOptions(perAgent, packSkillOptions(packPath, packNames)),
    note: headlessNote(packNames)
  }
}
