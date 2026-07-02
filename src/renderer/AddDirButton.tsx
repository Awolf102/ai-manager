import { useEffect, useRef, useState } from 'react'
import { ChevronDown, FolderPlus, X } from 'lucide-react'
import { useStore } from './store'

export default function AddDirButton() {
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)
  const notify = useStore((s) => s.notify)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const dirs = graph?.pairedDirs ?? []
  const anyWritable = dirs.some((d) => d.writable)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const add = async (): Promise<void> => {
    const r = await window.api.addPairedDir()
    setGraph(r.graph)
    if (r.skipped.length) notify({ kind: 'info', message: `Skipped: ${r.skipped.join(', ')}` })
  }
  const toggle = async (id: string, writable: boolean): Promise<void> => setGraph(await window.api.setPairedDirWritable(id, writable))
  const remove = async (id: string): Promise<void> => setGraph(await window.api.removePairedDir(id))

  return (
    <div className="topmenu" ref={ref}>
      <button
        className={`btn ${open ? 'active' : ''}`}
        title="Pair another working directory"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <FolderPlus size={14} /> Dirs{dirs.length > 0 && <span className="ctx-badge">{dirs.length}</span>} <ChevronDown size={12} />
      </button>
      {open && (
        <div className="topmenu-list paired-dirs" role="menu">
          {dirs.length === 0 && <div className="paired-empty">No paired directories yet.</div>}
          {dirs.map((d) => (
            <div key={d.id} className="paired-row">
              <span className="paired-path" title={d.path}>{d.path}</span>
              <label className="paired-writable" title="Grant agents & the terminal edit access">
                <input type="checkbox" checked={d.writable} onChange={(e) => void toggle(d.id, e.target.checked)} /> Writable
              </label>
              <button className="paired-remove" aria-label="Remove directory" onClick={() => void remove(d.id)}><X size={13} /></button>
            </div>
          ))}
          {anyWritable && <div className="paired-warn">Agents and the terminal can create &amp; edit files in writable directories.</div>}
          <button className="paired-add" onClick={() => void add()}><FolderPlus size={13} /> Add directory</button>
        </div>
      )}
    </div>
  )
}
