import { useState } from 'react'
import { useStore } from './store'
import type { SpawnedMember } from '../shared/types'
import { Modal } from './Modal'

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
  const notify = useStore((s) => s.notify)
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
    } catch (err) {
      notify({ kind: 'error', message: err instanceof Error ? err.message : 'Could not create the team.' })
    } finally {
      setApplying(false)
    }
  }

  return (
    <Modal onClose={onClose} className="modal-wide">{(close) => (<>
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
              {m.skills && m.skills.length > 0 && (
                <div className="spawn-skills muted" style={{ fontSize: 11, marginTop: 4 }}>
                  skills: {m.skills.join(', ')}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => close()} disabled={applying}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void apply()} disabled={applying}>
            {applying ? 'Creating…' : 'Apply — create team'}
          </button>
        </div>
    </>)}</Modal>
  )
}
