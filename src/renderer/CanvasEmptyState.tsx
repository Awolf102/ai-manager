import { Network, Plus } from 'lucide-react'
import { BrandMark } from './BrandMark'

/** Shown over the canvas when a project has no agents yet. */
export default function CanvasEmptyState({ onBuild, onAdd }: { onBuild: () => void; onAdd: () => void }) {
  return (
    <div className="canvas-empty">
      <div className="canvas-empty-card">
        <BrandMark size={34} />
        <h2>Assemble your team</h2>
        <p>
          Your team is led by an <b>Orchestrator</b> who delegates to specialists. Start from a goal and it
          builds the team for you.
        </p>
        <div className="canvas-empty-actions">
          <button className="btn primary" onClick={onBuild}>
            <Network size={14} /> Build a team from a goal
          </button>
          <button className="btn" onClick={onAdd}>
            <Plus size={14} /> Add a single agent
          </button>
        </div>
      </div>
    </div>
  )
}
