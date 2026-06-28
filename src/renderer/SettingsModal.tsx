import { useStore } from './store'
import type { Autonomy, ProjectSettings, ReviewMode } from '../shared/types'

const MODES: { id: ReviewMode; label: string; desc: string }[] = [
  { id: 'none', label: 'Review → memory only', desc: 'Review and record lessons; no redo.' },
  { id: 'once', label: '+ one repair pass', desc: 'Failed tasks get one redo, then re-review.' },
  { id: 'loop', label: '+ repair loop', desc: 'Redo until pass or max attempts.' }
]

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)
  if (!graph) return null
  const s = graph.settings

  const update = async (patch: Partial<ProjectSettings>): Promise<void> => {
    setGraph(await window.api.updateSettings(patch))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <div className="field">
          <label>Review &amp; repair</label>
          <div className="radio-list">
            {MODES.map((m) => (
              <label key={m.id} className={`radio-row ${s.reviewMode === m.id ? 'sel' : ''}`}>
                <input
                  type="radio"
                  name="reviewMode"
                  checked={s.reviewMode === m.id}
                  onChange={() => void update({ reviewMode: m.id })}
                />
                <div>
                  <div className="radio-title">{m.label}</div>
                  <div className="radio-desc">{m.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {s.reviewMode === 'loop' && (
          <div className="field">
            <label>Max repair attempts</label>
            <input
              type="number"
              min={1}
              max={6}
              value={s.maxRepairAttempts}
              onChange={(e) =>
                void update({
                  maxRepairAttempts: Math.max(1, Math.min(6, Number(e.target.value) || 1))
                })
              }
            />
          </div>
        )}

        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.reflection}
              onChange={(e) => void update({ reflection: e.target.checked })}
            />
            Update agent memory after runs
          </label>
        </div>

        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.adaptiveEffort}
              onChange={(e) => void update({ adaptiveEffort: e.target.checked })}
            />
            Adaptive effort — managers assign reasoning effort by task difficulty
          </label>
        </div>

        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.autoAssignModels}
              onChange={(e) => void update({ autoAssignModels: e.target.checked })}
            />
            Auto-assign worker models — orchestrator picks Sonnet/Opus per worker when building a team
          </label>
        </div>

        <div className="field">
          <label>Max mid-run re-plans (0 = off)</label>
          <input
            type="number"
            min={0}
            max={3}
            value={s.maxReplans}
            onChange={(e) =>
              void update({ maxReplans: Math.max(0, Math.min(3, Number(e.target.value) || 0)) })
            }
          />
          <div className="radio-desc" style={{ marginTop: 4 }}>
            When you set an execution order on the canvas, the orchestrator may rewrite the
            not-yet-run plan between stages based on what earlier stages found. The goal never changes.
          </div>
        </div>

        <div className="field">
          <label>Max peer handoffs per step (0 = off)</label>
          <input
            type="number"
            min={0}
            max={3}
            value={s.maxHandoffs}
            onChange={(e) =>
              void update({ maxHandoffs: Math.max(0, Math.min(3, Number(e.target.value) || 0)) })
            }
          />
          <div className="radio-desc" style={{ marginTop: 4 }}>
            When you draw a handoff edge (select an edge → Make handoff), an agent may consult that
            connected teammate mid-step and continue with their answer. The reporting tree is unaffected.
          </div>
        </div>

        <div className="field">
          <label>Max user questions per run (0 = off)</label>
          <input
            type="number"
            min={0}
            max={5}
            value={s.maxUserRequests}
            onChange={(e) =>
              void update({ maxUserRequests: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })
            }
          />
          <div className="radio-desc" style={{ marginTop: 4 }}>
            When on, a worker that is blocked may pause the run to ask you one question. Your answer
            resumes that worker. Workers only — it's sent to the agent, so don't share secrets.
          </div>
        </div>

        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.autoSyncTeam}
              onChange={(e) => void update({ autoSyncTeam: e.target.checked })}
            />
            Auto-sync team brain — pull lessons before a run, push after
          </label>
        </div>

        <div className="field">
          <label>Trusted-skill install threshold</label>
          <input
            type="number"
            min={0}
            step={1000}
            value={s.skillInstallThreshold}
            onChange={(e) =>
              void update({ skillInstallThreshold: Math.max(0, Number(e.target.value) || 0) })
            }
          />
          <div className="radio-desc" style={{ marginTop: 4 }}>
            Non-Anthropic plugins are offered to agents only at/above this many installs. Anthropic plugins are always trusted.
          </div>
        </div>

        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.skillsPackEnabled}
              onChange={(e) => void update({ skillsPackEnabled: e.target.checked })}
            />
            Skills pack — load curated design + Playwright skills as options for every agent
          </label>
        </div>

        <div className="field">
          <label>Skills-pack folder (optional)</label>
          <input
            type="text"
            placeholder="~/.ai-manager/skills-pack"
            value={s.skillsPackPath}
            onChange={(e) => void update({ skillsPackPath: e.target.value })}
          />
          <div className="radio-desc" style={{ marginTop: 4 }}>
            Leave blank for the default. Skills are model-invoked — available to every agent, never forced.
          </div>
        </div>

        <div className="field">
          <label>Autonomy (acting steps)</label>
          <select
            value={s.autonomy}
            onChange={(e) => void update({ autonomy: e.target.value as Autonomy })}
          >
            <option value="auto">Auto — run safe commands, deny risky ones</option>
            <option value="full">Full auto — bypass all permission checks</option>
            <option value="cautious">Cautious — edits only, no command execution</option>
          </select>
          <div className="radio-desc" style={{ marginTop: 4 }}>
            {s.autonomy === 'auto' &&
              'Planning stays read-only; the review can run tests, and risky commands are blocked by a classifier.'}
            {s.autonomy === 'full' && 'Nothing is gated during a run — keep the project under git.'}
            {s.autonomy === 'cautious' &&
              'Workers edit files, but commands (including the review’s tests) are blocked.'}
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
