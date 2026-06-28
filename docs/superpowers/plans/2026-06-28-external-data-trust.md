# External-data Trust + Security Controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app's two untrusted-external-data boundaries safe by default — third-party plugin/skill discovery and team-bundle import — and add a Settings → Security section the user controls.

**Architecture:** Pure logic in `src/shared/*` (unit-tested in plain Node), fs/wiring in `src/main/engine/*`, IPC in `src/main/ipc.ts`, UI in `src/renderer/*`. Safe defaults remediate audit #2/#17/#18/#19 out of the box; explicit, warned toggles let the user broaden trust. The single SDK call site (`streamAgent` → `buildPermissionOptions`) is the one clamp point for the Full-auto lock.

**Tech Stack:** TypeScript, Electron, React + zustand renderer, Vitest, electron-vite.

## Global Constraints

- Test runner: **Vitest**. Commands: `npm test` (= `vitest run`), `npm run typecheck` (node+web), `npm run build`.
- Models are the three ids in `MODELS` (`src/shared/types.ts`): `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`. `DEFAULT_MODEL_BY_KIND` = `{orchestrator:'claude-opus-4-8', manager:'claude-opus-4-8', worker:'claude-sonnet-4-6'}`.
- `AgentKind` = `'orchestrator' | 'manager' | 'worker'`. `PermissionMode` = `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto'`. `Autonomy` = `'auto' | 'full' | 'cautious'`.
- Pure modules in `src/shared/` must have **no node/DOM imports**.
- Each task must leave `npm run typecheck` and `npm test` **green** before its commit.
- Bound constants (Task 4): `MAX_ROLE_CHARS = 50_000`, `MAX_MEMBERS = 200`, `MAX_LESSONS = 200`, `MAX_LESSON_CHARS = 2_000`. Context (Task 5): `MAX_CONTEXT_BYTES = 25 * 1024 * 1024`.
- Defaults: `trustAnthropicOnly: true`, `blockPluginHooks: true`, `lockBypassPermissions: false`.
- Commit style: conventional commits, present-tense; end the body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/shared/types.ts` | +3 `ProjectSettings` fields + defaults; deprecate `skillInstallThreshold` doc | 1 |
| `src/shared/skill-trust.ts` | mode-aware `isTrusted`; `isAnthropicOwnedRepo`; `pluginShipsHooks`; `shapeCatalog(mode)` | 2 |
| `src/main/engine/skill-discovery.ts` | `discoverSkills({mode,blockHooks,root})`; hook fs-probe; fallback per mode | 2 |
| `src/main/engine/agent-runner.ts` | `discoveredPlugins()` reads settings; `streamAgent` passes `lockBypass` | 2, 3 |
| `src/main/ipc.ts` | `listSkills` settings read; import preview/apply IPC | 2, 6 |
| `src/main/engine/permission-options.ts` | `buildPermissionOptions(mode,{lockBypass})` clamp | 3 |
| `src/shared/team-bundle.ts` | validate-and-normalize; `planTeamImport` forces `acceptEdits`; bound consts | 4 |
| `src/main/engine/project-store.ts` | `addContextFiles` lstat/size/reasons | 5 |
| `src/main/preload.ts` + `src/shared/ipc-channels` | new import IPC channels + api | 6 |
| `src/renderer/App.tsx` | import preview→confirm→apply flow | 7 |
| `src/renderer/ConfirmDialog.tsx` + `.css` | preserve newlines in confirm body | 7 |
| `src/renderer/SettingsModal.tsx` | Security section (relocate autonomy + skills-pack; +3 toggles) | 8 |

**Task order (sequential, deps respected):** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8.

---

### Task 1: Settings fields

**Files:**
- Modify: `src/shared/types.ts` (`ProjectSettings` interface + `DEFAULT_SETTINGS`)
- Test: `src/shared/settings-defaults.test.ts`

**Interfaces:**
- Produces: `ProjectSettings.trustAnthropicOnly: boolean`, `.blockPluginHooks: boolean`, `.lockBypassPermissions: boolean`; same keys in `DEFAULT_SETTINGS` with defaults `true`, `true`, `false`.

- [ ] **Step 1: Write the failing test** — append to `src/shared/settings-defaults.test.ts`:

```typescript
it('defaults the security fields safely', () => {
  expect(DEFAULT_SETTINGS.trustAnthropicOnly).toBe(true)
  expect(DEFAULT_SETTINGS.blockPluginHooks).toBe(true)
  expect(DEFAULT_SETTINGS.lockBypassPermissions).toBe(false)
})
```

- [ ] **Step 2: Run it, verify it fails** — `npm test -- settings-defaults` → FAIL (properties undefined).

- [ ] **Step 3: Implement** — in `src/shared/types.ts`, add to the `ProjectSettings` interface (after `skillInstallThreshold`), and change `skillInstallThreshold`'s JSDoc to mark it deprecated:

```typescript
  /** @deprecated no longer consulted for trust (was a forgeable local cache); kept to avoid a settings migration */
  skillInstallThreshold: number
  /** ON ⇒ auto-trust only plugins whose own author is Anthropic in a verified anthropics-owned repo (strict); OFF ⇒ any skill from a verified anthropics-owned marketplace */
  trustAnthropicOnly: boolean
  /** ON ⇒ exclude any discovered plugin that ships hooks (hooks run code) */
  blockPluginHooks: boolean
  /** ON ⇒ clamp any bypassPermissions run down to acceptEdits, engine-wide */
  lockBypassPermissions: boolean
