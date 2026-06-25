import { useState } from 'react'
import { useStore } from './store'
import type { SpawnedMember } from '../shared/types'

export default function TeamSpawnModal({
  members,
  orchestratorId,
  onClose
}: {
  members: SpawnedMember[]
  orchestratorId: string
  onClose: () => void
}) {
  const setGraph = useStore((s) => s.setGraph)
  const [edited, setEdited] = useState<SpawnedMember[]>(members)
  const [applying, setApplying] = useState(false)

  const byId = new Map(edited.map((m) => [m.id, m]))
  const depthOf = (m: SpawnedMember): number => {
    let d = 0
    let cur = m.reportsTo
    let hops = 0
    while (cur !== 'orchestrator' && byId.has(cur) && hops++ < edited.length) {
      d++
      cur = byId.get(cur)!.reportsTo
    }
    return d
  }

  const apply = async (): Promise<void> => {
    setApplying(true)
    try {
      setGraph(await window.api.applySpawnedTeam({ members: edited, orchestratorId }))
      onClose()
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Proposed team ({edited.length})</h2>
        <div className="draft-list">
          {edited.map((m, i) => (
            <div key={m.id} className="field" style={{ marginLeft: depthOf(m) * 20 }}>
              <label>
                <span className="spawn-kind">{m.kind}</span>
                <input
                  className="spawn-name"
                  value={m.name}
                  onChange={(e) =>
                    setEdited((prev) => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                  }
                />
              </label>
              <textarea
                className="draft-role"
                value={m.role}
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
            {applying ? 'Creating…' : 'Apply — create team'}
          </button>
        </div>
      </div>
    </div>
  )
}
