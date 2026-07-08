import { useEffect, useState } from 'react'
import { useStore } from './store'
import { Modal } from './Modal'

export default function DesignPreviewModal() {
  const run = useStore((s) => s.run)
  const resolveDesignPreview = useStore((s) => s.resolveDesignPreview)
  const minimizeInterrupt = useStore((s) => s.minimizeInterrupt)
  const [html, setHtml] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')

  const pending = run.pendingInterrupt
  const active = pending?.kind === 'design-preview'

  useEffect(() => {
    if (!active) return
    setHtml(null)
    void window.api.readDesignPreview().then(setHtml)
  }, [active, pending?.iteration])

  if (!active) return null

  if (run.interruptMinimized) {
    return (
      <button className="hitl-badge" onClick={() => minimizeInterrupt(false)}>
        ✎ Design preview ready for review
      </button>
    )
  }

  return (
    <Modal dismissable={false} onClose={() => minimizeInterrupt(true)} labelledBy="dp-title">
      {(close) => (<>
        <div className="modal-header">
          <h2 id="dp-title" className="modal-title">Review the design preview</h2>
        </div>
        <div className="modal-body">
          {html === null ? (
            <div className="radio-desc">Loading preview…</div>
          ) : html === '' ? (
            <div className="radio-desc">The preview could not be generated. You can request changes to try again, or proceed to build without one.</div>
          ) : (
            <iframe
              srcDoc={html}
              sandbox="allow-same-origin"
              title="Design preview"
              style={{ width: '100%', height: '60vh', border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }}
            />
          )}
          <div className="field" style={{ marginTop: 12 }}>
            <textarea rows={2} value={feedback} placeholder="Optional: what to change if you request changes…" onChange={(e) => setFeedback(e.target.value)} />
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => close(() => minimizeInterrupt(true))}>Minimize</button>
          <button className="btn" disabled={!feedback.trim()} onClick={() => close(() => { resolveDesignPreview({ decision: 'changes', feedback: feedback.trim() }); setFeedback('') })}>Request changes</button>
          <button className="btn primary" onClick={() => close(() => resolveDesignPreview({ decision: 'approve' }))}>Approve &amp; build</button>
        </div>
      </>)}
    </Modal>
  )
}
