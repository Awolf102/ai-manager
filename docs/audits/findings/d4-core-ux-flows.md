# Dimension 4 — UX/Product (core renderer flows)

> **Status: historical — remediated.** This is an internal audit report from the
> 2026-06 review cycle, kept for the record. Every Critical and Important finding
> below has been fixed and merged; see
> [`docs/audits/2026-06-27-remediation-cycles.md`](../2026-06-27-remediation-cycles.md)
> for the per-cycle remediation log. Do not read the findings below as open issues.


**Scope:** A read-only UX/product review of the core renderer flows that a user (including non-technical
people) touches every session: the project picker, the top bar, the GoalBar action cluster
(Run / Draft roles / Build team / Run result / Stop), the org-chart canvas (placing nodes, drawing report vs
handoff edges, edge ordering), the live Run view (run tree, status pills, narration/ActivityFeed, terminal),
History, the HITL question modal, and the Run-result modal. Findings are framed as input to the planned
Phase-2 "Orkestr" UI overhaul — each says what the rebuild should fix or keep. Files reviewed:
`src/renderer/App.tsx`, `run/GoalBar.tsx`, `run/RunView.tsx`, `run/HistoryView.tsx`, `run/ActivityFeed.tsx`,
`run/RunResultModal.tsx`, `canvas/OrgChart.tsx`, `canvas/AgentNode.tsx`, `terminal/TerminalPane.tsx`,
`store.ts`, plus the modals they open (`HitlModal.tsx`, `ContextModal.tsx`, `RoleDraftModal.tsx`,
`TeamSpawnModal.tsx`, `panels/AgentConfigPanel.tsx`).

---

### [Critical] A live run shows no success / completion state and never displays the final report
**Location** `src/renderer/run/RunView.tsx:102-177` (whole render); `src/renderer/store.ts:210-216`
(`final` and `run-finished` handlers); `src/renderer/run/HistoryView.tsx:90-95` (the only place `final` renders).
**What's wrong** When a run finishes successfully, the only visible change in the Run view is that the
GoalBar Stop button reverts to Run (`run.running` flips at `store.ts:214`). RunView renders the run tree, the
ActivityFeed, and the terminal, but it never renders `run.final` — the orchestrator's plain-English final
report. `final` is captured into state (`store.ts:211`) but is only shown later in HistoryView. There is no
"Run complete", no checkmark, no toast, and no summary; the only terminal-state cue RunView ever shows is the
red error line (`RunView.tsx:170`, which only appears on failure).
**Why it matters** This is the single most important moment of the whole product — "did my team finish, and
what did they do?" A non-technical user is left staring at a tree of green pills with no signal that the work
is done or what the result was, and the headline deliverable (the final report) is hidden behind the History
clock icon. Success is effectively invisible while failure is loud, which inverts the emotional payoff.
**Suggested fix** Render `run.final` in RunView when present (a "Result" panel above or beside the tree), and
add an explicit terminal-state banner ("Run complete" / "Run failed" / "Stopped") driven off
`!run.running && run.runId`. Keep the History copy as the durable archive.

### [Critical] Destructive actions (delete agent, delete edge) have no confirmation and no undo
**Location** `src/renderer/panels/AgentConfigPanel.tsx:24-27,114-116` (Delete agent button);
`src/renderer/canvas/OrgChart.tsx:95-111` (`onEdgesDelete` / `onNodesDelete` via the canvas Delete/Backspace
key); the codebase has zero `window.confirm` calls (verified by grep across `src/renderer`).
**What's wrong** Clicking "Delete agent" immediately calls `window.api.deleteAgent` with no confirmation, and
selecting a node or edge on the canvas and pressing Delete/Backspace permanently removes it the same way.
Deleting an agent also deletes its on-disk `role.md` / `memory.md` (the accumulated lessons), and there is no
undo in the UI.
**Why it matters** A non-technical user dragging on the canvas can lose an agent — and its hand-written role
and accreted memory — with one stray keystroke and no way back. For a tool whose entire value proposition is
"compounding" team memory, silent destructive deletes are a data-loss footgun.
**Suggested fix** Add a confirm dialog for agent deletion ("Delete <name>? This removes its role and memory.")
and at minimum a confirm (or an undo toast) for canvas node/edge deletes; consider soft-delete/restore for
agents given the memory investment.

