import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// project-store.ts imports `app` from electron at module top; mock it so the module
// loads in plain Node. mergeMemory itself touches neither electron nor the fs.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import {
  openProject,
  createAgent,
  writeMemory,
  readMemory,
  exportTeam,
  importTeam,
  mergeMemory
} from './project-store'

async function tmpProject(): Promise<string> {
  const dir = join(tmpdir(), `aim-test-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe('team export/import round-trip', () => {
  it('exports portable lessons only and re-imports the team into a fresh project', async () => {
    await openProject(await tmpProject())
    await createAgent({ name: 'Dana', kind: 'worker' })
    const graph = await createAgent({ name: 'Quinn', kind: 'worker' })
    const dana = graph.nodes.find((n) => n.name === 'Dana')!
    await writeMemory(
      dana.id,
      '# Memory: Dana\n\n## Lessons\n- [portable] write tests first\n- [project] api key in config\n\n## Task log\n'
    )

    const bundle = await exportTeam()
    expect(bundle.kind).toBe('ai-manager-team')
    expect(bundle.members).toHaveLength(2)
    const danaMember = bundle.members.find((m) => m.name === 'Dana')!
    expect(danaMember.lessons).toEqual(['write tests first']) // project lesson excluded

    await openProject(await tmpProject()) // fresh, empty project
    const after = await importTeam(bundle)
    expect(after.nodes).toHaveLength(2)
    const imported = after.nodes.find((n) => n.name === 'Dana')!
    expect(imported.memberId).toBe(danaMember.memberId)
    const mem = await readMemory(imported.id)
    expect(mem).toContain('- [portable] write tests first')
    expect(mem).not.toContain('api key in config')
  })
})

describe('mergeMemory — tagged lessons', () => {
  it('writes a new tagged lesson as a bullet under ## Lessons', () => {
    const next = mergeMemory('', {
      win: '',
      loss: '',
      lessons: ['[portable] write a failing test first'],
      label: 'goal'
    })
    expect(next).toContain('- [portable] write a failing test first')
  })

  it('dedups a re-learned lesson by text even when its scope tag differs', () => {
    const base = '# Memory\n\n## Lessons\n- [portable] verify renders return 200\n\n## Task log\n'
    const next = mergeMemory(base, {
      win: '',
      loss: '',
      lessons: ['[project] verify renders return 200'],
      label: 'goal'
    })
    const occurrences = (next.match(/verify renders return 200/g) || []).length
    expect(occurrences).toBe(1) // not duplicated; existing [portable] bullet wins
    expect(next).toContain('- [portable] verify renders return 200')
  })
})
