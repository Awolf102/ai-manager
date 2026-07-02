import { useEffect, useRef, useState } from 'react'
import { ChevronDown, GitBranch } from 'lucide-react'
import { useStore } from './store'
import { rovingIndex } from './roving'

interface GitInfo { isRepo: boolean; branch: string; dirty: boolean; branches: string[] }

export default function BranchChip() {
  const projectPath = useStore((s) => s.graph?.project.path)
  const running = useStore((s) => s.run.running)
  const notify = useStore((s) => s.notify)
  const [info, setInfo] = useState<GitInfo | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const refresh = (): void => { void window.api.gitInfo().then(setInfo).catch(() => setInfo(null)) }
  useEffect(() => { refresh() }, [projectPath])
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!info?.isRepo) return null

  const disabled = running || info.dirty
  const reason = running
    ? "Can't switch branches during a run"
    : info.dirty
      ? 'Commit or stash your changes first'
      : 'Switch branch'

  const pick = async (branch: string): Promise<void> => {
    setOpen(false)
    if (branch === info.branch) return
    const r = await window.api.gitCheckout(branch)
    if (!r.ok) notify({ kind: 'error', message: r.error ?? 'Could not switch branch.' })
    refresh()
  }
  const onItemKeyDown = (e: React.KeyboardEvent, i: number): void => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); document.getElementById('branch-chip-trigger')?.focus(); return }
    const ni = rovingIndex(e.key, i, info.branches.length, 'vertical')
    if (ni == null) return
    e.preventDefault(); itemRefs.current[ni]?.focus()
  }

  return (
    <div className="topmenu" ref={ref}>
      <button
        className={`btn ${open ? 'active' : ''}`}
        id="branch-chip-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={reason}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !open) {
            e.preventDefault(); setOpen(true); requestAnimationFrame(() => itemRefs.current[0]?.focus())
          }
        }}
      >
        <GitBranch size={13} /> {info.branch}{info.dirty ? '*' : ''} <ChevronDown size={12} />
      </button>
      {open && (
        <div className="topmenu-list" role="menu" aria-labelledby="branch-chip-trigger">
          {info.branches.map((b, i) => (
            <button
              key={b}
              ref={(el) => { itemRefs.current[i] = el }}
              role="menuitem"
              tabIndex={-1}
              onClick={() => void pick(b)}
              onKeyDown={(e) => onItemKeyDown(e, i)}
            >
              {b === info.branch ? '● ' : ''}{b}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
