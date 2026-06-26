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