### [Important] GoalBar "Run" fails silently if `startRun` rejects — inconsistent with every sibling action
**Location** `src/renderer/run/GoalBar.tsx:78-85` (`start`); contrast with `buildTeam` (42-52), `runResult`
(54-64), `draftRoles` (66-76), which all `window.alert(r.error ?? …)` on failure.
**What's wrong** `start()` awaits `window.api.startRun(...)` with no try/catch and no error-result check, then
calls `beginRun`. If the main-process `startRun` throws or rejects (e.g. auth lapsed mid-session, no
orchestrator resolvable, engine error), the promise rejects, `beginRun` never runs, and the user sees
absolutely nothing — the button just doesn't seem to work. Every other GoalBar action surfaces its failure via
an alert; the primary action is the one that doesn't.
**Why it matters** The headline button silently no-op'ing is the worst possible failure for a non-technical
user — they will click repeatedly, conclude the app is broken, and have no message to act on.
**Suggested fix** Wrap `start()` in try/catch and surface failures the same way the sibling actions do (and
make `startRun` return a `{ ok, error }` shape so the success/failure contract matches Draft/Build/Run-result).

### [Important] Errors only ever surface as native `window.alert` or buried in a terminal — no consistent in-app error surface
**Location** `src/renderer/run/GoalBar.tsx:48,60,72`; `src/renderer/App.tsx:89,133,160-162`;
`src/renderer/TeamSpawnModal.tsx:36`; `src/renderer/run/RunView.tsx:170` (the lone inline error);
`src/renderer/terminal/TerminalPane.tsx:81-87` (PTY spawn failure written into the xterm buffer);
`src/renderer/run/RunResultModal.tsx:90-96` (server status/log only inside the modal).
**What's wrong** The app has no unified notification/error system. Failures are communicated three
incompatible ways: blocking native `window.alert` dialogs (Draft/Build/Run-result/import/sync), an inline red
line that exists only inside RunView (`run.error`), and raw text written into a terminal buffer (PTY spawn
failure). A run that fails while the user is looking at a different dock tab (a terminal or History) shows
nothing until they switch back to Run.
**Why it matters** Inconsistent, modal, easy-to-miss error reporting makes the app feel unreliable and makes
real failures (auth dropped, agent errored, parse failed) hard to notice. `window.alert` in Electron is
jarring and blocks the whole window.
**Suggested fix** Build one non-blocking toast/notification center for the rebuild and route every
`window.alert`, the RunView `run.error`, and server/PTY failures through it; keep the durable per-run error in
the run record/History.