```

And in `DEFAULT_SETTINGS` (after `skillInstallThreshold: 100000,`):

```typescript
  trustAnthropicOnly: true,
  blockPluginHooks: true,
  lockBypassPermissions: false,
```

- [ ] **Step 4: Run tests** — `npm test -- settings-defaults` → PASS. `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(security): add trust/hook/bypass-lock settings fields"`

---

### Task 2: S3 — plugin/skill trust + hook gating

**Files:**
- Modify: `src/shared/skill-trust.ts` (rewrite trust core)
- Modify: `src/main/engine/skill-discovery.ts` (signature + hook probe + fallback per mode)
- Modify: `src/main/engine/agent-runner.ts` (`discoveredPlugins()` reads settings)
- Modify: `src/main/ipc.ts` (`listSkills` reads settings)
- Test: `src/shared/skill-trust.test.ts` (rewrite), `src/main/engine/skill-discovery.test.ts` (extend/create)

**Interfaces:**
- Consumes: `ProjectSettings.trustAnthropicOnly`, `.blockPluginHooks` (Task 1).
- Produces:
  - `type SkillTrustMode = 'anthropic-only' | 'anthropic-marketplaces'`
  - `isAnthropicOwnedRepo(source: unknown): boolean`
  - `pluginShipsHooks(signals: { hasHooksJson?: boolean; hasPluginJsonHooksKey?: boolean; hooksDirNonEmpty?: boolean }): boolean`
  - `isTrusted(p: { author?: string; marketplaceSource?: unknown }, mode: SkillTrustMode): boolean`
  - `shapeCatalog(cacheJson: unknown, marketplacesJson: unknown, mode: SkillTrustMode): Omit<DiscoveredPlugin,'path'>[]`
  - `discoverSkills(opts: { mode: SkillTrustMode; blockHooks: boolean; root?: string }): Promise<DiscoveredPlugin[]>`

- [ ] **Step 1: Write failing pure tests** — replace the `isTrusted`/`shapeCatalog` describe blocks in `src/shared/skill-trust.test.ts` and add new ones (keep `skillOptionsFor`/`offeredSkills` tests as-is):

```typescript
import { describe, it, expect } from 'vitest'
import {
  isTrusted, isAnthropicOwnedRepo, pluginShipsHooks, shapeCatalog,
  skillOptionsFor, offeredSkills
} from './skill-trust'

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
```

- [ ] **Step 2: Run, verify fail** — `npm test -- skill-trust` → FAIL (new exports missing / old signature).

- [ ] **Step 3: Rewrite `src/shared/skill-trust.ts` trust core** — replace lines 6–55 (the `isTrusted` + `shapeCatalog`, keep `SkillSdkOptions`, `skillOptionsFor`, `offeredSkills` untouched):

```typescript
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
```

- [ ] **Step 4: Run pure tests** — `npm test -- skill-trust` → PASS.

- [ ] **Step 5: Write failing discovery test** — create/extend `src/main/engine/skill-discovery.test.ts`. Use a temp `root` with fixtures (one anthropic-authored hook-free plugin, one anthropic-authored plugin WITH hooks):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkills } from './skill-discovery'

let root: string
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'aim-skill-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

async function writeJson(p: string, v: unknown): Promise<void> {
  await fs.mkdir(join(p, '..'), { recursive: true }); await fs.writeFile(p, JSON.stringify(v), 'utf8')
}
async function plugin(loc: string, id: string, opts: { hooks?: boolean }): Promise<void> {
  const dir = join(loc, 'plugins', id)
  await fs.mkdir(join(dir, 'skills', 'main'), { recursive: true })
  await fs.writeFile(join(dir, 'skills', 'main', 'SKILL.md'), '# s', 'utf8')
  if (opts.hooks) { await fs.mkdir(join(dir, 'hooks'), { recursive: true }); await writeJson(join(dir, 'hooks', 'hooks.json'), { hooks: {} }) }
}

it('anthropic-only + blockHooks: keeps hook-free anthropic plugin, drops hook-bearing one', async () => {
  const loc = join(root, 'mk')
  await writeJson(join(root, 'known_marketplaces.json'), { mk: { source: { source: 'github', repo: 'anthropics/x' }, installLocation: loc } })
  await writeJson(join(root, 'plugin-catalog-cache.json'), { catalog: { plugins: {
    'clean@mk': { unique_installs: 1, marketplace_entry: { author: { name: 'Anthropic' }, description: 'd' }, components: { skills: [{ name: 'main' }] } },
    'hooky@mk': { unique_installs: 1, marketplace_entry: { author: { name: 'Anthropic' }, description: 'd' }, components: { skills: [{ name: 'main' }] } }
  } } })
  await plugin(loc, 'clean', {}); await plugin(loc, 'hooky', { hooks: true })
  const out = await discoverSkills({ mode: 'anthropic-only', blockHooks: true, root })
  expect(out.map((p) => p.id)).toEqual(['clean'])
})

it('blockHooks false keeps the hook-bearing plugin', async () => {
  const loc = join(root, 'mk')
  await writeJson(join(root, 'known_marketplaces.json'), { mk: { source: { source: 'github', repo: 'anthropics/x' }, installLocation: loc } })
  await writeJson(join(root, 'plugin-catalog-cache.json'), { catalog: { plugins: {
    'hooky@mk': { unique_installs: 1, marketplace_entry: { author: { name: 'Anthropic' }, description: 'd' }, components: { skills: [{ name: 'main' }] } }
  } } })
  await plugin(loc, 'hooky', { hooks: true })
  const out = await discoverSkills({ mode: 'anthropic-only', blockHooks: false, root })
  expect(out.map((p) => p.id)).toEqual(['hooky'])
})

