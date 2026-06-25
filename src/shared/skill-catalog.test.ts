import { describe, it, expect } from 'vitest'
import { skillOptionsFor, SKILL_CATALOG, catalogSkillIds } from './skill-catalog'

const path = (id: string): string => `/plugins/${id}`

describe('skillOptionsFor', () => {
  it('returns null when no skills are assigned', () => {
    expect(skillOptionsFor(undefined, path)).toBeNull()
    expect(skillOptionsFor([], path)).toBeNull()
  })

  it('loads the single plugin for a one-plugin selection, skipping its MCP server', () => {
    expect(skillOptionsFor(['data:analyze', 'data:write-query'], path)).toEqual({
      plugins: [{ type: 'local', path: '/plugins/data', skipMcpDiscovery: true }],
      skills: ['data:analyze', 'data:write-query']
    })
  })

  it('loads each distinct plugin once for a cross-plugin selection', () => {
    const o = skillOptionsFor(['data:analyze', 'engineering:code-review', 'data:explore-data'], path)
    expect(o?.plugins.map((p) => p.path).sort()).toEqual(['/plugins/data', '/plugins/engineering'])
    expect(o?.plugins.every((p) => p.skipMcpDiscovery === true)).toBe(true)
    expect(o?.skills).toEqual(['data:analyze', 'engineering:code-review', 'data:explore-data'])
  })

  it('ignores unknown / malformed skill ids (no plugin prefix)', () => {
    const o = skillOptionsFor(['nonsense', 'data:analyze'], path)
    expect(o?.plugins.map((p) => p.path)).toEqual(['/plugins/data'])
    expect(o?.skills).toEqual(['data:analyze'])
  })
})

describe('SKILL_CATALOG', () => {
  it('exposes the four expected plugins', () => {
    expect(SKILL_CATALOG.map((p) => p.id).sort()).toEqual([
      'data',
      'design',
      'engineering',
      'frontend-design'
    ])
  })

  it('every skill id is plugin-qualified (plugin:skill) and matches its plugin', () => {
    for (const plugin of SKILL_CATALOG) {
      expect(plugin.skills.length).toBeGreaterThan(0)
      for (const s of plugin.skills) {
        expect(s.id.startsWith(plugin.id + ':')).toBe(true)
        expect(s.label.length).toBeGreaterThan(0)
      }
    }
  })

  it('catalogSkillIds() returns every known id and they are unique', () => {
    const ids = catalogSkillIds()
    expect(ids.length).toBe(new Set(ids).size)
    expect(ids).toContain('engineering:debug')
    expect(ids).toContain('design:design-system')
  })
})
