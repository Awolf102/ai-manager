import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useStore, type TerminalTab } from '../store'

export default function TerminalPane({ tab }: { tab: TerminalTab }) {
  const agent = useStore((s) => s.agentById(tab.agentId))
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  const ptyIdRef = useRef<string | null>(null)
  const runIdRef = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [resume, setResume] = useState<boolean>(!!agent?.sessionId)

  // Create the xterm instance once (panes stay mounted; the dock hides inactive
  // ones via CSS visibility, so the terminal keeps a real size).
  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      cursorBlink: tab.mode === 'interactive',
      convertEol: false,
      theme: { background: '#141019', foreground: '#EAD7D1', cursor: '#DD99BB' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    const doFit = (): void => {
      try {
        fit.fit()
      } catch {
        /* container not measurable yet */
      }
    }
    doFit()
    termRef.current = term

    const ro = new ResizeObserver(() => {
      doFit()
      if (tab.mode === 'interactive' && ptyIdRef.current) {
        window.api.resizePty(ptyIdRef.current, term.cols, term.rows)
      }
    })
    if (hostRef.current) ro.observe(hostRef.current)

    return () => {
      ro.disconnect()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Interactive: spawn the claude PTY and wire I/O.
  useEffect(() => {
    if (tab.mode !== 'interactive') return
    const term = termRef.current!
    let unsubData: (() => void) | undefined
    let unsubExit: (() => void) | undefined

    const input = term.onData((d) => {
      if (ptyIdRef.current) window.api.writePty(ptyIdRef.current, d)
    })

    setBusy(true)
    void window.api
      .spawnPty({ agentId: tab.agentId, cols: term.cols, rows: term.rows, resume })
      .then(({ ptyId }) => {
        ptyIdRef.current = ptyId
        unsubData = window.api.onPtyData((e) => {
          if (e.ptyId === ptyId) term.write(e.data)
        })
        unsubExit = window.api.onPtyExit((e) => {
          if (e.ptyId === ptyId) {
            term.write(`\r\n\x1b[2m[claude exited (${e.exitCode})]\x1b[0m\r\n`)
            setBusy(false)
          }
        })
      })
      .catch((err) => {
        // Surface spawn failures instead of swallowing them (e.g. claude not on
        // PATH) — otherwise the pane just hangs "busy" with a blank terminal.
        const msg = err instanceof Error ? err.message : String(err)
        term.write(`\r\n\x1b[31m[failed to start claude: ${msg}]\x1b[0m\r\n`)
        setBusy(false)
      })

    return () => {
      input.dispose()
      unsubData?.()
      unsubExit?.()
      if (ptyIdRef.current) window.api.killPty(ptyIdRef.current)
      ptyIdRef.current = null
    }
    // resume captured once at spawn time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Headless: subscribe to this pane's run stream for the life of the pane.
  useEffect(() => {
    if (tab.mode !== 'headless') return
    const term = termRef.current!
    const unsub = window.api.onAgentStream((e) => {
      if (e.runId !== runIdRef.current) return
      term.write(e.text)
      if (e.isFinal) setBusy(false)
    })
    return () => unsub()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runHeadless = async (): Promise<void> => {
    const term = termRef.current!
    if (!prompt.trim() || busy) return
    setBusy(true)
    term.write(`\x1b[36m❯ ${prompt.replace(/\r?\n/g, ' ')}\x1b[0m\r\n`)
    const { runId } = await window.api.runHeadless({ agentId: tab.agentId, prompt, resume })
    runIdRef.current = runId
    setPrompt('')
  }

  const cancelHeadless = (): void => {
    if (runIdRef.current) window.api.cancelHeadless(runIdRef.current)
  }

  return (
    <div className="term-pane">
      <div className="term-host" ref={hostRef} />
      {tab.mode === 'interactive' && (
        <div className="term-hint">
          Type a prompt to drive this agent — this is a live <code>claude</code> session.
        </div>
      )}
      {tab.mode === 'headless' && (
        <div className="headless-input">
          <textarea
            placeholder={`Task for ${tab.agentName}…  (⌘/Ctrl+Enter to run)`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void runHeadless()
            }}
          />
          <div className="controls">
            {busy ? (
              <button className="btn danger tiny" onClick={cancelHeadless}>
                Stop
              </button>
            ) : (
              <button className="btn primary tiny" onClick={() => void runHeadless()}>
                Run
              </button>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={resume}
                disabled={!agent?.sessionId}
                onChange={(e) => setResume(e.target.checked)}
              />
              resume
            </label>
          </div>
        </div>
      )}
    </div>
  )
}
