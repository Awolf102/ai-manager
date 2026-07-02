import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const USERDATA = vi.hoisted(() => `/tmp/aim-userdata-${Math.random().toString(36).slice(2)}`)
vi.mock('electron', () => ({ app: { getPath: () => USERDATA } }))

import {
  openProject,
  getPairedDirs,
  addPairedDirs,
  setPairedDirWritable,
  removePairedDir
} from './project-store'

let proj: string
beforeEach(async () => {
  proj = await fs.mkdtemp(join(tmpdir(), 'aim-pd-'))
  await openProject(proj)
})
afterEach(async () => {
  await fs.rm(proj, { recursive: true, force: true })
})

describe('paired dirs store', () => {
  it('defaults to an empty list on open', () => {
    expect(getPairedDirs()).toEqual([])
  })

  it('adds a real directory as read-only with an absolute path', async () => {
    const sub = join(proj, 'lib')
    await fs.mkdir(sub)
    const { skipped } = await addPairedDirs([sub])
    expect(skipped).toEqual([])
    const dirs = getPairedDirs()
    expect(dirs).toHaveLength(1)
    expect(dirs[0].path).toBe(sub)
    expect(dirs[0].writable).toBe(false)
  })

  it('skips symlinks, non-dirs, dupes, and the project root', async () => {
    const sub = join(proj, 'lib')
    await fs.mkdir(sub)
    const file = join(proj, 'f.txt')
    await fs.writeFile(file, 'x', 'utf8')
    const link = join(proj, 'link')
    await fs.symlink(sub, link)
    await addPairedDirs([sub])
    const { skipped } = await addPairedDirs([sub, file, link, proj])
    expect(skipped.some((s) => s.includes('already added'))).toBe(true)
    expect(skipped.some((s) => s.includes('not a folder'))).toBe(true)
    expect(skipped.some((s) => s.includes('symlink'))).toBe(true)
    expect(skipped.some((s) => s.includes('project root'))).toBe(true)
    expect(getPairedDirs()).toHaveLength(1)
  })

  it('toggles writable and removes', async () => {
    const sub = join(proj, 'lib')
    await fs.mkdir(sub)
    await addPairedDirs([sub])
    const id = getPairedDirs()[0].id
    await setPairedDirWritable(id, true)
    expect(getPairedDirs()[0].writable).toBe(true)
    await removePairedDir(id)
    expect(getPairedDirs()).toEqual([])
  })
})
