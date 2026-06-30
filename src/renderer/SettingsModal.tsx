import { useStore } from './store'
import type { Autonomy, ProjectSettings, ReviewMode } from '../shared/types'

const MODES: { id: ReviewMode; label: string; desc: string }[] = [
  { id: 'none', label: 'Review → memory only', desc: 'Review and record lessons; no redo.' },
  { id: 'once', label: '+ one repair pass', desc: 'Failed tasks get one redo, then re-review.' },
  { id: 'loop', label: '+ repair loop', desc: 'Redo until pass or max attempts.' }
]

function GatedToggle({
  label,
  desc,
  value,
  max,
  onChange
}: {
  label: string
  desc: string
  value: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <div className="field">
      <label className="check">
        <input type="checkbox" checked={value > 0} onChange={(e) => onChange(e.target.checked ? 1 : 0)} />
        {label}
      </label>
      {value > 0 && (
        <div className="gated-count">
          up to{' '}
          <input
            type="number"
            min={1}
            max={max}
            value={value}
            onChange={(e) => onChange(Math.max(1, Math.min(max, Number(e.target.value) || 1)))}
          />
        </div>
      )}
      <div className="radio-desc" style={{ marginTop: 4 }}>
        {desc}
      </div>
    </div>
  )
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)
  const requestConfirm = useStore((st) => st.requestConfirm)
  if (!graph) return null
  const s = graph.settings

  const update = async (patch: Partial<ProjectSettings>): Promise<void> => {
    setGraph(await window.api.updateSettings(patch))
  }

  const onAutonomyChange = async (next: Autonomy): Promise<void> => {
    if (next === 'full' && s.autonomy !== 'full') {
      const ok = await requestConfirm({
        title: 'Enable Full auto?',
        body: 'Agents will run with NO permission checks and are not sandboxed to this project — they can read or write anything your user account can (SSH keys, other projects, system files). Only use Full auto on a throwaway or git-committed project.',
        confirmLabel: 'Enable Full auto',
        danger: true
      })
      if (!ok) return
    }
    await update({ autonomy: next })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <h3 className="settings-section">Safety</h3>
        <div className="field">
          <label>Autonomy (acting steps)</label>
          <select value={s.autonomy} onChange={(e) => void onAutonomyChange(e.target.value as Autonomy)}>
            <option value="auto">Auto — run safe commands, deny risky ones</option>
            <option value="full">Full auto — no permission checks (not sandboxed)</option>
            <option value="cautious">Cautious — edits only, no command execution</option>
          </select>
          <div className="radio-desc" style={{ marginTop: 4 }}>
            {s.autonomy === 'auto' &&
              'Planning stays read-only; the review can run tests, and risky commands are blocked by a classifier.'}
            {s.autonomy === 'full' && (
              <span className="autonomy-danger">
                ⚠ No permission checks and NOT sandboxed to this project — agents can read or write anything
                your user account can (SSH keys, other projects, system files). Use only on a throwaway or
                git-committed project.
              </span>
            )}
            {s.autonomy === 'cautious' &&
              "Workers edit files, but commands (including the review's tests) are blocked. Also governs running an agent directly."}
          </div>
        </div>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.lockBypassPermissions}
              onChange={(e) => void update({ lockBypassPermissions: e.target.checked })}
            />
            Never bypass permissions (lock)
          </label>
          <div className="radio-desc" style={{ marginTop: 4 }}>
            Forces any Full-auto or per-agent run down to "accept edits", engine-wide. A hard ceiling.
          </div>
        </div>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.trustAnthropicOnly}
              onChange={(e) => void update({ trustAnthropicOnly: e.target.checked })}
            />
            Auto-trust only Anthropic-authored skills
          </label>
          <div className="radio-desc" style={{ marginTop: 4 }}>
            {s.trustAnthropicOnly
              ? 'Only skills authored by Anthropic (in a verified anthropics-owned marketplace) are offered to agents.'
              : "⚠ Third-party skills from anthropics-owned marketplaces are also trusted — their plugin code runs under the agent’s permission mode."}
          </div>
        </div>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.blockPluginHooks}
              onChange={(e) => void update({ blockPluginHooks: e.target.checked })}
            />
            Block skills whose plugin ships hooks
          </label>
          <div className="radio-desc" style={{ marginTop: 4 }}>
            Plugin hooks run shell/HTTP/MCP commands at tool events. Blocked plugins are not offered to agents.
          </div>
        </div>

        <h3 className="settings-section">Cost</h3>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={s.autoAssignModels}
              onChange={(e) => void update({ autoAssignModels: e.target.checked })}
            />
            Auto-assign worker models — orchestrator picks Sonnet/Opus per worker when building a team
          </label>
          <div className="radio-desc" style={{ marginTop: 4 }}>
            💸 Opus costs more per token than Sonnet — auto-assign reserves Opus for the harder roles.
          </div>
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
          <div className="radio-desc" style={{ marginTop: 4 }}>
            💸 Higher reasoning effort spends more tokens (higher cost) on the tasks that get it.
          </div>
        </div>

        <h3 className="settings-section">Review &amp; repair</h3>
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
                void update({ maxRepairAttempts: Math.max(1, Math.min(6, Number(e.target.value) || 1)) })
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

        <h3 className="settings-section">Run behavior</h3>
        <GatedToggle
          label="Mid-run re-plans"
          max={3}
          value={s.maxReplans}
          onChange={(v) => void update({ maxReplans: v })}
          desc="When you set an execution order on the canvas, the orchestrator may rewrite the not-yet-run plan between stages based on what earlier stages found. The goal never changes."
        />
        <GatedToggle
          label="Peer handoffs per step"
          max={3}
          value={s.maxHandoffs}
          onChange={(v) => void update({ maxHandoffs: v })}
          desc="When you draw a handoff edge (select an edge → Make handoff), an agent may consult that connected teammate mid-step and continue with their answer. The reporting tree is unaffected."
        />
        <GatedToggle
          label="User questions per run"
          max={5}
          value={s.maxUserRequests}
          onChange={(v) => void update({ maxUserRequests: v })}
          desc="A worker that is blocked may pause the run to ask you one question. Your answer resumes that worker. Workers only — it's sent to the agent, so don't share secrets."
        />

        <h3 className="settings-section">Team</h3>
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
            onChange={(e) => void update({ skillInstallThreshold: Math.max(0, Number(e.target.value) || 0) })}
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

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
