import { useEffect, useState } from 'react'
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { Modal } from './Modal'
import { labelFor } from '../shared/env-file'
import type { EnvEntry } from '../shared/types'

export default function EnvModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<EnvEntry[]>([])
  const [revealed, setRevealed] = useState<Record<number, boolean>>({})
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.api.readEnv().then(setRows)
  }, [])

  const setValue = (i: number, value: string): void =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, value } : r)))
  const remove = (i: number): void => setRows((rs) => rs.filter((_, j) => j !== i))
  const add = (): void => {
    const key = newKey.trim()
    if (!key) return
    setRows((rs) => [...rs.filter((r) => r.key !== key), { key, value: newValue }])
    setNewKey('')
    setNewValue('')
  }
  const save = async (close: () => void): Promise<void> => {
    setSaving(true)
    try {
      await window.api.writeEnv(rows)
      close()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="env-title">
      {(close) => (<>
        <div className="modal-header">
          <h2 id="env-title" className="modal-title">Environment variables</h2>
          <div className="modal-desc">
            Edited directly in this project's <code>.env</code> — no AI is involved. (Agents can still read{' '}
            <code>.env</code> like any file in the project.)
          </div>
        </div>
        <div className="modal-body">
          {rows.length === 0 && <div className="radio-desc">No variables yet. Add one below.</div>}
          {rows.map((r, i) => (
            <div className="field" key={r.key}>
              <label>{labelFor(r.key)} <span className="path">{r.key}</span></label>
              <div className="gated-control">
                <input
                  type={revealed[i] ? 'text' : 'password'}
                  value={r.value}
                  onChange={(e) => setValue(i, e.target.value)}
                  style={{ flex: 1 }}
                />
                <button className="btn tiny" title={revealed[i] ? 'Hide' : 'Reveal'} aria-label={revealed[i] ? 'Hide value' : 'Reveal value'}
                  onClick={() => setRevealed((s) => ({ ...s, [i]: !s[i] }))}>
                  {revealed[i] ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button className="btn tiny" title="Delete" aria-label={`Delete ${r.key}`} onClick={() => remove(i)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
          <div className="field">
            <label>Add variable</label>
            <div className="gated-control">
              <input placeholder="KEY (e.g. ANTHROPIC_API_KEY)" value={newKey} onChange={(e) => setNewKey(e.target.value)} style={{ flex: 1 }} />
              <input placeholder="value" value={newValue} onChange={(e) => setNewValue(e.target.value)} style={{ flex: 1 }} />
              <button className="btn tiny" title="Add" aria-label="Add variable" onClick={() => add()}><Plus size={14} /></button>
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => close()}>Cancel</button>
          <button className="btn primary" disabled={saving} onClick={() => void save(close)}>Save</button>
        </div>
      </>)}
    </Modal>
  )
}
