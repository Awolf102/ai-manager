import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Modal } from './Modal'
import { useStore } from './store'
import { BACKEND_PRESETS, parseModelIds } from '../shared/model-backends'
import type { BackendView } from '../shared/types'

export default function BackendsModal({ onClose }: { onClose: () => void }) {
  const setGraph = useStore((s) => s.setGraph)
  const notify = useStore((s) => s.notify)
  const [list, setList] = useState<BackendView[]>([])
  const [encOk, setEncOk] = useState(true)

  // add/edit form
  const [editingId, setEditingId] = useState<string | null>(null)
  const [presetId, setPresetId] = useState('zai-glm')
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelsText, setModelsText] = useState('')
  const gateway = BACKEND_PRESETS.find((p) => p.presetId === presetId)?.gateway

  const refresh = async (): Promise<void> => setList(await window.api.listBackends())
  useEffect(() => {
    void refresh()
    void window.api.backendEncryptionAvailable().then(setEncOk)
  }, [])

  const applyPreset = (id: string): void => {
    setPresetId(id)
    const p = BACKEND_PRESETS.find((x) => x.presetId === id)
    if (!p) return
    setLabel(p.label === 'Custom' ? '' : p.label)
    setBaseUrl(p.baseUrl)
    setModelsText(p.models.map((m) => (m.label === m.id ? m.id : `${m.id}|${m.label}`)).join(', '))
  }

  const resetForm = (): void => {
    setEditingId(null); setPresetId('zai-glm'); setLabel(''); setBaseUrl(''); setModelsText('')
  }

  const save = async (): Promise<void> => {
    const models = parseModelIds(modelsText)
    try {
      if (editingId) {
        setGraph(await window.api.updateBackend(editingId, { label, baseUrl, models }))
      } else {
        setGraph(await window.api.addBackend({ label, baseUrl, models, presetId }))
      }
      resetForm()
      await refresh()
    } catch (err) {
      notify({ kind: 'error', message: err instanceof Error ? err.message : 'Could not save the backend.' })
    }
  }

  const startEdit = (b: BackendView): void => {
    setEditingId(b.id); setPresetId(b.presetId ?? 'custom'); setLabel(b.label); setBaseUrl(b.baseUrl)
    setModelsText(b.models.map((m) => (m.label === m.id ? m.id : `${m.id}|${m.label}`)).join(', '))
  }

  const remove = async (id: string): Promise<void> => {
    try {
      setGraph(await window.api.removeBackend(id))
      if (editingId === id) resetForm()
      await refresh()
    } catch (err) {
      notify({ kind: 'error', message: err instanceof Error ? err.message : 'Could not remove the backend.' })
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="backends-title">
      <div className="modal-header">
        <h2 id="backends-title" className="modal-title">Model backends</h2>
      </div>
      <div className="modal-body">
        <div className="backends">
          {!encOk && (
            <div className="setting-danger-callout">Secure storage is unavailable on this system — tokens can't be saved.</div>
          )}
          {list.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No backends yet. Add one below.</div>}
          {list.map((b) => (
            <BackendRow key={b.id} b={b} encOk={encOk} onEdit={() => startEdit(b)} onRemove={() => void remove(b.id)} onToken={refresh} />
          ))}

          <h4>{editingId ? 'Edit backend' : 'Add backend'}</h4>
          <div className="field">
            <label>Preset</label>
            <select value={presetId} onChange={(e) => applyPreset(e.target.value)} disabled={!!editingId}>
              {BACKEND_PRESETS.map((p) => (<option key={p.presetId} value={p.presetId}>{p.label}</option>))}
            </select>
          </div>
          {gateway && (
            <div className="muted" style={{ fontSize: 12 }}>
              Requires an Anthropic-compatible gateway in front of OpenAI — enter your gateway's base URL below.
            </div>
          )}
          <div className="field">
            <label>Label</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="z.ai (GLM)" />
          </div>
          <div className="field">
            <label>Base URL</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.z.ai/api/anthropic" />
          </div>
          <div className="field">
            <label>Models (comma or newline; `id` or `id|Label`)</label>
            <textarea value={modelsText} onChange={(e) => setModelsText(e.target.value)} rows={2} placeholder="glm-4.6, glm-4.5-air" />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={!label || !baseUrl} onClick={() => void save()}>{editingId ? 'Save' : 'Add backend'}</button>
            {editingId && <button className="btn" onClick={resetForm}>Cancel</button>}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function BackendRow({ b, encOk, onEdit, onRemove, onToken }: {
  b: BackendView; encOk: boolean; onEdit: () => void; onRemove: () => void; onToken: () => Promise<void>
}) {
  const notify = useStore((s) => s.notify)
  const [token, setToken] = useState('')
  const saveToken = async (): Promise<void> => {
    const r = await window.api.setBackendToken(b.id, token)
    if (!r.ok) notify({ kind: 'error', message: r.error ?? 'Could not save token.' })
    setToken('')
    await onToken()
  }
  return (
    <div className="backend-row">
      <div className="backend-head">
        <strong>{b.label}</strong> <span className="muted">{b.baseUrl}</span>
        <span className="spacer" />
        <button className="btn" onClick={onEdit}>Edit</button>
        <button className="backend-remove" aria-label="Remove backend" onClick={onRemove}><Trash2 size={13} /></button>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>{b.models.map((m) => m.label).join(', ') || 'no models'}</div>
      <div className="field token-field">
        <label>{b.hasToken ? 'Token configured — replace:' : 'Token:'}</label>
        <input type="password" value={token} disabled={!encOk} placeholder={b.hasToken ? '••••••••' : 'paste token'} onChange={(e) => setToken(e.target.value)} />
        <button className="btn" disabled={!encOk || !token} onClick={() => void saveToken()}>Save token</button>
      </div>
    </div>
  )
}
