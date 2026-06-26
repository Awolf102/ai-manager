# Trusted Skill Catalog + Auto-Assigned Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-discover the skills of *trusted* installed Claude Code plugins (Anthropic-published, or ≥100k installs) and have the orchestrator equip dynamically-spawned/drafted agents with the relevant ones — replacing today's hardcoded skill catalog.

**Architecture:** A pure, unit-tested core (`shared/skill-trust.ts`: `isTrusted`/`shapeCatalog`/`skillOptionsFor`/`offeredSkills`) does the trust logic over already-parsed JSON. An impure `main/engine/skill-discovery.ts` reads Claude Code's local plugin metadata (`~/.claude/plugins/{installed_plugins,plugin-catalog-cache,known_marketplaces}.json`), resolves on-disk skill dirs, and falls back to an Anthropic-only filesystem scan. `agent-runner` consumes discovery instead of the hardcoded catalog; the AgentConfigPanel lists trusted skills; and Build-team / Draft-roles let the orchestrator assign skills per member.

**Tech Stack:** TypeScript, Electron (main + preload + React renderer), Zustand store, vitest. No new dependencies.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-26-trusted-skill-catalog-design.md`.
- **No new dependencies.** Use `node:fs`/`node:os`/`node:path` only.
- **Trust rule (verbatim):** a plugin is trusted iff its author is "Anthropic" (case-insensitive), OR its marketplace's GitHub repo starts with `anthropics/`, OR its `unique_installs >= threshold`. Threshold default **100000**, from `ProjectSettings.skillInstallThreshold`.
- **Skill id format:** `<plugin>:<skill-name>` (e.g. `data:airflow`) — matches the existing convention; nothing downstream changes.
- **Local files (all under `~/.claude/plugins/`):** `installed_plugins.json` (`{plugins:{"<plugin>@<marketplace>":[{installPath,…}]}}`), `plugin-catalog-cache.json` (`{catalog:{plugins:{"<plugin>@<marketplace>":{components:{skills:[{name}]},unique_installs,marketplace_entry:{author:{name},description}}}}}`), `known_marketplaces.json` (`{"<marketplace>":{source:{repo},installLocation}}`). The catalog cache is **internal/undocumented** — parse tolerantly.
- **Never throw into a run.** Discovery failures degrade to an empty (or Anthropic-only fallback) catalog; the app then behaves as it does today with no skills installed.
- **Per-agent skill cap:** auto-assignment keeps **≤5** skills per member; the catalog offered to the orchestrator prompt is capped to **≤40** condensed entries.
- **Backward compatibility:** a project with no trusted/installed skills behaves exactly as today (no skills loaded).
- **House testing precedent:** pure `shared/*` modules + parse logic are unit-tested; `agent-runner`/IPC/preload/renderer are verified by `npm run typecheck` + `npm run build`.
- **Test runner:** `npx vitest run <file>` for one file; `npm test` for all; `npm run typecheck` + `npm run build` for the non-unit layers.
- **Commits:** every commit message ends with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Types + pure trust/catalog core (`shared/skill-trust.ts`)

The additive types and the fully-unit-tested pure core: trust predicate, catalog shaping over parsed JSON, the SDK-options builder, and the offered-skills condenser. No behavior change elsewhere yet.

**Files:**
- Modify: `src/shared/types.ts` (add `DiscoveredSkill`/`DiscoveredPlugin`; `ProjectSettings.skillInstallThreshold` + `DEFAULT_SETTINGS`; `SpawnedMember.skills?`)
- Create: `src/shared/skill-trust.ts`
- Create: `src/shared/skill-trust.test.ts`

**Interfaces:**
- Produces: `DiscoveredSkill { id: string; name: string; description: string }`
- Produces: `DiscoveredPlugin { id: string; marketplace: string; marketplaceRepo: string; author: string; uniqueInstalls: number; trusted: boolean; path: string; skills: DiscoveredSkill[] }`
- Produces: `isTrusted(p: { author?: string; marketplaceRepo?: string; uniqueInstalls?: number }, threshold: number): boolean`
- Produces: `shapeCatalog(cacheJson: unknown, marketplacesJson: unknown, threshold: number): Omit<DiscoveredPlugin, 'path'>[]`
- Produces: `skillOptionsFor(assigned: string[] | undefined, discovered: DiscoveredPlugin[]): SkillSdkOptions | null` where `SkillSdkOptions { plugins: { type: 'local'; path: string; skipMcpDiscovery: true }[]; skills: string[] }`
- Produces: `offeredSkills(discovered: DiscoveredPlugin[], cap: number): { id: string; description: string }[]`
- Produces: `ProjectSettings.skillInstallThreshold: number`; `SpawnedMember.skills?: string[]`

- [ ] **Step 1: Add the types (`src/shared/types.ts`)**

Add the two discovery interfaces (place them near `SpawnedMember`, e.g. right after the `SpawnedMember` interface):

```ts
/** A skill offered by a trusted installed plugin (discovered from ~/.claude/plugins). */
export interface DiscoveredSkill {
  id: string // plugin-qualified id passed to the SDK `skills` option, e.g. 'data:airflow'
  name: string
  description: string
}

/** A trusted installed plugin and its skills, resolved to an on-disk path. */
export interface DiscoveredPlugin {
  id: string // plugin name (the `skills` prefix)
  marketplace: string // marketplace name it came from
  marketplaceRepo: string // the marketplace's GitHub repo (e.g. 'anthropics/...')
  author: string // publisher (marketplace_entry.author.name), '' if unknown
  uniqueInstalls: number // 0 if unknown
  trusted: boolean // always true for surfaced plugins (kept for clarity)
  path: string // on-disk plugin dir containing skills/
  skills: DiscoveredSkill[]
}
```

Add `skills?` to `SpawnedMember`:

```ts
export interface SpawnedMember {
  id: string
  name: string
  kind: 'manager' | 'worker'
  role: string
  reportsTo: string
  skills?: string[]
}
```

Add the setting to `ProjectSettings` (after `autoSyncTeam`):

```ts
  /** auto pull the linked team brain before a run + push after (B2b) */
  autoSyncTeam: boolean
  /** install-count floor for trusting a non-Anthropic plugin's skills */
  skillInstallThreshold: number
