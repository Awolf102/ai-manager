import { useEffect, useState } from 'react'
import { useStore } from './store'
import { Modal } from './Modal'
import { ENHANCE_PRESETS, DESIGN_SYSTEM_FAQ_PROMPT } from '../shared/design-enhance'

export default function DesignSystemModal() {
  const show = useStore((s) => s.showDesignSystem)
  const setShow = useStore((s) => s.setShowDesignSystem)
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)

  const [html, setHtml] = useState('')            // current design-preview.html
  const [faq, setFaq] = useState(false)
  const [directions, setDirections] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [before, setBefore] = useState<string | null>(null) // set when a candidate awaits review
  const [after, setAfter] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const ds = graph?.designSystem

  useEffect(() => {
    if (!show) return
    void window.api.readDesignPreview().then(setHtml)
  }, [show, ds?.addedAt])

  if (!show || !graph) return null

  const doImport = async (path?: string): Promise<void> => {
    setErr('')
    try { setGraph(await window.api.importDesignSystem(path)) } catch (e) { setErr(String(e)) }
  }
  const doRemove = async (): Promise<void> => { setGraph(await window.api.removeDesignSystem()); setHtml('') }
  const toggleDir = (id: string): void =>
    setDirections((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]))

  const runEnhance = async (): Promise<void> => {
    setErr(''); setBusy(true)
    try {
      const labels = ENHANCE_PRESETS.filter((p) => directions.includes(p.id)).map((p) => p.label)
      await window.api.enhanceDesignSystem(labels, note)
      const [b, a] = await Promise.all([window.api.readDesignPreview(), window.api.readEnhancedDesign()])
      if (!a) { setErr('The enhancement produced no output — try again.'); return }
      if (graph.settings.autoApplyEnhancements) {
        setGraph(await window.api.adoptEnhancement())
        setHtml(await window.api.readDesignPreview())
      } else {
        setBefore(b); setAfter(a)
      }
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }
  const adopt = async (): Promise<void> => {
    setGraph(await window.api.adoptEnhancement()); setBefore(null); setAfter(null)
    setHtml(await window.api.readDesignPreview())
  }
  const discard = async (): Promise<void> => { await window.api.discardEnhancement(); setBefore(null); setAfter(null) }

  const frame = (src: string) => (
    <iframe srcDoc={src} sandbox="allow-same-origin" title="design" style={{ width: '100%', height: '52vh', border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} />
  )

  // Before/after review takes over the modal body when a candidate is pending.
  if (before !== null && after !== null) {
    return (
      <Modal dismissable={false} onClose={discard} labelledBy="ds-title">
        {(close) => (<>
          <div className="modal-header"><h2 id="ds-title" className="modal-title">Review enhancement</h2></div>
          <div className="modal-body">
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}><div className="radio-desc">Before</div>{frame(before)}</div>
              <div style={{ flex: 1, minWidth: 0 }}><div className="radio-desc">After</div>{frame(after)}</div>
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => close(discard)}>Discard</button>
            <button className="btn primary" onClick={() => close(adopt)}>Adopt enhancement</button>
          </div>
        </>)}
      </Modal>
    )
  }

  return (
    <Modal onClose={() => setShow(false)} labelledBy="ds-title">
      {(close) => (<>
        <div className="modal-header"><h2 id="ds-title" className="modal-title">Design system</h2></div>
        <div className="modal-body">
          {err && <div className="chat-key-error">{err}</div>}
          <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 0 }}>
            <button className="btn" disabled={busy} onClick={() => void doImport()}>Import .html…</button>
            <button className="btn" onClick={() => setFaq((v) => !v)}>FAQ</button>
            {ds && <button className="btn" disabled={busy} onClick={() => void doRemove()}>Remove</button>}
          </div>
          {faq && (
            <div className="field" style={{ marginTop: 8 }}>
              <div className="radio-desc">Ask your design tool's chat to export a faithful, self-contained file with this prompt:</div>
              <textarea readOnly rows={5} value={DESIGN_SYSTEM_FAQ_PROMPT} />
              <button className="btn" onClick={() => void navigator.clipboard.writeText(DESIGN_SYSTEM_FAQ_PROMPT)}>Copy prompt</button>
            </div>
          )}
          {ds ? (
            <>
              <div className="radio-desc" style={{ marginTop: 8 }}>{ds.fileName} · {ds.source}</div>
              {html && frame(html)}
              <div className="field" style={{ marginTop: 12 }}>
                <div className="radio-desc">Enhance with the design team</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {ENHANCE_PRESETS.map((p) => (
                    <button key={p.id} className={`btn ${directions.includes(p.id) ? 'primary' : ''}`} onClick={() => toggleDir(p.id)}>{p.label}</button>
                  ))}
                </div>
                <textarea rows={2} value={note} placeholder="Optional: your own instruction…" onChange={(e) => setNote(e.target.value)} style={{ marginTop: 6 }} />
                <button className="btn primary" disabled={busy} onClick={() => void runEnhance()} style={{ marginTop: 6 }}>{busy ? 'Enhancing…' : 'Enhance'}</button>
              </div>
            </>
          ) : (
            <div className="radio-desc" style={{ marginTop: 8 }}>No design system yet — import a self-contained .html to have the build follow it (skips the generate step).</div>
          )}
        </div>
        <div className="modal-actions"><button className="btn" onClick={() => close(() => setShow(false))}>Close</button></div>
      </>)}
    </Modal>
  )
}
