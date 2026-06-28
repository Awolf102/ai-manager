import { describe, it, expect } from 'vitest'
import {
  isTrusted, isAnthropicOwnedRepo, pluginShipsHooks, shapeCatalog,
  skillOptionsFor, offeredSkills
} from './skill-trust'
import type { DiscoveredPlugin } from './types'

const ghAnthropic = { source: 'github', repo: 'anthropics/claude-plugins-official' }
const ghOther = { source: 'github', repo: 'someone/community-pack' }

describe('isAnthropicOwnedRepo', () => {
  it('accepts a github source owned by anthropics, various spellings', () => {
    expect(isAnthropicOwnedRepo(ghAnthropic)).toBe(true)
    expect(isAnthropicOwnedRepo({ source: 'github', repo: 'github.com/anthropics/x' })).toBe(true)
    expect(isAnthropicOwnedRepo({ source: 'github', repo: 'https://github.com/Anthropics/X' })).toBe(true)
  })
  it('rejects look-alikes, non-github sources, and junk', () => {
    expect(isAnthropicOwnedRepo({ source: 'github', repo: 'anthropics-evil/x' })).toBe(false)
    expect(isAnthropicOwnedRepo({ source: 'github', repo: 'notanthropics/x' })).toBe(false)
    expect(isAnthropicOwnedRepo({ source: 'git', repo: 'anthropics/x' })).toBe(false)
    expect(isAnthropicOwnedRepo({ source: 'github', repo: '' })).toBe(false)
    expect(isAnthropicOwnedRepo(undefined)).toBe(false)
  })
})

describe('isTrusted', () => {
  it('anthropic-only: needs anthropic author AND an anthropics-owned repo', () => {
    expect(isTrusted({ author: 'Anthropic', marketplaceSource: ghAnthropic }, 'anthropic-only')).toBe(true)
    expect(isTrusted({ author: 'someone', marketplaceSource: ghAnthropic }, 'anthropic-only')).toBe(false)
    expect(isTrusted({ author: 'Anthropic', marketplaceSource: ghOther }, 'anthropic-only')).toBe(false)
  })
  it('anthropic-marketplaces: any member of an anthropics-owned repo passes', () => {
    expect(isTrusted({ author: 'someone', marketplaceSource: ghAnthropic }, 'anthropic-marketplaces')).toBe(true)
    expect(isTrusted({ author: 'Anthropic', marketplaceSource: ghOther }, 'anthropic-marketplaces')).toBe(false)
  })
})

describe('pluginShipsHooks', () => {
  it('true when any signal set, false when none', () => {
    expect(pluginShipsHooks({})).toBe(false)
    expect(pluginShipsHooks({ hasHooksJson: true })).toBe(true)
    expect(pluginShipsHooks({ hasPluginJsonHooksKey: true })).toBe(true)
    expect(pluginShipsHooks({ hooksDirNonEmpty: true })).toBe(true)
  })
})

describe('shapeCatalog', () => {
  const markets = { official: { source: ghAnthropic }, comm: { source: ghOther } }
  const cache = { catalog: { plugins: {
    'fd@official': { unique_installs: 5, marketplace_entry: { author: { name: 'Anthropic' }, description: 'd' }, components: { skills: [{ name: 'design' }] } },
    'third@official': { unique_installs: 999999, marketplace_entry: { author: { name: 'someone' }, description: 'd' }, components: { skills: [{ name: 's' }] } },
    'x@comm': { unique_installs: 999999, marketplace_entry: { author: { name: 'Anthropic' }, description: 'd' }, components: { skills: [{ name: 's' }] } }
  } } }
  it('anthropic-only keeps only the anthropic-authored plugin in an anthropics repo', () => {
    const out = shapeCatalog(cache, markets, 'anthropic-only')
    expect(out.map((p) => p.id)).toEqual(['fd'])
  })
  it('anthropic-marketplaces keeps all members of the anthropics repo, drops the community one', () => {
    const out = shapeCatalog(cache, markets, 'anthropic-marketplaces')
    expect(out.map((p) => p.id).sort()).toEqual(['fd', 'third'])
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
