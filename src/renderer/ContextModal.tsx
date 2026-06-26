import { useEffect, useState } from 'react'
import { FileText, Image as ImageIcon, Plus, X } from 'lucide-react'
import { useStore } from './store'
import type { ContextFile } from '../shared/types'

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

export default function ContextModal({ onClose }: { onClose: () => void }) {
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)
  const files = graph?.context ?? []

  const add = async (): Promise<void> => {
    const r = await window.api.addContext()
    setGraph(r.graph)
    if (r.skipped.length) window.alert(`Skipped (not a readable file): ${r.skipped.join(', ')}`)
  }
  const remove = async (id: string): Promise<void> => {
    setGraph(await window.api.removeContext(id))
  }
  const setNote = async (id: string, note: string): Promise<void> => {
    setGraph(await window.api.updateContext(id, note))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal ctx-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Project context</h2>
        <p className="ctx-hint">
          Files and images here are given to every agent as reference context for this project. Add a
          note to say what each one is for.
        </p>
        <div className="ctx-list">
          {files.length === 0 && (
            <div className="empty-hint">
              No context files yet. Add images or files, or drag them onto the canvas.
            </div>
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
                    if (e.target.value !== f.note) void setNote(f.id, e.target.value)
                  }}
                />
              </div>
              <button className="close" title="Remove" onClick={() => void remove(f.id)}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => void add()}>
            <Plus size={14} /> Add files
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
