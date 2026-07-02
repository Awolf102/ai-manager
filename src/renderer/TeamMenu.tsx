import { useEffect, useRef, useState } from 'react'
import { ChevronDown, CloudDownload, CloudUpload, Download, Palette, Upload } from 'lucide-react'
import { useStore } from './store'
import { buildImportConfirmBody } from './import-confirm'
import { rovingIndex } from './roving'
import TeamSpawnModal from './TeamSpawnModal'
import { briefTeamToSpawnedMembers } from '../shared/advisor'
import { VISION_TEAM } from '../shared/team-vision'
import type { SpawnedMember } from '../shared/types'

export default function TeamMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const setGraph = useStore((s) => s.setGraph)
  const requestConfirm = useStore((s) => s.requestConfirm)
  const notify = useStore((s) => s.notify)
  const graph = useStore((s) => s.graph)
  const [spawn, setSpawn] = useState<{ members: SpawnedMember[]; orchestratorId: string } | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const exportTeam = async (): Promise<void> => { setOpen(false); await window.api.exportTeam() }
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
  const addCreativeTeam = (): void => {
    setOpen(false)
    const orch = graph?.nodes.find((n) => n.kind === 'orchestrator')
    if (!orch) {
      notify({ kind: 'error', message: 'Add an Orchestrator first — then you can add a creative team under it.' })
      return
    }
    setSpawn({ members: briefTeamToSpawnedMembers(VISION_TEAM), orchestratorId: orch.id })
  }

  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const items = [
    { label: 'Export team…', icon: <Upload size={14} />, run: exportTeam },
    { label: 'Import team…', icon: <Download size={14} />, run: importTeam },
    { label: 'Add Creative Team', icon: <Palette size={14} />, run: async () => addCreativeTeam() },
    { label: 'Sync to team brain', icon: <CloudUpload size={14} />, run: syncUp },
    { label: 'Refresh from team brain', icon: <CloudDownload size={14} />, run: syncDown }
  ]
  const onItemKeyDown = (e: React.KeyboardEvent, i: number): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      document.getElementById('team-menu-trigger')?.focus()
      return
    }
    const ni = rovingIndex(e.key, i, items.length, 'vertical')
    if (ni == null) return
    e.preventDefault()
    itemRefs.current[ni]?.focus()
  }

  return (
    <>
      <div className="topmenu" ref={ref}>
        <button
          className={`btn ${open ? 'active' : ''}`}
          id="team-menu-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !open) {
              e.preventDefault()
              setOpen(true)
              requestAnimationFrame(() => itemRefs.current[0]?.focus())
            }
          }}
        >
          Team <ChevronDown size={12} />
        </button>
        {open && (
          <div className="topmenu-list" role="menu" aria-labelledby="team-menu-trigger">
            {items.map((it, i) => (
              <button
                key={it.label}
                ref={(el) => { itemRefs.current[i] = el }}
                role="menuitem"
                tabIndex={-1}
                onClick={() => void it.run()}
                onKeyDown={(e) => onItemKeyDown(e, i)}
              >
                {it.icon} {it.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {spawn && <TeamSpawnModal members={spawn.members} orchestratorId={spawn.orchestratorId} onClose={() => setSpawn(null)} />}
    </>
  )
}
