# Dimension 4 — UX/Product Audit: Settings & Modals

> **Status: historical — remediated.** This is an internal audit report from the
> 2026-06 review cycle, kept for the record. Every Critical and Important finding
> below has been fixed and merged; see
> [`docs/audits/2026-06-27-remediation-cycles.md`](../2026-06-27-remediation-cycles.md)
> for the per-cycle remediation log. Do not read the findings below as open issues.

<!-- VERIFICATION-ANCHOR -->


**Scope.** This is a read-only UX/product review of the Settings modal and every modal/panel
(`SettingsModal.tsx`, `panels/AgentConfigPanel.tsx`, `panels/RoleMemoryEditor.tsx`, `ContextModal.tsx`,
`HitlModal.tsx`, `RoleDraftModal.tsx`, `TeamSpawnModal.tsx`), cross-checked against the settings field set
in `src/shared/types.ts` and the engine that consumes them (`nodes.ts`, `agent-runner.ts`, `project-store.ts`).
It is framed for the Phase-2 ("Orkestr") rebuild with a target audience that includes non-technical users who
will not understand orchestration jargon. Findings are tagged by user impact: **Critical** (data loss / a
silently-wrong or dangerous default a non-technical user cannot foresee), **Important** (real comprehension gap
or foot-gun that bites in realistic use), **Minor** (polish/nit). Each finding ends with advice for a later
cycle — none of it is implemented here. The two strongest threads: (1) the most dangerous and most jargon-heavy
controls have the least guard-rail, and (2) several controls are duplicative or dead, which will confuse a
first-time user about what actually governs a run.

---

### [Critical] "Delete agent" permanently destroys hand-written role.md / memory.md with no confirmation

**Location** `src/renderer/panels/AgentConfigPanel.tsx:24-27` and `:114-116`; the on-disk effect is
`src/main/engine/project-store.ts:236-243` (`deleteAgent` → `fs.rm(aimPath(path, AGENTS_DIR, node.slug), { recursive: true, force: true })`).

**What's wrong.** The "Delete agent" button calls `remove()` immediately on click. There is no
`window.confirm`, no undo, no "are you sure". The handler then deletes the agent's entire on-disk directory
recursively, which includes the user-authored `role.md` and `memory.md` (the latter is the accumulated
learning the whole "team brain" feature exists to grow). A grep confirms there is no confirmation dialog
anywhere in the renderer.

**Why it matters.** A non-technical user clicking the red trash button — easy to do by accident, the only
button at the bottom of the panel — instantly and irreversibly loses an agent's role definition and all of its
accumulated memory/lessons. This is silent, unrecoverable data loss of the exact content the product spends
other features (reflection, brain sync) trying to preserve.

