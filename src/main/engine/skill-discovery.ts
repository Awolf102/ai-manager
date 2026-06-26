// Discover the skills of TRUSTED installed Claude Code plugins from ~/.claude/plugins.
// Pure trust/shape logic lives in shared/skill-trust.ts; this module does the fs reads,
// resolves each plugin's on-disk skills dir, and falls back to an Anthropic-only scan
// when the (internal, undocumented) catalog cache is missing.
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DiscoveredPlugin, DiscoveredSkill } from '../../shared/types'
import { shapeCatalog, isTrusted } from '../../shared/skill-trust'

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

export async function discoverSkills(threshold: number, root?: string): Promise<DiscoveredPlugin[]> {
  const dir = pluginsDir(root)
  if (!existsSync(dir)) return []
  const marketplacesJson = (await readJson(join(dir, 'known_marketplaces.json'))) as Record<
    string,
    { source?: { repo?: string }; installLocation?: string }
  > | null
  const cacheJson = await readJson(join(dir, 'plugin-catalog-cache.json'))

  // Fallback: no catalog cache → scan marketplaces, Anthropic-only.
  if (!cacheJson) return fallbackScan(marketplacesJson)

  const installed = (await readJson(join(dir, 'installed_plugins.json'))) as {
    plugins?: Record<string, { installPath?: string }[]>
  } | null
  const installPathByKey = new Map<string, string>()
  for (const [key, arr] of Object.entries(installed?.plugins ?? {})) {
    const ip = arr?.[0]?.installPath // user-scope (first) entry wins; subdir candidates cover the rest
    if (ip) installPathByKey.set(key, ip)
  }

  const candidates = shapeCatalog(cacheJson, marketplacesJson, threshold)
  const out: DiscoveredPlugin[] = []
  for (const c of candidates) {
    const installLocation = marketplacesJson?.[c.marketplace]?.installLocation
    const installPath = installPathByKey.get(`${c.id}@${c.marketplace}`)
    const path = candidatePaths(c.id, c.marketplace, installLocation, installPath).find((p) =>
      existsSync(join(p, 'skills'))
    )
    if (!path) continue
    out.push({ ...c, path })
  }
  return out
}

/** Anthropic-only filesystem fallback when the catalog cache is unavailable. */
async function fallbackScan(
  marketplaces: Record<string, { source?: { repo?: string }; installLocation?: string }> | null
): Promise<DiscoveredPlugin[]> {
  const out: DiscoveredPlugin[] = []
  const seen = new Set<string>()
  for (const [marketplace, m] of Object.entries(marketplaces ?? {})) {
    const repo = String(m.source?.repo ?? '')
    if (!isTrusted({ marketplaceRepo: repo }, Number.POSITIVE_INFINITY)) continue // anthropics/* only
    const loc = m.installLocation
    if (!loc) continue
    // plugins are either top-level subdirs or under plugins/<name>
    for (const baseRel of ['', 'plugins']) {
      const base = baseRel ? join(loc, baseRel) : loc
      let entries: { name: string; isDirectory: () => boolean }[]
      try {
        entries = await fs.readdir(base, { withFileTypes: true })
      } catch {
        continue
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue
        const pluginPath = join(base, ent.name)
        const skillsDir = join(pluginPath, 'skills')
        if (!existsSync(skillsDir)) continue
        let names: string[]
        try {
          names = (await fs.readdir(skillsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
        } catch {
          continue
        }
        if (names.length === 0) continue
        const skills: DiscoveredSkill[] = names.map((name) => ({ id: `${ent.name}:${name}`, name, description: '' }))
        if (seen.has(ent.name)) continue
        seen.add(ent.name)
        out.push({
          id: ent.name, marketplace, marketplaceRepo: repo, author: 'Anthropic',
          uniqueInstalls: 0, trusted: true, path: pluginPath, skills
        })
      }
    }
  }
  return out
}
