import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import * as pty from 'node-pty'
import type { SpawnPtyInput } from '../../shared/types'
import { IPC } from '../../shared/types'
import { buildAgentContext } from './project-store'
import { resolveClaudeBin } from './env'

type Session = { proc: pty.IPty }
const sessions = new Map<string, Session>()

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
  const { agent, projectPath, role, memory } = await buildAgentContext(input.agentId)
  const ptyId = randomUUID()

  const append = [role.trim(), '', '## Your memory', memory.trim() || '(empty)'].join('\n')
  const args = [
    '--append-system-prompt',
    append,
    '--model',
    agent.model,
    '--permission-mode',
    agent.permissionMode
  ]
  if (input.resume && agent.sessionId) args.push('--resume', agent.sessionId)

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
