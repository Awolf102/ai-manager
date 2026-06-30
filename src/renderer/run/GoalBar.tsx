import { useState } from 'react'
import { Network, PanelRight, Play, Rocket, Sparkles, Square, Target } from 'lucide-react'
import { isGoalSubmitKey } from './goalbar-keys'
import { useStore } from '../store'
import RoleDraftModal from '../RoleDraftModal'
import TeamSpawnModal from '../TeamSpawnModal'
import RunResultModal from './RunResultModal'
import RecentPrompts from './RecentPrompts'
import type { RunManifest, SpawnedMember } from '../../shared/types'

const MAX_GOAL_HEIGHT = 360 // px — focused expansion cap (~18 lines), then the textarea scrolls

/** Grow the goal textarea to fit its content, capped at MAX_GOAL_HEIGHT. */
function autosize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, MAX_GOAL_HEIGHT)}px`
}

export default function GoalBar() {
  const graph = useStore((s) => s.graph)
  const selectedId = useStore((s) => s.selectedAgentId)
  const running = useStore((s) => s.run.running)
  const runId = useStore((s) => s.run.runId)
  const pendingInterrupt = useStore((s) => s.run.pendingInterrupt)
  const beginRun = useStore((s) => s.beginRun)
  const notify = useStore((s) => s.notify)
  const inspectorCollapsed = useStore((s) => s.layout.inspector.collapsed)
  const toggleZoneCollapsed = useStore((s) => s.toggleZoneCollapsed)
  const [goal, setGoal] = useState('')
  const [focused, setFocused] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [drafts, setDrafts] = useState<{ agentId: string; name: string; role: string; skills?: string[] }[] | null>(null)
  const [spawning, setSpawning] = useState(false)
  const [spawned, setSpawned] = useState<SpawnedMember[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [manifest, setManifest] = useState<RunManifest | null>(null)

  const orchestrators = graph?.nodes.filter((n) => n.kind === 'orchestrator') ?? []
  const selectedOrch = orchestrators.find((o) => o.id === selectedId)
  const target = selectedOrch ?? (orchestrators.length === 1 ? orchestrators[0] : null)
  const canRun = !!target && !!goal.trim() && !running
  const hasSpecialists = (graph?.nodes.some((n) => n.kind !== 'orchestrator')) ?? false
  const canDraft = !!target && !!goal.trim() && hasSpecialists && !running && !drafting
  const canBuild = !!target && !!goal.trim() && !running && !spawning
  const canRunResult = !!target && !running && !detecting

  const buildTeam = async (): Promise<void> => {
    if (!target || !goal.trim() || running || spawning) return
    setSpawning(true)
    try {
      const r = await window.api.spawnTeam({ goal: goal.trim(), orchestratorId: target.id })
      if (r.ok && r.members && r.members.length) setSpawned(r.members)
      else notify({ kind: 'error', message: r.error ?? 'Could not build a team.' })
    } finally {
      setSpawning(false)
    }
  }

  const runResult = async (): Promise<void> => {
    if (!target || running || detecting) return
    setDetecting(true)
    try {
      const r = await window.api.detectManifest({ goal: goal.trim(), orchestratorId: target.id })
      if (r.ok && r.manifest) setManifest(r.manifest)
      else notify({ kind: 'error', message: r.error ?? 'Could not detect how to run the result.' })
    } finally {
      setDetecting(false)
    }
  }

  const draftRoles = async (): Promise<void> => {
    if (!target || !goal.trim() || !hasSpecialists || running || drafting) return
    setDrafting(true)
    try {
      const r = await window.api.draftRoles({ goal: goal.trim(), orchestratorId: target.id })
      if (r.ok && r.drafts) setDrafts(r.drafts)
      else notify({ kind: 'error', message: r.error ?? 'Could not draft roles.' })
    } finally {
      setDrafting(false)
    }
  }

  const start = async (): Promise<void> => {
    if (!target || !goal.trim() || running) return
    try {
      const { runId: id } = await window.api.startRun({
        goal: goal.trim(),
        orchestratorId: target.id
      })
      beginRun(id, goal.trim(), target.id)
    } catch (err) {
      notify({ kind: 'error', message: err instanceof Error ? err.message : 'Could not start the run.' })
    }
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
    <div className={`goalbar ${focused ? 'goalbar-focus' : ''}`}>
      <textarea
        className="goal-input"
        rows={1}
        placeholder="Describe a goal for the chain to build…  (Enter to run, Shift+Enter for a new line)"
        value={goal}
        onChange={(e) => {
          setGoal(e.target.value)
          if (focused) autosize(e.target)
        }}
        onFocus={(e) => {
          setFocused(true)
          autosize(e.target)
        }}
        onBlur={(e) => {
          setFocused(false)
          e.target.style.height = ''
        }}
        onKeyDown={(e) => {
          if (isGoalSubmitKey(e.key, e.shiftKey)) {
            e.preventDefault()
            if (canRun) void start()
          }
        }}
        disabled={running}
      />
      <span className="goal-target" title="The goal is given to this Orchestrator">
        <Target size={12} /> {hint}
      </span>
      <RecentPrompts onPick={setGoal} />
      <span className="goal-tools">
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
        <button
          className="btn"
          onClick={() => void runResult()}
          disabled={!canRunResult}
          title="Launch the app your team built and open it in the browser"
        >
          <Rocket size={14} /> {detecting ? 'Launching…' : 'Launch app'}
        </button>
      </span>
      {running ? (
        <button
          className="btn danger"
          onClick={stop}
          disabled={!!pendingInterrupt}
          title={
            pendingInterrupt
              ? 'The run is waiting on your answer — Submit or Skip the question to continue'
              : undefined
          }
        >
          <Square size={13} /> Stop
        </button>
      ) : (
        <button className="btn primary" onClick={() => void start()} disabled={!canRun}>
          <Play size={14} /> Run
        </button>
      )}
      {inspectorCollapsed && (
        <button className="btn" title="Show the inspector panel" onClick={() => toggleZoneCollapsed('inspector')}>
          <PanelRight size={14} /> Inspector
        </button>
      )}
      {drafts && <RoleDraftModal drafts={drafts} onClose={() => setDrafts(null)} />}
      {spawned && target && (
        <TeamSpawnModal members={spawned} orchestratorId={target.id} onClose={() => setSpawned(null)} />
      )}
      {manifest && <RunResultModal manifest={manifest} onClose={() => setManifest(null)} />}
    </div>
  )
}
