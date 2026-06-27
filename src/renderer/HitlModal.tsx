import { useState } from 'react'
import { useStore } from './store'

export default function HitlModal() {
  const run = useStore((s) => s.run)
  const answerInterrupt = useStore((s) => s.answerInterrupt)
  const minimizeInterrupt = useStore((s) => s.minimizeInterrupt)
  const [text, setText] = useState('')

  const pending = run.pendingInterrupt
  if (!pending) return null

  if (run.interruptMinimized) {
    return (
      <button className="hitl-badge" onClick={() => minimizeInterrupt(false)}>
        ❓ {pending.askerName} needs you
      </button>
    )
  }

  const submit = (answer: string): void => {
    answerInterrupt(answer)
    setText('')
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{pending.askerName} has a question</h2>
        <div className="hitl-question">{pending.question}</div>
        <div className="field">
          <textarea
            autoFocus
            rows={4}
            value={text}
            placeholder="Your answer…"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="radio-desc" style={{ marginTop: 4 }}>
            Your answer is sent to the agent and may appear in its output — don't paste secrets.
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => minimizeInterrupt(true)}>
            Minimize
          </button>
          <button className="btn" onClick={() => submit('')}>
            Skip
          </button>
          <button className="btn primary" disabled={!text.trim()} onClick={() => submit(text.trim())}>
            Submit
          </button>
        </div>
      </div>
    </div>
  )
}