it('no catalog cache: anthropic-only fallback returns empty', async () => {
  const loc = join(root, 'mk')
  await writeJson(join(root, 'known_marketplaces.json'), { mk: { source: { source: 'github', repo: 'anthropics/x' }, installLocation: loc } })
  await plugin(loc, 'clean', {})
  expect(await discoverSkills({ mode: 'anthropic-only', blockHooks: true, root })).toEqual([])
})
```

- [ ] **Step 6: Run, verify fail** — `npm test -- skill-discovery` → FAIL (signature mismatch).

- [ ] **Step 7: Update `src/main/engine/skill-discovery.ts`** — (a) import the new helpers; (b) add the hook fs-probe; (c) change `discoverSkills` + `fallbackScan` signatures. Replace the imports + `discoverSkills` + `fallbackScan`:

```typescript
import { shapeCatalog, isAnthropicOwnedRepo, pluginShipsHooks, type SkillTrustMode } from '../../shared/skill-trust'

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
    const ip = arr?.[0]?.installPath
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
```

(Remove the now-unused `isTrusted` import; keep `existsSync`, `fs`, `join`, etc.)

- [ ] **Step 8: Update callers so the build stays green** — in `src/main/engine/agent-runner.ts` replace `discoveredPlugins()`:

```typescript
async function discoveredPlugins(): Promise<import('../../shared/types').DiscoveredPlugin[]> {
  const now = Date.now()
  if (discoveryCache && now - discoveryCache.at < 30_000) return discoveryCache.plugins
  const s = getSettings()
  const plugins = await discoverSkills({
    mode: s.trustAnthropicOnly ? 'anthropic-only' : 'anthropic-marketplaces',
    blockHooks: s.blockPluginHooks
  })
  discoveryCache = { at: now, plugins }
  return plugins
}
```

In `src/main/ipc.ts` replace the `listSkills` handler:

```typescript
  ipcMain.handle(IPC.listSkills, () => {
    const s = store.getSettings()
    return discoverSkills({
      mode: s.trustAnthropicOnly ? 'anthropic-only' : 'anthropic-marketplaces',
      blockHooks: s.blockPluginHooks
    })
  })
```

- [ ] **Step 9: Run everything** — `npm test` → PASS. `npm run typecheck` → PASS.

- [ ] **Step 10: Commit** — `git add -A && git commit -m "feat(s3): per-plugin Anthropic trust + verified-repo + hook-block gating"`

---

### Task 3: Full-auto permission lock

**Files:**
- Modify: `src/main/engine/permission-options.ts`
- Modify: `src/main/engine/agent-runner.ts` (`streamAgent` passes the lock)
- Test: `src/main/engine/permission-options.test.ts` (create)

**Interfaces:**
- Consumes: `ProjectSettings.lockBypassPermissions` (Task 1).
- Produces: `buildPermissionOptions(mode: PermissionMode, opts?: { lockBypass?: boolean }): { permissionMode: PermissionMode; allowDangerouslySkipPermissions?: true }`.

- [ ] **Step 1: Write failing test** — create `src/main/engine/permission-options.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildPermissionOptions } from './permission-options'

