# Settings Modal Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Settings modal into a modern two-pane "Notion-airy" layout — a left rail of categories + a right content pane of clean rows (label/description left, control right) with toggle switches — without changing any setting's behavior.

**Architecture:** A new reusable `Switch` primitive, then a full rewrite of `SettingsModal.tsx` into a fixed left rail (5 category nav items + project name) + a scrolling content pane that renders one category's panes at a time, plus the supporting CSS. Purely presentational: every control still calls the existing `update(patch)` → `window.api.updateSettings`, so `ProjectSettings`, the store, and IPC are untouched.

**Tech Stack:** TypeScript, React (renderer), lucide-react icons, plain CSS with the warm-dark token system in `src/renderer/tokens.css`. No tests are added (renderer is verified by typecheck + build per house precedent; the existing Vitest suite must stay green).

## Global Constraints

- **Zero behavior change:** do NOT touch `src/shared/types.ts` (`ProjectSettings`), `project-store.ts`, `ipc.ts`, `preload`, or any engine file. Every control keeps calling `update(patch)`; settings round-trip byte-for-byte as today.
- **Preserve** the `update(patch)` auto-save and the `onAutonomyChange` Full-auto `requestConfirm` gate exactly.
- **Warm-dark tokens only** — no raw hex. Use the project tokens: surfaces `--bg` / `--panel` / `--panel-2` (a.k.a. `--surface-0/1/2`), `--border` / `--hairline-strong`, `--accent` (`--signal`), `--text` (`--fg`) / `--muted` (`--fg-muted`), `--radius` (10px) / `--radius-sm` (6px) / `--radius-pill` (999px), `--danger`, `--focus-ring`, `--text-sm`, `--font-sans`.
- **Calm-conductor voice; no emoji-as-UI** — remove the 💸 and ⚠ glyphs; the Full-auto warning becomes a real inline danger callout (lucide `AlertTriangle`).
- **No "Done" button** — an X (top-right) + backdrop click close the modal.
- **Renderer-only verification:** each task ends with `npm run typecheck` clean, `npm run build` succeeds, and `npm test` (the full Vitest suite) still passes. Final visual smoke is the user's.

---

### Task 1: `Switch` toggle primitive

**Files:**
- Create: `src/renderer/Switch.tsx`
- Modify: `src/renderer/styles.css` (append `.switch` rules)

**Interfaces:**
- Produces: `export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }): JSX.Element` — a styled `<button role="switch">` toggle. `label` is the accessible name (`aria-label`).

- [ ] **Step 1: Create `src/renderer/Switch.tsx`**

```tsx
/** Reusable on/off toggle. A styled <button role="switch"> — rose track when on, muted track off. */
export function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  )
}
```

- [ ] **Step 2: Append the `.switch` styles to `src/renderer/styles.css`**

Add at the end of the file:

```css
/* ---- Switch (reusable toggle) ---- */
.switch {
  position: relative;
  flex: 0 0 auto;
  width: 38px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--panel-2);
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.switch.on {
  background: var(--accent);
  border-color: var(--accent);
}
.switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--muted);
  transition: transform 120ms ease, background 120ms ease;
}
.switch.on .switch-knob {
  transform: translateX(16px);
  background: var(--bg);
}
.switch:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--focus-ring);
}
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: PASS. (`Switch` is exported and unused until Task 2 — that compiles cleanly.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/Switch.tsx src/renderer/styles.css
git commit -m "feat(settings): reusable Switch toggle primitive"
```

---

### Task 2: Two-pane Settings modal rewrite

**Files:**
- Modify (full rewrite): `src/renderer/SettingsModal.tsx`
- Modify: `src/renderer/styles.css` (append the Settings two-pane rules)

**Interfaces:**
- Consumes: `Switch` from `./Switch` (Task 1); `useStore` (`graph`, `setGraph`, `requestConfirm`); `window.api.updateSettings(patch)`; types `Autonomy`, `ProjectSettings`, `ReviewMode` from `../shared/types`.
- Produces: the redesigned `export default function SettingsModal({ onClose }: { onClose: () => void })`.

- [ ] **Step 1: Replace the entire contents of `src/renderer/SettingsModal.tsx`**

