# Orkestr — Sub-project 5: Settings & Gated Features

**Date:** 2026-06-30
**Parent:** `docs/superpowers/specs/2026-06-29-orkestr-overhaul-direction-design.md` (umbrella).
**Builds on:** Foundation tokens; Shell+IA; Run experience; Canvas; Goal/prompt.
**Status:** Design approved (brainstorm). Ready for implementation planning.

The sixth sub-project of the Orkestr overhaul (decomposition item 5). It groups Settings, makes the gated features real toggles, collapses the permission model to one concept, and adds enable-on-gesture for handoffs. Owns audit **#21 + #32 + #34**.

---

## 1. Goal

Make Settings legible and the controls honest:
1. **Grouped Settings** — organize the flat list into Safety / Cost / Review & repair / Run behavior / Team sections, with cost hints on the model/effort levers.
2. **Real on/off toggles** for the gated features (re-plans / handoffs / user questions) instead of "0 = off" number inputs.
3. **One permission concept** — remove the per-agent permission dropdown (raw SDK enums, no-op in orchestrated runs); the project Autonomy governs everything.
4. **Enable-on-gesture** — drawing a handoff edge while handoffs are off offers to enable them.

Success = Settings reads as labeled sections with clear on/off gated toggles and cost cues; there is exactly one permission model (Autonomy); and turning on handoffs can happen right where you draw one.

---

## 2. Current state

- `SettingsModal.tsx` is a flat field list with a single "Security" `<h3>`. `ProjectSettings` includes: `reviewMode`, `maxRepairAttempts`, `reflection`, `adaptiveEffort`, `autoAssignModels`, `maxReplans`, `maxHandoffs`, `maxUserRequests`, `autoSyncTeam`, `skillInstallThreshold`, `autonomy`, `lockBypassPermissions`, `trustAnthropicOnly`, `blockPluginHooks`, `skillsPackEnabled`, `skillsPackPath`. The 3 gated features are `<input type="number">` with "0 = off" labels.
- `AgentConfigPanel.tsx` has a per-agent `<select value={agent.permissionMode}>` over raw enums (`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto'`). This is consumed only by **direct** per-agent launches (`pty-manager.spawnPty` passes `--permission-mode agent.permissionMode`; `agent-runner.streamAgent` falls back to `agent.permissionMode`). Orchestrated runs ignore it — they use `actingMode = actingModeFor(autonomy)` (`nodes.ts`), seeded in `orchestrator.ts`.
- `actingModeFor(autonomy)` maps `full→bypassPermissions`, `cautious→acceptEdits`, else `auto`. `getSettings()` (`project-store.ts:552`) returns the live `ProjectSettings`.

---

## 3. Grouped Settings (5 sections)

Restructure `SettingsModal` into labeled sections (each a `settings-section` header, reusing the existing style), reordering the existing fields — no behavior change to the fields themselves except §4/§5:
- **Safety:** Autonomy (the existing `<select>` + danger copy + Full-auto confirm — unchanged), "Never bypass permissions (lock)", "Auto-trust only Anthropic-authored skills", "Block skills whose plugin ships hooks".
- **Cost:** "Auto-assign worker models" + **cost hint** ("Opus costs more per token than Sonnet"); "Adaptive effort" + **cost hint** ("higher effort spends more tokens → higher cost").
- **Review & repair:** review mode (radio list) + max repair attempts (when loop) + "Update agent memory after runs".
- **Run behavior:** the 3 gated toggles (§4).
- **Team:** "Auto-sync team brain", "Trusted-skill install threshold", "Skills pack" + path.

Section order: Safety, Cost, Review & repair, Run behavior, Team. Cost hints render as the existing `radio-desc` helper text under each control.

---

## 4. Gated features as real toggles (#32)

Replace each `maxReplans` / `maxHandoffs` / `maxUserRequests` number input with a **toggle + conditional count**:
- A checkbox/toggle "Enable …" reflecting `value > 0`.
- Toggling **on** sets the value to `1` (revealing a small count `<input type="number">`, clamped to the existing max — replans/handoffs `1–3`, user-requests `1–5`); toggling **off** sets it to `0` (hiding the count).
- Keep each control's existing description text (it already explains the feature). The labels drop the "(0 = off)" phrasing since the toggle now expresses on/off.
- The on↔count mapping is trivial; persistence is the existing `updateSettings({ maxX })`.

---

## 5. One permission concept (#21)

- **Remove** the per-agent permission `<select>` (+ its label) from `AgentConfigPanel.tsx`; remove now-unused `PermissionMode` import there.
- **Direct per-agent launches use Autonomy:**
  - `pty-manager.spawnPty`: replace `agent.permissionMode` in the args with `actingModeFor(getSettings().autonomy)`.
  - `agent-runner.streamAgent`: change the fallback `opts.permissionMode ?? agent.permissionMode` → `opts.permissionMode ?? actingModeFor(getSettings().autonomy)` (orchestrated callers always pass `opts.permissionMode`, so this only affects any non-orchestrated direct call).
