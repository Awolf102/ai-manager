// Discover the skills of TRUSTED installed Claude Code plugins from ~/.claude/plugins.
// Pure trust/shape logic lives in shared/skill-trust.ts; this module does the fs reads,
// resolves each plugin's on-disk skills dir, and falls back to an Anthropic-only scan
// when the (internal, undocumented) catalog cache is missing.
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DiscoveredPlugin, DiscoveredSkill } from '../../shared/types'
import { shapeCatalog, isAnthropicOwnedRepo, pluginShipsHooks, type SkillTrustMode } from '../../shared/skill-trust'

function pluginsDir(root?: string): string {
  return root ?? join(homedir(), '.claude', 'plugins')
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** Candidate on-disk dirs for a plugin, first whose skills/ exists wins. */
function candidatePaths(
  pluginId: string,
  marketplace: string,
  installLocation: string | undefined,
  installPath: string | undefined
): string[] {
  const paths: string[] = []
  if (installPath) paths.push(installPath) // installed → cache/<marketplace>/<plugin>/<version>
  if (installLocation) {
    paths.push(join(installLocation, pluginId)) // self-contained marketplace (knowledge-work-plugins)
    paths.push(join(installLocation, 'plugins', pluginId)) // claude-plugins-official layout
  }
  return paths
}

/** On-disk hook signals for a resolved plugin dir. */
async function pluginHookSignals(path: string): Promise<Parameters<typeof pluginShipsHooks>[0]> {
  const hasHooksJson = existsSync(join(path, 'hooks', 'hooks.json'))
  let hasPluginJsonHooksKey = false
  try {
    const pj = JSON.parse(await fs.readFile(join(path, '.claude-plugin', 'plugin.json'), 'utf8'))
    hasPluginJsonHooksKey = !!pj && typeof pj === 'object' && 'hooks' in pj
  } catch { /* no/invalid plugin.json */ }
  let hooksDirNonEmpty = false
  try { hooksDirNonEmpty = (await fs.readdir(join(path, 'hooks'))).length > 0 } catch { /* no hooks dir */ }
  return { hasHooksJson, hasPluginJsonHooksKey, hooksDirNonEmpty }
}

export async function discoverSkills(opts: {
  mode: SkillTrustMode
  blockHooks: boolean
  root?: string
}): Promise<DiscoveredPlugin[]> {
  const { mode, blockHooks, root } = opts
  const dir = pluginsDir(root)
  if (!existsSync(dir)) return []
  const marketplacesJson = (await readJson(join(dir, 'known_marketplaces.json'))) as Record<
    string,
    { source?: { source?: string; repo?: string }; installLocation?: string }
  > | null
  const cacheJson = await readJson(join(dir, 'plugin-catalog-cache.json'))

  if (!cacheJson) return fallbackScan(marketplacesJson, mode, blockHooks)

  const installed = (await readJson(join(dir, 'installed_plugins.json'))) as {
    plugins?: Record<string, { installPath?: string }[]>
  } | null
  const installPathByKey = new Map<string, string>()
  for (const [key, arr] of Object.entries(installed?.plugins ?? {})) {
    const ip = arr?.[0]?.installPath // user-scope (first) entry wins; subdir candidates cover the rest
    if (ip) installPathByKey.set(key, ip)
  }

  const candidates = shapeCatalog(cacheJson, marketplacesJson, mode)
  const out: DiscoveredPlugin[] = []
  for (const c of candidates) {
    const installLocation = marketplacesJson?.[c.marketplace]?.installLocation
    const installPath = installPathByKey.get(`${c.id}@${c.marketplace}`)
    const path = candidatePaths(c.id, c.marketplace, installLocation, installPath).find((p) =>
      existsSync(join(p, 'skills'))
    )
    if (!path) continue
    if (blockHooks && pluginShipsHooks(await pluginHookSignals(path))) continue
    out.push({ ...c, path })
  }
  return out
}

/** Anthropic-marketplace filesystem fallback when the catalog cache is unavailable.
 *  In 'anthropic-only' mode we cannot establish per-plugin authorship → trust nothing. */
async function fallbackScan(
  marketplaces: Record<string, { source?: { source?: string; repo?: string }; installLocation?: string }> | null,
  mode: SkillTrustMode,
  blockHooks: boolean
): Promise<DiscoveredPlugin[]> {
  if (mode === 'anthropic-only') return []
  const out: DiscoveredPlugin[] = []
  const seen = new Set<string>()
  for (const [marketplace, m] of Object.entries(marketplaces ?? {})) {
    if (!isAnthropicOwnedRepo(m.source)) continue
    const repo = String(m.source?.repo ?? '')
    const loc = m.installLocation
    if (!loc) continue
    for (const baseRel of ['', 'plugins']) {
      const base = baseRel ? join(loc, baseRel) : loc
      let entries: { name: string; isDirectory: () => boolean }[]
      try { entries = await fs.readdir(base, { withFileTypes: true }) } catch { continue }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue
        const pluginPath = join(base, ent.name)
        const skillsDir = join(pluginPath, 'skills')
        if (!existsSync(skillsDir)) continue
        let names: string[]
        try {
          names = (await fs.readdir(skillsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
        } catch { continue }
        if (names.length === 0) continue
        if (seen.has(ent.name)) continue
        if (blockHooks && pluginShipsHooks(await pluginHookSignals(pluginPath))) continue
        seen.add(ent.name)
        const skills: DiscoveredSkill[] = names.map((name) => ({ id: `${ent.name}:${name}`, name, description: '' }))
        out.push({
          id: ent.name, marketplace, marketplaceRepo: repo, author: 'Anthropic',
          uniqueInstalls: 0, trusted: true, path: pluginPath, skills
        })
      }
    }
  }
  return out
}
