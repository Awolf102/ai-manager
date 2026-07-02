import { safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './atomic-write'

const SECRET_FILE = 'backend-secrets.json'

function aimDir(projectPath: string): string {
  return join(projectPath, '.ai-manager')
}
function secretPath(projectPath: string): string {
  return join(aimDir(projectPath), SECRET_FILE)
}

/** True when the OS provides an encryption backend (keychain / DPAPI / libsecret). */
export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

async function readMap(projectPath: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(secretPath(projectPath), 'utf8')) as Record<string, string>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

/** Ensure `.ai-manager/.gitignore` ignores the secret file (scoped to the app dir; project root untouched). */
async function ensureGitignore(projectPath: string): Promise<void> {
  const gi = join(aimDir(projectPath), '.gitignore')
  let cur = ''
  try {
    cur = await fs.readFile(gi, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (cur.split(/\r?\n/).some((l) => l.trim() === SECRET_FILE)) return
  const next = (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + SECRET_FILE + '\n'
  await fs.writeFile(gi, next, 'utf8')
}

/** Encrypt + persist a backend token (base64 of the safeStorage cipher). Throws if unavailable. */
export async function setBackendToken(projectPath: string, id: string, token: string): Promise<void> {
  if (!encryptionAvailable()) throw new Error('Secure storage is unavailable on this system')
  await fs.mkdir(aimDir(projectPath), { recursive: true })
  const map = await readMap(projectPath)
  map[id] = safeStorage.encryptString(token).toString('base64')
  await atomicWrite(secretPath(projectPath), JSON.stringify(map, null, 2))
  await ensureGitignore(projectPath)
}

/** Decrypt a backend token, or undefined if unset/undecryptable. MAIN PROCESS ONLY. */
export async function getBackendToken(projectPath: string, id: string): Promise<string | undefined> {
  const enc = (await readMap(projectPath))[id]
  if (!enc) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return undefined
  }
}

export async function hasBackendToken(projectPath: string, id: string): Promise<boolean> {
  return !!(await readMap(projectPath))[id]
}

export async function deleteBackendToken(projectPath: string, id: string): Promise<void> {
  const map = await readMap(projectPath)
  if (!(id in map)) return
  delete map[id]
  await atomicWrite(secretPath(projectPath), JSON.stringify(map, null, 2))
}
