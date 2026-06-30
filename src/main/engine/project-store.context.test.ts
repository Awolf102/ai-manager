import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// project-store.ts imports `app` from electron at module top; mock it so the module
// loads in plain Node. Unique userData dir per test file so the recents file isn't
// shared with the other test files running in parallel (sharing one '/tmp' raced it).
const USERDATA = vi.hoisted(() => `/tmp/aim-userdata-${Math.random().toString(36).slice(2)}`)
vi.mock('electron', () => ({ app: { getPath: () => USERDATA } }))

import {
  openProject,
  addContextFiles,
  addContextFolders,
  addContextPaths,
  updateContextFolder,
  removeContextFolder,
  setContextScope,
  buildAgentContext,
  createAgent,
  getGraph
} from './project-store'

let proj: string

beforeEach(async () => {
  proj = await fs.mkdtemp(join(tmpdir(), 'aim-ctx-'))
  await openProject(proj)
})

afterEach(async () => {
  await fs.rm(proj, { recursive: true, force: true })
})

describe('addContextFiles symlink + size guard', () => {
  it('rejects a symlink with a reason', async () => {
    const real = join(proj, 'secret.txt')
    await fs.writeFile(real, 'top', 'utf8')
    const link = join(proj, 'link.txt')
    await fs.symlink(real, link)
    const { skipped } = await addContextFiles([link])
    expect(skipped.some((s) => s.includes('link') && s.includes('symlink'))).toBe(true)
  })

  it('rejects an oversized file with a reason', async () => {
    const big = join(proj, 'big.bin')
    await fs.writeFile(big, Buffer.alloc(26 * 1024 * 1024))
    const { skipped } = await addContextFiles([big])
    expect(skipped.some((s) => s.includes('big.bin') && s.includes('too large'))).toBe(true)
  })

  it('accepts a normal small file', async () => {
    const ok = join(proj, 'note.md')
    await fs.writeFile(ok, '# hi', 'utf8')
    const { graph, skipped } = await addContextFiles([ok])
    expect(skipped).toEqual([])
    expect(graph.context?.some((c) => c.fileName === 'note.md')).toBe(true)
  })
})

describe('referenced folders', () => {
  it('records a real directory as an absolute path', async () => {
    const sub = join(proj, 'sub')
    await fs.mkdir(sub)
    const { graph, skipped } = await addContextFolders([sub])
    expect(skipped).toEqual([])
    expect(graph.contextFolders?.some((f) => f.path === sub)).toBe(true)
  })
  it('skips a non-directory and a duplicate', async () => {
    const file = join(proj, 'f.txt')
    await fs.writeFile(file, 'x', 'utf8')
    const r1 = await addContextFolders([file])
    expect(r1.skipped.some((s) => s.includes('f.txt'))).toBe(true)
    const sub = join(proj, 'sub2')
    await fs.mkdir(sub)
    await addContextFolders([sub])
    const r2 = await addContextFolders([sub])
    expect(r2.skipped.some((s) => s.includes('already'))).toBe(true)
  })
  it('updates a note and removes a folder', async () => {
    const sub = join(proj, 'sub3')
    await fs.mkdir(sub)
    const { graph } = await addContextFolders([sub])
    const id = graph.contextFolders![0].id
    const g2 = await updateContextFolder(id, { note: 'the backend' })
    expect(g2.contextFolders![0].note).toBe('the backend')
    const g3 = await removeContextFolder(id)
    expect(g3.contextFolders).toEqual([])
  })
})

describe('addContextPaths router', () => {
  it('copies files and references directories from one mixed list', async () => {
    const file = join(proj, 'note.md')
    await fs.writeFile(file, '# hi', 'utf8')
    const sub = join(proj, 'codedir')
    await fs.mkdir(sub)
    const { graph } = await addContextPaths([file, sub])
    expect(graph.context?.some((c) => c.fileName === 'note.md')).toBe(true)
    expect(graph.contextFolders?.some((f) => f.path === sub)).toBe(true)
  })
})

describe('scope filtering in buildAgentContext', () => {
  it('delivers a kind-scoped item to that kind only', async () => {
    await createAgent({ name: 'web-dev', kind: 'worker' })
    await createAgent({ name: 'lead', kind: 'manager' })
    const worker = getGraph().nodes.find((n) => n.name === 'web-dev')!
    const manager = getGraph().nodes.find((n) => n.name === 'lead')!
    const file = join(proj, 'api.md')
    await fs.writeFile(file, 'spec', 'utf8')
    const { graph } = await addContextFiles([file])
    const fileId = graph.context!.find((c) => c.fileName === 'api.md')!.id
    await setContextScope(fileId, { kinds: ['worker'] })

    const wCtx = await buildAgentContext(worker.id)
    const mCtx = await buildAgentContext(manager.id)
    expect(wCtx.context.some((c) => c.fileName === 'api.md')).toBe(true)
    expect(mCtx.context.some((c) => c.fileName === 'api.md')).toBe(false)
  })
  it('returns graph unchanged and skips the disk write when id matches nothing', async () => {
    const file = join(proj, 'readme.md')
    await fs.writeFile(file, 'hi', 'utf8')
    const { graph: g } = await addContextFiles([file])
    const existingId = g.context![0].id
    const result = await setContextScope('nonexistent-id', { kinds: ['worker'] })
    // existing item untouched
    expect(result.context!.find((c) => c.id === existingId)?.scope).toBeUndefined()
    // returns a ProjectGraph (has the nodes array at minimum)
    expect(Array.isArray(result.nodes)).toBe(true)
  })
  it('delivers a node-scoped folder to that node only, and unscoped to all', async () => {
    await createAgent({ name: 'a', kind: 'worker' })
    await createAgent({ name: 'b', kind: 'worker' })
    const a = getGraph().nodes.find((n) => n.name === 'a')!
    const b = getGraph().nodes.find((n) => n.name === 'b')!
    const scopedDir = join(proj, 'only-a')
    const sharedDir = join(proj, 'shared')
    await fs.mkdir(scopedDir)
    await fs.mkdir(sharedDir)
    const { graph } = await addContextFolders([scopedDir, sharedDir])
    const scopedId = graph.contextFolders!.find((f) => f.path === scopedDir)!.id
    await setContextScope(scopedId, { nodeIds: [a.id] })

    const aCtx = await buildAgentContext(a.id)
    const bCtx = await buildAgentContext(b.id)
    expect(aCtx.folders.map((f) => f.path).sort()).toEqual([scopedDir, sharedDir].sort())
    expect(bCtx.folders.map((f) => f.path)).toEqual([sharedDir])
  })
})
