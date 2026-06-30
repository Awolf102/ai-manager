import { useState } from 'react'
import { useStore } from './store'
import { Modal } from './Modal'

type Draft = { agentId: string; name: string; role: string; skills?: string[] }

export default function RoleDraftModal({ drafts, onClose }: { drafts: Draft[]; onClose: () => void }) {
  const [edited, setEdited] = useState<Draft[]>(drafts)
  const [applying, setApplying] = useState(false)
  const requestConfirm = useStore((s) => s.requestConfirm)

  const apply = async (): Promise<void> => {
    const n = edited.length
    const ok = await requestConfirm({
      title: `Overwrite ${n} role${n === 1 ? '' : 's'}?`,
      body: `This replaces the current role for ${n} agent${n === 1 ? '' : 's'} with the drafted version${n === 1 ? '' : 's'}. Existing roles will be overwritten.`,
      confirmLabel: 'Overwrite roles',
      danger: true
    })
    if (!ok) return
    setApplying(true)
    try {
      for (const d of edited) {
        await window.api.writeRole(d.agentId, d.role)
        if (d.skills && d.skills.length) await window.api.updateAgent({ id: d.agentId, skills: d.skills })
      }
      onClose()
    } finally {
      setApplying(false)
    }
  }

  return (
    <Modal onClose={onClose} className="modal-wide">{(close) => (<>
        <h2>Draft roles ({edited.length})</h2>
        <div className="draft-list">
          {edited.map((d, i) => (
            <div key={d.agentId} className="field">
              <label>{d.name}</label>
              <textarea
                className="draft-role"
                value={d.role}
                onChange={(e) =>
                  setEdited((prev) => prev.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))
                }
              />
              {d.skills && d.skills.length > 0 && (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>skills: {d.skills.join(', ')}</div>
              )}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => close()} disabled={applying}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void apply()} disabled={applying}>
            {applying ? 'Applying…' : 'Apply roles'}
          </button>
        </div>
    </>)}</Modal>
  )
}