### [Important] Run-result detection failures and non-launchable projects under-explain; server crash is muffled
**Location** `src/renderer/run/GoalBar.tsx:54-64` (`runResult` — alert on failure, otherwise opens modal);
`src/renderer/run/RunResultModal.tsx:98-103` (non-launchable branch), `:67,90-92,109-117` (running/stop logic).
**What's wrong** (a) On a non-web/static project the modal just prints "This project doesn't look like a
runnable web app (detected: <type>)" with an "Open project folder" button — fine, but the detected type
(`node`, `cli`, etc.) is jargon to a non-technical user with no guidance on what to do. (b) When a launched
server exits or errors, `running` flips false (`:67`) and the button reverts to "Launch & open", but there is
no prominent failure message — the user must read the `(no output yet)` `<pre>` log (`:94-96`) to learn the
command crashed. The status line (`:90-92`) shows `Status: error` in small text but nothing explains it.
**Why it matters** "Run result" is pitched as the one-click payoff for a non-technical user ("see the thing my
team built"). When detection is wrong or the server crashes, the experience degrades into reading a terminal
log — exactly the audience this feature was meant to spare.
**Suggested fix** In the rebuild, translate the detected type into plain language + a suggested next step, and
when a launched server errors/exits show an explicit, friendly failure callout (with the tail of the log)
rather than silently reverting the button.

### [Important] Two different "Run" buttons mean two unrelated things, with no visual distinction
**Location** `src/renderer/run/GoalBar.tsx:157-159` (GoalBar "Run" = start a full orchestrated team run);
`src/renderer/canvas/AgentNode.tsx:34-43` ("Run" on each node = open a one-off headless terminal for that
single agent).
**What's wrong** The same word + same Play icon is used for two fundamentally different operations: the
GoalBar "Run" kicks off the whole planning→execute→review pipeline against the orchestrator, while the per-node
"Run" just opens a single-agent headless terminal. Nothing in the labels or icons distinguishes them.
**Why it matters** A non-technical user who reads "give the orchestrator a goal, then Run" (the side-panel
hint, App.tsx:262-263) will plausibly click the orchestrator node's "Run" button and get a blank headless
terminal instead of a team run — a confusing dead-end with no goal field in sight.
**Suggested fix** Rename/redesign the per-node actions ("Quick task" / "Open shell") so the canonical "Run a
goal" verb is unique to the GoalBar; consider hiding the per-node headless action behind an advanced/expand
affordance in the overhaul.

### [Important] Opening a terminal during a run yanks the dock away from the live Run view
**Location** `src/renderer/store.ts:121-126` (`openTerminal` sets `activeDockId` to the new tab);
`src/renderer/App.tsx:191-247` (single dock shows exactly one of Run / History / a terminal at a time).
**What's wrong** The dock is single-pane: only the active tab is visible. `openTerminal` always switches focus
to the newly opened terminal. So if a user opens an agent terminal while a run is in progress, the live Run
view (tree + ActivityFeed) is hidden until they manually click back to the "Run" tab.
**Why it matters** During the most information-dense moment (an active run), a routine action silently hides
the status surface the user most needs, with no indication the run is still going (the only persistent run
cue, the GoalBar Stop button, is in a different region).
**Suggested fix** In the overhaul, don't steal dock focus while `run.running` — or make the run status a
persistent strip independent of the dock tab so it's always visible during a run.

### [Important] Canvas edge semantics (report vs handoff, and edge order) are not discoverable
**Location** `src/renderer/canvas/OrgChart.tsx:83-93` (`onConnect` always creates a plain report edge),
`:127-145` (click an edge → "Make handoff/Make reporting" panel), `:175-183` (the "Order" toggle),
`:30-44` (handoff edges rendered dashed, ordered edges get a number label); side-panel hint
`src/renderer/App.tsx:261-263` only explains report edges.
**What's wrong** Three distinct edge concepts live on the canvas with almost no in-context explanation:
(1) drawing an edge always makes a "report" edge — there's no way to draw a handoff directly; you must draw,
then click the edge, then notice a "Make handoff" button appears top-left; (2) the "Order" toggle (top-right)
only does anything on edges leaving an orchestrator, but the button text and tooltip ("Click top-level flow
lines in the order their teams should run") assume the user already knows what an "ordered top-level flow
line" is; (3) the dashed-vs-solid and numeric-label conventions have no on-canvas legend. The only written
guidance (App.tsx:261-263) covers report edges and never mentions handoffs or ordering.
**Why it matters** Two of the marquee workflow-graph features (lateral handoffs, edge ordering) are
effectively hidden — a user cannot find them without already knowing they exist, which defeats the point of a
visual canvas for non-technical users.
**Suggested fix** Add an on-canvas legend and short inline coach-marks; let the user choose edge kind at draw
time (e.g. a connect-line menu); make the "Order" mode self-explanatory with a step indicator and a one-line
"why" the first time it's used.

### [Important] Top-bar team/brain actions are six unlabeled icons distinguished only by tooltip
**Location** `src/renderer/App.tsx:115-178` — History (Clock), Export team (Upload), Import team (Download),
Sync to team (CloudUpload), Refresh from team (CloudDownload), Context (Paperclip), Settings (gear) are all
icon-only `btn`s whose meaning lives entirely in the `title` attribute.
**What's wrong** Seven adjacent icon-only buttons, several of which are conceptually opposable pairs
(Upload/Download for team export/import; CloudUpload/CloudDownload for brain sync/refresh) sit next to each
other with no text labels and visually similar glyphs. Tooltips require a hover the user must first decide to
attempt, and the export/import-vs-sync/refresh distinction is subtle even on hover.
**Why it matters** A non-technical user cannot tell "Export team" from "Sync to team brain" from "Import" from
"Refresh from brain" at a glance, and these are not reversible no-ops — Import replaces the team, Refresh
overwrites agents from the brain (App.tsx:156-164). High-stakes actions hidden behind ambiguous icons is a
recipe for the wrong click.
**Suggested fix** In the overhaul, group these under a labeled "Team" menu/section with text labels (or
icon+label), visually separate the destructive/replacing actions, and reserve the top bar for the few
truly-frequent controls.

### [Minor] No success confirmation after Draft roles / Build team / Sync to team
**Location** `src/renderer/RoleDraftModal.tsx:9-20` (apply → `onClose()`, no toast);
`src/renderer/TeamSpawnModal.tsx:30-40` (apply → `onClose()`, no toast);
`src/renderer/App.tsx:143-152` (Sync to team — updates graph silently); contrast Refresh-from-team
(App.tsx:156-164) which *does* alert "Updated N agent(s)".
**What's wrong** Applying drafted roles, creating a spawned team, and syncing to the team brain all complete by
just closing the modal / mutating the graph with no confirmation message. Refresh-from-team is the lone action
that confirms success, so the feedback pattern is inconsistent even within the same feature family.
**Why it matters** After a multi-second AI operation, silent success leaves the user unsure whether anything
happened, especially since these mutate persistent on-disk state.
**Suggested fix** Standardize a brief success toast for these write actions in the rebuild (and remove the
one-off alert in Refresh in favor of the shared toast).

### [Minor] HITL "Skip" submits a blank answer with no explanation or confirmation
**Location** `src/renderer/HitlModal.tsx:46-49` (`Skip` calls `submit('')`); `store.ts:223-228`
(`answerInterrupt` resumes the run with whatever string is passed).
**What's wrong** The "Skip" button submits an empty answer to resume the asking agent's session, but the modal
never says what Skip does (the agent gets a blank/best-effort answer and proceeds). It's a one-way action with
no confirmation and no hint that the agent will continue without your input.
**Why it matters** A user facing a question they don't understand may hit Skip expecting "ask me later" and
instead let the agent guess — silently affecting the run's outcome.
**Suggested fix** Label/expand Skip ("Skip — let the agent decide") and add a one-line description of the
consequence; keep the existing minimize affordance, which is good.

### [Minor] Disabled GoalBar buttons give no reason; the "Run" disable in particular is unexplained
**Location** `src/renderer/run/GoalBar.tsx:36-40` (`canRun`/`canDraft`/`canBuild`/`canRunResult`),
`:119-160` (buttons use `disabled={!canX}` with no explanatory tooltip on the disabled state, except Stop's
pending-interrupt case at :148-152).
**What's wrong** Run is disabled until there's a target orchestrator AND non-empty goal; Draft roles
additionally requires at least one non-orchestrator agent (`hasSpecialists`). When disabled, the buttons give
no reason. The "target" hint span (`:90-96,116-118`) explains the orchestrator side but not the goal-empty or
no-specialists conditions, and Draft silently greys out with no clue that you need to add agents first.
**Why it matters** A non-technical user staring at a greyed-out "Draft roles" or "Run" with a typed goal has
no idea what they're missing.
**Suggested fix** Add `title` text (or an inline hint) on each disabled button stating the unmet precondition
("Add at least one specialist agent to draft roles", "Type a goal to run").

### [Minor] ActivityFeed / Run-output empty and loading states are thin; narration is the only "what's happening"
**Location** `src/renderer/run/ActivityFeed.tsx:60-61` ("No activity yet."), `:38-41` (rows capped at 200,
older rows dropped); `src/renderer/run/RunView.tsx:105` ("No run yet — enter a goal and Run.").
**What's wrong** At the start of a run (before any narration-bearing tool call), the ActivityFeed shows "No
activity yet." while the orchestrator is already planning — there's no "Planning your team's work…" bridge.
The feed also silently discards rows beyond 200 (`:38-41`), so on a long run the early history just vanishes
with no "earlier activity hidden" marker. The narration feed is the primary legibility surface for a
non-technical user, so its gaps matter.
**Why it matters** The very moments a nervous first-time user watches most closely (run just started; long run
scrolled past 200 events) are the ones with the weakest signal.
**Suggested fix** Seed the feed from the run-tree status (e.g. an initial "Planning…" line tied to the
orchestrator's `planning` status) and add an unobtrusive "earlier activity hidden" affordance when rows are
trimmed.

### [Minor] Run-tree status glyphs mix words, emoji, and symbols with no legend
**Location** `src/renderer/run/RunView.tsx:151` (text pills `idle/planning/working/done/error`), `:157-166`
(✓/✗ verdict, `🧠+N` memory), `:117-131` (⚡ re-plan, ↪ handoff, ❓ asked-you lines), `:152-156` (effort badge
like `xhigh` with a "capped from" tooltip).
**What's wrong** A single run row can show a status word, a colored effort code, a ✓/✗ verdict, and a `🧠+2`
memory badge, while special events appear as ⚡/↪/❓ lines above — a dense mix of conventions with no legend
anywhere in the UI. The effort code (`xhigh`, `none`) and the brain emoji are insider shorthand.
**Why it matters** The run tree is the at-a-glance "what is my team doing" view, but a non-technical user has
no way to decode `🧠+2` or `xhigh` or why a row turned ✗ vs ⚡.
**Suggested fix** Add a small legend/key (or hover-explanations) and prefer words over emoji for the rebuild's
status surface; the effort badge already has a good "capped from" tooltip — extend that tooltip-explains-itself
pattern to the rest.

---

## Keep-list — flows that work well and should be preserved

- **Auth visibility is genuinely good.** The persistent `AuthPill` (App.tsx:277-306) plus the full-width
  `AuthBanner` with actionable copy and a Re-check button (App.tsx:308-323) is exactly the right pattern:
  a glanceable status that escalates to an explanatory banner with a next step. Keep this model and reuse it.
- **The empty-state side-panel hint teaches the core interaction.** App.tsx:257-263 tells a new user how to
  draw a delegation edge and that the orchestrator takes the goal — good just-in-time onboarding. Expand it to
  cover handoffs/ordering (see the canvas finding) rather than dropping it.
- **GoalBar Stop is disabled with an explanatory tooltip while a HITL question is pending.** GoalBar.tsx:146-153
  is a thoughtful guard ("waiting on your answer — Submit or Skip…") — this is the right way to communicate a
  disabled-button reason and should be the template for the other disabled-state findings above.
- **The HITL flow is well-considered.** HitlModal.tsx — autofocus, a minimize-to-badge affordance
  (`:13-19,44-46`), a clear secrets warning (`:39-41`), and Submit disabled until non-empty (`:50`) — is a
  strong interruption pattern. Keep it (just clarify Skip).
- **The Project picker with recents is a clean, low-friction entry point.** App.tsx:325-367 — big primary
  "Open project folder…" plus a recents list — is the right first screen for a non-technical user.
- **Click-a-narration-line / click-a-run-row to focus that agent's terminal output** (ActivityFeed.tsx:64-72,
  RunView.tsx:142-149 → `selectStep`, RunView.tsx:88-95 repaint) is a genuinely nice, discoverable drill-down
  from plain-English summary to raw detail. Preserve this linkage.
- **History is thorough.** HistoryView.tsx renders plan + verdicts, re-plans, handoffs, user requests, per-agent
  output, and memory reflections — a complete post-hoc record. Keep it as the durable archive (and surface its
  `final` report live too, per the Critical finding).

## Verification

Adversarial re-check of each finding against the cited source (read-only). Verdicts:

- **d4-core-ux-flows-1 — adjusted (Important, was Critical).** Confirmed real: `RunView.tsx` (read in full, 1-178) never references `run.final`; on `run-finished` the store sets only `running=false` + `error` (store.ts:213-216), and `run.final` is captured (store.ts:210-212) but rendered only in `HistoryView.tsx:90-95`. The live view shows the headline error loudly (RunView.tsx:170) but no run-level completion banner and hides the deliverable. Severity lowered to Important: no data loss or wrong behavior — per-node `done` status DOES render (RunView.tsx:151 via STATUS_LABEL line 28) and the final report is preserved and viewable in History. It is a visibility gap, not a Critical (data-loss/corruption/silent-wrong-behavior) bug.
- **d4-core-ux-flows-2 — confirmed (Critical).** `AgentConfigPanel.tsx:24-27` `remove()` and `OrgChart.tsx:103-111` `onNodesDelete` / `95-101` `onEdgesDelete` all call `deleteAgent`/`setEdges` immediately. `deleteAgent` (project-store.ts:236-245) does `fs.rm(agent folder, {recursive:true, force:true})` (line 243) — irreversibly deletes the agent's role.md/memory.md from disk. `grep` for `window.confirm`/`confirm(` across `src/renderer/` returns zero hits. One click/Delete-key = irreversible loss of authored role/memory files. Critical confirmed.
- **d4-core-ux-flows-3 — confirmed (Important).** `GoalBar.tsx:78-85` `start()` awaits `window.api.startRun` with no try/catch and no `r.ok` check; a rejection skips `beginRun` and shows nothing. Sibling actions all alert on failure: buildTeam (48), runResult (60), draftRoles (72). Asymmetry confirmed.
- **d4-core-ux-flows-4 — confirmed (Important).** Three error channels verified: `window.alert` (GoalBar.tsx:48,60,72; App.tsx:89,133,160,162), inline `run-error` div (RunView.tsx:170), terminal text (TerminalPane.tsx:81-87). `run.error` renders only inside `RunView` (170); the dock is single-pane (App.tsx:229-245 `term-slot` toggled by `activeDockId`), so a run that fails while a terminal tab is active shows no error. Confirmed.
- **d4-core-ux-flows-5 — adjusted (Minor, was Important).** Partially overstated. Non-launchable branch (RunResultModal.tsx:98-103) is NOT a dead-end: it shows `manifest.notes` and a prominent "Open project folder" primary button (119-121) — a clear next step, contradicting "no next step." Server-crash signal: `running` flips off when status is `exited`/`error` (line 67) reverting the button to "Launch & open" (114), but the `rr-status` line DOES surface `Status: error`/`exited` (91) in addition to the `<pre>` log (94). Real but mild (status is shown, just not emphasized) and the "no next step" half is wrong → Minor.
- **d4-core-ux-flows-6 — confirmed (Important).** `GoalBar.tsx:157-159` primary "Run" with `<Play>` icon = full orchestrated run; `AgentNode.tsx:34-43` node "Run" with `<Play size={13}>` opens a headless terminal (`openTerminal(agent,'headless')`). Identical label+icon, different behavior; only distinguished by tooltip. The App.tsx:261-263 hint steers users toward "Run," inviting the wrong click. Confirmed.
- **d4-core-ux-flows-7 — confirmed (Important).** `store.ts:121-126` `openTerminal` unconditionally returns `activeDockId: id`. The dock renders one active `term-slot` at a time (App.tsx:230-245). Opening an agent terminal mid-run switches `activeDockId` away from `'run'`, hiding the live RunView/ActivityFeed with no notice the run continues. Confirmed.
- **d4-core-ux-flows-8 — confirmed (Important).** `OrgChart.tsx:83-93` `onConnect` always creates a plain (report) edge — no `kind`. Handoff conversion is a `Panel` button shown only after an edge is clicked (138-145, 168-173); Order mode is a top-right toggle gated to orchestrator-source edges (119-136, 130 `orchIds.has`). No on-canvas legend; the empty-state hint (App.tsx:261-263) mentions only delegation. Two marquee features are non-discoverable. Confirmed.
- **d4-core-ux-flows-9 — confirmed (Important).** App.tsx:115-178: History (Clock), Export (Upload), Import (Download), Sync-to-team (CloudUpload), Refresh-from-team (CloudDownload), Context (Paperclip), Settings — all icon-only with `title` tooltips. Export/Import and Sync/Refresh are opposable up/down-arrow pairs, visually near-identical; refreshFromTeam overwrites agents (156-164). Confirmed.
- **d4-core-ux-flows-10 — confirmed (Minor).** RoleDraftModal apply just `onClose()` (9-20); TeamSpawnModal apply `setGraph`+`onClose` (30-40); syncToTeam silently `setGraph` (App.tsx:143-152); refreshFromTeam is the sole action that `window.alert`s success (App.tsx:159-160). Inconsistent feedback for persistent writes. Confirmed.
- **d4-core-ux-flows-11 — confirmed (Minor).** HitlModal.tsx:47-49 Skip → `submit('')` → `answerInterrupt('')` → `resumeRun(runId,'')` (store.ts:223-228). No copy explaining the agent then proceeds without input; only the "don't paste secrets" note exists (HitlModal.tsx:39-41). Confirmed.
- **d4-core-ux-flows-12 — confirmed (Minor).** Disabled states computed at GoalBar.tsx:36-40; Draft/Build/Run-result `title`s (123,131,139) describe the action, not the unmet precondition, and the primary Run button (157-159) has no `title` at all. No tooltip explains why a button is greyed. Confirmed.
- **d4-core-ux-flows-13 — confirmed (Minor).** ActivityFeed.tsx:60-61 "No activity yet." shows even while the orchestrator plans; 38-40 slices to `MAX_ROWS=200` (line 12) with no "earlier activity hidden" marker. RunView.tsx:105 has only the no-run empty state. Confirmed.
- **d4-core-ux-flows-14 — confirmed (Minor).** RunView.tsx:117-166 mixes a status word (151), effort code e.g. `xhigh` (153), ✓/✗ verdict (159), `🧠+N` (164), and `⚡`/`↪`/`❓` event lines (119,124,129) with no legend/key anywhere. Confirmed.

**Summary:** 11 confirmed as-tagged, 2 adjusted (d4-1 Critical→Important; d4-5 Important→Minor), 0 refuted.

