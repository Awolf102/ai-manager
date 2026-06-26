// Launches and tracks the long-running server the agents built, streaming its
// output to the renderer and opening the system browser when the port is ready.
// Modeled on pty-manager.ts; impure (child_process) and not unit-tested.
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { shell } from 'electron'
import type { WebContents } from 'electron'
import { IPC } from '../../shared/types'
import type { ServerStatus } from '../../shared/types'
import { getCurrentProjectPath } from './project-store'

type Server = { serverId: string; proc: ChildProcess }
let active: Server | null = null

const READY_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 300

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v != null)
  ) as Record<string, string>
}

function sendStatus(wc: WebContents, serverId: string, status: ServerStatus): void {
  if (!wc.isDestroyed()) wc.send(IPC.serverStatus, { serverId, status })
}

export function launchServer(
  wc: WebContents,
  input: { startCommand: string; port?: number; path?: string }
): { serverId: string } {
  stopActive() // one server at a time
  const serverId = randomUUID()
  const projectPath = getCurrentProjectPath()
  const proc = spawn(input.startCommand, {
    shell: true,
    detached: true,
    cwd: projectPath,
    env: cleanEnv()
  })
  active = { serverId, proc }
  sendStatus(wc, serverId, 'starting')

  const onLog = (data: Buffer): void => {
    if (!wc.isDestroyed()) wc.send(IPC.serverLog, { serverId, data: data.toString() })
  }
  proc.stdout?.on('data', onLog)
  proc.stderr?.on('data', onLog)
  proc.on('error', (err) => {
    if (!wc.isDestroyed()) wc.send(IPC.serverLog, { serverId, data: `[spawn error] ${err.message}\n` })
    sendStatus(wc, serverId, 'error')
  })
  proc.on('exit', (code) => {
    if (active?.serverId === serverId) active = null
    sendStatus(wc, serverId, 'exited')
    if (!wc.isDestroyed()) wc.send(IPC.serverLog, { serverId, data: `\n[server exited (${code})]\n` })
  })

  if (input.port) waitForPort(wc, serverId, input.port, input.path ?? '/')
  else sendStatus(wc, serverId, 'running') // no port to poll — assume up

  return { serverId }
}

function waitForPort(wc: WebContents, serverId: string, port: number, path: string): void {
  const deadline = Date.now() + READY_TIMEOUT_MS
  const tick = (): void => {
    if (active?.serverId !== serverId) return // replaced or stopped
    const sock = connect(port, '127.0.0.1')
    sock.once('connect', () => {
      sock.destroy()
      if (active?.serverId !== serverId) return
      const url = `http://localhost:${port}${path}`
      sendStatus(wc, serverId, 'running')
      if (!wc.isDestroyed()) wc.send(IPC.serverReady, { serverId, url })
      void shell.openExternal(url)
    })
    sock.once('error', () => {
      sock.destroy()
      if (active?.serverId !== serverId) return
      if (Date.now() > deadline) {
        if (!wc.isDestroyed())
          wc.send(IPC.serverLog, { serverId, data: `\n[timed out waiting for port ${port}]\n` })
        sendStatus(wc, serverId, 'error')
      } else {
        setTimeout(tick, POLL_INTERVAL_MS)
      }
    })
  }
  setTimeout(tick, POLL_INTERVAL_MS)
}

export function stopServer(serverId: string): void {
  if (active?.serverId === serverId) stopActive()
}

function stopActive(): void {
  if (!active) return
  const { proc } = active
  active = null
  try {
    if (proc.pid) process.kill(-proc.pid, 'SIGTERM') // negative pid = whole process group
    else proc.kill()
  } catch {
    try {
      proc.kill()
    } catch {
      // already dead
    }
  }
}

export function killAllServers(): void {
  stopActive()
}
