# Orkestr — Sub-project 2: Run Experience

**Date:** 2026-06-30
**Parent:** `docs/superpowers/specs/2026-06-29-orkestr-overhaul-direction-design.md` (umbrella direction + decomposition)
**Builds on:** Foundation (tokens, primitives, Toast/notify) merge `378479f`; Shell+IA (panel system, dock, dock-toggle) merge `e8594cf` + polish `2850259`.
**Status:** Design approved (brainstorm). Ready for implementation planning.

The third sub-project of the Orkestr overhaul. It reworks the live Run view so a run's progress, output, and result are clear and a finishing run is never silent — fixing the audit's invisible-success / silent-error complaints. Visual execution uses Foundation tokens + live iteration.

---

## 1. Goal

Make a run legible end-to-end:
1. **Narration ↔ Terminal as toggle tabs at full height** — replace today's stacked split inside the Run view.
2. **Run-complete state + final report** — a success/failure banner and a Result tab that renders `run.final` live (today only History shows it).
3. **Error surfacing via the Toast** — route GoalBar's run-action failures + the silent run-start failure to toasts, and notify on run-end when the user isn't watching.

Success = while a run is live you can flip between the plain-English narration and the raw terminal at full height; when it ends you see a clear ✓/✗ banner and can read the final report in-place; and no run action or run completion fails silently.

---

## 2. Current state (what we're changing)

`src/renderer/run/RunView.tsx` renders two columns:
- `.run-tree` (left) — the agent chain (status pills, verdicts, replans, handoffs, asks). Clicking a row sets `run.selectedStepId`, which repaints the embedded xterm to that agent's buffered stream. `run.error` shows as one line here.
- `.run-right` (right) — `<ActivityFeed runId={run.runId} />` (plain-English narration) **stacked above** `.run-output` (the xterm). This stacking is what becomes toggle tabs.

`run.final` is in the store (set on the `final` event) but **never rendered in RunView**; History renders it as `<pre>{record.final}</pre>` (no markdown lib — plain text, pre-wrap).

`GoalBar.tsx` has 3 run-related `window.alert`s — Build team (`buildTeam`), Launch app (`runResult`), Draft roles (`draftRoles`) — and `start()` (run-start) has **no error handling** (silent fail).

The dock (App.tsx) already has top-level tabs (Run / History / per-agent terminals); the new tabs in this spec are the **within-Run** sub-tabs and only appear inside the Run slot.

---

## 3. Right-pane toggle tabs

- Replace the stacked `.run-right` with a **tab strip** (Narration | Terminal | Result) + a content area; the **agent-chain tree stays as the left column** unchanged.
- **Slots stay mounted; visibility toggles.** Mirror the dock's `term-slot` pattern: each tab's pane is `position: absolute; inset: 0; visibility: hidden`, and the active one is `visible`. This keeps the xterm mounted and measurable across tab switches (unmount/remount would lose the terminal and its buffer-repaint state).
- **Local state** `rightTab: 'narration' | 'terminal' | 'result'` in RunView. Default **`narration`** (the plain-English view is the friendly default).
- **Tabs present:** Narration and Terminal always; **Result only when `run.final` is non-empty**.
- The xterm lifecycle (the `useEffect`s that create the terminal, subscribe to `onAgentStream`, clear on new run, and repaint on `selectedStepId`) is unchanged — only its container becomes the Terminal slot.

---

## 4. Run-complete banner

- A banner across the top of `.runview` (spanning tree + right pane), driven by a pure helper:
  - `runBanner(run): null | { kind: 'success' | 'failure'; text: string }`
  - Returns `null` while there is no finished run (no `runId`, or `running === true`).
  - When `running === false` and `runId` is set: `run.error` → `{ kind: 'failure', text: \`Run failed: ${run.error}\` }`; otherwise `{ kind: 'success', text: 'Run complete' }`.
- Rendered as `.run-banner.success` (green, `--state-good`) / `.run-banner.failure` (red, `--state-danger`) using Foundation tokens. The existing `run.error` line in the tree may be removed in favor of the banner (avoid double-surfacing) — decided in the plan.

---

## 5. Result tab

- Appears only when `run.final` is non-empty.
- Renders the final report the same way History does: `<pre>{run.final}</pre>` inside a scrollable pane (`.run-result`), styled with tokens (readable line length, padding). No markdown dependency.
- **Auto-select on success:** when a run finishes successfully and `run.final` arrives, set `rightTab = 'result'` (a one-shot effect keyed on run completion, so the user lands on the report; they can flip back to Narration/Terminal freely). On failure, do not auto-switch (leave them on the current tab; the banner shows the failure).

---

## 6. Error & completion toasts

