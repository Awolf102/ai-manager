import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getCurrentProjectPath } from './project-store'
import { atomicWrite } from './atomic-write'
import { parseEnvEntries, applyEnvEdits, type EnvEntry } from '../../shared/env-file'

function envPath(): string {
  return join(getCurrentProjectPath(), '.env')
}

/** Parsed entries of the project-root .env; [] when the file doesn't exist. */
export async function readEnvFile(): Promise<EnvEntry[]> {
  try {
    return parseEnvEntries(await fs.readFile(envPath(), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/** Reconcile `desired` into the current .env (created if absent) preserving comments. */
export async function writeEnvFile(desired: EnvEntry[]): Promise<void> {
  let existing = ''
  try {
    existing = await fs.readFile(envPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await atomicWrite(envPath(), applyEnvEdits(existing, desired))
}