```

And to `DEFAULT_SETTINGS`:

```ts
export const DEFAULT_SETTINGS: ProjectSettings = {
  reviewMode: 'loop',
  maxRepairAttempts: 3,
  reflection: true,
  autonomy: 'auto',
  adaptiveEffort: true,
  autoSyncTeam: false,
  skillInstallThreshold: 100000
}
```

- [ ] **Step 2: Write the failing tests (`src/shared/skill-trust.test.ts`)**

```ts
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
  it('flattens skills and caps the count', () => {
    const out = offeredSkills([mk('a', 1), mk('b', 2), mk('c', 3)], 2)
    expect(out.length).toBe(2)
    expect(out[0]).toEqual({ id: 'a:s', description: 'd' })
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/shared/skill-trust.test.ts`
Expected: FAIL — `./skill-trust` cannot be resolved.

- [ ] **Step 4: Implement the pure module (`src/shared/skill-trust.ts`)**

```ts
// Pure trust + catalog logic for installed Claude Code skill plugins. No node/DOM
// imports — unit-tested in plain Node. The fs reads live in main/engine/skill-discovery.ts,
// which feeds already-parsed JSON into shapeCatalog here.
import type { DiscoveredPlugin, DiscoveredSkill } from './types'

/** A plugin is trusted iff: Anthropic author, OR an anthropics/* marketplace repo, OR installs >= threshold. */
export function isTrusted(
  p: { author?: string; marketplaceRepo?: string; uniqueInstalls?: number },
  threshold: number
): boolean {
  if ((p.author ?? '').trim().toLowerCase() === 'anthropic') return true
  if ((p.marketplaceRepo ?? '').toLowerCase().startsWith('anthropics/')) return true
  return (p.uniqueInstalls ?? 0) >= threshold
}

export interface SkillSdkOptions {
  plugins: { type: 'local'; path: string; skipMcpDiscovery: true }[]
  skills: string[]
}

/** Shape the parsed catalog-cache + known-marketplaces into trusted plugin candidates (no on-disk path). */
export function shapeCatalog(
  cacheJson: unknown,
  marketplacesJson: unknown,
  threshold: number
): Omit<DiscoveredPlugin, 'path'>[] {
  const plugins = (cacheJson as { catalog?: { plugins?: Record<string, unknown> } })?.catalog?.plugins
  if (!plugins || typeof plugins !== 'object') return []
  const markets = (marketplacesJson as Record<string, { source?: { repo?: string } }>) ?? {}
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
    const marketplaceRepo = String(markets[marketplace]?.source?.repo ?? '')
    const authorName = e.marketplace_entry?.author?.name
    const author = typeof authorName === 'string' ? authorName : ''
    const uniqueInstalls = typeof e.unique_installs === 'number' ? e.unique_installs : 0
    if (!isTrusted({ author, marketplaceRepo, uniqueInstalls }, threshold)) continue
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

/** Build the SDK plugins+skills options from an agent's assigned ids, restricted to discovered (trusted) skills. */
export function skillOptionsFor(
  assigned: string[] | undefined,
  discovered: DiscoveredPlugin[]
): SkillSdkOptions | null {
  const pathByPlugin = new Map(discovered.map((p) => [p.id, p.path]))
  const known = new Set(discovered.flatMap((p) => p.skills.map((s) => s.id)))
  const valid = (assigned ?? []).filter((s) => known.has(s))
  if (valid.length === 0) return null
  const pluginIds = [...new Set(valid.map((s) => s.slice(0, s.indexOf(':'))))]
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
  const all = discovered.flatMap((p) => p.skills.map((s) => ({ id: s.id, description: s.description })))
  return all.slice(0, cap)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/shared/skill-trust.test.ts`
Expected: PASS (all in this file).

- [ ] **Step 6: Typecheck + full suite + commit**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full suite green (additions are additive/unused elsewhere so far).
```bash
git add src/shared/types.ts src/shared/skill-trust.ts src/shared/skill-trust.test.ts
git commit -m "feat(skills): trust types + pure skill-trust core (isTrusted/shapeCatalog/skillOptionsFor)"
```

---

### Task 2: Discovery (`skill-discovery.ts`) + `skills:list` IPC

The impure layer that reads `~/.claude/plugins`, resolves on-disk skill dirs, falls back to an Anthropic-only scan, and exposes the trusted catalog to the renderer.

**Files:**
- Create: `src/main/engine/skill-discovery.ts`
- Create: `src/main/engine/skill-discovery.test.ts`
- Modify: `src/shared/types.ts` (IPC `listSkills` + `RendererApi.listSkills`)
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc.ts`

**Interfaces:**
- Consumes: `shapeCatalog`, `DiscoveredPlugin` (Task 1); `getSettings` (project-store).
- Produces: `discoverSkills(threshold: number, pluginsRoot?: string): Promise<DiscoveredPlugin[]>`
- Produces: IPC `listSkills: 'skills:list'`; `RendererApi.listSkills(): Promise<DiscoveredPlugin[]>`

- [ ] **Step 1: Write the failing discovery test (`src/main/engine/skill-discovery.test.ts`)**

```ts
import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverSkills } from './skill-discovery'

async function fixtureRoot(): Promise<string> {
  const root = join(tmpdir(), `aim-skills-${Math.random().toString(36).slice(2)}`)
  const mkDir = join(root, 'marketplaces', 'knowledge-work-plugins')
  const offDir = join(root, 'marketplaces', 'claude-plugins-official')
  // on-disk skills for: data (anthropics/kw, subdir layout) + adobe (cache install layout)
  await fs.mkdir(join(mkDir, 'data', 'skills', 'airflow'), { recursive: true })
  await fs.writeFile(join(mkDir, 'data', 'skills', 'airflow', 'SKILL.md'), '---\nname: airflow\n---\n', 'utf8')
  await fs.mkdir(join(root, 'cache', 'claude-plugins-official', 'adobe-for-creativity', '1.1.0', 'skills', 'edit-image'), { recursive: true })
  await fs.mkdir(join(offDir, '.claude-plugin'), { recursive: true })

  await fs.writeFile(join(root, 'known_marketplaces.json'), JSON.stringify({
    'knowledge-work-plugins': { source: { repo: 'anthropics/knowledge-work-plugins' }, installLocation: mkDir },
    'claude-plugins-official': { source: { repo: 'anthropics/claude-plugins-official' }, installLocation: offDir }
  }), 'utf8')
  await fs.writeFile(join(root, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'adobe-for-creativity@claude-plugins-official': [
        { scope: 'user', installPath: join(root, 'cache', 'claude-plugins-official', 'adobe-for-creativity', '1.1.0'), version: '1.1.0' }
      ]
    }
  }), 'utf8')
  await fs.writeFile(join(root, 'plugin-catalog-cache.json'), JSON.stringify({
    version: 1, fetchedAt: 'x',
    catalog: { plugins: {
      'data@knowledge-work-plugins': { unique_installs: 5, components: { skills: [{ name: 'airflow' }] }, marketplace_entry: { author: { name: 'Anthropic' }, description: 'Data.' } },
      'adobe-for-creativity@claude-plugins-official': { unique_installs: 250000, components: { skills: [{ name: 'edit-image' }] }, marketplace_entry: { author: { name: 'Adobe' }, description: 'Creative.' } },
      'ghost@claude-plugins-official': { unique_installs: 999999, components: { skills: [{ name: 'g' }] }, marketplace_entry: { author: { name: 'X' }, description: 'no files on disk' } }
    } }
  }), 'utf8')
  return root
}

describe('discoverSkills', () => {
  it('returns trusted plugins whose skills dir exists on disk', async () => {
    const root = await fixtureRoot()
    const out = await discoverSkills(100000, root)
    const ids = out.map((p) => p.id).sort()
    // data (subdir layout) + adobe (cache installPath layout); ghost dropped (no skills dir on disk)
    expect(ids).toEqual(['adobe-for-creativity', 'data'])
    expect(out.find((p) => p.id === 'data')!.skills.map((s) => s.id)).toEqual(['data:airflow'])
    expect(out.find((p) => p.id === 'data')!.path).toContain(join('knowledge-work-plugins', 'data'))
  })

  it('returns [] when the plugins root does not exist', async () => {
    expect(await discoverSkills(100000, join(tmpdir(), 'aim-nope-' + Math.random()))).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/engine/skill-discovery.test.ts`
Expected: FAIL — `discoverSkills` not exported.

- [ ] **Step 3: Implement discovery (`src/main/engine/skill-discovery.ts`)**

```ts
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
    const ip = arr?.[0]?.installPath
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
        out.push({
          id: ent.name, marketplace, marketplaceRepo: repo, author: 'Anthropic',
          uniqueInstalls: 0, trusted: true, path: pluginPath, skills
        })
      }
    }
  }
  return out
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/main/engine/skill-discovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the IPC channel + API + handler**

In `src/shared/types.ts`, in the `IPC` map after `contextThumbnail: 'context:thumbnail'`:
```ts
  contextThumbnail: 'context:thumbnail',
  listSkills: 'skills:list'
```

In `RendererApi`, after `getPathForFile: (file: File) => string`:
```ts
  getPathForFile: (file: File) => string
  listSkills: () => Promise<DiscoveredPlugin[]>
```
(Ensure `DiscoveredPlugin` is imported in the `RendererApi` file's type imports — it's defined in the same `types.ts`, so it's in scope.)

In `src/preload/index.ts`, after `getPathForFile: (file) => webUtils.getPathForFile(file),`:
```ts
  getPathForFile: (file) => webUtils.getPathForFile(file),
  listSkills: () => ipcRenderer.invoke(IPC.listSkills),
```

In `src/main/ipc.ts`: add the import and the handler. Near the top imports add:
```ts
import { discoverSkills } from './engine/skill-discovery'
```
At the end of `registerIpc()` (after the context handlers):
```ts
  // ---- skills ----
  ipcMain.handle(IPC.listSkills, () => discoverSkills(store.getSettings().skillInstallThreshold ?? 100000))
```

- [ ] **Step 6: Typecheck + build + full suite + commit**

Run: `npm run typecheck && npm run build && npm test`
Expected: all green.
```bash
git add src/main/engine/skill-discovery.ts src/main/engine/skill-discovery.test.ts src/shared/types.ts src/preload/index.ts src/main/ipc.ts
git commit -m "feat(skills): discoverSkills (trusted, on-disk-resolved) + skills:list IPC"
```

---

### Task 3: Rewire `agent-runner` to discovery

Replace the hardcoded `resolvePluginPath` + static-catalog `skillOptionsFor` with discovery. Cache discovery per run (it's consulted for every agent step). `skill-catalog.ts` stays for now (AgentConfigPanel still imports it; removed in Task 4).

**Files:**
- Modify: `src/main/engine/agent-runner.ts`

**Interfaces:**
- Consumes: `discoverSkills` (Task 2); `skillOptionsFor` (Task 1, from `shared/skill-trust`); `getSettings` (project-store).

- [ ] **Step 1: Swap the imports (`src/main/engine/agent-runner.ts`)**

Replace the skill-catalog import line:
```ts
import { skillOptionsFor } from '../../shared/skill-catalog'
```
with:
```ts
import { skillOptionsFor } from '../../shared/skill-trust'
import { discoverSkills } from './skill-discovery'
```
Add `getSettings` to the existing project-store import:
```ts
import { buildAgentContext, getSettings, updateAgent } from './project-store'
```

- [ ] **Step 2: Remove `resolvePluginPath` and add a per-run discovery cache**

Delete the `resolvePluginPath` function entirely. Above `streamAgent`, add a tiny cached discovery (read once, reused across the many agent steps in a run):
```ts
let discoveryCache: { at: number; plugins: import('../../shared/types').DiscoveredPlugin[] } | null = null

/** Discover trusted installed skills, cached briefly so a run doesn't re-read the catalog per agent step. */
async function discoveredPlugins(): Promise<import('../../shared/types').DiscoveredPlugin[]> {
  const now = Date.now()
  if (discoveryCache && now - discoveryCache.at < 30_000) return discoveryCache.plugins
  const plugins = await discoverSkills(getSettings().skillInstallThreshold ?? 100000)
  discoveryCache = { at: now, plugins }
  return plugins
}
```
(`Date.now()` is allowed in app code — this is the runtime, not a workflow script.)

- [ ] **Step 3: Use discovery in `streamAgent`**

Find the skills block in `streamAgent`:
```ts
    const skillOpts = skillOptionsFor(agent.skills, resolvePluginPath)
```
Replace it with:
```ts
    const skillOpts = skillOptionsFor(agent.skills, await discoveredPlugins())
```
(The rest of the block — `if (skillOpts) { … options.plugins = …; options.skills = … }` — depends on whether it still references `existsSync(p.path)`; since discovered paths already passed an on-disk check, simplify to load all of `skillOpts.plugins`. Replace the existing block body with:)
```ts
    const skillOpts = skillOptionsFor(agent.skills, await discoveredPlugins())
    if (skillOpts) {
      options.plugins = skillOpts.plugins
      options.skills = skillOpts.skills
    }
```

- [ ] **Step 4: Typecheck + build + full suite + commit**

Run: `npm run typecheck && npm run build && npm test`
Expected: all green. (`agent-runner` is not unit-tested per house precedent; `skillOptionsFor` is covered by Task 1. A project with no trusted skills yields `skillOptionsFor → null`, identical to today.)
```bash
git add src/main/engine/agent-runner.ts
git commit -m "feat(skills): agent-runner loads skills from discovery (drops hardcoded plugin paths)"
```

---

### Task 4: Dynamic AgentConfigPanel + Settings threshold; retire `skill-catalog.ts`

Make the skills picker dynamic from `skills:list`, add the trust-threshold Settings field, then delete the now-unused static catalog and update the dev script.

**Files:**
- Modify: `src/renderer/panels/AgentConfigPanel.tsx`
- Modify: `src/renderer/SettingsModal.tsx`
- Delete: `src/shared/skill-catalog.ts`
- Modify: `scripts/skills-check.mjs`

**Interfaces:**
- Consumes: `window.api.listSkills()` (Task 2); `ProjectSettings.skillInstallThreshold` (Task 1).

- [ ] **Step 1: Make the skills picker dynamic (`src/renderer/panels/AgentConfigPanel.tsx`)**

Replace the import:
```ts
import { SKILL_CATALOG } from '../../shared/skill-catalog'
```
with:
```ts
import { useEffect, useState } from 'react'
import type { DiscoveredPlugin } from '../../shared/types'
```
Inside the component, after the `assigned`/`toggleSkill` block, add catalog state:
```ts
  const [catalog, setCatalog] = useState<DiscoveredPlugin[]>([])
  useEffect(() => {
    void window.api.listSkills().then(setCatalog)
  }, [])
```
Replace the `<div className="skills-picker"> … </div>` body (the `SKILL_CATALOG.map(...)`) with:
```tsx
        <div className="skills-picker">
          {catalog.length === 0 && (
            <div className="muted" style={{ fontSize: 12 }}>
              No trusted skills found. Install plugins via Claude Code (`claude plugin marketplace add …`).
            </div>
          )}
          {catalog.map((plugin) => (
            <details key={plugin.id} className="skill-group">
              <summary>
                {plugin.id}{' '}
                <span className="muted">
                  · {plugin.author || plugin.marketplace}
                  {plugin.author?.toLowerCase() === 'anthropic'
                    ? ' ✓'
                    : plugin.uniqueInstalls
                      ? ` · ${Math.round(plugin.uniqueInstalls / 1000)}k installs`
                      : ''}
                </span>
              </summary>
              {plugin.skills.map((s) => (
                <label key={s.id} className="check skill-row" title={s.description}>
                  <input type="checkbox" checked={assigned.has(s.id)} onChange={() => toggleSkill(s.id)} />
                  {s.name}
                </label>
              ))}
            </details>
          ))}
        </div>
```

- [ ] **Step 2: Add the threshold field to Settings (`src/renderer/SettingsModal.tsx`)**

After the `autoSyncTeam` checkbox `<div className="field"> … </div>`, add:
```tsx
        <div className="field">
          <label>Trusted-skill install threshold</label>
          <input
            type="number"
            min={0}
            step={1000}
            value={s.skillInstallThreshold}
            onChange={(e) =>
              void update({ skillInstallThreshold: Math.max(0, Number(e.target.value) || 0) })
            }
          />
          <div className="radio-desc" style={{ marginTop: 4 }}>
            Non-Anthropic plugins are offered to agents only at/above this many installs. Anthropic plugins are always trusted.
          </div>
        </div>
```

- [ ] **Step 3: Delete the static catalog**

```bash
git rm src/shared/skill-catalog.ts
```
Confirm nothing imports it any more:
Run: `grep -rn "skill-catalog" src/ ; echo "exit: $?"`
Expected: no `src/` matches (exit 1 from grep = no matches).

- [ ] **Step 4: Update the dev script (`scripts/skills-check.mjs`)**

Replace the whole file with a self-contained scan of the trusted catalog (it can't import the TS modules):
```js
#!/usr/bin/env node
// Sanity-check which TRUSTED skill plugins the app will discover.
//   npm run skills:check
// Reads ~/.claude/plugins metadata the same way main/engine/skill-discovery.ts does.
// Filesystem/metadata check only — live loading is proven only by running the app.

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = join(homedir(), '.claude', 'plugins')
const read = (f) => {
  try {
    return JSON.parse(readFileSync(join(dir, f), 'utf8'))
  } catch {
    return null
  }
}
const THRESHOLD = 100000
const markets = read('known_marketplaces.json') ?? {}
const cache = read('plugin-catalog-cache.json')
const plugins = cache?.catalog?.plugins ?? {}

const trusted = (author, repo, installs) =>
  String(author ?? '').toLowerCase() === 'anthropic' ||
  String(repo ?? '').toLowerCase().startsWith('anthropics/') ||
  (installs ?? 0) >= THRESHOLD

console.log('\n  Trusted skill plugins the app will discover\n')
let n = 0
for (const [key, e] of Object.entries(plugins)) {
  const at = key.lastIndexOf('@')
  const id = key.slice(0, at)
  const marketplace = key.slice(at + 1)
  const repo = markets[marketplace]?.source?.repo
  const author = e.marketplace_entry?.author?.name
  const installs = e.unique_installs ?? 0
  if (!trusted(author, repo, installs)) continue
  const loc = markets[marketplace]?.installLocation
  const onDisk = loc && (existsSync(join(loc, id, 'skills')) || existsSync(join(loc, 'plugins', id, 'skills')))
  const skills = (e.components?.skills ?? []).map((s) => s.name)
  if (!skills.length) continue
  n++
  console.log(`  ${onDisk ? '✓' : '·'} ${id}  (${author || marketplace}, ${installs} installs, ${skills.length} skills)${onDisk ? '' : '  [not on disk]'}`)
}
if (n === 0) console.log('  (none — add a marketplace: claude plugin marketplace add anthropics/knowledge-work-plugins)')
console.log('')
```

- [ ] **Step 5: Typecheck + build + run the script + commit**

Run: `npm run typecheck && npm run build && npm test && node scripts/skills-check.mjs`
Expected: typecheck/build/tests green; the script prints the trusted plugins.
```bash
git add src/renderer/panels/AgentConfigPanel.tsx src/renderer/SettingsModal.tsx scripts/skills-check.mjs
git commit -m "feat(skills): dynamic skills picker + trust-threshold setting; retire static catalog"
```

---

### Task 5: Auto-assign skills in Build-team

Let the orchestrator pick per-member skills when proposing a team; persist them; show them in the preview.

**Files:**
- Modify: `src/shared/team-spawn.ts`
- Modify: `src/shared/team-spawn.test.ts`
- Modify: `src/main/engine/team-spawner.ts`
- Modify: `src/main/engine/project-store.ts` (`applySpawnedTeam`)
- Modify: `src/renderer/TeamSpawnModal.tsx`

**Interfaces:**
- Consumes: `SpawnedMember.skills?` (Task 1); `discoverSkills` (Task 2); `offeredSkills` (Task 1).
- Produces: `spawnTeamPrompt(goal, orchestratorName, existing, offered?)`; `parseSpawnedTeam(text, validSkillIds?)`.

- [ ] **Step 1: Write the failing tests (`src/shared/team-spawn.test.ts`)**

Add to the existing `describe('spawnTeamPrompt', …)` and `describe('parseSpawnedTeam', …)` blocks (import already present):
```ts
  it('offers the provided skills and asks for per-member skills', () => {
    const p = spawnTeamPrompt('build it', 'Boss', [], [{ id: 'data:airflow', description: 'pipelines' }])
    expect(p).toContain('data:airflow')
    expect(p).toMatch(/skills/i)
  })

  it('keeps only offered skill ids, caps at 5, drops unknown', () => {
    const valid = ['data:airflow', 'data:sql-queries', 'eng:a', 'eng:b', 'eng:c', 'eng:d']
    const text = '```json\n' + JSON.stringify({
      members: [{
        id: 'm1', name: 'Dev', kind: 'worker', role: '# Role', reportsTo: 'orchestrator',
        skills: ['data:airflow', 'ghost:x', 'data:sql-queries', 'eng:a', 'eng:b', 'eng:c', 'eng:d']
      }]
    }) + '\n```'
    const out = parseSpawnedTeam(text, valid)!
    expect(out[0].skills).toEqual(['data:airflow', 'data:sql-queries', 'eng:a', 'eng:b', 'eng:c']) // ghost dropped, capped to 5
  })

  it('omits skills when none are valid / none provided', () => {
    const text = '```json\n{"members":[{"id":"m1","name":"D","kind":"worker","role":"# R","reportsTo":"orchestrator"}]}\n```'
    expect(parseSpawnedTeam(text, ['data:airflow'])![0].skills).toBeUndefined()
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/shared/team-spawn.test.ts`
Expected: FAIL — `spawnTeamPrompt` takes no `offered` arg; `parseSpawnedTeam` takes no `validSkillIds`; no `skills` on output.

- [ ] **Step 3: Implement in `src/shared/team-spawn.ts`**

Change `spawnTeamPrompt`'s signature + body to accept offered skills:
```ts
export function spawnTeamPrompt(
  goal: string,
  orchestratorName: string,
  existing: { name: string; kind: AgentKind; role: string }[],
  offered: { id: string; description: string }[] = []
): string {
  const existingList = existing.length
    ? existing.map((a) => `- ${a.name} (${a.kind}): ${a.role.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')
    : '(none yet)'
  const skillsBlock = offered.length
    ? `\n\nAVAILABLE SKILLS (assign the most relevant to each member as a "skills" array of these exact ids — at most 5 per member; omit or use [] if none fit):\n${offered
        .map((s) => `- ${s.id}: ${s.description}`)
        .join('\n')}`
    : ''
  return `You are ${orchestratorName}, the lead orchestrator. Design the team of specialists you need to achieve this goal. Propose each teammate as a worker or a manager, give each a complete role.md, and define who reports to whom.

GOAL:
${goal}

ALREADY ON THE TEAM (do NOT duplicate these specialties — propose only what's missing):
${existingList}${skillsBlock}

Rules:
- Make every specialty DISTINCT and COMPLEMENTARY.
- Create a domain manager when a distinct area of work (a cluster of several related roles or subsystems) would benefit from dedicated review, testing, and accumulated QA expertise — not only when there are many workers. A manager owns reviewing and testing its area, so group several related roles under one QA-capable manager. A manager with a single worker is pure overhead — keep that flat (the worker reports directly to you).
- Each member's "reportsTo" is the "id" of another member you propose, or the literal "orchestrator" (you). A manager may have workers (or managers) reporting to it.
- Each "role" is a complete role.md: a "# Role" title, "## Specialty", "## Responsibilities", "## How you work", "## Constraints".

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "members": [ { "id": "m1", "name": "short name", "kind": "manager|worker", "role": "<full role.md>", "reportsTo": "orchestrator", "skills": [] } ] }
\`\`\``
}
```
Change `parseSpawnedTeam` to accept + validate skills:
```ts
export function parseSpawnedTeam(text: string, validSkillIds: string[] = []): SpawnedMember[] | null {
  const parsed = parseJsonBlock(text)
  const raw = (parsed as { members?: unknown })?.members
  if (!Array.isArray(raw)) return null
  const valid = new Set(validSkillIds)
  const seen = new Set<string>()
  const members: SpawnedMember[] = []
  for (const r of raw) {
    const o = r as { id?: unknown; name?: unknown; kind?: unknown; role?: unknown; reportsTo?: unknown; skills?: unknown }
    const id = String(o.id ?? '').trim()
    const name = String(o.name ?? '').trim()
    const kind = o.kind === 'manager' ? 'manager' : o.kind === 'worker' ? 'worker' : null
    const role = String(o.role ?? '').trim()
    if (!id || seen.has(id) || !name || !kind || !role) continue
    seen.add(id)
    const skills = Array.isArray(o.skills)
      ? [...new Set(o.skills.map((x) => String(x)))].filter((x) => valid.has(x)).slice(0, 5)
      : []
    const member: SpawnedMember = { id, name, kind, role, reportsTo: String(o.reportsTo ?? 'orchestrator').trim() || 'orchestrator' }
    if (skills.length) member.skills = skills
    members.push(member)
  }
  if (members.length === 0) return null
  breakCycles(members)
  return members
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/shared/team-spawn.test.ts`
Expected: PASS.

- [ ] **Step 5: Pass the catalog through the spawner (`src/main/engine/team-spawner.ts`)**

Add imports:
```ts
import { spawnTeamPrompt, parseSpawnedTeam } from '../../shared/team-spawn'
import { offeredSkills } from '../../shared/skill-trust'
import { discoverSkills } from './skill-discovery'
import { getAgent, rosterForDrafting, getSettings } from './project-store'
```
(Adjust the existing `getAgent, rosterForDrafting` import to add `getSettings`.)
In `spawnTeam`, after `const { agents } = await rosterForDrafting()`:
```ts
  const { agents } = await rosterForDrafting()
  const discovered = await discoverSkills(getSettings().skillInstallThreshold ?? 100000)
  const offered = offeredSkills(discovered, 40)
  const validIds = discovered.flatMap((p) => p.skills.map((s) => s.id))
  const base = spawnTeamPrompt(opts.goal, getAgent(opts.orchestratorId).name, agents, offered)
```
And change the parse call:
```ts
    const members = parseSpawnedTeam(text, validIds)
```

- [ ] **Step 6: Persist skills in `applySpawnedTeam` (`src/main/engine/project-store.ts`)**

In the node-push inside `applySpawnedTeam`, add skills when present. Replace the `graph.nodes.push({ … })` block with:
```ts
    const node: AgentNodeData = {
      id,
      name: m.name,
      slug,
      kind: m.kind,
      icon: iconForName(m.name, m.kind),
      model: DEFAULT_MODEL_BY_KIND[m.kind],
      permissionMode: 'acceptEdits',
      position: { x: base.x + col * 220, y: base.y + d * 150 }
    }
    if (m.skills && m.skills.length) node.skills = m.skills
    graph.nodes.push(node)
```

- [ ] **Step 7: Show proposed skills in the preview (`src/renderer/TeamSpawnModal.tsx`)**

Inside the member `<div className="field" …>`, after the `<textarea className="draft-role" … />`, add a read-only chip row:
```tsx
              {m.skills && m.skills.length > 0 && (
                <div className="spawn-skills muted" style={{ fontSize: 11, marginTop: 4 }}>
                  skills: {m.skills.join(', ')}
                </div>
              )}
```
(`SpawnedMember.skills?` is already on the type; `edited` carries it through `applySpawnedTeam`.)

- [ ] **Step 8: Typecheck + build + full suite + commit**

Run: `npm run typecheck && npm run build && npm test`
Expected: all green.
```bash
git add src/shared/team-spawn.ts src/shared/team-spawn.test.ts src/main/engine/team-spawner.ts src/main/engine/project-store.ts src/renderer/TeamSpawnModal.tsx
git commit -m "feat(skills): orchestrator assigns skills in Build-team; persisted + shown in preview"
```

---

### Task 6: Auto-assign skills in Draft-roles

Same pattern for the Draft-roles flow: offer the catalog, parse optional per-role skills, persist them on Apply.

**Files:**
- Modify: `src/shared/role-draft.ts`
- Modify: `src/shared/role-draft.test.ts` (create if absent)
- Modify: `src/main/engine/role-drafter.ts`
- Modify: `src/shared/types.ts` (`RendererApi.draftRoles` return shape) + `src/main/ipc.ts` (already returns drafts; shape change only)
- Modify: `src/renderer/run/GoalBar.tsx` (drafts state type) + `src/renderer/RoleDraftModal.tsx` (persist skills)

**Interfaces:**
- Consumes: `offeredSkills`/`discoverSkills`; `DraftRosterAgent`.
- Produces: `draftRolesPrompt(goal, roster, edges, offered?)`; `parseDraftedRoles(text, knownIds, validSkillIds?)` returning `{ agentId, role, skills? }[]`; `draftRoles(...)` returning `{ agentId, name, role, skills? }[]`.

- [ ] **Step 1: Write the failing tests (`src/shared/role-draft.test.ts`)**

```ts
import { describe, it, expect } from 'vitest'
import { draftRolesPrompt, parseDraftedRoles } from './role-draft'

describe('draftRolesPrompt', () => {
  it('offers skills when provided', () => {
    const p = draftRolesPrompt('g', [{ id: 'a', name: 'A', kind: 'worker', role: 'r' }], [], [{ id: 'data:airflow', description: 'pipelines' }])
    expect(p).toContain('data:airflow')
  })
})

describe('parseDraftedRoles', () => {
  it('reads optional per-role skills, validates + caps', () => {
    const text = '```json\n' + JSON.stringify({
      roles: [{ agentId: 'a', role: '# Role', skills: ['data:airflow', 'ghost:x', 'eng:a', 'eng:b', 'eng:c', 'eng:d'] }]
    }) + '\n```'
    const out = parseDraftedRoles(text, ['a'], ['data:airflow', 'eng:a', 'eng:b', 'eng:c', 'eng:d'])!
    expect(out[0].skills).toEqual(['data:airflow', 'eng:a', 'eng:b', 'eng:c', 'eng:d']) // ghost dropped, capped 5
  })
  it('omits skills when none valid', () => {
    const text = '```json\n{"roles":[{"agentId":"a","role":"# R"}]}\n```'
    expect(parseDraftedRoles(text, ['a'], ['data:airflow'])![0].skills).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/shared/role-draft.test.ts`
Expected: FAIL — extra params / `skills` not supported.

- [ ] **Step 3: Implement in `src/shared/role-draft.ts`**

Change `draftRolesPrompt` to accept offered skills (append a block and add `skills` to the JSON shape):
```ts
export function draftRolesPrompt(
  goal: string,
  roster: DraftRosterAgent[],
  edges: { source: string; target: string }[],
  offered: { id: string; description: string }[] = []
): string {
  const nameById = new Map(roster.map((a) => [a.id, a.name]))
  const agents = roster
    .map(
      (a) =>
        `- id: ${a.id}\n  name: ${a.name} (${a.kind})\n  current role: ${a.role.replace(/\s+/g, ' ').slice(0, 400)}`
    )
    .join('\n')
  const topology =
    edges.map((e) => `${nameById.get(e.source) ?? e.source} → ${nameById.get(e.target) ?? e.target}`).join('\n') ||
    '(no reporting links)'
  const skillsBlock = offered.length
    ? `\n\nAVAILABLE SKILLS (optionally assign the most relevant to each agent as a "skills" array of these exact ids — at most 5 each):\n${offered
        .map((s) => `- ${s.id}: ${s.description}`)
        .join('\n')}`
    : ''
  return `You are the lead orchestrator. Draft a tailored role for each specialist on your team so they are well-suited to this goal. Each role becomes that agent's role.md and is reused across future goals, so write a DURABLE specialty (informed by the goal, not narrowly tied to it).

GOAL:
${goal}

YOUR TEAM (write one role per agent; make their specialties DISTINCT and COMPLEMENTARY — no two agents should share the same focus):
${agents}

REPORTING STRUCTURE (source delegates work down to target):
${topology}${skillsBlock}

For each agent, write a COMPLETE role.md in this shape:
# Role: <name> (<Worker|Manager>)

## Specialty
<1-3 sentences naming this agent's distinct focus on this team>

## Responsibilities
- <bullet>
- <bullet>

## How you work
- <bullet>

## Constraints
- You operate inside this one project folder.

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "roles": [ { "agentId": "<id>", "role": "<the full role.md markdown>", "skills": [] } ] }
\`\`\``
}
```
Change `parseDraftedRoles` to return optional validated skills:
```ts
export function parseDraftedRoles(
  text: string,
  knownIds: string[],
  validSkillIds: string[] = []
): { agentId: string; role: string; skills?: string[] }[] | null {
  const parsed = parseJsonBlock(text)
  const roles = (parsed as { roles?: unknown })?.roles
  if (!Array.isArray(roles)) return null
  const known = new Set(knownIds)
  const valid = new Set(validSkillIds)
  const out: { agentId: string; role: string; skills?: string[] }[] = []
  for (const r of roles) {
    const o = r as { agentId?: unknown; role?: unknown; skills?: unknown }
    const agentId = String(o.agentId ?? '')
    const role = String(o.role ?? '').trim()
    if (!(known.has(agentId) && role)) continue
    const skills = Array.isArray(o.skills)
      ? [...new Set(o.skills.map((x) => String(x)))].filter((x) => valid.has(x)).slice(0, 5)
      : []
    const entry: { agentId: string; role: string; skills?: string[] } = { agentId, role }
    if (skills.length) entry.skills = skills
    out.push(entry)
  }
  return out
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/shared/role-draft.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread the catalog + skills through `draftRoles` (`src/main/engine/role-drafter.ts`)**

Update imports + the function so it offers skills and returns them:
```ts
import { draftRolesPrompt, parseDraftedRoles } from '../../shared/role-draft'
import { offeredSkills } from '../../shared/skill-trust'
import { discoverSkills } from './skill-discovery'
import { getAgent, rosterForDrafting, getSettings } from './project-store'
```
Change the signature's return type and body:
```ts
export async function draftRoles(
  opts: { goal: string; orchestratorId: string; wc: WebContents; abort: AbortController; runId: string },
  runAgent: AgentRunner = streamAgent
): Promise<{ agentId: string; name: string; role: string; skills?: string[] }[]> {
  const { agents, edges } = await rosterForDrafting()
  if (agents.length === 0) return []
  const knownIds = agents.map((a) => a.id)
  const nameById = new Map(agents.map((a) => [a.id, a.name]))
  const discovered = await discoverSkills(getSettings().skillInstallThreshold ?? 100000)
  const offered = offeredSkills(discovered, 40)
  const validIds = discovered.flatMap((p) => p.skills.map((s) => s.id))
  const base = draftRolesPrompt(opts.goal, agents, edges, offered)
  let last = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await runAgent({
      wc: opts.wc,
      agentId: opts.orchestratorId,
      prompt: attempt === 0 ? base : base + STRICT_REMINDER,
      runId: opts.runId,
      stepId: opts.orchestratorId,
      permissionMode: 'default',
      disallowedTools: THINK_DISALLOW,
      abort: opts.abort,
      header: false
    })
    last = text
    const parsed = parseDraftedRoles(text, knownIds, validIds)
    if (parsed && parsed.length > 0) {
      return parsed.map((r) => ({ agentId: r.agentId, name: nameById.get(r.agentId) ?? r.agentId, role: r.role, skills: r.skills }))
    }
  }
  throw new Error(
    `${getAgent(opts.orchestratorId).name} did not return valid role drafts. Last output:\n${last.slice(0, 400)}`
  )
}
```

- [ ] **Step 6: Update the API return shape + renderer apply**

In `src/shared/types.ts`, the `RendererApi.draftRoles` return type — change its `drafts?` element shape to include skills:
```ts
  draftRoles: (input: { goal: string; orchestratorId: string }) => Promise<{
    ok: boolean
    drafts?: { agentId: string; name: string; role: string; skills?: string[] }[]
    error?: string
  }>
```
(`src/main/ipc.ts`'s `roles:draft` handler returns `{ ok: true, drafts }` from `draftRoles` unchanged — the shape now carries `skills`.)

In `src/renderer/run/GoalBar.tsx`, widen the `drafts` state type to match (find the `useState<{ agentId: string; name: string; role: string }[] | null>` and add `skills?: string[]`):
```ts
  const [drafts, setDrafts] = useState<{ agentId: string; name: string; role: string; skills?: string[] }[] | null>(null)
```

In `src/renderer/RoleDraftModal.tsx`, carry + persist skills:
```ts
type Draft = { agentId: string; name: string; role: string; skills?: string[] }
```
Change `apply` to also write skills via `updateAgent`:
```ts
  const apply = async (): Promise<void> => {
    setApplying(true)
    try {
      for (const d of edited) {
        await window.api.writeRole(d.agentId, d.role)
        if (d.skills && d.skills.length) await window.api.updateAgent({ id: d.agentId, skills: d.skills })
      }
      onClose()
    } finally {
      setApplying(false)
    }
  }
```
And show the proposed skills under each role textarea:
```tsx
              {d.skills && d.skills.length > 0 && (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>skills: {d.skills.join(', ')}</div>
              )}
```

- [ ] **Step 7: Typecheck + build + full suite + commit**

Run: `npm run typecheck && npm run build && npm test`
Expected: all green.
```bash
git add src/shared/role-draft.ts src/shared/role-draft.test.ts src/main/engine/role-drafter.ts src/shared/types.ts src/renderer/run/GoalBar.tsx src/renderer/RoleDraftModal.tsx
git commit -m "feat(skills): orchestrator assigns skills in Draft-roles; persisted on apply"
```

---

## Self-Review

**Spec coverage:**
- Discover + trust-filter installed skills from local metadata → Task 2 (`discoverSkills` over the 3 JSON files) + Task 1 (`shapeCatalog`). ✓
- Trust rule "Anthropic OR ≥threshold (default 100k, tunable)" → Task 1 (`isTrusted`) + Task 4 (Settings field) + Task 2 (threshold read in the IPC handler / discovery). ✓
- Replace hardcoded catalog + path resolver → Task 3 (agent-runner uses discovery) + Task 4 (delete `skill-catalog.ts`, dynamic panel). ✓
- Auto-assign to spawned agents → Task 5 (Build-team). ✓
- Auto-assign to drafted agents → Task 6 (Draft-roles). ✓
- On-disk path resolution covering installed-cache + self-contained marketplace + `plugins/` layout → Task 2 `candidatePaths` + the `skills/` existence gate. ✓
- Filesystem fallback, Anthropic-only, when cache absent → Task 2 `fallbackScan`. ✓
- Per-agent ≤5 cap; offered-catalog ≤40 cap → Task 5/6 parsers (slice(0,5)); Task 5/6 spawner/drafter (`offeredSkills(…, 40)`). ✓
- Never throw into a run; empty catalog = today's behavior → Task 2 (`readJson` swallows, returns `[]`/fallback) + Task 1 (`skillOptionsFor → null`). ✓
- Manual agents unchanged → `createAgent` untouched; only spawn/draft set skills. ✓
- Testing: pure unit (`skill-trust.test.ts`), discovery fixture test, spawn/draft parser tests, typecheck+build for runtime/IPC/renderer → Tasks 1,2,5,6. ✓
- Non-goals (no install, no registry, no verified badge, no manual re-equip, no per-skill override) → not implemented. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code + exact commands.

**Type consistency:** `DiscoveredPlugin`/`DiscoveredSkill` (Task 1) are consumed identically in `skill-discovery` (Task 2), `agent-runner` (Task 3), `AgentConfigPanel` (Task 4), and the spawner/drafter (Tasks 5/6). `isTrusted(p, threshold)`, `shapeCatalog(cache, marketplaces, threshold)`, `skillOptionsFor(assigned, discovered)`, `offeredSkills(discovered, cap)` signatures (Task 1) match every call site. `discoverSkills(threshold, root?)` (Task 2) is called with `getSettings().skillInstallThreshold ?? 100000` in the IPC handler, agent-runner, spawner, and drafter. `SpawnedMember.skills?` (Task 1) is written by `parseSpawnedTeam` (Task 5) and read by `applySpawnedTeam` (Task 5) + `TeamSpawnModal` (Task 5). `parseSpawnedTeam(text, validSkillIds?)` and `parseDraftedRoles(text, knownIds, validSkillIds?)` keep their existing callers valid via default params. `RendererApi.listSkills` (Task 2) + `RendererApi.draftRoles` skills shape (Task 6) match preload + renderer usage. ✓
