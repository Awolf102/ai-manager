import { useState } from 'react'

type Draft = { agentId: string; name: string; role: string }

export default function RoleDraftModal({ drafts, onClose }: { drafts: Draft[]; onClose: () => void }) {
  const [edited, setEdited] = useState<Draft[]>(drafts)
  const [applying, setApplying] = useState(false)

  const apply = async (): Promise<void> => {
    setApplying(true)
    try {
      for (const d of edited) await window.api.writeRole(d.agentId, d.role)
      onClose()
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
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
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={applying}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void apply()} disabled={applying}>
            {applying ? 'Applying…' : 'Apply roles'}
          </button>
        </div>
      </div>
    </div>
  )
}
