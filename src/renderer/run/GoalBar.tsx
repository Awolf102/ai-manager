import { useState } from 'react'
import { Network, Play, Sparkles, Square, Target } from 'lucide-react'
import { useStore } from '../store'
import RoleDraftModal from '../RoleDraftModal'
import TeamSpawnModal from '../TeamSpawnModal'
import type { SpawnedMember } from '../../shared/types'

export default function GoalBar() {
  const graph = useStore((s) => s.graph)
  const selectedId = useStore((s) => s.selectedAgentId)
  const running = useStore((s) => s.run.running)
  const runId = useStore((s) => s.run.runId)
  const beginRun = useStore((s) => s.beginRun)
  const [goal, setGoal] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [drafts, setDrafts] = useState<{ agentId: string; name: string; role: string }[] | null>(null)
  const [spawning, setSpawning] = useState(false)
  const [spawned, setSpawned] = useState<SpawnedMember[] | null>(null)

  const orchestrators = graph?.nodes.filter((n) => n.kind === 'orchestrator') ?? []
  const selectedOrch = orchestrators.find((o) => o.id === selectedId)
  const target = selectedOrch ?? (orchestrators.length === 1 ? orchestrators[0] : null)
  const canRun = !!target && !!goal.trim() && !running
  const hasSpecialists = (graph?.nodes.some((n) => n.kind !== 'orchestrator')) ?? false
  const canDraft = !!target && !!goal.trim() && hasSpecialists && !running && !drafting
  const canBuild = !!target && !!goal.trim() && !running && !spawning

  const buildTeam = async (): Promise<void> => {
    if (!target || !goal.trim() || running || spawning) return
    setSpawning(true)
    try {
      const r = await window.api.spawnTeam({ goal: goal.trim(), orchestratorId: target.id })
      if (r.ok && r.members && r.members.length) setSpawned(r.members)
      else window.alert(r.error ?? 'Could not build a team.')
    } finally {
      setSpawning(false)
    }
  }

  const draftRoles = async (): Promise<void> => {
    if (!target || !goal.trim() || !hasSpecialists || running || drafting) return
    setDrafting(true)
    try {
      const r = await window.api.draftRoles({ goal: goal.trim(), orchestratorId: target.id })
      if (r.ok && r.drafts) setDrafts(r.drafts)
      else window.alert(r.error ?? 'Could not draft roles.')
    } finally {
      setDrafting(false)
    }
  }

  const start = async (): Promise<void> => {
    if (!target || !goal.trim() || running) return
    const { runId: id } = await window.api.startRun({
      goal: goal.trim(),
      orchestratorId: target.id
    })
    beginRun(id, goal.trim(), target.id)
  }
  const stop = (): void => {
    if (runId) void window.api.stopRun(runId)
  }

  const hint =
    orchestrators.length === 0
      ? 'add an Orchestrator to run a goal'
      : !target
        ? 'select which Orchestrator to run'
        : target.name

  return (
    <div className="goalbar">
      <input
        className="goal-input"
        placeholder="Describe a goal for the chain to build…"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && canRun) void start()
        }}
        disabled={running}
      />
      <span className="goal-target" title="The goal is given to this Orchestrator">
        <Target size={12} /> {hint}
      </span>
      <button
        className="btn"
        onClick={() => void draftRoles()}
        disabled={!canDraft}
        title="Have the orchestrator draft roles for the team from this goal"
      >
        <Sparkles size={14} /> {drafting ? 'Drafting…' : 'Draft roles'}
      </button>
      <button
        className="btn"
        onClick={() => void buildTeam()}
        disabled={!canBuild}
        title="Have the orchestrator design and create a team for this goal"
      >
        <Network size={14} /> {spawning ? 'Building…' : 'Build team'}
      </button>
      {running ? (
        <button className="btn danger" onClick={stop}>
          <Square size={13} /> Stop
        </button>
      ) : (
        <button className="btn primary" onClick={() => void start()} disabled={!canRun}>
          <Play size={14} /> Run
        </button>
      )}
      {drafts && <RoleDraftModal drafts={drafts} onClose={() => setDrafts(null)} />}
      {spawned && target && (
        <TeamSpawnModal members={spawned} orchestratorId={target.id} onClose={() => setSpawned(null)} />
      )}
    </div>
  )
}
