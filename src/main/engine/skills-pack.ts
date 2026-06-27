// fs discovery for the always-available skills pack. Pure shaping lives in shared/skills-pack.ts.
import { promises as fs, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolve the pack dir: explicit setting wins, else ~/.ai-manager/skills-pack. */
export function resolvePackPath(settingPath: string): string {
  const t = (settingPath ?? '').trim()
  return t || join(homedir(), '.ai-manager', 'skills-pack')
}

/** Skill names under <packPath>/skills/* (SKILL.md `name:`, fallback folder). [] if absent. */
export async function discoverPackSkills(packPath: string): Promise<string[]> {
  const skillsDir = join(packPath, 'skills')
  if (!existsSync(skillsDir)) return []
  let entries: { name: string; isDirectory: () => boolean }[]
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const md = join(skillsDir, ent.name, 'SKILL.md')
    if (!existsSync(md)) continue
    names.push(await skillName(md, ent.name))
  }
  return names
}

async function skillName(skillMdPath: string, fallback: string): Promise<string> {
  try {
    const text = await fs.readFile(skillMdPath, 'utf8')
    const fm = text.match(/^---\n([\s\S]*?)\n---/)
    const m = (fm ? fm[1] : '').match(/^name:\s*(.+?)\s*$/m)
    if (m?.[1]) return m[1].replace(/^["']|["']$/g, '').trim()
  } catch { /* fall through */ }
  return fallback
}
