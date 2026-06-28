import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
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
  mergeMemory,
  setEdges,
  syncToTeam,
  refreshFromTeam,
  writeRole,
  readRole,
  rosterForDrafting,
  readTeamBrain,
  autoPullFromTeam,
  autoPushToTeam,
  updateSettings,
  applySpawnedTeam,
  parentOf,
  childrenOf,
  handoffPeersOf,
  getContextFiles,
  addContextFiles,
  updateContextFile,
  removeContextFile,
  contextThumbnail,
  deleteAgent,
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
    const quinn = graph.nodes.find((n) => n.name === 'Quinn')!
    await writeMemory(
      dana.id,
      '# Memory: Dana\n\n## Lessons\n- [portable] write tests first\n- [project] api key in config\n\n## Task log\n'
    )
    await setEdges([{ id: 'e1', source: dana.id, target: quinn.id }])

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
    const importedQuinn = after.nodes.find((n) => n.name === 'Quinn')!
    expect(after.edges).toHaveLength(1)
    expect(after.edges[0].source).toBe(imported.id)   // imported Dana
    expect(after.edges[0].target).toBe(importedQuinn.id)
  })
})

describe('team brain sync', () => {
  it('pushes portable lessons to a brain and pulls new ones into another project', async () => {
    const brainPath = join(await tmpProject(), 'brain.aimteam.json')

    // project 1: a team learns a portable + a project lesson, then pushes
    await openProject(await tmpProject())
    await createAgent({ name: 'Dana', kind: 'worker' })
    const g1 = await createAgent({ name: 'Quinn', kind: 'worker' })
    const dana = g1.nodes.find((n) => n.name === 'Dana')!
    const quinn = g1.nodes.find((n) => n.name === 'Quinn')!
    await setEdges([{ id: 'e1', source: dana.id, target: quinn.id }])
    await writeMemory(dana.id, '# Memory: Dana\n\n## Lessons\n- [portable] write tests first\n- [project] api key in config\n\n## Task log\n')

    const push = await syncToTeam(brainPath, 'team-1')
    expect(push.graph.linkedTeam).toEqual({ teamId: 'team-1', path: brainPath })
    const brain = JSON.parse(await fs.readFile(brainPath, 'utf8'))
    expect(brain.teamId).toBe('team-1')
    expect(brain.edges).toHaveLength(1)
    expect(brain.members.find((m: { name: string }) => m.name === 'Dana').lessons).toEqual(['write tests first'])

    // project 2: import the team (links + seeds), then pull a newly-added brain lesson
    await openProject(await tmpProject())
    await importTeam(brain, brainPath)
    const updatedBrain = {
      ...brain,
      members: brain.members.map((m: { name: string; lessons: string[] }) =>
        m.name === 'Dana' ? { ...m, lessons: [...m.lessons, 'verify renders'] } : m
      )
    }
    const pull = await refreshFromTeam(updatedBrain, brainPath)
    expect(pull.updated).toBe(1)
    const dana2 = pull.graph.nodes.find((n) => n.name === 'Dana')!
    const mem2 = await readMemory(dana2.id)
    expect(mem2).toContain('- [portable] verify renders')
    expect(mem2).toContain('- [portable] write tests first')
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

describe('rosterForDrafting', () => {
  it('returns non-orchestrator agents with their roles, plus edges', async () => {
    await openProject(await tmpProject())
    await createAgent({ name: 'Boss', kind: 'orchestrator' })
    const g = await createAgent({ name: 'Dana', kind: 'worker' })
    const boss = g.nodes.find((n) => n.name === 'Boss')!
    const dana = g.nodes.find((n) => n.name === 'Dana')!
    await setEdges([{ id: 'e1', source: boss.id, target: dana.id }])
    await writeRole(dana.id, '# Role: Dana\nA data specialist.')

    const { agents, edges } = await rosterForDrafting()
    expect(agents.map((a) => a.name)).toEqual(['Dana']) // orchestrator excluded
    expect(agents[0].role).toContain('data specialist')
    expect(edges).toHaveLength(1)
  })
})

describe('parentOf', () => {
  it('returns the single reporting parent, or null for a root', async () => {
    await openProject(await tmpProject())
    await createAgent({ name: 'Orchestrator', kind: 'orchestrator' })
    await createAgent({ name: 'Manager', kind: 'manager' })
    const g = await createAgent({ name: 'Worker', kind: 'worker' })

    const o = g.nodes.find((n) => n.kind === 'orchestrator')!
    const m = g.nodes.find((n) => n.kind === 'manager')!
    const w = g.nodes.find((n) => n.kind === 'worker')!

    await setEdges([
      { id: 'e1', source: o.id, target: m.id },
      { id: 'e2', source: m.id, target: w.id }
    ])

    expect(parentOf(w.id)?.id).toBe(m.id)
    expect(parentOf(m.id)?.id).toBe(o.id)
    expect(parentOf(o.id)).toBeNull()
  })
})

describe('handoff edges and the reporting tree', () => {
  it('childrenOf/parentOf ignore handoff edges; handoffPeersOf returns handoff targets', async () => {
    await openProject(await tmpProject())
    await createAgent({ name: 'Lead', kind: 'manager' })
    await createAgent({ name: 'Dev', kind: 'worker' })
    const graph = await createAgent({ name: 'Research', kind: 'worker' })
    const lead = graph.nodes.find((n) => n.name === 'Lead')!
    const dev = graph.nodes.find((n) => n.name === 'Dev')!
    const research = graph.nodes.find((n) => n.name === 'Research')!
    await setEdges([
      { id: 'e1', source: lead.id, target: dev.id }, // reporting (no kind = report)
      { id: 'e2', source: dev.id, target: research.id, kind: 'handoff' } // lateral
    ])

    expect(childrenOf(lead.id).map((n) => n.id)).toEqual([dev.id]) // dev only
    expect(childrenOf(dev.id)).toEqual([]) // research is a handoff peer, NOT a child
    expect(parentOf(research.id)).toBeNull() // handoff edge is not a reporting parent
    expect(parentOf(dev.id)?.id).toBe(lead.id)
    expect(handoffPeersOf(dev.id).map((n) => n.id)).toEqual([research.id])
    expect(handoffPeersOf(lead.id)).toEqual([])
  })
})

describe('auto team-brain sync', () => {
  it('readTeamBrain returns a bundle for a valid file, null otherwise', async () => {
    const path = join(await tmpProject(), 'brain.json')
    expect(await readTeamBrain(path)).toBeNull() // missing
    await fs.writeFile(path, 'not json', 'utf8')
    expect(await readTeamBrain(path)).toBeNull() // invalid JSON
    await fs.writeFile(
      path,
      JSON.stringify({ kind: 'ai-manager-team', version: 1, teamId: 't', name: 'n', exportedAt: 'x', members: [], edges: [] }),
      'utf8'
    )
    expect((await readTeamBrain(path))?.teamId).toBe('t')
  })

  it('auto-sync is gated by the setting (off = no-op, on = push + pull)', async () => {
    const brainPath = join(await tmpProject(), 'brain.aimteam.json')
    await openProject(await tmpProject())
    const g = await createAgent({ name: 'Dana', kind: 'worker' })
    const dana = g.nodes.find((n) => n.name === 'Dana')!
    await writeMemory(dana.id, '# Memory\n\n## Lessons\n- [portable] write tests first\n\n## Task log\n')
    await syncToTeam(brainPath, 'team-1') // creates the brain + links the project

    // Dana learns a new portable lesson locally (not yet pushed)
    await writeMemory(
      dana.id,
      '# Memory\n\n## Lessons\n- [portable] write tests first\n- [portable] verify renders\n\n## Task log\n'
    )

    // setting OFF → both are no-ops
    await autoPushToTeam()
    expect((await readTeamBrain(brainPath))!.members[0].lessons).not.toContain('verify renders')
    expect(await autoPullFromTeam()).toBe(0)

    // setting ON → push sends the new lesson up
    await updateSettings({ autoSyncTeam: true })
    await autoPushToTeam()
    expect((await readTeamBrain(brainPath))!.members[0].lessons).toContain('verify renders')

    // ON → pull merges a brain-only lesson down into the matching agent
    const brain = (await readTeamBrain(brainPath))!
    const withNew = { ...brain, members: brain.members.map((m) => ({ ...m, lessons: [...m.lessons, 'read errors fully'] })) }
    await fs.writeFile(brainPath, JSON.stringify(withNew), 'utf8')
    expect(await autoPullFromTeam()).toBe(1)
    expect(await readMemory(dana.id)).toContain('- [portable] read errors fully')
  })
})

describe('applySpawnedTeam', () => {
  it('creates the proposed agents with roles + reporting edges', async () => {
    await openProject(await tmpProject())
    const g = await createAgent({ name: 'Boss', kind: 'orchestrator' })
    const boss = g.nodes.find((n) => n.name === 'Boss')!
    const after = await applySpawnedTeam(
      [
        { id: 'm1', name: 'Lead', kind: 'manager', role: '# Role: Lead\nA backend lead.', reportsTo: 'orchestrator' },
        { id: 'w1', name: 'API Dev', kind: 'worker', role: '# Role: API', reportsTo: 'm1' }
      ],
      boss.id
    )
    expect(after.nodes).toHaveLength(3) // Boss + Lead + API Dev
    const lead = after.nodes.find((n) => n.name === 'Lead')!
    const apiDev = after.nodes.find((n) => n.name === 'API Dev')!
    expect(lead.kind).toBe('manager')
    expect(await readRole(lead.id)).toContain('backend lead')
    expect(after.edges.some((e) => e.source === boss.id && e.target === lead.id)).toBe(true) // Boss → Lead
    expect(after.edges.some((e) => e.source === lead.id && e.target === apiDev.id)).toBe(true) // Lead → API Dev
  })

  it('creates the agent but skips the edge when reportsTo is an unknown temp id', async () => {
    await openProject(await tmpProject())
    const g = await createAgent({ name: 'Boss', kind: 'orchestrator' })
    const boss = g.nodes.find((n) => n.name === 'Boss')!
    const after = await applySpawnedTeam(
      [{ id: 'w1', name: 'Solo Dev', kind: 'worker', role: '# Role: Solo', reportsTo: 'ghost' }],
      boss.id
    )
    expect(after.nodes).toHaveLength(2) // Boss + Solo Dev
    const soloDev = after.nodes.find((n) => n.name === 'Solo Dev')!
    expect(soloDev.kind).toBe('worker')
    expect(after.edges.some((e) => e.target === soloDev.id)).toBe(false) // no edge to Solo Dev
  })
})

describe('context files', () => {
  it('copies a file into .ai-manager/context, records it, and uniquifies a name collision', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    // two sources with the SAME basename in different dirs
    const srcDirA = join(tmpdir(), `ctx-a-${Math.random().toString(36).slice(2)}`)
    const srcDirB = join(tmpdir(), `ctx-b-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(srcDirA, { recursive: true })
    await fs.mkdir(srcDirB, { recursive: true })
    await fs.writeFile(join(srcDirA, 'mockup.png'), 'AAAA', 'utf8')
    await fs.writeFile(join(srcDirB, 'mockup.png'), 'BBBB', 'utf8')

    await addContextFiles([join(srcDirA, 'mockup.png')])
    const { graph } = await addContextFiles([join(srcDirB, 'mockup.png')])

    expect(graph.context).toHaveLength(2)
    const names = graph.context!.map((c) => c.fileName).sort()
    expect(names).toEqual(['mockup-2.png', 'mockup.png'])
    expect(graph.context!.every((c) => c.isImage)).toBe(true)
    // both copies exist on disk under .ai-manager/context/
    expect(await fs.readFile(join(proj, '.ai-manager', 'context', 'mockup.png'), 'utf8')).toBe('AAAA')
    expect(await fs.readFile(join(proj, '.ai-manager', 'context', 'mockup-2.png'), 'utf8')).toBe('BBBB')
  })

  it('updates a note and removes a file (deleting the copy)', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    const srcDir = join(tmpdir(), `ctx-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(srcDir, { recursive: true })
    await fs.writeFile(join(srcDir, 'spec.md'), '# spec', 'utf8')

    const { graph: added } = await addContextFiles([join(srcDir, 'spec.md')])
    const id = added.context![0].id

    const noted = await updateContextFile(id, { note: 'the API the backend must follow' })
    expect(noted.context![0].note).toBe('the API the backend must follow')

    const removed = await removeContextFile(id)
    expect(removed.context).toHaveLength(0)
    await expect(fs.readFile(join(proj, '.ai-manager', 'context', 'spec.md'), 'utf8')).rejects.toThrow()
  })

  it('returns a data-URL thumbnail for an image, null for a non-image', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    const srcDir = join(tmpdir(), `ctx-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(srcDir, { recursive: true })
    await fs.writeFile(join(srcDir, 'pic.png'), 'PNGDATA', 'utf8')
    await fs.writeFile(join(srcDir, 'notes.txt'), 'text', 'utf8')

    const { graph: g } = await addContextFiles([join(srcDir, 'pic.png'), join(srcDir, 'notes.txt')])
    const pic = g.context!.find((c) => c.fileName === 'pic.png')!
    const txt = g.context!.find((c) => c.fileName === 'notes.txt')!

    const thumb = await contextThumbnail(pic.id)
    expect(thumb?.startsWith('data:image/png;base64,')).toBe(true)
    expect(await contextThumbnail(txt.id)).toBeNull()
  })

  it('skips an unreadable/non-file source, reports it, and still adds the rest', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    const srcDir = join(tmpdir(), `ctx-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(srcDir, { recursive: true })
    await fs.writeFile(join(srcDir, 'good.md'), 'ok', 'utf8')
    const aDir = join(srcDir, 'a-directory')
    await fs.mkdir(aDir, { recursive: true })
    const { graph, skipped } = await addContextFiles([join(srcDir, 'good.md'), aDir, join(srcDir, 'missing.png')])
    expect(graph.context).toHaveLength(1)
    expect(graph.context![0].fileName).toBe('good.md')
    expect(skipped.sort()).toEqual(['a-directory', 'missing.png'])
  })
})

describe('crash-safe graph.json', () => {
  it('keeps a graph.json.bak after a mutating save', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    await createAgent({ name: 'Dana', kind: 'worker' })
    expect(existsSync(join(proj, '.ai-manager', 'graph.json.bak'))).toBe(true)
  })

  it('recovers from .bak when graph.json is corrupt, preserving the corrupt file', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    await createAgent({ name: 'Dana', kind: 'worker' }) // creates .bak (=empty), graph.json (=Dana)
    await createAgent({ name: 'Quinn', kind: 'worker' }) // .bak (=Dana), graph.json (=Dana,Quinn)
    await fs.writeFile(join(proj, '.ai-manager', 'graph.json'), '{ broken', 'utf8')

    const recovered = await openProject(proj)
    expect(recovered.nodes.some((n) => n.name === 'Dana')).toBe(true) // from .bak
    const entries = await fs.readdir(join(proj, '.ai-manager'))
    expect(entries.some((e) => e.startsWith('graph.json.corrupt-'))).toBe(true)
  })

  it('opens an empty graph when graph.json is corrupt and there is no backup', async () => {
    const proj = await tmpProject()
    await fs.mkdir(join(proj, '.ai-manager'), { recursive: true })
    await fs.writeFile(join(proj, '.ai-manager', 'graph.json'), 'not json', 'utf8')
    const g = await openProject(proj)
    expect(g.nodes).toEqual([])
  })

  it('opens a fresh project to an empty graph without creating a .corrupt file', async () => {
    const proj = await tmpProject()
    const g = await openProject(proj)
    expect(g.nodes).toEqual([])
    const entries = await fs.readdir(join(proj, '.ai-manager'))
    expect(entries.some((e) => e.includes('.corrupt-'))).toBe(false)
  })
})

describe('deleteAgent soft-delete', () => {
  it('moves the agent folder to .trash (preserving memory.md) and drops the node + its edges', async () => {
    const proj = await tmpProject()
    await openProject(proj)
    await createAgent({ name: 'Boss', kind: 'orchestrator' })
    const g0 = await createAgent({ name: 'Dana', kind: 'worker' })
    const dana = g0.nodes.find((n) => n.name === 'Dana')!
    const boss = g0.nodes.find((n) => n.name === 'Boss')!
    await writeMemory(dana.id, '# Memory: Dana\n\n## Lessons\n- [portable] keep this\n\n## Task log\n')
    await setEdges([{ id: 'e1', source: boss.id, target: dana.id }])

    const agentDir = join(proj, '.ai-manager', 'agents', dana.slug)
    expect(existsSync(agentDir)).toBe(true)

    const after = await deleteAgent(dana.id)

    expect(after.nodes.find((n) => n.id === dana.id)).toBeUndefined()
    expect(after.edges).toHaveLength(0)
    expect(existsSync(agentDir)).toBe(false)

    const trash = join(proj, '.ai-manager', '.trash')
    const entries = await fs.readdir(trash)
    const moved = entries.find((e) => e.startsWith(`${dana.slug}-`))
    expect(moved).toBeDefined()
    const mem = await fs.readFile(join(trash, moved!, 'memory.md'), 'utf8')
    expect(mem).toContain('[portable] keep this')
  })
})
