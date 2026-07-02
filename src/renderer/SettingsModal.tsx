import { useState, type ReactNode } from 'react'
import { AlertTriangle, ClipboardCheck, Coins, Gauge, Shield, Users, Workflow, X, type LucideIcon } from 'lucide-react'
import { useStore } from './store'
import { Switch } from './Switch'
import { Modal } from './Modal'
import type { Autonomy, ProjectSettings, ReviewMode } from '../shared/types'

type CategoryId = 'safety' | 'cost' | 'efficiency' | 'review' | 'run' | 'team'

const CATEGORIES: { id: CategoryId; label: string; icon: LucideIcon; subtitle: string }[] = [
  { id: 'safety', label: 'Safety', icon: Shield, subtitle: 'Autonomy, permissions, and which skills agents may load' },
  { id: 'cost', label: 'Cost', icon: Coins, subtitle: 'Where the team may spend more for better results' },
  { id: 'efficiency', label: 'Token Efficiency', icon: Gauge, subtitle: 'Opt-in ways to spend fewer tokens per run — all off by default' },
  { id: 'review', label: 'Review & repair', icon: ClipboardCheck, subtitle: 'What happens after work is produced' },
  { id: 'run', label: 'Run behavior', icon: Workflow, subtitle: 'Optional mid-run behaviors, off by default' },
  { id: 'team', label: 'Team', icon: Users, subtitle: 'Shared team knowledge and the skills available to agents' }
]

const REVIEW_MODES: { id: ReviewMode; label: string; desc: string }[] = [
  { id: 'none', label: 'Review → memory only', desc: 'Review and record lessons; failed tasks are not redone.' },
  { id: 'once', label: 'Review + one repair pass', desc: 'Failed tasks get one redo, then a re-review.' },
  { id: 'loop', label: 'Review + repair loop', desc: 'Redo failed tasks until they pass or hit the max attempts.' }
]

function SettingSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="setting-section">
      {title && <div className="setting-section-title">{title}</div>}
      {children}
    </div>
  )
}

function SettingRow({ label, desc, control }: { label: string; desc?: ReactNode; control: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-row-main">
        <div className="setting-row-label">{label}</div>
        {desc && <div className="setting-row-desc">{desc}</div>}
      </div>
      <div className="setting-row-control">{control}</div>
    </div>
  )
}

