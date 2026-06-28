import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite, atomicWriteWithBackup } from './atomic-write'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-write-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('atomicWrite', () => {
  it('writes the content to the target and leaves no .tmp behind', async () => {
    const target = join(dir, 'f.json')
    await atomicWrite(target, 'hello')
    expect(await fs.readFile(target, 'utf8')).toBe('hello')
    expect(await fs.readdir(dir)).toEqual(['f.json'])
  })
})

describe('atomicWriteWithBackup', () => {
  it('does not create a .bak on the first write', async () => {
    const target = join(dir, 'f.json')
    await atomicWriteWithBackup(target, 'v1')
    expect(await fs.readFile(target, 'utf8')).toBe('v1')
    expect(existsSync(`${target}.bak`)).toBe(false)
  })

  it('demotes the previous content to .bak on the second write, leaving no .tmp', async () => {
    const target = join(dir, 'f.json')
    await atomicWriteWithBackup(target, 'v1')
    await atomicWriteWithBackup(target, 'v2')
    expect(await fs.readFile(target, 'utf8')).toBe('v2')
    expect(await fs.readFile(`${target}.bak`, 'utf8')).toBe('v1')
    expect((await fs.readdir(dir)).some((e) => e.endsWith('.tmp'))).toBe(false)
  })
})
