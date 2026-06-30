import { useEffect, useRef, useState } from 'react'
import type { RunManifest, ServerStatus } from '../../shared/types'
import { parseStartCommand } from '../../shared/run-manifest'
import { Modal } from '../Modal'

export default function RunResultModal({
  manifest,
  onClose
}: {
  manifest: RunManifest
  onClose: () => void
}) {
  const [cmd, setCmd] = useState(manifest.startCommand)
  const [port, setPort] = useState(manifest.port ? String(manifest.port) : '')
  const [path, setPath] = useState(manifest.path ?? '/')
  const [serverId, setServerId] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [status, setStatus] = useState<ServerStatus | 'idle'>('idle')
  const [url, setUrl] = useState<string | null>(null)
  const [log, setLog] = useState('')
  const logRef = useRef<HTMLPreElement>(null)
  const serverIdRef = useRef<string | null>(null)
  const launchable = manifest.type === 'web' || manifest.type === 'static'
  const parsedCmd = parseStartCommand(cmd)
  const cmdError = cmd.trim() && !parsedCmd.ok ? parsedCmd.error : null

  useEffect(() => {
    const offLog = window.api.onServerLog((e) => {
      if (e.serverId === serverIdRef.current) setLog((p) => p + e.data)
    })
    const offStatus = window.api.onServerStatus((e) => {
      if (e.serverId === serverIdRef.current) setStatus(e.status)
    })
    const offReady = window.api.onServerReady((e) => {
      if (e.serverId === serverIdRef.current) setUrl(e.url)
    })
    return () => {
      offLog()
      offStatus()
      offReady()
    }
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const launch = async (): Promise<void> => {
    if (launching) return
    setLaunching(true)
    try {
      setLog('')
      setUrl(null)
      setStatus('starting')
      const p = parseInt(port, 10)
      const { serverId: id } = await window.api.launchServer({
        startCommand: cmd.trim(),
        port: Number.isInteger(p) && p > 0 ? p : undefined,
        path: path.trim() || '/'
      })
      serverIdRef.current = id
      setServerId(id)
    } finally {
      setLaunching(false)
    }
  }
  const stop = (): void => {
    if (serverId) window.api.stopServer(serverId)
  }

  const running = serverId !== null && status !== 'exited' && status !== 'error'

  return (
    <Modal onClose={onClose} className="modal-wide">{(close) => (<>
        <h2>Launch app</h2>
        {launchable ? (
          <>
            <div className="field">
              <label>Start command</label>
              <input className="spawn-name" value={cmd} onChange={(e) => setCmd(e.target.value)} />
              {cmdError && <p className="rr-error">{cmdError}</p>}
            </div>
            <div className="rr-row">
              <div className="field">
                <label>Port</label>
                <input className="spawn-name" value={port} onChange={(e) => setPort(e.target.value)} placeholder="e.g. 5173" />
              </div>
              <div className="field">
                <label>Entry path</label>
                <input className="spawn-name" value={path} onChange={(e) => setPath(e.target.value)} />
              </div>
            </div>
            {manifest.notes && <p className="rr-notes">{manifest.notes}</p>}
            <div className="rr-status">
              {status === 'idle' ? 'Not started' : `Status: ${status}`}
              {url && <> — opened {url}</>}
            </div>
            <pre className="server-log" ref={logRef}>
              {log || '(no output yet)'}
            </pre>
          </>
        ) : (
          <p className="rr-notes">
            This project doesn't look like a runnable web app (detected: {manifest.type}).{' '}
            {manifest.notes ?? 'Open the project folder to run it yourself.'}
          </p>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={() => close()}>
            Close
          </button>
          {launchable ? (
            running ? (
              <button className="btn danger" onClick={stop}>
                Stop
              </button>
            ) : (
              <button className="btn primary" onClick={() => void launch()} disabled={!parsedCmd.ok || launching}>
                Launch &amp; open
              </button>
            )
          ) : (
            <button className="btn primary" onClick={() => window.api.openProjectPath()}>
              Open project folder
            </button>
          )}
        </div>
    </>)}</Modal>
  )
}
