import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverSkills } from './skill-discovery'

// ---- new TDD tests from brief ----

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

// ---- legacy fixture-based tests (adapted to new signature) ----

describe('discoverSkills (legacy fixture)', () => {
  async function fixtureRoot(): Promise<string> {
    const r = join(tmpdir(), `aim-skills-${Math.random().toString(36).slice(2)}`)
    const mkDir = join(r, 'marketplaces', 'knowledge-work-plugins')
    const offDir = join(r, 'marketplaces', 'claude-plugins-official')
    // on-disk skills for: data (anthropics/kw, subdir layout) + adobe (cache install layout)
    await fs.mkdir(join(mkDir, 'data', 'skills', 'airflow'), { recursive: true })
    await fs.writeFile(join(mkDir, 'data', 'skills', 'airflow', 'SKILL.md'), '---\nname: airflow\n---\n', 'utf8')
    await fs.mkdir(join(r, 'cache', 'claude-plugins-official', 'adobe-for-creativity', '1.1.0', 'skills', 'edit-image'), { recursive: true })
    await fs.mkdir(join(offDir, '.claude-plugin'), { recursive: true })

    await fs.writeFile(join(r, 'known_marketplaces.json'), JSON.stringify({
      'knowledge-work-plugins': { source: { source: 'github', repo: 'anthropics/knowledge-work-plugins' }, installLocation: mkDir },
      'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' }, installLocation: offDir }
    }), 'utf8')
    await fs.writeFile(join(r, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'adobe-for-creativity@claude-plugins-official': [
          { scope: 'user', installPath: join(r, 'cache', 'claude-plugins-official', 'adobe-for-creativity', '1.1.0'), version: '1.1.0' }
        ]
      }
    }), 'utf8')
    await fs.writeFile(join(r, 'plugin-catalog-cache.json'), JSON.stringify({
      version: 1, fetchedAt: 'x',
      catalog: { plugins: {
        'data@knowledge-work-plugins': { unique_installs: 5, components: { skills: [{ name: 'airflow' }] }, marketplace_entry: { author: { name: 'Anthropic' }, description: 'Data.' } },
        'adobe-for-creativity@claude-plugins-official': { unique_installs: 250000, components: { skills: [{ name: 'edit-image' }] }, marketplace_entry: { author: { name: 'Adobe' }, description: 'Creative.' } },
        'ghost@claude-plugins-official': { unique_installs: 999999, components: { skills: [{ name: 'g' }] }, marketplace_entry: { author: { name: 'X' }, description: 'no files on disk' } }
      } }
    }), 'utf8')
    return r
  }

  it('returns trusted plugins whose skills dir exists on disk (anthropic-marketplaces)', async () => {
    const r = await fixtureRoot()
    const out = await discoverSkills({ mode: 'anthropic-marketplaces', blockHooks: false, root: r })
    const ids = out.map((p) => p.id).sort()
    // data (subdir layout) + adobe (cache installPath layout); ghost dropped (no skills dir on disk)
    expect(ids).toEqual(['adobe-for-creativity', 'data'])
    expect(out.find((p) => p.id === 'data')!.skills.map((s) => s.id)).toEqual(['data:airflow'])
    expect(out.find((p) => p.id === 'data')!.path).toContain(join('knowledge-work-plugins', 'data'))
    await fs.rm(r, { recursive: true, force: true })
  })

  it('returns [] when the plugins root does not exist', async () => {
    expect(await discoverSkills({ mode: 'anthropic-marketplaces', blockHooks: false, root: join(tmpdir(), 'aim-nope-' + Math.random()) })).toEqual([])
  })

  it('falls back to on-disk scan (anthropic-marketplaces) and returns only anthropics/* marketplace plugins when no cache present', async () => {
    const r = join(tmpdir(), `aim-skills-nocache-${Math.random().toString(36).slice(2)}`)
    // anthropics/* marketplace: one plugin with a skill on disk
    const anthropicDir = join(r, 'marketplaces', 'official')
    await fs.mkdir(join(anthropicDir, 'trusted-plugin', 'skills', 'my-skill'), { recursive: true })
    await fs.writeFile(join(anthropicDir, 'trusted-plugin', 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\n', 'utf8')
    // non-anthropics marketplace: one plugin with a skill on disk — should NOT be returned
    const thirdPartyDir = join(r, 'marketplaces', 'third-party')
    await fs.mkdir(join(thirdPartyDir, 'untrusted-plugin', 'skills', 'other-skill'), { recursive: true })
    await fs.writeFile(join(thirdPartyDir, 'untrusted-plugin', 'skills', 'other-skill', 'SKILL.md'), '---\nname: other-skill\n---\n', 'utf8')
    // known_marketplaces.json listing both marketplaces
    await fs.writeFile(join(r, 'known_marketplaces.json'), JSON.stringify({
      'official': { source: { source: 'github', repo: 'anthropics/official' }, installLocation: anthropicDir },
      'third-party': { source: { repo: 'someone/plugins' }, installLocation: thirdPartyDir }
    }), 'utf8')
    // NO plugin-catalog-cache.json → forces fallback scan
    const out = await discoverSkills({ mode: 'anthropic-marketplaces', blockHooks: false, root: r })
    const ids = out.map((p) => p.id)
    expect(ids).toContain('trusted-plugin')
    expect(ids).not.toContain('untrusted-plugin')
    const p = out.find((p) => p.id === 'trusted-plugin')!
    expect(p.author).toBe('Anthropic')
    expect(p.uniqueInstalls).toBe(0)
    expect(p.skills.map((s) => s.id)).toContain('trusted-plugin:my-skill')
    await fs.rm(r, { recursive: true, force: true })
  })
})