```tsx
import { useState, type ReactNode } from 'react'
import { AlertTriangle, ClipboardCheck, Coins, Shield, Users, Workflow, X, type LucideIcon } from 'lucide-react'
import { useStore } from './store'
import { Switch } from './Switch'
import type { Autonomy, ProjectSettings, ReviewMode } from '../shared/types'

type CategoryId = 'safety' | 'cost' | 'review' | 'run' | 'team'

const CATEGORIES: { id: CategoryId; label: string; icon: LucideIcon; subtitle: string }[] = [
  { id: 'safety', label: 'Safety', icon: Shield, subtitle: 'Autonomy, permissions, and which skills agents may load' },
  { id: 'cost', label: 'Cost', icon: Coins, subtitle: 'Where the team may spend more for better results' },
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
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

        <button className="settings-close" title="Close" onClick={onClose}>
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
                        ? 'Workers edit files, but commands (including the review’s tests) are blocked. Also governs running an agent directly.'
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
                  desc="Forces any Full-auto or per-agent run down to “accept edits”, engine-wide. A hard ceiling."
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
                      : 'Third-party skills from anthropics-owned marketplaces are also trusted — their plugin code runs under the agent’s permission mode.'
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
                desc="A worker that is blocked may pause the run to ask you one question. Your answer resumes that worker. Workers only — it’s sent to the agent, so don’t share secrets."
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
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Append the Settings two-pane styles to `src/renderer/styles.css`**

Add at the end of the file:

```css
/* ---- Settings modal (two-pane) ---- */
.settings-modal {
  position: relative;
  display: grid;
  grid-template-columns: 220px 1fr;
  width: 880px;
  max-width: 94vw;
  height: min(660px, 86vh);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.settings-rail {
  display: flex;
  flex-direction: column;
  padding: 16px 10px;
  background: var(--bg);
  border-right: 1px solid var(--border);
  overflow-y: auto;
}
.settings-rail-head {
  padding: 4px 8px 14px;
}
.settings-rail-eyebrow {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.settings-rail-project {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.settings-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  font-family: var(--font-sans);
  text-align: left;
  cursor: pointer;
}
.settings-nav-item:hover {
  background: var(--panel-2);
  color: var(--text);
}
.settings-nav-item.active {
  background: var(--panel-2);
  color: var(--text);
}
.settings-close {
  position: absolute;
  top: 14px;
  right: 14px;
  display: flex;
  padding: 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.settings-close:hover {
  background: var(--panel-2);
  color: var(--text);
}
.settings-pane {
  padding: 28px 32px;
  overflow-y: auto;
}
.settings-pane-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: var(--text);
}
.settings-pane-subtitle {
  margin: 4px 0 6px;
  font-size: 13px;
  color: var(--muted);
}
.setting-section {
  margin-top: 22px;
}
.setting-section-title {
  padding-bottom: 8px;
  margin-bottom: 2px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.setting-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}
.setting-row:last-child {
  border-bottom: none;
}
.setting-row-main {
  min-width: 0;
}
.setting-row-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.setting-row-desc {
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
}
.setting-row-control {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 2px;
}
.settings-pane select,
.settings-pane input[type='number'],
.settings-pane input[type='text'] {
  background: var(--panel-2);
  border: 1px solid var(--hairline-strong);
  color: var(--text);
  border-radius: var(--radius-sm);
  padding: 6px 9px;
  font-size: var(--text-sm);
  font-family: var(--font-sans);
}
.settings-pane select:focus,
.settings-pane input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--focus-ring);
}
.settings-pane input[type='number'] {
  width: 64px;
}
.setting-text-input {
  width: 240px;
}
.setting-danger-callout {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin: 4px 0 8px;
  padding: 10px 12px;
  border: 1px solid var(--danger);
  border-left-width: 3px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
}
.setting-danger-callout svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--danger);
}
.gated-control {
  display: flex;
  align-items: center;
  gap: 8px;
}
.gated-count {
  font-size: 12px;
  color: var(--muted);
}
```

- [ ] **Step 3: Check for orphaned settings-only CSS, leave shared classes alone**

The old modal used generic classes (`.field`, `.check`, `.radio-row`, `.radio-list`, `.radio-title`, `.radio-desc`, `.settings-section`, `.gated-count`, `.autonomy-danger`). Several are shared with other modals — do NOT delete those. Run this to see who else uses them:

Run: `grep -rn "settings-section\|autonomy-danger\|radio-row\|\.field\b" src/renderer --include=*.tsx`

Only remove a CSS rule if the grep shows it is now used by **no** `.tsx` file. The safe outcome for this task is to leave the old CSS rules in place (harmless dead CSS); removing dead rules is optional and must be grep-verified. Do not change any other component.

- [ ] **Step 4: Typecheck, build, and run the suite**

Run: `npm run typecheck && npm run build && npm test`
Expected: typecheck PASS; build PASS; Vitest all pass (no regressions — no engine/store code changed).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/SettingsModal.tsx src/renderer/styles.css
git commit -m "feat(settings): two-pane Notion-airy Settings modal"
```

---

## Final verification (after both tasks)

- [ ] `npm run typecheck && npm run build && npm test` — all clean.
- [ ] **User visual smoke** (agents can't run the Electron GUI): open Settings; confirm the left rail switches panes; toggles flip and persist; Autonomy/Review-mode dropdowns work and the Full-auto danger callout appears on "Full auto"; the gated toggles reveal their "up to N" stepper; the X and backdrop close the modal; every setting still saves (reopen shows the saved value).

## Spec coverage check

| Spec requirement | Task |
| --- | --- |
| Two-pane layout (fixed rail + scrolling pane), ~880×min(660,86vh) | 2 (`.settings-modal`) |
| Left rail: "Settings" eyebrow + project name + 5 icon nav items, active highlight | 2 |
| X close (top-right) + backdrop; no "Done" button | 2 |
| Rows: label/desc left, control right; Notion-airy section headers + hairlines | 2 (`SettingRow`/`SettingSection` + CSS) |
| Booleans → `Switch` (reusable, `role="switch"`) | 1 (primitive) + 2 (usage) |
| Review-mode → dropdown; selected mode's sentence as row desc; max-attempts conditional | 2 |
| Gated toggles → Switch + inline "up to N" stepper | 2 (`GatedRow`) |
| Emoji removed; Full-auto → inline danger callout (`AlertTriangle`) | 2 |
| All 16 settings mapped to the 5 panes | 2 (Safety/Cost/Review/Run/Team panes) |
| Zero behavior change (`update(patch)` preserved; no store/IPC/types edits) | 1 + 2 (no engine files touched) |
| `requestConfirm` Full-auto gate preserved | 2 (`onAutonomyChange`) |
| Warm-dark tokens only; no raw hex | 1 + 2 (CSS) |
