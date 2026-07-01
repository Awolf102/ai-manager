import { useEffect, useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import { recentGoals, promptLabel } from './recent-prompts'
import { rovingIndex } from '../roving'

export default function RecentPrompts({ onPick }: { onPick: (goal: string) => void }) {
  const [open, setOpen] = useState(false)
  const [goals, setGoals] = useState<string[]>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const toggle = async (): Promise<void> => {
    if (open) {
      setOpen(false)
      return
    }
    const runs = await window.api.listRuns()
    setGoals(recentGoals(runs))
    setOpen(true)
  }

  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const onItemKeyDown = (e: React.KeyboardEvent, i: number): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      document.getElementById('recent-prompts-trigger')?.focus()
      return
    }
    const ni = rovingIndex(e.key, i, goals.length, 'vertical')
    if (ni == null) return
    e.preventDefault()
    itemRefs.current[ni]?.focus()
  }

  return (
    <div className="recent-prompts-menu" ref={ref}>
      <button
        className="btn"
        id="recent-prompts-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => void toggle()}
        title="Reuse a recent prompt"
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !open) {
            e.preventDefault()
            void toggle().then(() => requestAnimationFrame(() => itemRefs.current[0]?.focus()))
          }
        }}
      >
        <Clock size={14} /> Recent
      </button>
      {open && (
        <div className="recent-prompts-list" role="menu" aria-labelledby="recent-prompts-trigger">
          {goals.length === 0 ? (
            <div className="recent-prompts-empty">No past prompts yet.</div>
          ) : (
            goals.map((g, i) => (
              <button
                key={i}
                ref={(el) => { itemRefs.current[i] = el }}
                className="recent-prompts-item"
                role="menuitem"
                tabIndex={-1}
                title={g}
                onClick={() => {
                  onPick(g)
                  setOpen(false)
                }}
                onKeyDown={(e) => onItemKeyDown(e, i)}
              >
                {promptLabel(g)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
