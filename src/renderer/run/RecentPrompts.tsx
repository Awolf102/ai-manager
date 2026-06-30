import { useEffect, useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import { recentGoals, promptLabel } from './recent-prompts'

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

  return (
    <div className="recent-menu" ref={ref}>
      <button className="btn" onClick={() => void toggle()} title="Reuse a recent prompt">
        <Clock size={14} /> Recent
      </button>
      {open && (
        <div className="recent-list">
          {goals.length === 0 ? (
            <div className="recent-empty">No past prompts yet.</div>
          ) : (
            goals.map((g, i) => (
              <button
                key={i}
                className="recent-item"
                title={g}
                onClick={() => {
                  onPick(g)
                  setOpen(false)
                }}
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