### 6.1 GoalBar (pre-run / run-start)
- Add a `notify` selector. Replace the 3 `window.alert`s with `notify({ kind: 'error', message: … })` (same messages): `buildTeam`, `runResult` (Launch app), `draftRoles`.
- Wrap `start()`'s body in try/catch; on error `notify({ kind: 'error', message: 'Could not start the run.' })` (or the thrown message) — fixing the silent run-start failure (#28).

### 6.2 Run-end toast-when-away
- A pure helper `shouldToastRunEnd(view: { activeDockId: string | null; dockOpen: boolean }): boolean` — returns `true` when the user is **not** viewing the live Run tab: `view.activeDockId !== 'run' || !view.dockOpen`.
- Wire it into the store's `applyOrchestration` `run-finished` case: after updating `run`, if `shouldToastRunEnd({ activeDockId, dockOpen })`, append a toast via the existing `addToast` — `{ kind: 'success', message: 'Run complete' }` or `{ kind: 'error', message: \`Run failed: ${error}\` }` (kind/message from the same logic as `runBanner`). When the Run tab is active, stay silent (the banner covers it).
- This directly fixes the audit's "a run that fails while on another dock tab shows nothing" without success-toast noise while watching.

---

## 7. Architecture / units

- **New pure module** `src/renderer/run/run-status.ts` — `runBanner(run)` and `shouldToastRunEnd(view)`. No React/DOM. The run-end toast kind/message derive from one shared internal function so banner and toast never diverge.
- **`RunView.tsx`** — adds the banner (from `runBanner`), the right-pane tab strip + slots, the Result pane, and the auto-select-Result effect. Keep the file focused; the xterm logic stays as-is.
- **`store.ts`** — only the `run-finished` case gains the toast-when-away branch (consuming `shouldToastRunEnd` + `addToast`). No other action changes.
- **`GoalBar.tsx`** — notify selector + the 4 error routes (3 alerts + start try/catch).
- **`styles.css`** — `.run-banner`, the right-pane tab strip + slot rules, `.run-result`.

---

## 8. Audit UX criteria owned here

From the umbrella spec §5 (audit `docs/audits/2026-06-27-tool-audit.md`):
- **#28** one non-blocking error surface — run wiring: GoalBar run-action + run-start failures → toasts; run-end toast-when-away. (Foundation shipped the Toast primitive; this is the run-side wiring.)
- **#29** "Run complete" success state + render `run.final` live — the banner + Result tab.

---

## 9. Out of scope

- Canvas, Settings, Context — their own cycles.
- The **quick-reuse past-prompts picker** (sub-project 4's remaining item; focus-to-expand already shipped).
- The dock's top-level tabs / panel system (Shell+IA, shipped).
- Streaming markdown rendering of `run.final` (match History's plain `<pre>`; richer rendering is a later polish).
- Per-agent terminal *dock tabs* (opened from canvas nodes) — unchanged; this spec only reworks the Run slot's internal panes.

---

## 10. Testing

Per the project pattern (pure logic TDD'd; UI/wiring by typecheck + build + live render):
- **Unit (TDD)** `run-status.ts`: `runBanner` (no run → null; running → null; finished+error → failure with message; finished+no-error → success) and `shouldToastRunEnd` (active 'run' + dockOpen → false; other tab → true; dock closed → true).
- **Type/build:** `tsc` + `npm run build` clean. (Executor note: the full `electron-vite build` takes ~9 min and has dropped subagent connections — run typecheck in-agent; the controller runs the build at the integration gate.)
- **Live verify:** start a run → flip Narration/Terminal tabs at full height; select agents in the tree and confirm the Terminal repaints; on completion see the ✓ banner and the Result tab auto-selected rendering the report; force a failure and see the ✗ banner; trigger a GoalBar action error and a run-finish while on the canvas/History tab and confirm toasts appear (and that no success toast appears while watching the Run tab).

---

## 11. Acceptance criteria

1. Inside the Run view, Narration and Terminal are full-height toggle tabs (tree stays left); switching tabs never loses the terminal's contents.
2. A finished run shows a banner: green "✓ Run complete" or red "✗ Run failed: <error>"; nothing while idle/running.
3. A Result tab appears when `run.final` exists, renders it as a `<pre>` report, and is auto-selected on a successful finish.
4. GoalBar's Build team / Launch app / Draft roles failures and a failed run-start surface as error toasts (no `window.alert`, no silent fail).
5. When a run ends while the user is not viewing the Run tab, a success/failure toast appears; when they are viewing it, no completion toast (banner only).
6. `tsc` + build clean; `run-status.ts` unit tests pass; existing tests still pass; live-verified per §10.
7. No out-of-scope changes (no canvas/settings/context, no past-prompts picker, dock/panel system untouched).
