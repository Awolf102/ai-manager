import { useState } from 'react'
import { useStore } from './store'
import { Modal } from './Modal'

export default function FollowThroughModal() {
  const run = useStore((s) => s.run)
  const answerInterrupt = useStore((s) => s.answerInterrupt)
  const minimizeInterrupt = useStore((s) => s.minimizeInterrupt)
  const [text, setText] = useState('')

  const pending = run.pendingInterrupt
  if (!pending || pending.kind !== 'follow-through') return null

  if (run.interruptMinimized) {
    return (
      <button className="hitl-badge" onClick={() => minimizeInterrupt(false)}>
        ✎ {pending.askerName} needs a decision
      </button>
    )
  }

  const submit = (answer: string): void => {
    answerInterrupt(answer)
    setText('')
  }

  return (
    <Modal dismissable={false} onClose={() => minimizeInterrupt(true)} labelledBy="ft-title">
      {(close) => (<>
        <div className="modal-header">
          <h2 id="ft-title" className="modal-title">{pending.askerName} needs a decision</h2>
        </div>
        <div className="modal-body">
          {pending.summary && <div className="hitl-question">{pending.summary}</div>}
          <div className="radio-desc" style={{ marginTop: 4 }}>{pending.question}</div>
          {(pending.options ?? []).length > 0 && (
            <div className="field" style={{ marginTop: 8 }}>
              {pending.options!.map((opt, i) => (
                <button key={i} className="btn" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6 }} onClick={() => close(() => submit(opt))}>
                  {opt}
                </button>
              ))}
            </div>
          )}
          <div className="field">
            <textarea autoFocus rows={3} value={text} placeholder="Or type your own answer…" onChange={(e) => setText(e.target.value)} />
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => close(() => minimizeInterrupt(true))}>Minimize</button>
          <button className="btn" onClick={() => close(() => submit(''))}>Skip</button>
          <button className="btn primary" disabled={!text.trim()} onClick={() => close(() => submit(text.trim()))}>Submit</button>
        </div>
      </>)}
    </Modal>
  )
}
