# Agent Skills Pack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load a curated, machine-global "skills pack" (4 design skills + Playwright) into **every** agent run as model-invoked options, merged with the orchestrator's per-agent assignments — available, never forced; off/empty = byte-for-byte.

**Architecture:** A pack directory (`~/.ai-manager/skills-pack`, overridable) structured as one local SDK plugin. Pure logic in `shared/skills-pack.ts`; fs discovery in `main/engine/skills-pack.ts`; `agent-runner` merges the pack into each agent's existing `options.plugins`/`options.skills` and appends a headless reminder when Playwright is present. Reuses the exact `SkillSdkOptions` shape the trusted-plugin path already uses.

**Tech Stack:** TypeScript, Electron main, Vitest. Spec: `docs/superpowers/specs/2026-06-26-agent-skills-pack-design.md`.

## Global Constraints

- **Off = byte-for-byte:** with `skillsPackEnabled:false` OR an absent/empty pack dir, every agent's `options` must be identical to today. Regression-test this.
- Reuse `SkillSdkOptions` from `src/shared/skill-trust.ts` — do **not** redefine it.
- Pure logic (no `node:`/electron imports) lives in `shared/`; fs lives in `main/engine/`. Mirror `skill-trust.ts` / `skill-discovery.ts` split.
- No change to `isTrusted`/`discoverSkills`/`offeredSkills` (the trusted-plugin pipeline stays exactly as-is). No `settingSources` change. No MCP.
- TDD, frequent commits, one task per commit.

---

## File Structure

