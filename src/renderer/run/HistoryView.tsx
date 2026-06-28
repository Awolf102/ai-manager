import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { effortByTask } from '../../shared/effort'
import { parseLessonBullet } from '../../shared/lessons'
import type { RunRecord, RunStatus, RunSummary } from '../../shared/types'

function statusPill(status: RunStatus): string {
  return status === 'completed' ? 'st-done' : status === 'cancelled' ? 'st-skipped' : 'st-error'
}

function fmt(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export default function HistoryView() {
  const showHistory = useStore((s) => s.showHistory)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [record, setRecord] = useState<RunRecord | null>(null)
  const resumable = useStore((s) => s.resumable)
  const resumeResumable = useStore((s) => s.resumeResumable)
  const discardResumable = useStore((s) => s.discardResumable)
  const requestConfirm = useStore((s) => s.requestConfirm)
  const refreshResumable = useStore((s) => s.refreshResumable)

  const refresh = (): void => {
    void window.api.listRuns().then(setRuns)
  }
  useEffect(() => {
    if (showHistory) { refresh(); void refreshResumable() }
  }, [showHistory])

  const open = (file: string): void => {
    setSelected(file)
    setRecord(null)
    void window.api.loadRun(file).then(setRecord)
  }

  return (
    <div className="history">
      {resumable.length > 0 && (
        <div className="hist-list resumable">
          <div className="hist-list-head"><span>Resumable ({resumable.length})</span></div>
          {resumable.map((r) => (
            <div key={r.runId} className="hist-row">
              <div className="hist-goal">{r.goal || '(no goal)'}</div>
              <div className="hist-meta">
                <span className={`run-pill ${r.status === 'interrupted' ? 'st-skipped' : 'st-error'}`}>
                  {r.status === 'interrupted' ? 'Paused' : 'Crashed'}
                </span>
                <span>{fmt(r.startedAt)}</span>
                <span>· {r.taskCount} tasks</span>
                <button className="btn tiny" onClick={() => resumeResumable(r.runId)}>Resume</button>
                <button
                  className="btn tiny"
                  onClick={async () => {
                    const ok = await requestConfirm({ title: 'Discard this run?', body: 'Its recovery checkpoint is deleted permanently.', confirmLabel: 'Discard', danger: true })
                    if (ok) void discardResumable(r.runId)
                  }}
                >Discard</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="hist-list">
        <div className="hist-list-head">
          <span>Runs ({runs.length})</span>
          <button className="btn tiny" onClick={refresh}>
            Refresh
          </button>
        </div>
        {runs.length === 0 && <div className="run-empty">No runs yet.</div>}
        {runs.map((r) => (
          <div
            key={r.file}
            className={`hist-row ${selected === r.file ? 'sel' : ''}`}
            onClick={() => open(r.file)}
          >
            <div className="hist-goal">{r.goal || '(no goal)'}</div>
            <div className="hist-meta">
              <span className={`run-pill ${statusPill(r.status)}`}>{r.status}</span>
              <span>{fmt(r.startedAt)}</span>
              <span>· {r.taskCount} tasks</span>
            </div>
          </div>
        ))}
      </div>
      <div className="hist-detail">
        {record ? (
          <RunDetail record={record} />
        ) : (
          <div className="run-empty">Select a run to inspect.</div>
        )}
      </div>
    </div>
  )
}

function RunDetail({ record }: { record: RunRecord }) {
  const latest = new Map<string, { verdict: string; feedback: string }>()
  for (const rev of record.reviews ?? []) {
    for (const t of rev.tasks) latest.set(t.taskId, { verdict: t.verdict, feedback: t.feedback })
  }
  const efforts = effortByTask(record.steps)
  const nameOf = (id: string): string =>
    record.steps.find((s) => s.nodeId === id)?.nodeName ?? id

  return (
    <div className="hist-detail-inner">
      <h3>{record.goal}</h3>
      <div className="hist-sub">
        <span className={`run-pill ${statusPill(record.status)}`}>{record.status}</span>{' '}
        {fmt(record.startedAt)} → {fmt(record.finishedAt)}
      </div>
      {record.error && <div className="run-error">✗ {record.error}</div>}

      {record.final && (
        <div className="hist-section">
          <h4>Final report</h4>
          <pre>{record.final}</pre>
        </div>
      )}

      <div className="hist-section">
        <h4>Plan ({record.plan.length})</h4>
        <ul>
          {record.plan.map((t) => {
            const v = latest.get(t.id)
            const eff = efforts[t.id]
            return (
              <li key={t.id}>
                {v && (
                  <span className={`run-verdict ${v.verdict === 'fail' ? 'fail' : 'pass'}`}>
                    {v.verdict === 'fail' ? '✗' : '✓'}{' '}
                  </span>
                )}
                <b>{t.title}</b>
                {eff && (
                  <>
                    {' '}
                    <span className={`run-eff eff-${eff}`} title={`assigned effort: ${eff}`}>
                      {eff}
                    </span>
                  </>
                )}
                {v?.feedback ? ` — ${v.feedback}` : ''}
              </li>
            )
          })}
        </ul>
      </div>

      {(record.replans ?? []).length > 0 && (
        <div className="hist-section">
          <h4>Re-plans ({record.replans!.length})</h4>
          <ul>
            {record.replans!.map((r) => (
              <li key={r.attempt}>
                <b>#{r.attempt}</b>: {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(record.handoffs ?? []).length > 0 && (
        <div className="hist-section">
          <h4>Handoffs ({record.handoffs!.length})</h4>
          <ul>
            {record.handoffs!.map((hnd, i) => (
              <li key={i}>
                <b>{nameOf(hnd.askerId)} → {nameOf(hnd.peerId)}</b>: {hnd.ask}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(record.userRequests ?? []).length > 0 && (
        <div className="hist-section">
          <h4>User requests ({record.userRequests!.length})</h4>
          <ul>
            {record.userRequests!.map((ur, i) => (
              <li key={i}>
                <b>{nameOf(ur.askerId)}</b>: {ur.question}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="hist-section">
        <h4>Agents</h4>
        {record.steps.map((s) => (
          <div key={s.nodeId} className="hist-step">
            <div className="hist-step-head">
              <b>{s.nodeName}</b> <span className="agent-kind">{s.kind}</span>{' '}
              <span className={`run-pill st-${s.status}`}>{s.status}</span>
            </div>
            {s.output && <pre>{s.output}</pre>}
          </div>
        ))}
      </div>

      {(record.reflections ?? []).length > 0 && (
        <div className="hist-section">
          <h4>Memory reflections</h4>
          {(record.reflections ?? []).map((r, i) => (
            <div key={i} className="hist-step">
              <div className="hist-step-head">
                <b>{nameOf(r.nodeId)}</b>
              </div>
              {r.win && <div>✓ Win: {r.win}</div>}
              {r.loss && <div>✗ Loss: {r.loss}</div>}
              {r.lessons.length > 0 && (
                <ul>
                  {r.lessons.map((l, j) => (
                    <li key={j}>{parseLessonBullet(l).text}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
