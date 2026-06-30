import { useEffect, useRef, useState } from 'react'
import { ChevronDown, CloudDownload, CloudUpload, Download, Upload } from 'lucide-react'
import { useStore } from './store'
import { buildImportConfirmBody } from './import-confirm'

export default function TeamMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const setGraph = useStore((s) => s.setGraph)
  const requestConfirm = useStore((s) => s.requestConfirm)
  const notify = useStore((s) => s.notify)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const exportTeam = async (): Promise<void> => { await window.api.exportTeam(); setOpen(false) }
  const importTeam = async (): Promise<void> => {
    setOpen(false)
    const r = await window.api.importTeamPreview()
    if (r.status === 'canceled') return
    if (r.status === 'error') { notify({ kind: 'error', message: r.error }); return }
    const ok = await requestConfirm({ title: 'Import this team?', body: buildImportConfirmBody(r.preview), confirmLabel: 'Import', danger: false })
    if (!ok) return
    const a = await window.api.importTeamApply(r.bundle, r.path)
    if ('graph' in a && a.graph) setGraph(a.graph)
    else if ('error' in a && a.error) notify({ kind: 'error', message: a.error })
  }
  const syncUp = async (): Promise<void> => { setOpen(false); const r = await window.api.syncToTeam(); if (r.synced && r.graph) setGraph(r.graph) }
  const syncDown = async (): Promise<void> => {
    setOpen(false)
    const r = await window.api.refreshFromTeam()
    if (r.refreshed && r.graph) { setGraph(r.graph); notify({ kind: 'success', message: `Updated ${r.updated} agent(s) from the team brain.` }) }
    else if (r.error) notify({ kind: 'error', message: r.error })
  }

  return (
    <div className="topmenu" ref={ref}>
      <button className="btn" onClick={() => setOpen((v) => !v)}>Team <ChevronDown size={12} /></button>
      {open && (
        <div className="topmenu-list">
          <button onClick={() => void exportTeam()}><Upload size={14} /> Export team…</button>
          <button onClick={() => void importTeam()}><Download size={14} /> Import team…</button>
          <button onClick={() => void syncUp()}><CloudUpload size={14} /> Sync to team brain</button>
          <button onClick={() => void syncDown()}><CloudDownload size={14} /> Refresh from team brain</button>
        </div>
      )}
    </div>
  )
}
