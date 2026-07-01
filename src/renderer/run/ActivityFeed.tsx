import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import type { AgentStreamEvent } from '../../shared/types'

interface FeedRow {
  id: number
  agentId: string
  text: string
  time: string
}

const MAX_ROWS = 200

function hhmmss(d: Date): string {
  return d.toTimeString().slice(0, 8)
}

/** Whole-run, plain-English activity feed. Live-only: collects narration-bearing
 *  stream events, capped + cleared per run. Clicking a row selects that agent. */
export default function ActivityFeed({ runId }: { runId: string | null }) {
  const graph = useStore((s) => s.graph)
  const selectStep = useStore((s) => s.selectStep)
  const [rows, setRows] = useState<FeedRow[]>([])
  const counter = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  // subscribe once to the agent stream; keep only narration-bearing events
  useEffect(() => {
    const unsub = window.api.onAgentStream((e: AgentStreamEvent) => {
      if (!e.narration) return
      const row: FeedRow = {
        id: ++counter.current,
        agentId: e.agentId,
        text: e.narration,
        time: hhmmss(new Date())
      }
      setRows((prev) => {
        const next = [...prev, row]
        return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next
      })
    })
    return () => unsub()
  }, [])

  // clear when a new run starts
  useEffect(() => {
    setRows([])
  }, [runId])

  // keep pinned to the newest row
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows])

  const nameOf = (id: string): string => graph?.nodes.find((n) => n.id === id)?.name ?? id
  const kindOf = (id: string): string => graph?.nodes.find((n) => n.id === id)?.kind ?? 'unknown'

  return (
    <div className="activity-feed" ref={listRef}>
      {rows.length === 0 ? (
        <div className="activity-empty">No activity yet.</div>
      ) : (
        rows.map((r) => (
          <div
            key={r.id}
            className="activity-row"
            title={r.text}
            onClick={() => selectStep(r.agentId)}
          >
            <span className="activity-time">{r.time}</span>
            <span className={`activity-agent kind-${kindOf(r.agentId)}`}>{nameOf(r.agentId)}</span>
            <span className="activity-text">{r.text}</span>
          </div>
        ))
      )}
    </div>
  )
}
