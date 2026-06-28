// Pure trust + catalog logic for installed Claude Code skill plugins. No node/DOM
// imports — unit-tested in plain Node. The fs reads live in main/engine/skill-discovery.ts,
// which feeds already-parsed JSON into shapeCatalog here.
import type { DiscoveredPlugin, DiscoveredSkill } from './types'

export type SkillTrustMode = 'anthropic-only' | 'anthropic-marketplaces'

function isAnthropicAuthor(author: unknown): boolean {
  return String(author ?? '').trim().toLowerCase() === 'anthropic'
}

/** True iff `source` is a github-type marketplace source whose owner is exactly `anthropics`.
 *  Accepts 'owner/name', 'github.com/owner/name', 'https://github.com/owner/name'. */
export function isAnthropicOwnedRepo(source: unknown): boolean {
  const s = source as { source?: unknown; repo?: unknown } | null
  if (!s || typeof s !== 'object') return false
  if (String(s.source ?? '').trim().toLowerCase() !== 'github') return false
  const repo = String(s.repo ?? '').trim().toLowerCase()
  if (!repo) return false
  const path = repo.replace(/^https?:\/\//, '').replace(/^github\.com\//, '')
  return path.split('/')[0] === 'anthropics'
}

/** True if a plugin dir ships any hooks (hooks run code). */
export function pluginShipsHooks(signals: {
  hasHooksJson?: boolean
  hasPluginJsonHooksKey?: boolean
  hooksDirNonEmpty?: boolean
}): boolean {
  return !!(signals.hasHooksJson || signals.hasPluginJsonHooksKey || signals.hooksDirNonEmpty)
}

/** A plugin is trusted per the mode. Both modes require a verified anthropics-owned repo;
 *  'anthropic-only' additionally requires the plugin's own author to be Anthropic. */
export function isTrusted(
  p: { author?: string; marketplaceSource?: unknown },
  mode: SkillTrustMode
): boolean {
  if (!isAnthropicOwnedRepo(p.marketplaceSource)) return false
  if (mode === 'anthropic-marketplaces') return true
  return isAnthropicAuthor(p.author)
}

/** Shape the parsed catalog-cache + known-marketplaces into trusted plugin candidates (no on-disk path). */
export function shapeCatalog(
  cacheJson: unknown,
  marketplacesJson: unknown,
  mode: SkillTrustMode
): Omit<DiscoveredPlugin, 'path'>[] {
  const plugins = (cacheJson as { catalog?: { plugins?: Record<string, unknown> } })?.catalog?.plugins
  if (!plugins || typeof plugins !== 'object') return []
  const markets = (marketplacesJson as Record<string, { source?: { source?: string; repo?: string } }>) ?? {}
  const out: Omit<DiscoveredPlugin, 'path'>[] = []
  for (const [key, raw] of Object.entries(plugins)) {
    const at = key.lastIndexOf('@')
    if (at <= 0) continue
    const pluginId = key.slice(0, at)
    const marketplace = key.slice(at + 1)
    const e = raw as {
      unique_installs?: unknown
      components?: { skills?: { name?: unknown }[] }
      marketplace_entry?: { author?: { name?: unknown }; description?: unknown }
    }
    const marketplaceSource = markets[marketplace]?.source
    const marketplaceRepo = String(marketplaceSource?.repo ?? '')
    const authorName = e.marketplace_entry?.author?.name
    const author = typeof authorName === 'string' ? authorName : ''
    const uniqueInstalls = typeof e.unique_installs === 'number' ? e.unique_installs : 0
    if (!isTrusted({ author, marketplaceSource }, mode)) continue
    const description = String(e.marketplace_entry?.description ?? '')
    const skills: DiscoveredSkill[] = (e.components?.skills ?? [])
      .map((s) => String(s?.name ?? '').trim())
      .filter((n) => n)
      .map((name) => ({ id: `${pluginId}:${name}`, name, description }))
    if (skills.length === 0) continue
    out.push({ id: pluginId, marketplace, marketplaceRepo, author, uniqueInstalls, trusted: true, skills })
  }
  return out
}

export interface SkillSdkOptions {
  plugins: { type: 'local'; path: string; skipMcpDiscovery: true }[]
  skills: string[]
}

/** Build the SDK plugins+skills options from an agent's assigned ids, restricted to discovered (trusted) skills. */
export function skillOptionsFor(
  assigned: string[] | undefined,
  discovered: DiscoveredPlugin[]
): SkillSdkOptions | null {
  const pathByPlugin = new Map(discovered.map((p) => [p.id, p.path]))
  const known = new Set(discovered.flatMap((p) => p.skills.map((s) => s.id)))
  const valid = (assigned ?? []).filter((s) => known.has(s))
  if (valid.length === 0) return null
  // valid ids are always '<plugin>:<skill>' (filtered via `known`); guard anyway.
  const pluginIds = [...new Set(valid.map((s) => (s.includes(':') ? s.slice(0, s.indexOf(':')) : s)))]
  return {
    plugins: pluginIds
      .map((id) => pathByPlugin.get(id))
      .filter((p): p is string => !!p)
      .map((path) => ({ type: 'local', path, skipMcpDiscovery: true })),
    skills: valid
  }
}

/** A condensed, capped list of skills (id + description) to offer the orchestrator in spawn/draft prompts. */
export function offeredSkills(discovered: DiscoveredPlugin[], cap: number): { id: string; description: string }[] {
  const ranked = [...discovered].sort((a, b) => {
    const aA = a.author.trim().toLowerCase() === 'anthropic' ? 1 : 0
    const bA = b.author.trim().toLowerCase() === 'anthropic' ? 1 : 0
    if (aA !== bA) return bA - aA // Anthropic plugins first
    return b.uniqueInstalls - a.uniqueInstalls // then highest installs
  })
  const all = ranked.flatMap((p) => p.skills.map((s) => ({ id: s.id, description: s.description })))
  return all.slice(0, cap)
}
