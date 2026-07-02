import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import * as pty from 'node-pty'
import type { SpawnPtyInput, PairedDir } from '../../shared/types'
import { IPC } from '../../shared/types'
import { pairedDirCliArgs } from '../../shared/paired-dirs'
import { buildAgentContext, getCurrentProjectPath, getSettings } from './project-store'
import { resolveClaudeBin } from './env'
import { launchMode } from './acting-mode'

type Session = { proc: pty.IPty }
const sessions = new Map<string, Session>()

/** Assemble the interactive `claude` CLI args. Pure + exported for tests. Writable paired dirs
 *  become `--add-dir` grants; empty ⇒ the baseline args (byte-for-byte). */
export function buildClaudeArgs(input: {
  append: string
  model: string
  mode: string
  resumeSessionId?: string
  pairedDirs?: PairedDir[]
}): string[] {
  const args = [
    '--append-system-prompt', input.append,
    '--model', input.model,
    '--permission-mode', input.mode,
    ...pairedDirCliArgs(input.pairedDirs)
  ]
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId)
  return args
}

function cleanEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v != null)
  ) as Record<string, string>
  env.TERM = 'xterm-256color'
  return env
}

export async function spawnPty(
  wc: WebContents,
  input: SpawnPtyInput
): Promise<{ ptyId: string }> {
  const { agent, projectPath, role, memory, pairedDirs } = await buildAgentContext(input.agentId)
  const ptyId = randomUUID()

  const settings = getSettings()
  const append = [role.trim(), '', '## Your memory', memory.trim() || '(empty)'].join('\n')
  const args = buildClaudeArgs({
    append,
    model: agent.model,
    mode: launchMode(settings.autonomy, settings.lockBypassPermissions),
    resumeSessionId: input.resume && agent.sessionId ? agent.sessionId : undefined,
    pairedDirs
  })

  const proc = pty.spawn(resolveClaudeBin(), args, {
    name: 'xterm-256color',
    cols: Math.max(2, input.cols || 80),
    rows: Math.max(2, input.rows || 24),
    cwd: projectPath,
    env: cleanEnv()
  })

  sessions.set(ptyId, { proc })

  proc.onData((data) => {
    if (!wc.isDestroyed()) wc.send(IPC.ptyData, { ptyId, data })
  })
  proc.onExit(({ exitCode }) => {
    sessions.delete(ptyId)
    if (!wc.isDestroyed()) wc.send(IPC.ptyExit, { ptyId, exitCode })
  })

  return { ptyId }
}

/** Spawn a plain interactive login shell at the project root (no agent). Reuses the
 *  same sessions map + writePty/resizePty/killPty/ptyData/ptyExit plumbing. */
export async function spawnShellPty(
  wc: WebContents,
  input: { cols: number; rows: number }
): Promise<{ ptyId: string }> {
  const ptyId = randomUUID()
  const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')
  const args = process.platform === 'win32' ? [] : ['-il']
  const proc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: Math.max(2, input.cols || 80),
    rows: Math.max(2, input.rows || 24),
    cwd: getCurrentProjectPath(),
    env: cleanEnv()
  })
  sessions.set(ptyId, { proc })
  proc.onData((data) => {
    if (!wc.isDestroyed()) wc.send(IPC.ptyData, { ptyId, data })
  })
  proc.onExit(({ exitCode }) => {
    sessions.delete(ptyId)
    if (!wc.isDestroyed()) wc.send(IPC.ptyExit, { ptyId, exitCode })
  })
  return { ptyId }
}

export function writePty(ptyId: string, data: string): void {
  try {
    sessions.get(ptyId)?.proc.write(data)
  } catch {
    // pty may have exited between the keystroke and onExit deleting the session — drop it
  }
}

export function resizePty(ptyId: string, cols: number, rows: number): void {
  const s = sessions.get(ptyId)
  if (!s) return
  try {
    s.proc.resize(Math.max(2, cols), Math.max(2, rows))
  } catch {
    // pty may have exited between resize calls — ignore
  }
}

export function killPty(ptyId: string): void {
  const s = sessions.get(ptyId)
  if (!s) return
  try {
    s.proc.kill()
  } catch {
    // already dead
  }
  sessions.delete(ptyId)
}

export function killAllPtys(): void {
  for (const { proc } of sessions.values()) {
    try {
      proc.kill()
    } catch {
      // ignore
    }
  }
  sessions.clear()
}