/** A boolean Switch row that, when on, reveals an inline "up to N" stepper. */
function GatedRow({ label, desc, value, max, onChange }: {
  label: string
  desc: string
  value: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <SettingRow
      label={label}
      desc={desc}
      control={
        <div className="gated-control">
          {value > 0 && (
            <label className="gated-count">
              up to{' '}
              <input
                type="number"
                min={1}
                max={max}
                value={value}
                onChange={(e) => onChange(Math.max(1, Math.min(max, Number(e.target.value) || 1)))}
              />
            </label>
          )}
          <Switch checked={value > 0} label={label} onChange={(on) => onChange(on ? 1 : 0)} />
        </div>
      }
    />
  )
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)
  const requestConfirm = useStore((st) => st.requestConfirm)
  const [active, setActive] = useState<CategoryId>('safety')
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

  const meta = CATEGORIES.find((c) => c.id === active)!

  return (
    <Modal onClose={onClose} unstyled className="settings-modal">
      {(close) => (<>
        <aside className="settings-rail">
          <div className="settings-rail-head">
            <div className="settings-rail-eyebrow">Settings</div>
            <div className="settings-rail-project" title={graph.project.name}>{graph.project.name}</div>
          </div>
          <nav className="settings-nav">
            {CATEGORIES.map((c) => {
              const Icon = c.icon
              return (
                <button
                  key={c.id}
                  className={`settings-nav-item${active === c.id ? ' active' : ''}`}
                  onClick={() => setActive(c.id)}
                >
                  <Icon size={16} /> {c.label}
                </button>
              )
            })}
          </nav>
        </aside>

        <button className="settings-close" title="Close" onClick={() => close()}>
          <X size={18} />
        </button>

        <div className="settings-pane">
          <h2 className="settings-pane-title">{meta.label}</h2>
          <div className="settings-pane-subtitle">{meta.subtitle}</div>

          {active === 'safety' && (
            <>
              <SettingSection title="Permissions">
                <SettingRow
                  label="Autonomy"
                  desc={
                    s.autonomy === 'auto'
                      ? 'Planning stays read-only; the review can run tests, and risky commands are blocked by a classifier.'
                      : s.autonomy === 'cautious'
                        ? 'Workers edit files, but commands (including the review\'s tests) are blocked. Also governs running an agent directly.'
                        : 'Acting steps run with no permission checks.'
                  }
                  control={
                    <select value={s.autonomy} onChange={(e) => void onAutonomyChange(e.target.value as Autonomy)}>
                      <option value="auto">Auto</option>
                      <option value="cautious">Cautious</option>
                      <option value="full">Full auto</option>
                    </select>
                  }
                />
                {s.autonomy === 'full' && (
                  <div className="setting-danger-callout">
                    <AlertTriangle size={16} />
                    <span>
                      No permission checks and NOT sandboxed to this project — agents can read or write anything your
                      user account can (SSH keys, other projects, system files). Use only on a throwaway or
                      git-committed project.
                    </span>
                  </div>
                )}
                <SettingRow
                  label="Never bypass permissions"
                  desc='Forces any Full-auto or per-agent run down to "accept edits", engine-wide. A hard ceiling.'
                  control={
                    <Switch
                      checked={s.lockBypassPermissions}
                      label="Never bypass permissions"
                      onChange={(v) => void update({ lockBypassPermissions: v })}
                    />
                  }
                />
              </SettingSection>
              <SettingSection title="Skills trust">
                <SettingRow
                  label="Auto-trust only Anthropic-authored skills"
                  desc={
                    s.trustAnthropicOnly
                      ? 'Only skills authored by Anthropic (in a verified anthropics-owned marketplace) are offered to agents.'
                      : "Third-party skills from anthropics-owned marketplaces are also trusted — their plugin code runs under the agent's permission mode."
                  }
                  control={
                    <Switch
                      checked={s.trustAnthropicOnly}
                      label="Auto-trust only Anthropic-authored skills"
                      onChange={(v) => void update({ trustAnthropicOnly: v })}
                    />
                  }
                />
                <SettingRow
                  label="Block skills whose plugin ships hooks"
                  desc="Plugin hooks run shell/HTTP/MCP commands at tool events. Blocked plugins are not offered to agents."
                  control={
                    <Switch
                      checked={s.blockPluginHooks}
                      label="Block skills whose plugin ships hooks"
                      onChange={(v) => void update({ blockPluginHooks: v })}
                    />
                  }
                />
              </SettingSection>
            </>
          )}

          {active === 'cost' && (
            <SettingSection>
              <SettingRow
                label="Auto-assign worker models"
                desc="The orchestrator picks Sonnet/Opus per worker when building a team. Opus costs more per token than Sonnet — auto-assign reserves Opus for the harder roles."
                control={
                  <Switch
                    checked={s.autoAssignModels}
                    label="Auto-assign worker models"
                    onChange={(v) => void update({ autoAssignModels: v })}
                  />
                }
              />
              <SettingRow
                label="Adaptive effort"
                desc="Managers assign reasoning effort by task difficulty. Higher reasoning effort spends more tokens on the tasks that get it."
                control={
                  <Switch
                    checked={s.adaptiveEffort}
                    label="Adaptive effort"
                    onChange={(v) => void update({ adaptiveEffort: v })}
                  />
                }
              />
            </SettingSection>
          )}

          {active === 'efficiency' && (
            <SettingSection>
              <SettingRow
                label="Concise output"
                desc={
                  s.outputMode === 'normal'
                    ? 'Agents write normally. Turn on to instruct every agent to minimize prose (required code/JSON is always kept in full).'
                    : s.outputMode === 'terse'
                      ? 'Agents minimize prose — no preamble or summaries, just the essential result.'
                      : 'Agents output only code and essential results, omitting explanations.'
                }
                control={
                  <div className="gated-control">
                    {s.outputMode !== 'normal' && (
                      <select
                        value={s.outputMode}
                        onChange={(e) => void update({ outputMode: e.target.value as ProjectSettings['outputMode'] })}
                      >
                        <option value="terse">Terse</option>
                        <option value="code-only">Code only</option>
                      </select>
                    )}
                    <Switch
                      checked={s.outputMode !== 'normal'}
                      label="Concise output"
                      onChange={(on) => void update({ outputMode: on ? 'terse' : 'normal' })}
                    />
                  </div>
                }
              />
              <SettingRow
                label="Effort thrift"
                desc="Cap every task's reasoning effort at a ceiling. Lower reasoning effort spends fewer thinking tokens — the biggest cost driver. Applies even when Adaptive effort is off."
                control={
                  <div className="gated-control">
                    {s.effortThrift && (
                      <select
                        value={s.effortThriftCeiling}
                        onChange={(e) => void update({ effortThriftCeiling: e.target.value as ProjectSettings['effortThriftCeiling'] })}
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                    )}
                    <Switch
                      checked={s.effortThrift}
                      label="Effort thrift"
                      onChange={(v) => void update({ effortThrift: v })}
                    />
                  </div>
                }
              />
              <SettingRow
                label="Cheap-model workers"
                desc="Run all workers on a cheaper model. Managers and the orchestrator keep their own model, so planning, routing, and review quality are unaffected."
                control={
                  <div className="gated-control">
                    {s.cheapModelWorkers && (
                      <select
                        value={s.cheapModelTier}
                        onChange={(e) => void update({ cheapModelTier: e.target.value })}
                      >
                        <option value="claude-sonnet-4-6">Sonnet 4.6</option>
                        <option value="claude-haiku-4-5">Haiku 4.5</option>
                      </select>
                    )}
                    <Switch
                      checked={s.cheapModelWorkers}
                      label="Cheap-model workers"
                      onChange={(v) => void update({ cheapModelWorkers: v })}
                    />
                  </div>
                }
              />
              <SettingRow
                label="Lighter internal prompts"
                desc="Send trimmed versions of the app's own routing and worker instructions — fewer input tokens per step. Slightly less guidance to the agents."
                control={
                  <Switch
                    checked={s.lightPrompts}
                    label="Lighter internal prompts"
                    onChange={(v) => void update({ lightPrompts: v })}
                  />
                }
              />
            </SettingSection>
          )}

          {active === 'review' && (
            <>
              <SettingSection title="Review mode">
                <SettingRow
                  label="Review & repair"
                  desc={REVIEW_MODES.find((m) => m.id === s.reviewMode)?.desc}
                  control={
                    <select value={s.reviewMode} onChange={(e) => void update({ reviewMode: e.target.value as ReviewMode })}>
                      {REVIEW_MODES.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  }
                />
                {s.reviewMode === 'loop' && (
                  <SettingRow
                    label="Max repair attempts"
                    desc="How many times a failed task is redone before giving up."
                    control={
                      <input
                        type="number"
                        min={1}
                        max={6}
                        value={s.maxRepairAttempts}
                        onChange={(e) =>
                          void update({ maxRepairAttempts: Math.max(1, Math.min(6, Number(e.target.value) || 1)) })
                        }
                      />
                    }
                  />
                )}
              </SettingSection>
              <SettingSection title="Memory">
                <SettingRow
                  label="Update agent memory after runs"
                  desc="Agents write reflections to memory.md when a run finishes."
                  control={
                    <Switch
                      checked={s.reflection}
                      label="Update agent memory after runs"
                      onChange={(v) => void update({ reflection: v })}
                    />
                  }
                />
              </SettingSection>
            </>
          )}

          {active === 'run' && (
            <SettingSection>
              <GatedRow
                label="Mid-run re-plans"
                max={3}
                value={s.maxReplans}
                onChange={(v) => void update({ maxReplans: v })}
                desc="When you set an execution order on the canvas, the orchestrator may rewrite the not-yet-run plan between stages based on what earlier stages found. The goal never changes."
              />
              <GatedRow
                label="Peer handoffs per step"
                max={3}
                value={s.maxHandoffs}
                onChange={(v) => void update({ maxHandoffs: v })}
                desc="When you draw a handoff edge (select an edge → Make handoff), an agent may consult that connected teammate mid-step and continue with their answer. The reporting tree is unaffected."
              />
              <GatedRow
                label="User questions per run"
                max={5}
                value={s.maxUserRequests}
                onChange={(v) => void update({ maxUserRequests: v })}
                desc="A worker that is blocked may pause the run to ask you one question. Your answer resumes that worker. Workers only — it's sent to the agent, so don't share secrets."
              />
              <SettingRow
                label="Follow-through"
                desc={
                  s.followThrough === 'headless'
                    ? "When a worker hits a feature whose behavior wasn't specified, it builds a reasonable version instead of a placeholder and records what it assumed."
                    : s.followThrough === 'ask'
                      ? 'When a worker hits an under-specified feature, it pauses and asks you, with clickable options it proposes. Your pick is recorded.'
                      : 'Off — workers may leave placeholders for under-specified features.'
                }
                control={
                  <div className="gated-control">
                    {s.followThrough === 'ask' && (
                      <label className="gated-count">
                        up to{' '}
                        <input
                          type="number"
                          min={1}
                          max={5}
                          value={s.maxFollowThrough || 3}
                          onChange={(e) => void update({ maxFollowThrough: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })}
                        />
                      </label>
                    )}
                    <select
                      value={s.followThrough}
                      onChange={(e) => {
                        const v = e.target.value as ProjectSettings['followThrough']
                        void update(v === 'ask' ? { followThrough: v, maxFollowThrough: s.maxFollowThrough || 3 } : { followThrough: v })
                      }}
                    >
                      <option value="off">Off</option>
                      <option value="headless">Headless (auto-assume)</option>
                      <option value="ask">Ask me</option>
                    </select>
                  </div>
                }
              />
            </SettingSection>
          )}

          {active === 'team' && (
            <>
              <SettingSection title="Sync">
                <SettingRow
                  label="Auto-sync team brain"
                  desc="Pull shared lessons before a run, push after."
                  control={
                    <Switch
                      checked={s.autoSyncTeam}
                      label="Auto-sync team brain"
                      onChange={(v) => void update({ autoSyncTeam: v })}
                    />
                  }
                />
              </SettingSection>
              <SettingSection title="Skills">
                <SettingRow
                  label="Trusted-skill install threshold"
                  desc="Non-Anthropic plugins are offered to agents only at/above this many installs. Anthropic plugins are always trusted."
                  control={
                    <input
                      type="number"
                      min={0}
                      step={1000}
                      value={s.skillInstallThreshold}
                      onChange={(e) => void update({ skillInstallThreshold: Math.max(0, Number(e.target.value) || 0) })}
                    />
                  }
                />
                <SettingRow
                  label="Skills pack"
                  desc="Load curated design + Playwright skills as options for every agent. Skills are model-invoked — available, never forced."
                  control={
                    <Switch
                      checked={s.skillsPackEnabled}
                      label="Skills pack"
                      onChange={(v) => void update({ skillsPackEnabled: v })}
                    />
                  }
                />
                <SettingRow
                  label="Skills-pack folder"
                  desc="Leave blank for the default (~/.ai-manager/skills-pack)."
                  control={
                    <input
                      type="text"
                      className="setting-text-input"
                      placeholder="~/.ai-manager/skills-pack"
                      value={s.skillsPackPath}
                      onChange={(e) => void update({ skillsPackPath: e.target.value })}
                    />
                  }
                />
              </SettingSection>
            </>
          )}
        </div>
      </>)}
    </Modal>
  )
}
