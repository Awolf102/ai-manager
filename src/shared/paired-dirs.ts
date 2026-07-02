// Pure helpers for paired working directories (no node/DOM imports — unit-tested in plain Node,
// used by the agent runner, the PTY manager, and the renderer).
import type { PairedDir } from './types'

/** Partition paired dirs into writable (access-grant) and read-only (prompt-reference) paths. */
export function splitPairedDirs(dirs: PairedDir[] = []): { writablePaths: string[]; readOnlyPaths: string[] } {
  const writablePaths: string[] = []
  const readOnlyPaths: string[] = []
  for (const dir of dirs) (dir.writable ? writablePaths : readOnlyPaths).push(dir.path)
  return { writablePaths, readOnlyPaths }
}

/** CLI args granting the interactive `claude` PTY access to each WRITABLE paired dir. Empty ⇒ []. */
export function pairedDirCliArgs(dirs: PairedDir[] = []): string[] {
  return splitPairedDirs(dirs).writablePaths.flatMap((p) => ['--add-dir', p])
}