- **Extract `actingModeFor`** from `nodes.ts` into a small pure module `src/main/engine/acting-mode.ts` (so the launch path doesn't import the orchestration engine), and update `orchestrator.ts` to import it from there. Behavior identical.
- `agent.permissionMode` (the data field) is left **vestigial** — no longer read for launches, but kept in the type/bundle/store to avoid a risky data/bundle migration (a later cleanup can remove it). Existing defaults (`'default'`/`'acceptEdits'`) stay harmless.

Result: the project **Autonomy** is the single permission concept for both orchestrated runs and direct per-agent Run/Terminal; no raw SDK enum strings shown to the user.

---

## 6. Enable-on-gesture for handoffs (#32, deferred from Canvas)

- In `OrgChart.tsx`'s `convertSelected` (the "Make handoff/reporting" action): when converting an edge **to** `handoff` and `graph.settings.maxHandoffs === 0`, first `requestConfirm({ title: 'Enable handoffs?', body: 'Handoffs are off, so this edge would do nothing during a run. Enable peer handoffs now?', confirmLabel: 'Enable' })`. On confirm, `updateSettings({ maxHandoffs: 1 })` then proceed with the conversion; on decline, still convert the edge (the user may enable later) — the edge is harmless while off.
- Uses the existing `requestConfirm` + `window.api.updateSettings`; OrgChart already has `graph` (for `settings.maxHandoffs`).
- Scope: only the handoff gesture (the explicitly-deferred Canvas nudge). Other gestures (e.g. setting run order → re-plans) are out of scope.

---

## 7. Architecture / units

- **`acting-mode.ts`** (new, pure) — `actingModeFor(autonomy)`; TDD'd; imported by `orchestrator.ts`, `pty-manager.ts`, `agent-runner.ts`.
- **`pty-manager.ts` / `agent-runner.ts`** — direct-launch permission sourced from Autonomy.
- **`AgentConfigPanel.tsx`** — remove the permission control.
- **`SettingsModal.tsx`** — section restructure + gated toggles + cost hints. (It will grow; keep it readable — extract a small `GatedToggle` sub-component for the 3 toggles to avoid repetition.)
- **`OrgChart.tsx`** — the handoff enable-on-gesture confirm.
- **`styles.css`** — section/toggle styling as needed (reuse `settings-section`, `field`, `check`, `radio-desc`).

---

## 8. Out of scope

- Removing the vestigial `agent.permissionMode` field (data/bundle/store) — later cleanup.
- Enable-on-gesture for re-plans/user-requests (only handoffs here).
- The a11y pass (pooled separately).
- Context (sub-project 6); any other surface.
- Changing what the gated features DO (engine behavior) — this is UI/permission wiring only.

---

## 9. Testing

Per the project pattern (pure logic TDD'd; UI/wiring by typecheck + build + live):
- **Unit (TDD)** `acting-mode.ts`: `actingModeFor('full') → 'bypassPermissions'`, `'cautious' → 'acceptEdits'`, `'auto' → 'auto'`.
- **Type/build:** `tsc` + `npm run build` clean. (Executor note: full build ~9 min has dropped subagent connections — run typecheck in-agent; controller runs the build at the integration gate.)
- **Live verify:** Settings shows 5 labeled sections; gated features are on/off toggles that reveal a count when on and persist; cost hints visible; AgentConfigPanel has no permission dropdown; a direct per-agent Run/Terminal respects the project Autonomy (e.g. Cautious blocks commands); drawing a handoff edge with handoffs off prompts to enable and, on confirm, flips the toggle on.

---

## 10. Acceptance criteria

1. Settings is organized into Safety / Cost / Review & repair / Run behavior / Team sections; auto-assign-models and adaptive-effort show cost hints.
2. Re-plans / handoffs / user-questions are on/off toggles (off=0, on=1 + a clamped count input); no "0 = off" number-only inputs; values persist.
3. The per-agent permission dropdown is gone; both orchestrated runs and direct per-agent launches derive permission from the project Autonomy (`actingModeFor`); no raw SDK enum strings in the UI.
4. `actingModeFor` is a pure, TDD'd module reused by the orchestrator and the launch paths.
5. Converting an edge to a handoff while handoffs are off offers to enable them and, on confirm, sets `maxHandoffs = 1`.
6. `tsc` + build clean; `acting-mode` unit tests pass; existing tests still pass; live-verified per §9.
7. No out-of-scope changes (vestigial field kept, no other gesture nudges, no engine-behavior changes, no Context work).
