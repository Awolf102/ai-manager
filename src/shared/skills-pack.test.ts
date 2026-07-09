import { describe, it, expect } from 'vitest'
import {
  packSkillOptions, mergeSkillOptions, headlessNote, assembleAgentSkills, withExtraSkills, SKILLS_PACK_PLUGIN_ID
} from './skills-pack'

const pa = { plugins: [{ type: 'local' as const, path: '/a', skipMcpDiscovery: true as const }], skills: ['a:x'] }

describe('packSkillOptions', () => {
  it('returns null when no skills', () => expect(packSkillOptions('/pack', [])).toBeNull())
  it('returns null when no path', () => expect(packSkillOptions('', ['emil'])).toBeNull())
  it('builds local plugin + namespaced ids', () => {
    expect(packSkillOptions('/pack', ['emil', 'playwright-skill'])).toEqual({
      plugins: [{ type: 'local', path: '/pack', skipMcpDiscovery: true }],
      skills: [`${SKILLS_PACK_PLUGIN_ID}:emil`, `${SKILLS_PACK_PLUGIN_ID}:playwright-skill`]
    })
  })
})

describe('mergeSkillOptions', () => {
  const pb = { plugins: [{ type: 'local' as const, path: '/pack', skipMcpDiscovery: true as const }], skills: ['p:y'] }
  it('null + b → b', () => expect(mergeSkillOptions(null, pb)).toBe(pb))
  it('a + null → a', () => expect(mergeSkillOptions(pa, null)).toBe(pa))
  it('null + null → null', () => expect(mergeSkillOptions(null, null)).toBeNull())
  it('merges + dedupes paths and ids', () => {
    const merged = mergeSkillOptions(pa, pb)!
    expect(merged.plugins.map((p) => p.path)).toEqual(['/a', '/pack'])
    expect(merged.skills).toEqual(['a:x', 'p:y'])
  })
  it('dedupes overlapping path + id', () => {
    const merged = mergeSkillOptions(pa, { plugins: pa.plugins, skills: ['a:x', 'a:z'] })!
    expect(merged.plugins).toHaveLength(1)
    expect(merged.skills).toEqual(['a:x', 'a:z'])
  })
})

describe('headlessNote', () => {
  it('empty without playwright', () => expect(headlessNote(['emil', 'taste'])).toBe(''))
  it('mentions headless with playwright', () => expect(headlessNote(['playwright-skill'])).toMatch(/headless/i))
})

describe('assembleAgentSkills', () => {
  it('merges per-agent + pack and returns note', () => {
    const r = assembleAgentSkills(pa, '/pack', ['playwright-skill'])
    expect(r.options!.skills).toContain(`${SKILLS_PACK_PLUGIN_ID}:playwright-skill`)
    expect(r.options!.skills).toContain('a:x')
    expect(r.note).toMatch(/headless/i)
  })
  it('pack disabled (empty names) → per-agent unchanged, no note', () => {
    const r = assembleAgentSkills(pa, '/pack', [])
    expect(r.options).toBe(pa)
    expect(r.note).toBe('')
  })
})

describe('withExtraSkills', () => {
  it('returns the base unchanged when no extra names', () => {
    const base = { plugins: [{ type: 'local' as const, path: '/p', skipMcpDiscovery: true as const }], skills: ['a'] }
    expect(withExtraSkills(base, [], '/pack')).toBe(base)
    expect(withExtraSkills(null, [], '/pack')).toBe(null)
  })
  it('merges the pack-filtered extra skills into the base', () => {
    const out = withExtraSkills(null, ['emil-design-eng'], '/pack')
    expect(out).not.toBeNull()
    expect(out!.skills.some((s) => s.includes('emil-design-eng'))).toBe(true)
    expect(out!.plugins.some((p) => p.path === '/pack')).toBe(true)
  })
})
