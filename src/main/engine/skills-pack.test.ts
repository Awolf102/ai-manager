import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { resolvePackPath, discoverPackSkills } from './skills-pack'

describe('resolvePackPath', () => {
  it('uses explicit setting when set', () => expect(resolvePackPath('  /custom/pack ')).toBe('/custom/pack'))
  it('defaults to ~/.ai-manager/skills-pack', () =>
    expect(resolvePackPath('')).toBe(join(homedir(), '.ai-manager', 'skills-pack')))
})

describe('discoverPackSkills', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pack-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns [] when skills/ absent', async () => expect(await discoverPackSkills(dir)).toEqual([]))

  it('reads SKILL.md name: frontmatter; falls back to folder; skips dirs without SKILL.md', async () => {
    const skills = join(dir, 'skills')
    mkdirSync(join(skills, 'emil'), { recursive: true })
    writeFileSync(join(skills, 'emil', 'SKILL.md'), '---\nname: emil-kowalski\ndescription: x\n---\n# body')
    mkdirSync(join(skills, 'fallback'), { recursive: true })
    writeFileSync(join(skills, 'fallback', 'SKILL.md'), '# no frontmatter')
    mkdirSync(join(skills, 'not-a-skill'), { recursive: true }) // no SKILL.md → skipped
    const names = (await discoverPackSkills(dir)).sort()
    expect(names).toEqual(['emil-kowalski', 'fallback'])
  })
})
