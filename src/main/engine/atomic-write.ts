import { promises as fs } from 'node:fs'

let seq = 0
function tmpName(target: string): string {
  return `${target}.${process.pid}.${seq++}.tmp`
}

/** Write `data` to `target` atomically (temp file + rename): a crash mid-write never
 *  leaves a torn file, and concurrent writers never interleave bytes (last rename wins). */
export async function atomicWrite(target: string, data: string): Promise<void> {
  const tmp = tmpName(target)
  await fs.writeFile(tmp, data, 'utf8')
  await fs.rename(tmp, target)
}

/** Like atomicWrite, but first demotes an existing `target` to `${target}.bak`
 *  (a cheap rename — no data copy), keeping one previous good version for recovery. */
export async function atomicWriteWithBackup(target: string, data: string): Promise<void> {
  const tmp = tmpName(target)
  await fs.writeFile(tmp, data, 'utf8')
  try {
    await fs.rename(target, `${target}.bak`) // demote previous version; ENOENT (no prior file) is fine
  } catch {
    // no existing target, or a concurrent writer already moved it — ignore
  }
  await fs.rename(tmp, target)
}