**Suggested fix.** Add a confirmation step that names what will be lost ("Delete <name>? This permanently
removes its role and memory.") and, ideally, soft-delete (move the agent dir to a trash/archive folder) so it
is recoverable.

---

### [Critical] "Full auto" autonomy is a full-filesystem, no-permission mode presented as a peer option with no danger styling

**Location** `src/renderer/SettingsModal.tsx:197-214` (the `<select>` + the one-line note
`'Nothing is gated during a run — keep the project under git.'`); engine mapping at
`src/main/engine/nodes.ts:62-66` (`autonomy === 'full'` → `bypassPermissions`).

**What's wrong.** "Full auto — bypass all permission checks" sits as a plain third `<option>` alongside the
safer modes, with identical visual weight. Its only warning is a single muted line that appears *after* you
select it: "Nothing is gated during a run — keep the project under git." Critically, the copy never tells the
user the truth the architecture notes call out: this is **not sandboxed to the project** — `bypassPermissions`
lets the agents run any command anywhere on the machine (delete files outside the repo, hit the network, etc.).
"keep the project under git" actively under-states the blast radius by implying the only risk is to tracked
files in the repo.

**Why it matters.** A non-technical user choosing "Full auto" to "make it just work" is handing a team of LLMs
unsupervised shell access to their whole machine, while the UI frames the worst case as a git-revertable repo
change. This is the single highest-consequence setting in the app and it has the weakest guard-rail.

**Suggested fix.** Re-label to plainly state the scope ("runs any command on your computer without asking — not
limited to this project") with a warning treatment (color/icon), and gate the first selection behind an
explicit acknowledgement; consider not offering "Full" at all to first-run / non-technical profiles.

---

### [Important] The per-agent "Permission mode" dropdown is a fifth competing permission control that is overridden during every orchestrated run

**Location** `src/renderer/panels/AgentConfigPanel.tsx:64-76` (the per-agent `permissionMode` select, options
from `PERMISSION_MODES` in `src/shared/types.ts:430-436`); during a run every node passes the *global*
`state.actingMode` instead (`src/main/engine/nodes.ts:251`, `:294`, `:526`, `:855` all set
`permissionMode: state.actingMode`, and `agent-runner.ts:111` is `opts.permissionMode ?? agent.permissionMode`,
so the per-agent value is always shadowed during a run). `actingMode` comes from the global `autonomy` setting
(`nodes.ts:62`). The per-agent value only takes effect for manual headless/PTY runs (`pty-manager.ts:34`).

**What's wrong.** The app exposes two unrelated permission controls — global "Autonomy" (Settings) and per-agent
"Permission mode" (Agent panel) — with overlapping but different vocabularies (`auto`/`full`/`cautious` vs.
`default`/`acceptEdits`/`bypassPermissions`/`plan`/`auto`). For an orchestrated run (the product's main flow)
the per-agent dropdown does nothing: the global autonomy wins. Nothing in the UI says so.

**Why it matters.** A user who sets a worker to "bypassPermissions" (or, trying to be safe, to "plan") in the
Agent panel will reasonably believe that governs the run — it does not. Conversely, raw SDK enum values
(`acceptEdits`, `bypassPermissions`, `plan`) are pure jargon to a non-technical user and have zero help text.
This is both a comprehension gap and a silent no-op.

**Suggested fix.** In the rebuild, collapse to one permission concept. Either drop the per-agent dropdown for
orchestrated runs (or label it clearly "only applies when you run this agent manually"), and never show raw SDK
enum strings to users — map them to the same plain-language autonomy words used in Settings.

---

### [Important] maxReplans / maxHandoffs / maxUserRequests default to 0, silently disabling the very features they describe

**Location** `src/shared/types.ts:113-127` (`DEFAULT_SETTINGS`: `maxReplans: 0`, `maxHandoffs: 0`,
`maxUserRequests: 0`); UI at `src/renderer/SettingsModal.tsx:95-144`.

**What's wrong.** Three flagship behaviors — mid-run re-planning, peer handoffs, and human-in-the-loop questions
— are off by default (the "off = byte-for-byte" design choice). The Settings copy explains *what each does when
on* ("When on, a worker that is blocked may pause the run to ask you one question…") but the field defaults to 0
= off, and the "(0 = off)" label is the only hint of the current state. A user who draws a handoff edge on the
canvas (HITL #3) or who expects to be asked questions will get neither, with no indication that a hidden global
toggle is suppressing it.

**Why it matters.** The HITL case is the sharpest: a non-technical user runs a long autonomous job specifically
hoping the agents will *ask* when stuck — but `maxUserRequests=0` means the agents silently guess instead, and
nothing tells the user the safety valve was off. Handoff edges drawn on the canvas are similarly inert until an
unrelated number in Settings is raised. The feature is discoverable on the canvas but its enabling switch is
buried elsewhere and defaults off.

**Suggested fix.** When a user performs the gesture that needs a feature (draws a handoff edge; or starts a run
after expressing they want check-ins), surface an inline prompt to enable it, or flip sensible defaults for
non-expert profiles (e.g. `maxUserRequests` ≥ 1). At minimum show the on/off state as a real toggle, not an
easily-missed "0".

---

### [Important] autoAssignModels and adaptiveEffort change cost/behavior but never mention cost, and their defaults disagree

**Location** `src/renderer/SettingsModal.tsx:73-93`; defaults in `src/shared/types.ts:117-119`
(`adaptiveEffort: true`, `autoAssignModels: false`).

**What's wrong.** "Auto-assign worker models — orchestrator picks Sonnet/Opus per worker" and "Adaptive effort
— managers assign reasoning effort by task difficulty" both directly drive token spend (Opus vs Sonnet;
high/max effort vs low). Neither help string mentions money or speed at all. They also ship inconsistently:
adaptive effort is **on** by default while auto-assign models is **off**, with no explanation of why one
auto-escalates cost and the other doesn't.

**Why it matters.** A non-technical user cannot tell that flipping "Auto-assign worker models" on may multiply
their API bill (Opus workers), or that "Adaptive effort" (on by default) is already letting managers spend
max-effort tokens. Cost is the thing this audience is least equipped to reason about and the copy is silent on
it.

**Suggested fix.** Add a one-line cost/speed implication to each ("may use the pricier Opus model for hard
tasks → higher cost, better quality"), and reconcile the defaults with a stated rationale; consider a single
"quality vs. cost" slider in the rebuild that drives both.

---

### [Important] HITL "Skip" looks like a normal button but silently sends an empty answer to a blocked agent

**Location** `src/renderer/HitlModal.tsx:47-49` (`<button className="btn" onClick={() => submit('')}>Skip</button>`)
and `:21-24` (`submit` → `answerInterrupt(answer)`).

**What's wrong.** The modal pops up because a worker is *blocked* and needs information. "Skip" is rendered with
the same neutral styling as "Minimize" and submits `''` — i.e. it resumes the worker with an empty answer
("best-effort"). The user is given no explanation of what skipping does; a reasonable reading is "skip this
question" (dismiss), not "force the stuck agent to proceed on a guess."

**Why it matters.** A non-technical user will treat Skip as a harmless dismiss and unknowingly tell a blocked
agent to barrel ahead without the answer it said it needed, degrading the result with no signal that they made
that choice.

**Suggested fix.** Relabel ("Proceed without answering") and/or add a one-line consequence note; visually
de-emphasize it relative to Submit so it does not read as the easy default.

---

### [Important] The HITL "sensitive answer is not stored" guarantee is never communicated to the user

**Location** `src/renderer/HitlModal.tsx:39-42` (the only note is "Your answer is sent to the agent and may
appear in its output — don't paste secrets."). The actual scrubbing behavior (answer recorded as question-only,
never persisted) lives in the engine per the project notes, but `userRequests` in `types.ts:295`/`:408-409`
explicitly stores *questions only, never answers*.

**What's wrong.** The product makes a real privacy guarantee — the answer is scrubbed from every checkpoint and
History — but the modal only warns *against* pasting secrets; it never tells the user the reassuring half
(your answer is not saved to disk/History). The framing is all stick, no carrot, and slightly contradictory: it
warns the answer "may appear in its output" without clarifying it is deliberately *not* persisted in the run
record.

**Why it matters.** A cautious user may refuse to answer useful questions because the UI only signals danger,
while a careless user gets the same vague warning. Communicating the actual handling ("we don't store your
answer; but the agent may echo it in its work") would let users make the right call.

**Suggested fix.** State the actual guarantee in the modal ("Your answer is not saved to this run's history —
but the agent may include it in files/output, so still avoid secrets.").

---

### [Important] HITL modal is fully blocking with no way to abort the run from within it

**Location** `src/renderer/HitlModal.tsx:26-55` (backdrop has no `onClick` close; only Minimize/Skip/Submit);
the Stop button is simultaneously disabled while an interrupt is pending (`src/renderer/run/GoalBar.tsx:147-152`,
`disabled={!!pendingInterrupt}`).

**What's wrong.** When a question is pending the user has exactly three exits — answer, skip (empty answer), or
minimize — and the run's Stop button is disabled until they do one of those. There is no "cancel the whole run"
from the paused state; the modal backdrop also does not dismiss (correctly, to avoid accidental loss, but it
leaves no escape hatch either).

**Why it matters.** A user who realizes mid-question that the run is going wrong cannot stop it without first
either answering or skipping (which resumes the agent they wanted to stop). For a non-technical user this is a
"how do I get out of this?" dead-end.

**Suggested fix.** Allow Stop/Cancel-run while paused (Skip-then-stop is a workaround, not a feature), or add a
"Stop run" action inside the HITL modal.

---

### [Important] Team-spawn and Role-draft modals create/overwrite real on-disk content but read as harmless previews

**Location** `src/renderer/TeamSpawnModal.tsx:30-40` and `:74-82` ("Apply — create team" → `applySpawnedTeam`,
which creates agents + role files + edges per `project-store.ts:783`); `src/renderer/RoleDraftModal.tsx:9-20`
("Apply roles" → `writeRole(d.agentId, d.role)` for every draft, **overwriting** each agent's existing role.md).

**What's wrong.** Both modals present an editable preview and a single "Apply" button. Role-draft's Apply
silently overwrites the existing `role.md` of every listed agent with the LLM draft — there is no indication
that hand-written roles will be replaced, and no per-agent opt-out. Team-spawn's Apply creates a whole hierarchy
of agents; the only failure feedback is a `window.alert` on throw (`TeamSpawnModal.tsx:36`). Neither says the
action is (or isn't) reversible.

**Why it matters.** A user who tweaked an agent's role by hand and then clicks "Draft roles → Apply" loses that
work to an AI rewrite with no warning and no undo (compounds the no-confirm-delete data-loss theme). For
team-spawn, a non-technical user can't tell whether "Apply — create team" is a try-it-and-undo action or a
commitment.

**Suggested fix.** Warn before overwriting an existing role ("This replaces <name>'s current role"), offer
per-agent apply/skip checkboxes, and label reversibility; for team-spawn, state that it adds N agents and how to
remove them.

---

### [Important] Settings is one long flat scroll with no grouping, search, or indication of which knobs are advanced/dangerous

**Location** `src/renderer/SettingsModal.tsx:20-224` (eleven `div.field` blocks rendered in a flat column, no
sections, no headings beyond `<h2>Settings</h2>`).

**What's wrong.** Everything from the everyday "Update agent memory after runs" to the machine-endangering
"Full auto" to the deep-jargon "Trusted-skill install threshold" lives in one undifferentiated vertical list,
in roughly implementation order rather than user-importance order. The single most dangerous control
(Autonomy) is dead last (`:197`), after niche ones like skills-pack folder.

**Why it matters.** A non-technical user has no map: no "Basic vs. Advanced", no grouping by concern
(safety / cost / team / skills), no way to find a setting. The most consequential safety control is the hardest
to notice because it's buried at the bottom.

**Suggested fix.** Group into labeled sections (Safety & permissions / Cost & quality / Review & repair /
Team & skills), float the safety/cost controls to the top, and tuck the threshold-style expert knobs under an
"Advanced" disclosure.

---

### [Minor] "Trusted-skill install threshold" is pure jargon with a magic default and a unit-less number field

**Location** `src/renderer/SettingsModal.tsx:157-171`; default `skillInstallThreshold: 100000`
(`src/shared/types.ts:121`).

**What's wrong.** The label and help ("Non-Anthropic plugins are offered to agents only at/above this many
installs") assume the user knows what plugins, skills, marketplaces, and install counts are. The numeric input
shows `100000` with `step={1000}` and no thousands separator or "installs" suffix, so it reads as an opaque
big number.

**Why it matters.** A non-technical user cannot form an intent for this field — it's a security/trust knob
phrased entirely in ecosystem jargon, with a default no one will understand the meaning of.

**Suggested fix.** Replace the raw number with a plain trust toggle ("Only let agents use skills from Anthropic"
vs. "…and popular community plugins"), and hide the numeric threshold under Advanced.

---

### [Minor] "Run result" detection ignores the goal text but still requires it indirectly, and uses bare alert() for all errors

**Location** `src/renderer/run/GoalBar.tsx:54-64` (`runResult` passes `goal.trim()` which may be empty and only
shows `window.alert` on failure); `canRunResult = !!target && !running && !detecting` (`:40`) does not require a
goal, yet detection is goal-driven.

**What's wrong.** Across GoalBar the only failure feedback for Draft/Build/Run-result is `window.alert` with a
generic string (`:48`, `:60`, `:72`). Native alerts are jarring, un-styled, and modal; they give a
non-technical user no next step.

**Why it matters.** When the orchestrator fails to draft/build/detect (a common early-use case), the user gets
a stark OS alert box with terse text and no guidance, which reads as a crash rather than a recoverable hiccup.

**Suggested fix.** Replace `window.alert` with inline, styled error states that suggest a remedy ("Add at least
one specialist first", "Try a more specific goal").

---

### [Minor] RoleMemoryEditor and ContextModal save silently with weak/no feedback and no dirty-state guard

**Location** `src/renderer/panels/RoleMemoryEditor.tsx:26-31` (save shows a 1.5s "saved ✓" then nothing;
switching tabs/agents in the effect at `:12-22` discards unsaved edits without warning); `ContextModal.tsx:75-78`
(notes save on blur only).

**What's wrong.** In RoleMemoryEditor, selecting a different agent or flipping the role/memory tab reloads `text`
from disk, throwing away any unsaved edits in the textarea with no "unsaved changes" prompt. In ContextModal,
the per-file note persists only on `onBlur`, so a user who types a note and immediately closes the modal (the
Close button is a click elsewhere, which does blur first — but Escape/backdrop paths and fast closes are
fragile) can lose it.

**Why it matters.** Quiet edit loss in the very editors meant for the user's hand-authored role/memory content
erodes trust and compounds the data-loss theme, even if each instance is small.

**Suggested fix.** Track dirty state and warn before discarding unsaved role/memory edits; make the context-note
save explicit or on-change-debounced rather than blur-only.

---

### [Minor] No way to reset settings to defaults, and no surfacing of what changed from defaults

**Location** `src/renderer/SettingsModal.tsx:20-224` (only action is "Done"; no reset, no per-field default
hint); defaults live in `src/shared/types.ts:113-127`.

**What's wrong.** Once a user changes settings there is no "Restore defaults" and no visual cue for which fields
are at non-default values. The only button is "Done."

**Why it matters.** A non-technical user who experiments (e.g. cranks effort, flips autonomy to Full) has no
one-click way back to a known-safe baseline, and can't tell at a glance how far they've drifted.

**Suggested fix.** Add "Restore defaults" and mark non-default fields.

---

## Keep-list — patterns worth carrying into the Phase-2 rebuild

- **Review & repair as a 3-option radio with a one-line `desc` each** (`SettingsModal.tsx:4-8`, `:25-43`):
  plain-language labels ("+ one repair pass") with an explanatory subtitle is exactly the right pattern; extend
  this style to every setting.
- **Conditional reveal of dependent fields** — "Max repair attempts" only appears when `reviewMode === 'loop'`
  (`SettingsModal.tsx:45-60`). Good progressive disclosure; reuse it for the other gated numbers.
- **Settings backfilled from `DEFAULT_SETTINGS`** on load (`project-store.ts:180`,
  `graph.settings = { ...DEFAULT_SETTINGS, ...(graph.settings ?? {}) }`) so older projects never crash on a
  missing field — keep this defensive merge.
- **Editable preview before commit** in Team-spawn and Role-draft (names/roles are editable text areas before
  Apply) — the right instinct; just add overwrite warnings and reversibility (see findings above).
- **HITL minimize-to-badge** (`HitlModal.tsx:13-19`) lets a long run continue while the user gathers an answer
  — a genuinely good non-blocking affordance worth keeping.
- **Context modal's plain framing** ("given to every agent as reference context… Add a note to say what each is
  for", `ContextModal.tsx:54-57`) and empty-state hint (`:59-63`) are clear and jargon-free — a model for the
  rest of the UI's copy.
- **Skills picker grouped by plugin with a trust marker** (Anthropic "✓" / "Nk installs",
  `AgentConfigPanel.tsx:86-104`) communicates provenance well; keep the trust signal, drop the raw plugin ids.


## Verification

Adversarial verification by a second agent; each verdict cites code actually read.

- **d4-settings-modals-ux-1 — confirmed.** `AgentConfigPanel.tsx:24-27` `remove()` calls `window.api.deleteAgent` directly with no confirm dialog; the red button at `:114-116` wires straight to it. `project-store.ts:236-243` `deleteAgent` does `fs.rm(... { recursive: true, force: true })` on the agent dir (role.md + memory.md). No confirmation/undo anywhere. Critical stands.
- **d4-settings-modals-ux-2 — confirmed.** `SettingsModal.tsx:204` "Full auto — bypass all permission checks" is a peer `<option>`; the only warning at `:210` is "Nothing is gated during a run — keep the project under git." `nodes.ts:62-66` `actingModeFor` maps `'full'`→`'bypassPermissions'`. The SDK runs with `cwd: projectPath` but bypassPermissions is not a filesystem sandbox; the warning understates whole-machine reach. Critical stands.
- **d4-settings-modals-ux-3 — confirmed.** `AgentConfigPanel.tsx:64-76` is a raw `PERMISSION_MODES` enum dropdown bound to `agent.permissionMode`. `agent-runner.ts:111` uses `opts.permissionMode ?? agent.permissionMode`. Grep of `nodes.ts` shows EVERY orchestrated run passes an explicit permissionMode (lines 251, 294, 526, 718, 738, 765, 797, 829, 855, 873, 895, 994, 1027), so `agent.permissionMode` is never reached during orchestration — the dropdown is a silent no-op. Important stands.
- **d4-settings-modals-ux-4 — confirmed.** `types.ts:124-126` `maxReplans: 0, maxHandoffs: 0, maxUserRequests: 0`. `SettingsModal.tsx:96/113/130` each labels "(0 = off)" yet the descriptive copy at `:106-109/123-126/140-143` reads as if the feature is active ("the orchestrator may rewrite…", "an agent may consult…", "a worker that is blocked may pause…"). With defaults at 0 these never fire. Important stands.
- **d4-settings-modals-ux-5 — confirmed.** `SettingsModal.tsx:73-93` neither `adaptiveEffort` nor `autoAssignModels` copy mentions cost/speed. `types.ts:118-119` `adaptiveEffort: true, autoAssignModels: false` — defaults disagree with no in-UI rationale. Important stands.
- **d4-settings-modals-ux-6 — confirmed.** `HitlModal.tsx:47-49` Skip button calls `submit('')`; `:21-24` `submit` forwards the answer (here `''`) to `answerInterrupt`. Styled identically to a neutral button with no warning that an empty answer forces the worker to guess. Important stands.
- **d4-settings-modals-ux-7 — confirmed.** `HitlModal.tsx:39-42` only warns "don't paste secrets". The scrub guarantee is real (`nodes.ts:234-235` clears `resumeInput`/`pendingAsk` on every return; `types.ts:408-409,412` document questions-only/never-answer persistence; graph.test.ts:233 tests it). The reassuring "answer isn't saved" half is never shown to the user. Important stands.
- **d4-settings-modals-ux-8 — confirmed.** `HitlModal.tsx:43-53` offers only Minimize/Skip/Submit. `GoalBar.tsx:147-152` disables Stop while `pendingInterrupt` is set (title tells the user to Submit/Skip first). So while paused there is no abort-run escape hatch. Important stands.
- **d4-settings-modals-ux-9 — confirmed.** `RoleDraftModal.tsx:9-20` `apply` loops `writeRole` for every draft; `project-store.ts:284-287` `writeRole` unconditionally `fs.writeFile`s role.md (overwrite, no merge/backup/warning). `TeamSpawnModal.tsx:30-40` `apply` calls `applySpawnedTeam` (creates real agents/dirs) with only an `alert()` on failure and no reversibility cue. Important stands.
- **d4-settings-modals-ux-10 — confirmed.** `SettingsModal.tsx:20-224` is one flat sequence of `.field` blocks with no `<fieldset>`/section/search; Autonomy (the top safety control) is the last field at `:197-214`, after skills-pack knobs (`:157-195`). Important stands.
- **d4-settings-modals-ux-11 — confirmed.** `SettingsModal.tsx:157-171` label "Trusted-skill install threshold" + copy "offered to agents only at/above this many installs"; `types.ts:121` default `skillInstallThreshold: 100000` (unit-less, no thousands separator in the number input). Jargon-heavy for a non-technical user. Minor stands.
- **d4-settings-modals-ux-12 — confirmed.** `GoalBar.tsx:48` (buildTeam), `:60` (runResult), `:72` (draftRoles) all surface failures via bare `window.alert(...)` with terse text and no remedy. (Note: cited line 40 is inside `buildTeam`'s body, not an alert itself, but the three alert calls are real.) Minor stands.
- **d4-settings-modals-ux-13 — confirmed.** `RoleMemoryEditor.tsx:12-22` reloads `text` from disk whenever `selectedId`/`which` changes, with no dirty check, so switching agent/tab drops unsaved edits silently. `ContextModal.tsx:75-78` persists a note only `onBlur` and only if changed — fragile on a fast modal close. Minor stands.
- **d4-settings-modals-ux-14 — confirmed.** Full read of `SettingsModal.tsx:20-224` shows no "Restore defaults" action and no per-field "differs from default" indicator; `types.ts:113-127` `DEFAULT_SETTINGS` exists but is never surfaced as a reset target. Minor stands.
- **d4-settings-modals-ux-15 — adjusted (Minor retained; description partly inaccurate).** Core claim holds: `project-store.ts:206` (createAgent) and `:783` (applySpawnedTeam) both seed `permissionMode: 'acceptEdits'`, a value shadowed at run time (per finding 3) yet editable in the panel. BUT the parenthetical "(or 'default' for spawned)" is wrong: `team-spawner.ts:36`'s `permissionMode: 'default'` is the runAgent option for the *spawning orchestrator's* dispatch call, not the seed value of the created agents — spawned agents are seeded `'acceptEdits'` at `project-store.ts:783`, not `'default'`. Severity unchanged (Minor); note the misattributed citation.
