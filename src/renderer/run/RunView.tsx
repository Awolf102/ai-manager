import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useStore } from '../store'
import { effortOfWorker, cappedFromDisplay } from '../../shared/effort'
import type { ProjectGraph } from '../../shared/types'
import ActivityFeed from './ActivityFeed'
import { runBanner } from './run-status'

function buildChain(graph: ProjectGraph, rootId: string | null): { id: string; depth: number }[] {
  if (!rootId) return []
  const out: { id: string; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (id: string, depth: number): void => {
    if (seen.has(id)) return
    seen.add(id)
    out.push({ id, depth })
    for (const e of graph.edges.filter((edge) => edge.source === id)) walk(e.target, depth + 1)
  }
  walk(rootId, 0)
  return out
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  planning: 'planning',
  assigning: 'assigning',
  working: 'working',
  done: 'done',
  error: 'error',
  skipped: 'skipped'
}

export default function RunView() {
  const graph = useStore((s) => s.graph)
  const run = useStore((s) => s.run)
  const selectStep = useStore((s) => s.selectStep)

  const [rightTab, setRightTab] = useState<'narration' | 'terminal' | 'result'>('narration')
  const [revealResult, setRevealResult] = useState(false)
  const prevRunning = useRef(run.running)
  // Land on the Result tab when a run finishes successfully with a report.
  useEffect(() => {
    if (prevRunning.current && !run.running && run.final && !run.error) {
      setRightTab('result')
      setRevealResult(true)
    }
    prevRunning.current = run.running
  }, [run.running, run.final, run.error])

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const buffers = useRef<Map<string, string>>(new Map())
  const selectedRef = useRef<string | null>(run.selectedStepId)

  // xterm once
  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      convertEol: false,
      cursorBlink: false,
      theme: { background: '#141019', foreground: '#EAD7D1', cursor: '#DD99BB' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    const doFit = (): void => {
      try {
        fit.fit()
      } catch {
        /* not measurable yet */
      }
    }
    doFit()
    termRef.current = term
    const ro = new ResizeObserver(doFit)
    if (hostRef.current) ro.observe(hostRef.current)
    return () => {
      ro.disconnect()
      term.dispose()
    }
  }, [])

  // buffer every agent's stream by agentId; live-write the selected one
  useEffect(() => {
    const unsub = window.api.onAgentStream((e) => {
      const prev = buffers.current.get(e.agentId) ?? ''
      buffers.current.set(e.agentId, prev + e.text)
      if (e.agentId === selectedRef.current) termRef.current?.write(e.text)
    })
    return () => unsub()
  }, [])

  // new run → clear buffers + screen
  useEffect(() => {
    buffers.current.clear()
    termRef.current?.clear()
    setRevealResult(false)
  }, [run.runId])

  // selection change → repaint from buffer
  useEffect(() => {
    selectedRef.current = run.selectedStepId
    const t = termRef.current
    if (!t) return
    t.clear()
    t.write(buffers.current.get(run.selectedStepId ?? '') ?? '')
  }, [run.selectedStepId])

  const chain = graph ? buildChain(graph, run.orchestratorId) : []
  const nameOf = (id: string): string => graph?.nodes.find((n) => n.id === id)?.name ?? id
  const kindOf = (id: string): string => graph?.nodes.find((n) => n.id === id)?.kind ?? 'unknown'
  // Effort is assigned per task and the worker runs at the highest of its batch.
  const allAssignments = Object.values(run.assignments).flat()

  const banner = runBanner(run)
  const hasResult = !!run.final

  return (
    <div className="runview">
      {banner && (
        <div className={`run-banner ${banner.kind}`}>
          <span className="run-banner-mark">{banner.kind === 'success' ? '✓' : '✗'}</span> {banner.text}
        </div>
      )}
      <div className="run-main">
        <div className="run-tree">
          {chain.length === 0 && <div className="run-empty">No run yet — enter a goal and Run.</div>}
          {run.reviewAttempt > 0 &&
            (() => {
              const all = Object.values(run.verdict)
              const pass = all.filter((v) => v.verdict === 'pass').length
              return (
                <div className="run-attempt">
                  Review · {pass}/{all.length} passed
                  {run.reviewAttempt > 1 ? ` · attempt ${run.reviewAttempt}` : ''}
                </div>
              )
            })()}
          {run.replans.map((r) => (
            <div key={r.attempt} className="run-replan" title={r.reason}>
              ⚡ Re-planned (#{r.attempt}): {r.reason}
            </div>
          ))}
          {run.handoffs.map((hnd, i) => (
            <div key={i} className="run-handoff" title={hnd.ask}>
              ↪ Handoff: {nameOf(hnd.askerId)} → {nameOf(hnd.peerId)}: {hnd.ask}
            </div>
          ))}
          {run.userRequests.map((ur, i) => (
            <div key={`ur-${i}`} className="run-userrequest" title={ur.question}>
              ❓ Asked you · {nameOf(ur.askerId)}: {ur.question}
            </div>
          ))}
          {chain.map(({ id, depth }) => {
            const status = run.nodeStatus[id] ?? 'idle'
            const tasks = run.nodeTasks[id]
            const verdicts = Object.values(run.verdict).filter((v) => v.nodeId === id)
            const failed = verdicts.some((v) => v.verdict === 'fail')
            const mem = run.memoryUpdated[id]
            // only leaf workers actually execute tasks → show the effort they ran at
            const isLeaf = !graph?.edges.some((e) => e.source === id)
            const eff = isLeaf ? effortOfWorker(allAssignments, id) : undefined
            const capped = isLeaf ? cappedFromDisplay(allAssignments, id) : undefined
            return (
              <div
                key={id}
                className={`run-row ${run.selectedStepId === id ? 'sel' : ''}`}
                style={{ paddingLeft: 10 + depth * 16 }}
                title={tasks?.join(', ')}
                onClick={() => selectStep(id)}
              >
                <span className={`run-row-name kind-${kindOf(id)}`}>{nameOf(id)}</span>
                <span className={`run-pill st-${status}`}>{STATUS_LABEL[status] ?? status}</span>
                {eff && (
                  <span className={`run-eff eff-${eff}`} title={capped ? `effort ${eff} (capped from ${capped} — model limit)` : `assigned effort: ${eff}`}>
                    {eff}
                  </span>
                )}
                {verdicts.length > 0 && (
                  <span className={`run-verdict ${failed ? 'fail' : 'pass'}`}>
                    {failed ? '✗' : '✓'}
                  </span>
                )}
                {mem != null && (
                  <span className="run-mem" title="memory updated">
                    🧠+{mem}
                  </span>
                )}
              </div>
            )
          })}
        </div>
        <div className="run-right">
          <div className="run-tabs">
            <button className={`run-tab ${rightTab === 'narration' ? 'active' : ''}`} onClick={() => setRightTab('narration')}>Narration</button>
            <button className={`run-tab ${rightTab === 'terminal' ? 'active' : ''}`} onClick={() => setRightTab('terminal')}>Terminal</button>
            {hasResult && (
              <button className={`run-tab ${rightTab === 'result' ? 'active' : ''}`} onClick={() => setRightTab('result')}>Result</button>
            )}
          </div>
          <div className="run-slots">
            <div className={`run-slot ${rightTab === 'narration' ? 'active' : ''}`}>
              <ActivityFeed runId={run.runId} />
            </div>
            <div className={`run-slot ${rightTab === 'terminal' ? 'active' : ''}`}>
              <div className="run-output" ref={hostRef} />
            </div>
            {hasResult && (
              <div className={`run-slot ${rightTab === 'result' ? 'active' : ''}`}>
                <pre className={`run-result ${revealResult ? 'reveal' : ''}`}>{run.final}</pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
