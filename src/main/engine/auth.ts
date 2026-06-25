import { execFile } from 'node:child_process'
import type { AuthStatus } from '../../shared/types'
import { resolveClaudeBin } from './env'

/**
 * Probe whether Claude Code is usable: resolve the `claude` binary and run a
 * tiny headless call (Haiku, ~nothing) that proves the local login works. Uses
 * the user's existing login — no credentials are handled here.
 */
export function checkAuth(): Promise<AuthStatus> {
  const bin = resolveClaudeBin()
  return new Promise((resolve) => {
    execFile(
      bin,
      ['-p', 'Reply with: OK', '--model', 'claude-haiku-4-5'],
      { timeout: 25000, env: process.env },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`.trim()
        if (!err && stdout.trim()) return resolve({ state: 'ok' })

        const code = (err as (Error & { code?: string }) | null)?.code
        if (code === 'ENOENT') {
          return resolve({ state: 'no-cli', message: 'The `claude` CLI was not found on PATH.' })
        }

        const lc = out.toLowerCase()
        if (
          /log ?in|logged out|unauthor|not authenticat|api key|oauth|forbidden|credit balance|please run|401|403/.test(
            lc
          )
        ) {
          return resolve({ state: 'logged-out', message: firstLine(out) })
        }
        if ((err as { killed?: boolean } | null)?.killed) {
          return resolve({ state: 'error', message: 'Login check timed out.' })
        }
        return resolve({
          state: out ? 'error' : 'logged-out',
          message: firstLine(out) || 'Could not verify the Claude Code login.'
        })
      }
    )
  })
}

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim()) ?? '').slice(0, 200)
}