describe('buildPermissionOptions', () => {
  it('lockBypass clamps bypassPermissions to acceptEdits', () => {
    expect(buildPermissionOptions('bypassPermissions', { lockBypass: true }))
      .toEqual({ permissionMode: 'acceptEdits' })
  })
  it('without lock, bypass keeps the dangerous flag', () => {
    expect(buildPermissionOptions('bypassPermissions'))
      .toEqual({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
  })
  it('non-bypass modes are unaffected by the lock', () => {
    expect(buildPermissionOptions('acceptEdits', { lockBypass: true })).toEqual({ permissionMode: 'acceptEdits' })
    expect(buildPermissionOptions('auto', { lockBypass: true })).toEqual({ permissionMode: 'auto' })
  })
})
```

- [ ] **Step 2: Run, verify fail** — `npm test -- permission-options` → FAIL.

- [ ] **Step 3: Implement** — replace `src/main/engine/permission-options.ts`:

```typescript
import type { PermissionMode } from '../../shared/types'

/** SDK permission options for a mode. The SDK REQUIRES allowDangerouslySkipPermissions=true
 *  whenever permissionMode is 'bypassPermissions' (sdk.d.ts), else the run errors.
 *  When `lockBypass` is set, any bypass is clamped down to 'acceptEdits' (Full-auto lock). */
export function buildPermissionOptions(
  mode: PermissionMode,
  opts?: { lockBypass?: boolean }
): { permissionMode: PermissionMode; allowDangerouslySkipPermissions?: true } {
  const effective: PermissionMode = opts?.lockBypass && mode === 'bypassPermissions' ? 'acceptEdits' : mode
  if (effective === 'bypassPermissions') {
    return { permissionMode: effective, allowDangerouslySkipPermissions: true }
  }
  return { permissionMode: effective }
}
```

- [ ] **Step 4: Wire `streamAgent`** — in `src/main/engine/agent-runner.ts`, change the `buildPermissionOptions(mode)` spread (~line 113):

```typescript
      ...buildPermissionOptions(mode, { lockBypass: getSettings().lockBypassPermissions }),
```

- [ ] **Step 5: Run** — `npm test -- permission-options` → PASS. `npm test` → PASS. `npm run typecheck` → PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(security): Full-auto lock clamps bypass to acceptEdits at the SDK boundary"`

---

### Task 4: S4 — team-bundle validate-and-normalize

**Files:**
- Modify: `src/shared/team-bundle.ts` (`validateTeamBundle` rewrite; `planTeamImport` forces acceptEdits; bound consts)
- Test: `src/shared/team-bundle.test.ts` (extend)

**Interfaces:**
- Consumes: `MODELS`, `DEFAULT_MODEL_BY_KIND` from `./types`.
- Produces: `validateTeamBundle(raw): { ok: true; bundle: TeamBundle; warnings: string[] } | { ok: false; error: string }` (now also returns `warnings`); `planTeamImport` output members always have `permissionMode: 'acceptEdits'`.

- [ ] **Step 1: Write failing tests** — add to `src/shared/team-bundle.test.ts`:

```typescript
import { MODELS } from './types'

function rawBundle(members: unknown[]): unknown {
  return { kind: 'ai-manager-team', version: 1, name: 't', exportedAt: 'x', members, edges: [] }
}

describe('validateTeamBundle (normalize)', () => {
  it('clamps oversized role + lessons and whitelists model/permissionMode, never throws', () => {
    const r = validateTeamBundle(rawBundle([{
      memberId: 'm1', name: 'A', kind: 'worker', icon: 'x',
      model: 'evil-model', permissionMode: 'bypassPermissions',
      position: { x: Number.NaN, y: 3 },
      role: 'z'.repeat(60000),
      lessons: Array.from({ length: 500 }, () => 'L'.repeat(5000))
    }]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const m = r.bundle.members[0]
    expect(m.model).toBe('claude-sonnet-4-6') // unknown → worker default
    expect(MODELS.some((x) => x.id === m.model)).toBe(true)
    expect(m.permissionMode).toBe('bypassPermissions') // valid enum value kept here; planTeamImport forces acceptEdits
    expect(m.position).toEqual({ x: 0, y: 3 })
    expect(m.role.length).toBe(50000)
    expect(m.lessons.length).toBe(200)
    expect(m.lessons[0].length).toBe(2000)
  })

  it('coerces an unknown permissionMode to acceptEdits', () => {
    const r = validateTeamBundle(rawBundle([{ memberId: 'm', name: 'A', kind: 'worker', icon: 'x', model: 'claude-sonnet-4-6', permissionMode: 'sudo', position: { x: 0, y: 0 }, role: '', lessons: [] }]))
    expect(r.ok && r.bundle.members[0].permissionMode).toBe('acceptEdits')
  })

  it('rejects a member missing memberId/name and a too-large team', () => {
    expect(validateTeamBundle(rawBundle([{ name: 'A', kind: 'worker' }])).ok).toBe(false)
    const many = Array.from({ length: 201 }, (_, i) => ({ memberId: `m${i}`, name: 'A', kind: 'worker', icon: 'x', model: 'claude-sonnet-4-6', permissionMode: 'acceptEdits', position: { x: 0, y: 0 }, role: '', lessons: [] }))
    expect(validateTeamBundle(rawBundle(many)).ok).toBe(false)
  })

  it('keeps a well-formed exported bundle valid (round-trip) and reports warnings', () => {
    const good = validateTeamBundle(rawBundle([{ memberId: 'm', name: 'A', kind: 'manager', icon: 'x', model: 'claude-opus-4-8', permissionMode: 'acceptEdits', position: { x: 1, y: 2 }, role: 'hi', lessons: ['a'] }]))
    expect(good.ok).toBe(true)
    if (good.ok) expect(Array.isArray(good.warnings)).toBe(true)
  })
})

describe('planTeamImport (force safe mode)', () => {
  it('forces acceptEdits regardless of the bundle value', () => {
    const v = validateTeamBundle(rawBundle([{ memberId: 'm', name: 'A', kind: 'worker', icon: 'x', model: 'claude-sonnet-4-6', permissionMode: 'bypassPermissions', position: { x: 0, y: 0 }, role: '', lessons: [] }]))
    if (!v.ok) throw new Error('precondition')
    const plan = planTeamImport(v.bundle, [])
    expect(plan.members[0].permissionMode).toBe('acceptEdits')
  })
})
```

- [ ] **Step 2: Run, verify fail** — `npm test -- team-bundle` → FAIL.

- [ ] **Step 3: Implement** — in `src/shared/team-bundle.ts`: add imports + consts at top, replace `validateTeamBundle`, and change the `permissionMode` line in `planTeamImport`.

Add near the top (after existing imports):

```typescript
import { MODELS, DEFAULT_MODEL_BY_KIND } from './types'

const MAX_ROLE_CHARS = 50_000
const MAX_MEMBERS = 200
const MAX_LESSONS = 200
const MAX_LESSON_CHARS = 2_000
const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto']
const AGENT_KINDS: AgentKind[] = ['orchestrator', 'manager', 'worker']
const KNOWN_MODELS = new Set(MODELS.map((m) => m.id))
```

Replace `validateTeamBundle` (lines 84–100) with:

```typescript
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function finite(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Validate AND normalize untrusted JSON read from disk. On success returns a fully-typed,
 *  bounded bundle plus human-readable warnings about anything clamped/dropped. Never throws
 *  on member field access downstream. */
export function validateTeamBundle(
  raw: unknown
): { ok: true; bundle: TeamBundle; warnings: string[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Not a team bundle (not an object).' }
  const b = raw as Record<string, unknown>
  if (b.kind !== 'ai-manager-team') return { ok: false, error: 'Not an AI Manager team bundle.' }
  if (b.version !== 1) return { ok: false, error: `Unsupported team bundle version: ${String(b.version)}.` }
  if (!Array.isArray(b.members)) return { ok: false, error: 'Team bundle has no members array.' }
  if (b.members.length > MAX_MEMBERS) return { ok: false, error: `Team bundle has too many members (>${MAX_MEMBERS}).` }
  if (b.edges !== undefined && !Array.isArray(b.edges)) return { ok: false, error: 'Team bundle edges are malformed.' }

  const warnings: string[] = []
  const members: TeamMember[] = []
  for (const m of b.members) {
    const mm = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
    if (typeof mm.memberId !== 'string' || typeof mm.name !== 'string') {
      return { ok: false, error: 'Team bundle has a member missing memberId/name.' }
    }
    if (!AGENT_KINDS.includes(mm.kind as AgentKind)) {
      return { ok: false, error: `Team bundle member "${mm.name}" has an invalid kind.` }
    }
    const kind = mm.kind as AgentKind
    let model = str(mm.model)
    if (!KNOWN_MODELS.has(model)) { model = DEFAULT_MODEL_BY_KIND[kind]; warnings.push(`${mm.name}: unknown model → ${model}`) }
    let permissionMode = mm.permissionMode as PermissionMode
    if (!PERMISSION_MODES.includes(permissionMode)) { warnings.push(`${mm.name}: unknown permissionMode → acceptEdits`); permissionMode = 'acceptEdits' }
    let role = str(mm.role)
    if (role.length > MAX_ROLE_CHARS) { role = role.slice(0, MAX_ROLE_CHARS); warnings.push(`${mm.name}: role truncated to ${MAX_ROLE_CHARS} chars`) }
    const rawLessons = Array.isArray(mm.lessons) ? mm.lessons : []
    const lessons = rawLessons.filter((l) => typeof l === 'string').slice(0, MAX_LESSONS).map((l) => (l as string).slice(0, MAX_LESSON_CHARS))
    if (rawLessons.length > lessons.length) warnings.push(`${mm.name}: lessons capped to ${MAX_LESSONS}`)
    const pos = (mm.position && typeof mm.position === 'object' ? mm.position : {}) as Record<string, unknown>
    const member: TeamMember = {
      memberId: mm.memberId, name: mm.name, kind, model, permissionMode,
      icon: str(mm.icon, '🤖'),
      position: { x: finite(pos.x), y: finite(pos.y) },
      role, lessons
    }
    if (Array.isArray(mm.skills)) { const s = mm.skills.filter((x): x is string => typeof x === 'string'); if (s.length) member.skills = s }
    members.push(member)
  }
  const edges = (Array.isArray(b.edges) ? b.edges : [])
    .filter((e) => e && typeof e === 'object' && typeof (e as Record<string, unknown>).source === 'string' && typeof (e as Record<string, unknown>).target === 'string')
    .map((e) => ({ source: (e as Record<string, string>).source, target: (e as Record<string, string>).target }))
  const bundle: TeamBundle = {
    kind: 'ai-manager-team', version: 1, name: str(b.name, 'Imported team'),
    exportedAt: str(b.exportedAt), members, edges
  }
  if (typeof b.teamId === 'string') bundle.teamId = b.teamId
  return { ok: true, bundle, warnings }
}
```

In `planTeamImport`, change the `permissionMode: m.permissionMode,` line to:

```typescript
      permissionMode: 'acceptEdits', // force safe mode — never honor a bundle's permissionMode (#17)
```

- [ ] **Step 4: Fix existing callers' types** — `validateTeamBundle` now returns `warnings` on the ok branch. Existing `if (v.ok)` consumers (`ipc.ts importTeam`, `project-store.ts readTeamBrain`) still compile (they read `v.bundle`). Confirm `npm run typecheck` passes; no code change needed there.

- [ ] **Step 5: Run** — `npm test -- team-bundle` → PASS. `npm test` → PASS. `npm run typecheck` → PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(s4): validate-and-normalize team bundles + force acceptEdits on import"`

> **Auto-sync note (no code):** `readTeamBrain` already calls `validateTeamBundle`, so the B2b auto-sync path (`autoPullFromTeam` → `refreshFromTeam`, lessons-only) is now covered transitively — malformed/oversized lessons are clamped or the brain is skipped (`readTeamBrain` returns null on `ok:false`).

---

### Task 5: Context-file symlink + size guard

**Files:**
- Modify: `src/main/engine/project-store.ts` (`addContextFiles`)
- Test: `src/main/engine/project-store.context.test.ts` (create) — or extend an existing project-store test

**Interfaces:**
- Produces: `addContextFiles` rejects symlinks + files `> MAX_CONTEXT_BYTES`, with reason-suffixed `skipped` entries. Signature unchanged: `Promise<{ graph: ProjectGraph; skipped: string[] }>`.

- [ ] **Step 1: Write failing test** — create `src/main/engine/project-store.context.test.ts`. Set up a temp project via the store's open API (match the pattern in existing project-store tests — inspect a sibling test for `openProject`/temp setup first), then:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProject, addContextFiles } from './project-store'

let proj: string
beforeEach(async () => { proj = await fs.mkdtemp(join(tmpdir(), 'aim-ctx-')); await openProject(proj) })
afterEach(async () => { await fs.rm(proj, { recursive: true, force: true }) })

it('rejects a symlink with a reason', async () => {
  const real = join(proj, 'secret.txt'); await fs.writeFile(real, 'top', 'utf8')
  const link = join(proj, 'link.txt'); await fs.symlink(real, link)
  const { skipped } = await addContextFiles([link])
  expect(skipped.some((s) => s.includes('link') && s.includes('symlink'))).toBe(true)
})

it('rejects an oversized file with a reason', async () => {
  const big = join(proj, 'big.bin'); await fs.writeFile(big, Buffer.alloc(26 * 1024 * 1024))
  const { skipped } = await addContextFiles([big])
  expect(skipped.some((s) => s.includes('big.bin') && s.includes('too large'))).toBe(true)
})

it('accepts a normal small file', async () => {
  const ok = join(proj, 'note.md'); await fs.writeFile(ok, '# hi', 'utf8')
  const { graph, skipped } = await addContextFiles([ok])
  expect(skipped).toEqual([])
  expect(graph.context?.some((c) => c.fileName === 'note.md')).toBe(true)
})
```

(If `openProject` needs extra args, mirror the existing project-store test setup exactly.)

- [ ] **Step 2: Run, verify fail** — `npm test -- project-store.context` → FAIL.

- [ ] **Step 3: Implement** — replace the loop body inside `addContextFiles` (lines 374–390) with lstat + size + reasons:

```typescript
  const MAX_CONTEXT_BYTES = 25 * 1024 * 1024
  for (const src of sourcePaths) {
    try {
      const stat = await fs.lstat(src)
      if (stat.isSymbolicLink()) { skipped.push(`${basename(src)} (symlink)`); continue }
      if (!stat.isFile()) { skipped.push(`${basename(src)} (not a file)`); continue }
      if (stat.size > MAX_CONTEXT_BYTES) { skipped.push(`${basename(src)} (too large)`); continue }
      const fileName = uniqueContextName(graph.context.map((c) => c.fileName), basename(src))
      await fs.copyFile(src, join(dir, fileName))
      graph.context.push({
        id: randomUUID(),
        fileName,
        note: '',
        addedAt: new Date().toISOString(),
        bytes: stat.size,
        isImage: isImageName(fileName)
      })
    } catch {
      skipped.push(`${basename(src)} (unreadable)`)
    }
  }
```

(Hoist `MAX_CONTEXT_BYTES` to module scope if the file's style prefers that.)

- [ ] **Step 4: Run** — `npm test -- project-store.context` → PASS. `npm test` → PASS. `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(s4): reject symlink/oversized context files with reasons"`

---

### Task 6: Import preview/apply IPC

**Files:**
- Modify: `src/main/ipc.ts` (replace `importTeam` handler with `importTeamPreview` + `importTeamApply`)
- Modify: the IPC channel constants (search `IPC.importTeam` definition — likely `src/shared/ipc.ts` or `src/main/ipc-channels`) — add `importTeamPreview`, `importTeamApply`
- Modify: `src/main/preload.ts` (expose `importTeamPreview`, `importTeamApply`; update the `window.api` type)
- Test: `src/main/ipc-import.test.ts` (create) OR a focused unit test on the preview-shaping helper

**Interfaces:**
- Consumes: `validateTeamBundle` (Task 4), `store.importTeam`.
- Produces:
  - `importTeamPreview(): Promise<{ status: 'canceled' } | { status: 'error'; error: string } | { status: 'ok'; bundle: TeamBundle; path: string; preview: { members: { name: string; kind: string; role: string }[]; warnings: string[] } }>`
  - `importTeamApply(bundle: TeamBundle, path: string): Promise<{ graph: ProjectGraph } | { error: string }>`

- [ ] **Step 1: Add channel constants** — in the IPC-channels source, add (next to `importTeam`):

```typescript
  importTeamPreview: 'team:import-preview',
  importTeamApply: 'team:import-apply',
```

(Keep `importTeam` for now to avoid breaking other refs; remove in Task 7.)

- [ ] **Step 2: Write a failing unit test for the preview shaper** — to keep this testable without Electron `dialog`, factor preview-shaping into a pure helper in `src/shared/team-bundle.ts` and test it:

```typescript
// in team-bundle.test.ts
describe('previewOf', () => {
  it('summarizes members with their forced mode', () => {
    const v = validateTeamBundle(rawBundle([{ memberId: 'm', name: 'A', kind: 'worker', icon: 'x', model: 'claude-sonnet-4-6', permissionMode: 'bypassPermissions', position: { x: 0, y: 0 }, role: 'do x', lessons: [] }]))
    if (!v.ok) throw new Error('precondition')
    const p = previewOf(v.bundle, v.warnings)
    expect(p.members[0]).toEqual({ name: 'A', kind: 'worker', role: 'do x' })
    expect(Array.isArray(p.warnings)).toBe(true)
  })
})
```

Add to `src/shared/team-bundle.ts`:

```typescript
/** Renderer-facing preview of an import (members + validation warnings). Roles shown for review. */
export function previewOf(bundle: TeamBundle, warnings: string[]): {
  members: { name: string; kind: AgentKind; role: string }[]
  warnings: string[]
} {
  return { members: bundle.members.map((m) => ({ name: m.name, kind: m.kind, role: m.role })), warnings }
}
```

- [ ] **Step 3: Run, verify fail then pass the pure part** — `npm test -- team-bundle` → FAIL → add `previewOf` → PASS.

- [ ] **Step 4: Replace the `importTeam` IPC handler** in `src/main/ipc.ts` with two handlers:

```typescript
  ipcMain.handle(IPC.importTeamPreview, async () => {
    const r = await dialog.showOpenDialog({
      title: 'Import team',
      properties: ['openFile'],
      filters: [{ name: 'AI Manager team', extensions: ['json'] }]
    })
    if (r.canceled || r.filePaths.length === 0) return { status: 'canceled' as const }
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(r.filePaths[0], 'utf8'))
    } catch {
      return { status: 'error' as const, error: 'That file is not valid JSON.' }
    }
    const v = validateTeamBundle(parsed)
    if (!v.ok) return { status: 'error' as const, error: v.error }
    return { status: 'ok' as const, bundle: v.bundle, path: r.filePaths[0], preview: previewOf(v.bundle, v.warnings) }
  })

  ipcMain.handle(IPC.importTeamApply, async (_e, bundle: unknown, path: string) => {
    const v = validateTeamBundle(bundle) // re-validate defensively
    if (!v.ok) return { error: v.error }
    const graph = await store.importTeam(v.bundle, path)
    return { graph }
  })
```

Add `previewOf` to the `team-bundle` import in `ipc.ts`.

- [ ] **Step 5: Expose in preload** — in `src/main/preload.ts`, add to the `api` object + its type:

```typescript
  importTeamPreview: () => ipcRenderer.invoke(IPC.importTeamPreview),
  importTeamApply: (bundle: unknown, path: string) => ipcRenderer.invoke(IPC.importTeamApply, bundle, path),
```

(Match the existing preload typing style; the renderer `window.api` type lives wherever the others are declared.)

- [ ] **Step 6: Run** — `npm test` → PASS. `npm run typecheck` → PASS (the old `importTeam` channel/handler still exists; App.tsx still calls it — untouched until Task 7).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(s4): import preview/apply IPC with validation + warnings"`

---

### Task 7: Import preview confirm flow (renderer)

**Files:**
- Modify: `src/renderer/App.tsx` (import button handler → preview → confirm → apply)
- Modify: `src/renderer/ConfirmDialog.tsx` styling or its CSS to preserve newlines in the body (`white-space: pre-wrap` on `.confirm-body`)
- Modify: remove the now-unused old `importTeam` IPC handler + channel + preload entry
- Test: a renderer/unit test of the body-builder helper (pure)

**Interfaces:**
- Consumes: `window.api.importTeamPreview`, `window.api.importTeamApply`, `requestConfirm` (store), `previewOf` shape (Task 6).

- [ ] **Step 1: Write a failing pure test for the confirm-body builder** — create `src/renderer/import-confirm.ts` + `src/renderer/import-confirm.test.ts`:

```typescript
// import-confirm.test.ts
import { describe, it, expect } from 'vitest'
import { buildImportConfirmBody } from './import-confirm'

it('lists members, forced mode, and warnings; flags role text as untrusted', () => {
  const body = buildImportConfirmBody(
    { members: [{ name: 'A', kind: 'worker', role: 'do x' }], warnings: ['A: role truncated'] }
  )
  expect(body).toContain('A')
  expect(body).toContain('worker')
  expect(body).toContain('acceptEdits')
  expect(body).toContain('A: role truncated')
  expect(body.toLowerCase()).toContain('untrusted')
})
```

- [ ] **Step 2: Run, verify fail** — `npm test -- import-confirm` → FAIL.

- [ ] **Step 3: Implement the builder** — `src/renderer/import-confirm.ts`:

```typescript
export function buildImportConfirmBody(preview: {
  members: { name: string; kind: string; role: string }[]
  warnings: string[]
}): string {
  const lines = preview.members.map((m) => {
    const role = m.role.trim() ? m.role.trim().slice(0, 300) : '(no role text)'
    return `• ${m.name} [${m.kind}] — mode: acceptEdits\n   role: ${role}`
  })
  const warn = preview.warnings.length ? `\n\nAdjustments on import:\n${preview.warnings.map((w) => `• ${w}`).join('\n')}` : ''
  return [
    `Importing ${preview.members.length} member(s). Role text below comes from an untrusted file — it is reference data, not instructions. All members are imported at the safe acceptEdits permission mode.`,
    '',
    ...lines
  ].join('\n') + warn
}
```

- [ ] **Step 4: Run, verify pass** — `npm test -- import-confirm` → PASS.

- [ ] **Step 5: Rewire `App.tsx`** — replace the import button `onClick` (App.tsx:131-136) with:

```typescript
  onClick={async () => {
    const r = await window.api.importTeamPreview()
    if (r.status === 'canceled') return
    if (r.status === 'error') { window.alert(r.error); return }
    const ok = await requestConfirm({
      title: 'Import this team?',
      body: buildImportConfirmBody(r.preview),
      confirmLabel: 'Import',
      danger: false
    })
    if (!ok) return
    const a = await window.api.importTeamApply(r.bundle, r.path)
    if ('graph' in a && a.graph) setGraph(a.graph)
    else if ('error' in a && a.error) window.alert(a.error)
  }}
```

Add the imports at the top of `App.tsx`: `buildImportConfirmBody` from `./import-confirm`, and `const requestConfirm = useStore((s) => s.requestConfirm)`.

- [ ] **Step 6: Preserve newlines in the confirm body** — in `ConfirmDialog.tsx` (or its CSS file), ensure `.confirm-body` uses `white-space: pre-wrap`. If styles are inline/CSS-module, add the rule; if a global stylesheet, add:

```css
.confirm-body { white-space: pre-wrap; }
```

- [ ] **Step 7: Remove the dead old path** — delete the old `importTeam` IPC handler in `ipc.ts`, the `importTeam` channel constant, and the `importTeam` preload entry + `window.api.importTeam` type. Confirm nothing else references them (`grep -rn "importTeam\b" src` — only the new `importTeamPreview/Apply` should remain).

- [ ] **Step 8: Run** — `npm test` → PASS. `npm run typecheck` → PASS. `npm run build` → PASS.

- [ ] **Step 9: Commit** — `git add -A && git commit -m "feat(s4): import role-preview confirm before applying an imported team"`

---

### Task 8: Settings → Security section

**Files:**
- Modify: `src/renderer/SettingsModal.tsx` (relocate autonomy + skills-pack under a Security heading; add 3 toggles)
- Modify: settings stylesheet (optional `.settings-section` heading style)

**Interfaces:**
- Consumes: `ProjectSettings.trustAnthropicOnly`, `.blockPluginHooks`, `.lockBypassPermissions` (Task 1); existing `update(patch)` + `requestConfirm`.

- [ ] **Step 1: Add a Security section heading + the three toggles** — in `SettingsModal.tsx`, introduce a heading before the relocated autonomy field and add the toggles. Place this block where the autonomy field currently is (move the autonomy `.field` and the two skills-pack `.field`s to sit under this heading):

```jsx
<h3 className="settings-section">Security</h3>

{/* (relocated) Autonomy select — unchanged JSX, now under Security */}

<div className="field">
  <label className="check">
    <input
      type="checkbox"
      checked={s.lockBypassPermissions}
      onChange={(e) => void update({ lockBypassPermissions: e.target.checked })}
    />
    Never bypass permissions (lock)
  </label>
  <div className="radio-desc" style={{ marginTop: 4 }}>
    Forces any Full-auto or per-agent run down to “accept edits”, engine-wide. A hard ceiling.
  </div>
</div>

<div className="field">
  <label className="check">
    <input
      type="checkbox"
      checked={s.trustAnthropicOnly}
      onChange={(e) => void update({ trustAnthropicOnly: e.target.checked })}
    />
    Auto-trust only Anthropic-authored skills
  </label>
  <div className="radio-desc" style={{ marginTop: 4 }}>
    {s.trustAnthropicOnly
      ? 'Only skills authored by Anthropic (in a verified anthropics-owned marketplace) are offered to agents.'
      : '⚠ Third-party skills from anthropics-owned marketplaces are also trusted — their plugin code runs under the agent’s permission mode.'}
  </div>
</div>

<div className="field">
  <label className="check">
    <input
      type="checkbox"
      checked={s.blockPluginHooks}
      onChange={(e) => void update({ blockPluginHooks: e.target.checked })}
    />
    Block skills whose plugin ships hooks
  </label>
  <div className="radio-desc" style={{ marginTop: 4 }}>
    Plugin hooks run shell/HTTP/MCP commands at tool events. Blocked plugins are not offered to agents.
  </div>
</div>

{/* (relocated) Skills-pack toggle + folder — unchanged JSX, now under Security */}
```

- [ ] **Step 2: Move the existing JSX** — cut the autonomy `.field` (212-234) and the two skills-pack `.field`s (187-209) and paste them under the `Security` heading in the order: autonomy → lock → trust → hooks → skills-pack. Leave `onAutonomyChange` and its `requestConfirm` gate exactly as-is.

- [ ] **Step 3: Optional heading style** — if no `.settings-section` style exists, add to the settings CSS: `.settings-section { margin: 18px 0 6px; font-size: 13px; opacity: .8; }`.

- [ ] **Step 4: Typecheck + build** — `npm run typecheck` → PASS. `npm run build` → PASS. `npm test` → PASS.

- [ ] **Step 5: Manual smoke (describe, don't automate)** — note in the commit that the Security section renders the five controls and toggling persists via `updateSettings`. (A full Playwright pass is part of the cycle's live-verify, not this task.)

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(security): Settings Security section — trust/hook/bypass-lock toggles + relocated autonomy/skills-pack"`

---

## Self-Review (completed by plan author)

- **Spec coverage:** §2 settings → Task 1. §3 trust/hooks/fallback/wiring → Task 2. §4.1/4.2 validation+force-mode → Task 4. §4.3 preview-confirm → Tasks 6+7. §4.4 auto-sync → covered transitively by Task 4 (documented note). §4.5 context files → Task 5. §6 Full-auto lock → Task 3. §7 Security UI → Task 8. §4.4 runHeadless no-change → honored (no task touches it). All spec sections map to a task.
- **Placeholder scan:** no TBD/“add validation”/“handle edge cases”; every code step shows the code.
- **Type consistency:** `discoverSkills({mode,blockHooks,root})` defined in Task 2 and called identically in Task 2's wiring; `buildPermissionOptions(mode,{lockBypass})` defined+called in Task 3; `validateTeamBundle` return `{ok,bundle,warnings}` defined in Task 4 and consumed in Task 6; `previewOf`/`buildImportConfirmBody` shapes match across Tasks 6→7. Settings keys identical across Tasks 1/2/3/8.
- **Build-green-per-task:** signature changes (Task 2 trust/discovery, Task 6 IPC) update all callers within the same task or keep the old path until its consumer migrates (Task 6 keeps `importTeam` until Task 7 removes it).
