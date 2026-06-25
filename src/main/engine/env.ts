import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let applied = false

/**
 * Electron GUI apps on macOS launch with a minimal PATH that usually does NOT
 * include `~/.local/bin`, Homebrew, etc. — so the `claude` binary can't be
 * found. Recover the real PATH from a login shell once at startup and merge in
 * the common bin dirs as a fallback. Both node-pty (`claude` TUI) and the Agent
 * SDK (which spawns the claude CLI) depend on this.
 */
export function ensureLoginPath(): void {
  if (applied || process.platform === 'win32') return
  applied = true

  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const out = execSync(`${shell} -lic 'printf "%s" "$PATH"'`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const path = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('/'))
      .pop()
    if (path) process.env.PATH = path
  } catch {
    // fall through to the static fallback below
  }

  const parts = new Set((process.env.PATH || '').split(':').filter(Boolean))
  for (const p of [
    join(homedir(), '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ]) {
    if (existsSync(p)) parts.add(p)
  }
  process.env.PATH = Array.from(parts).join(':')
}

/** Resolve an absolute path to the `claude` binary, or 'claude' to rely on PATH. */
export function resolveClaudeBin(): string {
  for (const p of [
    join(homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ]) {
    if (existsSync(p)) return p
  }
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const out = execSync(`${shell} -lic 'command -v claude'`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const line = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop()
    if (line && existsSync(line)) return line
  } catch {
    // ignore
  }
  return 'claude'
}