- Create: `src/shared/skills-pack.ts` — pure pack-option assembly (`packSkillOptions`, `mergeSkillOptions`, `headlessNote`, `assembleAgentSkills`).
- Create: `src/shared/skills-pack.test.ts`.
- Create: `src/main/engine/skills-pack.ts` — fs (`resolvePackPath`, `discoverPackSkills`).
- Create: `src/main/engine/skills-pack.test.ts`.
- Modify: `src/shared/types.ts` — add `skillsPackEnabled`, `skillsPackPath` to `ProjectSettings` + `DEFAULT_SETTINGS`.
- Modify: `src/renderer/SettingsModal.tsx` — add the two controls.
- Modify: `src/main/engine/agent-runner.ts` — cached `packSkills()` + merge into `options` + append `headlessNote`.
- Create: `scripts/setup-skills-pack.mjs` — provisioning (#6).

---

### Task 1: Pure pack-option assembly

**Files:**
- Create: `src/shared/skills-pack.ts`
- Test: `src/shared/skills-pack.test.ts`

**Interfaces:**
- Consumes: `SkillSdkOptions` from `./skill-trust`.
- Produces: `packSkillOptions(packPath: string, skillNames: string[]): SkillSdkOptions | null`; `mergeSkillOptions(a: SkillSdkOptions | null, b: SkillSdkOptions | null): SkillSdkOptions | null`; `headlessNote(skillNames: string[]): string`; `assembleAgentSkills(perAgent: SkillSdkOptions | null, packPath: string, packNames: string[]): { options: SkillSdkOptions | null; note: string }`; `SKILLS_PACK_PLUGIN_ID`.

- [ ] **Step 1: Write the failing test** (`src/shared/skills-pack.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import {
  packSkillOptions, mergeSkillOptions, headlessNote, assembleAgentSkills, SKILLS_PACK_PLUGIN_ID
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
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/shared/skills-pack.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** (`src/shared/skills-pack.ts`)

```ts
// Pure assembly of the always-available "skills pack" SDK options. No node/DOM imports.
import type { SkillSdkOptions } from './skill-trust'

export const SKILLS_PACK_PLUGIN_ID = 'ai-manager-skills-pack'

/** SDK options for the pack from discovered skill names. null when path or names are empty. */
export function packSkillOptions(packPath: string, skillNames: string[]): SkillSdkOptions | null {
  if (!packPath || skillNames.length === 0) return null
  return {
    plugins: [{ type: 'local', path: packPath, skipMcpDiscovery: true }],
    skills: skillNames.map((n) => `${SKILLS_PACK_PLUGIN_ID}:${n}`)
  }
}

/** Merge two option sets (either may be null), de-duping plugin paths and skill ids. */
export function mergeSkillOptions(
  a: SkillSdkOptions | null,
  b: SkillSdkOptions | null
): SkillSdkOptions | null {
  if (!a) return b
  if (!b) return a
  const byPath = new Map<string, SkillSdkOptions['plugins'][number]>()
  for (const p of [...a.plugins, ...b.plugins]) byPath.set(p.path, p)
  return { plugins: [...byPath.values()], skills: [...new Set([...a.skills, ...b.skills])] }
}

/** Reminder appended to an agent's prompt when the pack ships the Playwright skill. */
export function headlessNote(skillNames: string[]): string {
  return skillNames.some((n) => n.toLowerCase().includes('playwright'))
    ? '\n\nWhen using the playwright-skill, always launch browsers headless (`headless: true`) — you run in a headless environment with no display.'
    : ''
}

/** Combine per-agent options with the pack; returns merged options + the headless note. */
export function assembleAgentSkills(
  perAgent: SkillSdkOptions | null,
  packPath: string,
  packNames: string[]
): { options: SkillSdkOptions | null; note: string } {
  return {
    options: mergeSkillOptions(perAgent, packSkillOptions(packPath, packNames)),
    note: headlessNote(packNames)
  }
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/shared/skills-pack.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add src/shared/skills-pack.ts src/shared/skills-pack.test.ts && git commit -m "feat(skills): pure skills-pack option assembly"`

---

### Task 2: Pack discovery (fs)

**Files:**
- Create: `src/main/engine/skills-pack.ts`
- Test: `src/main/engine/skills-pack.test.ts`

**Interfaces:**
- Produces: `resolvePackPath(settingPath: string): string`; `discoverPackSkills(packPath: string): Promise<string[]>`.

- [ ] **Step 1: Write the failing test** (`src/main/engine/skills-pack.test.ts`)

```ts
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
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/engine/skills-pack.test.ts` → FAIL.

- [ ] **Step 3: Implement** (`src/main/engine/skills-pack.ts`)

```ts
// fs discovery for the always-available skills pack. Pure shaping lives in shared/skills-pack.ts.
import { promises as fs, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolve the pack dir: explicit setting wins, else ~/.ai-manager/skills-pack. */
export function resolvePackPath(settingPath: string): string {
  const t = (settingPath ?? '').trim()
  return t || join(homedir(), '.ai-manager', 'skills-pack')
}

/** Skill names under <packPath>/skills/* (SKILL.md `name:`, fallback folder). [] if absent. */
export async function discoverPackSkills(packPath: string): Promise<string[]> {
  const skillsDir = join(packPath, 'skills')
  if (!existsSync(skillsDir)) return []
  let entries: { name: string; isDirectory: () => boolean }[]
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names: string[] = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const md = join(skillsDir, ent.name, 'SKILL.md')
    if (!existsSync(md)) continue
    names.push(await skillName(md, ent.name))
  }
  return names
}

async function skillName(skillMdPath: string, fallback: string): Promise<string> {
  try {
    const text = await fs.readFile(skillMdPath, 'utf8')
    const fm = text.match(/^---\n([\s\S]*?)\n---/)
    const m = (fm ? fm[1] : '').match(/^name:\s*(.+?)\s*$/m)
    if (m?.[1]) return m[1].replace(/^["']|["']$/g, '').trim()
  } catch { /* fall through */ }
  return fallback
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/main/engine/skills-pack.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(skills): pack discovery (resolvePackPath + discoverPackSkills)"`

---

### Task 3: Settings field

**Files:**
- Modify: `src/shared/types.ts` (`ProjectSettings` ~line 97-101 + `DEFAULT_SETTINGS` ~line 111-113)
- Modify: `src/renderer/SettingsModal.tsx` (after the threshold field, ~line 143)

**Interfaces:**
- Produces: `ProjectSettings.skillsPackEnabled: boolean`, `ProjectSettings.skillsPackPath: string`.

- [ ] **Step 1: Add to the interface** — in `ProjectSettings`, after `skillInstallThreshold: number`:

```ts
  /** load the always-available curated skills pack for every agent */
  skillsPackEnabled: boolean
  /** override the skills-pack dir; empty = ~/.ai-manager/skills-pack */
  skillsPackPath: string
```

- [ ] **Step 2: Add to `DEFAULT_SETTINGS`** — after `skillInstallThreshold: 100000,`:

```ts
  skillsPackEnabled: true,
  skillsPackPath: '',
```

(Default `true` is safe: an unpopulated pack discovers no skills → no-op.)

- [ ] **Step 3: Add the UI controls** — in `SettingsModal.tsx`, after the threshold `.field` block:

```tsx
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.skillsPackEnabled}
              onChange={(e) => void update({ skillsPackEnabled: e.target.checked })}
            />
            Skills pack — load curated design + Playwright skills as options for every agent
          </label>
        </div>

        <div className="field">
          <label>Skills-pack folder (optional)</label>
          <input
            type="text"
            placeholder="~/.ai-manager/skills-pack"
            value={s.skillsPackPath}
            onChange={(e) => void update({ skillsPackPath: e.target.value })}
          />
          <div className="radio-desc" style={{ marginTop: 4 }}>
            Leave blank for the default. Skills are model-invoked — available to every agent, never forced.
          </div>
        </div>
```

- [ ] **Step 4: Verify** — `npm run typecheck` passes; if a settings-defaults test exists, update it to include the two keys.
- [ ] **Step 5: Commit** — `git commit -am "feat(skills): skillsPackEnabled + skillsPackPath settings"`

---

### Task 4: agent-runner wiring

**Files:**
- Modify: `src/main/engine/agent-runner.ts`

**Interfaces:**
- Consumes: `assembleAgentSkills` (Task 1), `resolvePackPath`/`discoverPackSkills` (Task 2), `getSettings()` (already used at ~line 35).

- [ ] **Step 1: Add imports** (top of file, near the existing `skillOptionsFor` import):

```ts
import { assembleAgentSkills } from '../../shared/skills-pack'
import { resolvePackPath, discoverPackSkills } from './skills-pack'
```

- [ ] **Step 2: Add a cached pack reader** (next to `discoveredPlugins()`, ~line 38):

```ts
let packCache: { at: number; path: string; names: string[] } | null = null
/** Discover the always-available pack skills, cached briefly like discoveredPlugins(). */
async function packSkills(): Promise<{ path: string; names: string[] }> {
  const s = getSettings()
  if (!s.skillsPackEnabled) return { path: '', names: [] }
  const path = resolvePackPath(s.skillsPackPath ?? '')
  const now = Date.now()
  if (packCache && packCache.path === path && now - packCache.at < 30_000) {
    return { path, names: packCache.names }
  }
  const names = await discoverPackSkills(path)
  packCache = { at: now, path, names }
  return { path, names }
}
```

- [ ] **Step 3: Fetch the pack before building `options`** — in `streamAgent`, before `const options: Options = {` (~line 87):

```ts
    const pack = await packSkills()
```

- [ ] **Step 4: Append the headless note to the system prompt** — change the `systemPrompt` line (~line 90) to:

```ts
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: composeAppend(role, memory, context) + headlessNote(pack.names)
      },
```

…and add `headlessNote` to the Task-1 import: `import { assembleAgentSkills, headlessNote } from '../../shared/skills-pack'`.

- [ ] **Step 5: Merge the pack into the skills options** — replace the existing per-agent skills block (~lines 104-108) with:

```ts
    const perAgent = skillOptionsFor(agent.skills, await discoveredPlugins())
    const { options: skillSdk } = assembleAgentSkills(perAgent, pack.path, pack.names)
    if (skillSdk) {
      options.plugins = skillSdk.plugins
      options.skills = skillSdk.skills
    }
```

- [ ] **Step 6: Verify** — `npm run typecheck` + `npm run build` pass. Confirm by reading the diff that when `skillsPackEnabled:false` → `packSkills()` returns empty names → `assembleAgentSkills` returns `perAgent` unchanged and `headlessNote('')` is `''` → **byte-for-byte** with today.
- [ ] **Step 7: Commit** — `git commit -am "feat(skills): merge skills pack into every agent run + headless note"`

---

### Task 5: Provisioning script (#6)

**Files:**
- Create: `scripts/setup-skills-pack.mjs`

**Interfaces:** none (CLI). Usage: `node scripts/setup-skills-pack.mjs [packDir]` (default `~/.ai-manager/skills-pack`).

- [ ] **Step 1: Implement the script**

```js
#!/usr/bin/env node
// Populate the AI Manager skills pack: create the plugin manifest, install Playwright
// (incl. Chromium), and copy each bare design skill into <pack>/skills/.
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, cpSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const pack = process.argv[2] || join(homedir(), '.ai-manager', 'skills-pack')
const skillsDir = join(pack, 'skills')
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' })

mkdirSync(join(pack, '.claude-plugin'), { recursive: true })
mkdirSync(skillsDir, { recursive: true })
writeFileSync(
  join(pack, '.claude-plugin', 'plugin.json'),
  JSON.stringify({ name: 'ai-manager-skills-pack', version: '1.0.0', description: 'AI Manager curated always-available skills' }, null, 2)
)

// --- Playwright (known layout) ---
const pwTmp = join(tmpdir(), `pw-skill-${process.pid}`)
rmSync(pwTmp, { recursive: true, force: true })
run(`git clone --depth 1 https://github.com/lackeyjb/playwright-skill.git "${pwTmp}"`)
cpSync(join(pwTmp, 'skills', 'playwright-skill'), join(skillsDir, 'playwright-skill'), { recursive: true })
run('npm run setup', join(skillsDir, 'playwright-skill')) // npm install + npx playwright install chromium
rmSync(pwTmp, { recursive: true, force: true })

// --- Design skills: run each installer in a temp project, copy resulting .claude/skills/* ---
// (impeccable's `/impeccable init` is a Claude Code slash command; run it once yourself if its
//  setup needs it. This copies whatever skill folders the installers emit.)
const designInstalls = [
  'npx -y skills add emilkowalski/skill',
  'npx -y skills add Leonxlnx/taste-skill',
  'npx -y impeccable install',
  'npx -y uipro init --ai claude'
]
for (const cmd of designInstalls) {
  const t = join(tmpdir(), `skill-${process.pid}-${Math.abs(hash(cmd))}`)
  rmSync(t, { recursive: true, force: true })
  mkdirSync(t, { recursive: true })
  try {
    run(cmd, t)
    const src = join(t, '.claude', 'skills')
    if (existsSync(src)) {
      for (const name of readdirSync(src)) cpSync(join(src, name), join(skillsDir, name), { recursive: true })
    } else {
      console.warn(`[warn] "${cmd}" produced no .claude/skills/ in ${t} — inspect and copy manually.`)
    }
  } catch (e) {
    console.warn(`[warn] "${cmd}" failed: ${e.message} — skipping; install manually if needed.`)
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
}

// tiny stable hash for temp dir names (Math.random is fine here; not in the app)
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h }

console.log(`\nSkills pack ready at: ${pack}`)
console.log('Skills installed:', existsSync(skillsDir) ? readdirSync(skillsDir).join(', ') : '(none)')
```

- [ ] **Step 2: Smoke the script's safe parts** — `node -c scripts/setup-skills-pack.mjs` (syntax check). Do **not** run network installs in CI.
- [ ] **Step 3: Commit** — `git add scripts/setup-skills-pack.mjs && git commit -m "feat(skills): setup-skills-pack provisioning script (#6)"`

---

### Task 6: Live install + end-to-end verification (manual)

Not a code task — the live-smoke step (run during/after merge, per the project's usual "live smoke pending" pattern).

- [ ] Run `node scripts/setup-skills-pack.mjs`; confirm `~/.ai-manager/skills-pack/skills/` contains the five skill folders + Chromium under `playwright-skill`.
- [ ] Record the actual skill `name:` ids (resolves the spec's open item) and confirm the pack's `.claude-plugin/plugin.json` is valid.
- [ ] Start a run with a UI-flavored goal; confirm a worker can invoke a design skill, and a QA/verify agent can drive the running app headless via Playwright.
- [ ] Confirm a non-UI agent (e.g. a schema/research role) does **not** trigger the design/Playwright skills.
- [ ] Toggle `skillsPackEnabled:false` → confirm runs behave exactly as before.

---

## Self-Review

- **Spec coverage:** pack mechanism (T1/T2/T4), settings (T3), provisioning #6 (T5), per-role pipeline untouched (T4 leaves `skillOptionsFor` path intact), off=byte-for-byte (T3 default no-op + T4 Step 6 + T6), headless caveat (T4 Step 4), out-of-scope respected (no trust/MCP/settingSources changes).
- **Type consistency:** `SkillSdkOptions` reused; `assembleAgentSkills`/`packSkills`/`resolvePackPath`/`discoverPackSkills` names consistent across tasks.
- **No placeholders:** every code step is concrete. The only genuine unknown (bespoke installer output dirs) is handled by the script's generic `.claude/skills/*` copy + warn, and pinned in T6.
