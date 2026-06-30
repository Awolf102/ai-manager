import { useEffect, useState } from 'react'
import { FileText, Folder, Image as ImageIcon, Plus, Users, X } from 'lucide-react'
import { useStore } from './store'
import { scopeLabel } from '../shared/context-files'
import type { AgentKind, AgentNodeData, ContextFile, ContextScope } from '../shared/types'
import { Modal } from './Modal'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function Thumb({ file }: { file: ContextFile }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (file.isImage) {
      void window.api.contextThumbnail(file.id).then((u) => {
        if (alive) setUrl(u)
      })
    }
    return () => {
      alive = false
    }
  }, [file.id, file.isImage])
  if (file.isImage && url) return <img className="ctx-thumb" src={url} alt={file.fileName} />
  return (
    <span className="ctx-thumb ctx-thumb-icon">
      {file.isImage ? <ImageIcon size={18} /> : <FileText size={18} />}
    </span>
  )
}

const KINDS: { k: AgentKind; label: string }[] = [
  { k: 'orchestrator', label: 'Orchestrator' },
  { k: 'manager', label: 'Managers' },
  { k: 'worker', label: 'Workers' }
]

function ScopeControl({
  scope,
  nodes,
  onChange
}: {
  scope?: ContextScope
  nodes: AgentNodeData[]
  onChange: (s: ContextScope) => void
}) {
  const [open, setOpen] = useState(false)
  const kinds = scope?.kinds ?? []
  const ids = scope?.nodeIds ?? []
  const toggleKind = (k: AgentKind): void =>
    onChange({ kinds: kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k], nodeIds: ids })
  const toggleId = (id: string): void =>
    onChange({ kinds, nodeIds: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] })
  return (
    <div className="ctx-scope">
      <button className="ctx-scope-btn" onClick={() => setOpen((o) => !o)} title="Which agents see this">
        <Users size={12} /> {scopeLabel(scope, nodes)}
      </button>
      {open && (
        <div className="ctx-scope-panel">
          <div className="ctx-scope-group">
            {KINDS.map(({ k, label }) => (
              <label key={k} className="ctx-scope-item">
                <input type="checkbox" checked={kinds.includes(k)} onChange={() => toggleKind(k)} /> {label}
              </label>
            ))}
          </div>
          {nodes.length > 0 && <div className="ctx-scope-sep" />}
          <div className="ctx-scope-group">
            {nodes.map((n) => (
              <label key={n.id} className="ctx-scope-item">
                <input type="checkbox" checked={ids.includes(n.id)} onChange={() => toggleId(n.id)} /> {n.name}
              </label>
            ))}
          </div>
          <div className="ctx-scope-hint">Nothing checked = all agents.</div>
        </div>
      )}
    </div>
  )
}

export default function ContextModal({ onClose }: { onClose: () => void }) {
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)
  const notify = useStore((s) => s.notify)
  const files = graph?.context ?? []
  const folders = graph?.contextFolders ?? []
  const nodes = graph?.nodes ?? []

  const addFiles = async (): Promise<void> => {
    const r = await window.api.addContext()
    setGraph(r.graph)
    if (r.skipped.length) notify({ kind: 'info', message: `Skipped: ${r.skipped.join(', ')}` })
  }
  const addFolder = async (): Promise<void> => {
    const r = await window.api.addContextFolder()
    setGraph(r.graph)
    if (r.skipped.length) notify({ kind: 'info', message: `Skipped: ${r.skipped.join(', ')}` })
  }
  const setScope = async (id: string, scope: ContextScope): Promise<void> =>
    setGraph(await window.api.setContextScope(id, scope))

  return (
    <Modal onClose={onClose} className="ctx-modal">{(close) => (<>
        <h2>Project context</h2>
        <p className="ctx-hint">
          Reference material for this project. Every item goes to all agents by default — use "Applies to"
          to narrow it to specific agents.
        </p>

        <div className="ctx-section-head">
          <span>Attached files</span>
          <button className="btn tiny" onClick={() => void addFiles()}>
            <Plus size={12} /> Add files
          </button>
        </div>
        <div className="ctx-list">
          {files.length === 0 && (
            <div className="empty-hint">No files yet. Add images or specs, or drag them onto the canvas.</div>
          )}
          {files.map((f) => (
            <div className="ctx-row" key={f.id}>
              <Thumb file={f} />
              <div className="ctx-meta">
                <div className="ctx-name">
                  {f.fileName} <span className="ctx-size">{fmtBytes(f.bytes)}</span>
                </div>
                <input
                  className="ctx-note"
                  defaultValue={f.note}
                  placeholder="note — what is this / how to use it (optional)"
                  onBlur={(e) => {
                    if (e.target.value !== f.note)
                      void window.api.updateContext(f.id, e.target.value).then(setGraph)
                  }}
                />
                <ScopeControl scope={f.scope} nodes={nodes} onChange={(s) => void setScope(f.id, s)} />
              </div>
              <button className="close" title="Remove" onClick={() => void window.api.removeContext(f.id).then(setGraph)}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>

        <div className="ctx-section-head">
          <span>Referenced folders</span>
          <button className="btn tiny" onClick={() => void addFolder()}>
            <Plus size={12} /> Add folder
          </button>
        </div>
        <div className="ctx-list">
          {folders.length === 0 && (
            <div className="empty-hint">
              No folders yet. Point the team at a folder to read on demand — nothing is copied.
            </div>
          )}
          {folders.map((f) => (
            <div className="ctx-row" key={f.id}>
              <span className="ctx-thumb ctx-thumb-icon">
                <Folder size={18} />
              </span>
              <div className="ctx-meta">
                <div className="ctx-name" title={f.path}>
                  {f.path}
                </div>
                <input
                  className="ctx-note"
                  defaultValue={f.note}
                  placeholder="note — what is this folder for (optional)"
                  onBlur={(e) => {
                    if (e.target.value !== f.note)
                      void window.api.updateContextFolder(f.id, e.target.value).then(setGraph)
                  }}
                />
                <ScopeControl scope={f.scope} nodes={nodes} onChange={(s) => void setScope(f.id, s)} />
              </div>
              <button
                className="close"
                title="Remove"
                onClick={() => void window.api.removeContextFolder(f.id).then(setGraph)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <span className="spacer" />
          <button className="btn primary" onClick={() => close()}>
            Close
          </button>
        </div>
    </>)}</Modal>
  )
}
