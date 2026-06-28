import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// project-store.ts imports `app` from electron at module top; mock it so the module
// loads in plain Node. Unique userData dir per test file so the recents file isn't
// shared with the other test files running in parallel (sharing one '/tmp' raced it).
const USERDATA = vi.hoisted(() => `/tmp/aim-userdata-${Math.random().toString(36).slice(2)}`)
vi.mock('electron', () => ({ app: { getPath: () => USERDATA } }))

import { openProject, addContextFiles } from './project-store'

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
