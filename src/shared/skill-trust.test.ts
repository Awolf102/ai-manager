import { describe, it, expect } from 'vitest'
import { isTrusted, shapeCatalog, skillOptionsFor, offeredSkills } from './skill-trust'
import type { DiscoveredPlugin } from './types'

describe('isTrusted', () => {
  it('trusts Anthropic author regardless of installs', () => {
    expect(isTrusted({ author: 'Anthropic', uniqueInstalls: 3 }, 100000)).toBe(true)
    expect(isTrusted({ author: 'anthropic', uniqueInstalls: 0 }, 100000)).toBe(true)
  })
  it('trusts an anthropics/* marketplace repo', () => {
    expect(isTrusted({ marketplaceRepo: 'anthropics/claude-plugins-official', uniqueInstalls: 0 }, 100000)).toBe(true)
  })
  it('trusts a non-Anthropic plugin at/above the threshold', () => {
    expect(isTrusted({ author: 'Adobe', uniqueInstalls: 100000 }, 100000)).toBe(true)
    expect(isTrusted({ author: 'Adobe', uniqueInstalls: 250000 }, 100000)).toBe(true)
  })
  it('does NOT trust a non-Anthropic plugin below the threshold', () => {
    expect(isTrusted({ author: '42Crunch', uniqueInstalls: 1262 }, 100000)).toBe(false)
    expect(isTrusted({ uniqueInstalls: 99999 }, 100000)).toBe(false)
  })
})

describe('shapeCatalog', () => {
  const cache = {
    catalog: {
      plugins: {
        'data@knowledge-work-plugins': {
          unique_installs: 5,
          components: { skills: [{ name: 'airflow' }, { name: 'sql-queries' }] },
          marketplace_entry: { author: { name: 'Anthropic' }, description: 'Data work.' }
        },
        'adobe-for-creativity@claude-plugins-official': {
          unique_installs: 250000,
          components: { skills: [{ name: 'edit-image' }] },
          marketplace_entry: { author: { name: 'Adobe' }, description: 'Creative tools.' }
        },
        'tiny-thing@claude-plugins-official': {
          unique_installs: 12,
          components: { skills: [{ name: 'x' }] },
          marketplace_entry: { author: { name: 'Somebody' }, description: 'niche' }
        }
      }
    }
  }
  const marketplaces = {
    'knowledge-work-plugins': { source: { repo: 'anthropics/knowledge-work-plugins' }, installLocation: '/m/kw' },
    'claude-plugins-official': { source: { repo: 'anthropics/claude-plugins-official' }, installLocation: '/m/off' }
  }

  it('keeps trusted plugins, derives <plugin>:<skill> ids, drops untrusted', () => {
    const out = shapeCatalog(cache, marketplaces, 100000)
    const ids = out.map((p) => p.id).sort()
    // data trusted (Anthropic author), adobe trusted (250k>=100k); tiny-thing untrusted...
    // BUT tiny-thing's marketplace repo is anthropics/* → it IS trusted by repo.
    expect(ids).toEqual(['adobe-for-creativity', 'data', 'tiny-thing'])
    const data = out.find((p) => p.id === 'data')!
    expect(data.skills.map((s) => s.id)).toEqual(['data:airflow', 'data:sql-queries'])
    expect(data.marketplaceRepo).toBe('anthropics/knowledge-work-plugins')
    expect(data.author).toBe('Anthropic')
  })

  it('drops a non-anthropics, sub-threshold plugin', () => {
    const cache2 = {
      catalog: {
        plugins: {
          'niche@third-party': {
            unique_installs: 10,
            components: { skills: [{ name: 'x' }] },
            marketplace_entry: { author: { name: 'Someone' }, description: '' }
          }
        }
      }
    }
    const mk2 = { 'third-party': { source: { repo: 'someone/plugins' }, installLocation: '/m/tp' } }
    expect(shapeCatalog(cache2, mk2, 100000)).toEqual([])
  })

  it('tolerates missing/garbage input', () => {
    expect(shapeCatalog(null, null, 100000)).toEqual([])
    expect(shapeCatalog({ catalog: {} }, {}, 100000)).toEqual([])
  })
})

describe('skillOptionsFor', () => {
  const discovered: DiscoveredPlugin[] = [
    {
      id: 'data', marketplace: 'kw', marketplaceRepo: 'anthropics/kw', author: 'Anthropic',
      uniqueInstalls: 5, trusted: true, path: '/p/data',
      skills: [{ id: 'data:airflow', name: 'airflow', description: '' }]
    }
  ]
  it('returns null when nothing assigned or nothing matches', () => {
    expect(skillOptionsFor([], discovered)).toBeNull()
    expect(skillOptionsFor(['nope:gone'], discovered)).toBeNull()
  })
  it('builds plugins+skills only for assigned skills that exist in discovered', () => {
    const out = skillOptionsFor(['data:airflow', 'data:missing', 'ghost:x'], discovered)!
    expect(out.skills).toEqual(['data:airflow']) // missing/ghost dropped
    expect(out.plugins).toEqual([{ type: 'local', path: '/p/data', skipMcpDiscovery: true }])
  })
})

describe('offeredSkills', () => {
  const mk = (id: string, installs: number): DiscoveredPlugin => ({
    id, marketplace: 'm', marketplaceRepo: 'r', author: 'a', uniqueInstalls: installs, trusted: true,
    path: '/p', skills: [{ id: `${id}:s`, name: 's', description: 'd' }]
  })
  it('flattens skills ranked by Anthropic-then-installs, and caps the count', () => {
    const out = offeredSkills([mk('a', 1), mk('b', 2), mk('c', 3)], 2)
    expect(out.length).toBe(2)
    expect(out.map((o) => o.id)).toEqual(['c:s', 'b:s']) // highest installs first
  })
  it('ranks Anthropic-authored plugins ahead of higher-install non-Anthropic ones', () => {
    const anthro = { ...mk('z', 1), author: 'Anthropic' }
    const out = offeredSkills([mk('a', 500000), anthro], 2)
    expect(out.map((o) => o.id)).toEqual(['z:s', 'a:s']) // Anthropic first despite far fewer installs
  })
})
