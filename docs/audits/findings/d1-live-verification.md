# Dimension 1 — Live-verification sweep

> **Status: historical — remediated.** This is an internal audit report from the
> 2026-06 review cycle, kept for the record. Every Critical and Important finding
> below has been fixed and merged; see
> [`docs/audits/2026-06-27-remediation-cycles.md`](../2026-06-27-remediation-cycles.md)
> for the per-cycle remediation log. Do not read the findings below as open issues.


**Scope.** This audit traces, end-to-end (renderer → preload → IPC → engine → back), every recently-shipped
feature that has green unit tests but was likely never exercised together against real Claude in the running app:
two-tier review + v2 escalation, the three workflow-graph phases (clickable edge ordering, goal-locked mid-run
re-plan, lateral peer handoffs), the run-result button, project context files, the trusted skill catalog, the
agent skills pack, HITL Stage 3, run narration, model-tier assignment + effort clamp, and the auto-growing goal
textbox. It produces (A) a concrete live-verification checklist (one finding below, severity Minor) and (B) a
never-executed-together wiring analysis: every event the engine emits is checked for a renderer consumer, every
setting for an engine reader, every node for a router, and every parsed block for a consumer. Baseline at audit
time: `npm test` = 286 passing, `npm run typecheck` clean (node + web). Read-only audit; no source was modified.

The headline: the wiring is, on the whole, genuinely connected — there is no dead event, orphan node, or
unread setting among the audited features. The findings below are the cases where a path is reachable but
*behaves wrong or surprises the user the first time it actually runs* (the live-verification risk), plus a
handful of true gaps where a feature is less wired than the memory notes claim.

---

### [Important] HITL/handoff blocks emitted outside `executeNode`'s worker call are silently dropped and can turn a recoverable pause into a fatal "did not return valid JSON" run error

**Location** `src/main/engine/nodes.ts:291` + `:305-312` (ask section + `parseAskUser` only inside `runGroup`);
`src/main/engine/nodes.ts:1031-1036` (`runStructured`: retry-then-throw on any non-JSON output);
`src/main/engine/nodes.ts:950-956` (`askUserSection`); `src/main/engine/graph.ts:64-74` (thrown → run `error`).

**What's wrong.** `parseAskUser` is called ONLY in `runGroup` (line 306) and the ask affordance is appended only
to the worker *execution* prompt (line 291). It is correctly workers-only and execute-only by design. The gap is
robustness: the same worker agents are also driven through `runStructured` for `reflectStep` (which runs on a
worker, nodes.ts:638) and could, in a real run, volunteer an ` ```ask ``` ` or ` ```handoff ``` ` block when it
feels blocked (the agent has seen those affordances earlier in the run/session). `runStructured` does not
recognize either block — it sees non-conforming output, retries once with `STRICT_REMINDER` (line 1020), then
THROWS "did not return valid JSON" (line 1036), which `runGraph` converts into a terminal run `error`
(graph.ts:64-74). The question/handoff is dropped and the run dies. Unit tests never hit this because the fake
runner always returns canned JSON.

**Why it matters.** A blocked agent in a structured step converts a recoverable situation into a fatal run error,
with its message buried in a truncated 400-char string — exactly a "parsed block whose result is dropped" gap,
and silent-wrong-behavior under realistic use. It is reachable today (reflect on a worker; any future structured
call on a worker).

**Suggested fix.** On a JSON parse failure in `runStructured`, scan the output for an `ask`/`handoff` block before
giving up — surface the ask (pause) or run the consult rather than erroring — or explicitly instruct in the
structured prompts that asking/handoff is unavailable there so the agent doesn't attempt it.

---

### [Important] `interrupt` event has no consumer when the run is resumed for crash-recovery vs. HITL — the HITL modal can be lost if the renderer reloads while paused

**Location** `src/main/engine/orchestrator.ts:99-104` (resume re-emits `run-started` only when `resumeInput === undefined`),
`src/main/engine/orchestrator.ts:106-113` (`finishRun` emits `interrupt` only when `final.status === 'interrupted'`),
`src/renderer/store.ts:198-206` (`interrupt` handler).

**What's wrong.** When a run pauses on a HITL `ask`, the engine returns with `status: 'interrupted'` and
`finishRun` emits the `interrupt` event (orchestrator.ts:110). The renderer shows the modal. But the
`pendingInterrupt` lives ONLY in renderer zustand state — it is never re-derived from the persisted
checkpoint. If the renderer window is reloaded/crashes while paused (or the user closes and reopens the Run
view), the only way back into the paused state is `resumeRun`, and there is no UI path that calls
`resumeRun(runId)` (without an answer) to re-emit the interrupt: `answerInterrupt` always passes an answer
(store.ts:226). The checkpoint with `pendingInterrupt` + `pendingAsk` is on disk and resumable in principle,
but nothing in the renderer offers "resume this paused run", so a paused run becomes orphaned from the UI.

**Why it matters.** The whole point of the durable checkpoint is crash survival, but the HITL pause is the one
state the user must act on, and it is the one with no recovery entry point in the UI. A reload mid-pause strands
the run (the checkpoint is never cleaned up either, since `finishRun` only `store.remove`s on a non-interrupted
terminal state, orchestrator.ts:106-125).

**Suggested fix.** On project open / app start, scan the checkpoint dir for runs with `status === 'interrupted'`
and surface a "resume paused run" affordance that calls `resumeRun(runId)` (no answer), which already re-enters
the paused node and re-emits the interrupt (the `resumeInput === undefined` branch is built for exactly this,
orchestrator.ts:99-101). This is a wiring gap, not a logic bug — the engine half exists; the renderer half does not.

---

### [Important] Lateral peer handoff: the consulted peer never emits a `status` event, so the Run-view tree shows it idle/done while it is actually working

**Location** `src/main/engine/nodes.ts:988-998` (peer consult call sets `stepId: peer.id` but never calls
`setStatus(eng, steps, peer.id, 'working')`); contrast `executeNode`'s `runGroup` which does (`nodes.ts:285`).

**What's wrong.** When an agent emits a `handoff` block, `runWithHandoffs` emits the `handoff` OrchestrationEvent
(nodes.ts:985, consumed by store.ts:195 and shown in RunView.tsx:122) and then runs the peer with
`agentId/stepId: peer.id`. The peer's terminal output streams correctly (RunView buffers by agentId,
RunView.tsx:74-78) and its narration appears in the ActivityFeed (attributed to the peer). BUT no `status`
event is ever emitted for the peer during the consult, so its pill in the run tree (`run.nodeStatus[peer.id]`,
RunView.tsx:133) stays whatever it last was — typically `idle` (never run) or `done`. The peer is visibly
working in its terminal yet shows idle in the tree, and never flips back. This only manifests in a real run
where the peer actually does work.

**Why it matters.** It is a real, observable inconsistency the first time handoffs run live: the user sees a
handoff line and a filling terminal but a tree that disagrees. It also means a peer that is a never-otherwise-run
node won't appear "active" anywhere structured.

**Suggested fix.** In `runWithHandoffs`, wrap the peer consult with `setStatus(... peer.id, 'working', [ask])`
before and restore its prior status (or 'done') after, and thread `steps`/`io.checkpoint` through, OR
explicitly emit a transient status. (Threading `steps` into `runWithHandoffs` is the larger change; a minimal
`eng.emit({type:'status', nodeId: peer.id, status:'working'})` before and `'done'` after would at least make the
tree honest.)

---

### [Important] Run narration is attributed to the wrong node when one agent runs a sub-step for another (review/reflect/handoff-resume), because `stepId` ≠ acting agent in those calls

**Location** `src/main/engine/agent-runner.ts:92-94` (stream events carry `agentId`, not `stepId`);
`src/renderer/run/ActivityFeed.tsx:30-41` and `RunView.tsx:74-77` (both key off `e.agentId`);
`src/main/engine/nodes.ts:251` (HITL resume uses `agentId: ask.ownerId` — correct) vs. the review/reflect calls
which use `agentId: <reviewer/worker>` correctly, but the handoff *resume* call reuses `...base` whose
`agentId` is the asker (nodes.ts:1003) — also correct. The genuine mismatch is narrower: every
`AgentStreamEvent` is emitted with `agentId` only and `stepId` is informational; the ActivityFeed and the
RunView terminal both bucket purely by `agentId`. That is correct for who *ran*, but the run tree's
"selected step" navigation (`selectStep`) and the per-row terminal expect `agentId === nodeId`.

**What's wrong.** In the common paths this holds. It breaks for the integration review and domain review when
the reviewer is the orchestrator/manager (those correctly stream under the reviewer's id — fine), but it is a
latent confusion for the skills-pack/discovery sub-runs and any future call where `agentId` and the displayed
node diverge. The concrete observable today: when the orchestrator runs `planStep`, `reviewStep`,
`integrationReviewStep`, `synthesizeStep`, AND a worker's `reflectStep`, every one of those tool calls produces
narration attributed to whoever `agentId` is — which is right — but a single agent (the orchestrator) then owns
narration spanning planning, routing, review, and synth, with no phase label in the feed (ActivityFeed shows
`name + text` only, ActivityFeed.tsx:70-72). The feed cannot distinguish "orchestrator planning" from
"orchestrator reviewing".

**Why it matters.** The narration feature's selling point is a readable whole-run story; in a real two-tier run
the orchestrator's rows interleave plan/route/review/synth with no marker, which is materially harder to read
than the spec implied. Not a crash, but a real first-run UX gap that unit tests can't catch (they don't render
the feed).

**Suggested fix.** Carry the run *phase* or `stepId` into the narration row and show it (e.g. dim phase tag),
since `AgentStreamEvent` already has `stepId`. This is additive and live-only, matching the feature's design.

---

### [Important] `autoAssignModels` is read at Build-team only; the "builds/drafts" model assignment promised by the design never happens on the Draft-roles path

**Location** design doc `docs/superpowers/specs/2026-06-27-orchestrator-model-effort-design.md` ("when the
orchestrator builds/drafts a team, it picks each worker's model tier"); engine reality:
`src/main/engine/project-store.ts:782` (`pickSpawnModel(m, getSettings().autoAssignModels)` — applied ONLY in
`applySpawnedTeam`); `src/main/engine/role-drafter.ts:18-60` (Draft-roles returns role text + skills, never a
model; `draftRolesPrompt`/`parseDraftedRoles` have no model field).

**What's wrong.** The setting is genuinely read (no orphan), but only on the Build-team flow. The Draft-roles
flow (which operates on *existing* agents and only rewrites their role.md) never touches model, so turning
`autoAssignModels` on has zero effect on a team built via Draft-roles or hand-created agents — contrary to the
design's "builds/drafts" wording and the user's likely mental model.

**Why it matters.** A user who enables auto-assign and then uses Draft-roles (a first-class button in GoalBar,
`GoalBar.tsx:119-126`) will see no model changes and reasonably conclude the feature is broken. It is a
real expectation gap that only shows up when both features are exercised together.

**Suggested fix.** Either document that auto-assign applies to Build-team only (and relabel the Settings copy,
`SettingsModal.tsx:91` already says "when building a team"), or extend Draft-roles to also propose+apply a model
per existing agent. The Settings copy is already narrower than the design doc — align the doc, or widen the code.

---

### [Important] Effort clamp is a no-op whenever `adaptiveEffort` is OFF, so the "always-on, fixes the badge at the source" guarantee does not hold for a fixed-effort run

**Location** `src/main/engine/nodes.ts:745` (`effort = effortForModel(model, requested, getSettings().adaptiveEffort)`);
`src/main/engine/nodes.ts:1129-1136` (`effortForModel` returns `requested` unchanged when `!adaptiveEnabled`);
`src/main/engine/nodes.ts:286` and `:518` (execution effort computed only when `adaptiveEffort`).

**What's wrong.** The design says the clamp is "always on … a pure no-op when adaptiveEffort is off (effort is
undefined)". That assumption holds for the *dispatched* effort (execute/repair only set `effort` when adaptive
is on). But `assignStep` still records `a.effort` from the model even with adaptive off only because
`effortForModel` short-circuits — and `out.assignedEffort` (the "capped from" badge driver) is only set when
`requested !== effort` (nodes.ts:747). With adaptive off, `requested` may be a parsed value but `effort ===
requested` (no clamp), so no badge; with adaptive off the assignment's effort is then ignored at execution
anyway. Net: consistent, but the clamp genuinely never runs unless adaptive is on. The badge-mismatch fix
(XHIGH-on-Sonnet) therefore only applies in adaptive-effort runs — which is the default, so in practice fine,
but the "always on" claim is overstated and a fixed-effort future path would re-introduce the mismatch.

**Why it matters.** Low-severity in today's default config, but it contradicts the documented invariant and is a
trap for any later change that dispatches a non-adaptive effort. Flagged because the audit ground rules ask to
test "always-on" claims for a path where the guard makes them untrue.

**Suggested fix.** Either clamp unconditionally in `effortForModel` (drop the `adaptiveEnabled` short-circuit —
clamping a value the SDK would silently downgrade anyway is harmless) or restate the invariant as
"clamp applies wherever effort is dispatched, which today is adaptive-only".

---

### [Minor] Duplicate "▶ name · model" header lines accumulate in an agent's terminal buffer across review/repair/reflect/handoff-resume because `header: false` is not passed for in-run sub-steps

**Location** `src/main/engine/agent-runner.ts:101-103` (`if (opts.header !== false)` prints header);
`role-drafter.ts:41` and `manifest-detector.ts:66` pass `header: false`, but the graph nodes
(`nodes.ts:245`, `:288`, `:520`, `:849`, `:988`, `:1003`, `runStructured` `:1021`) never pass `header`, so each
sub-call re-prints the header into the same agentId-keyed buffer (RunView.tsx:74-78 appends by agentId).

**What's wrong.** A single agent that plans, gets reviewed, repairs, and reflects will have its run-view
terminal interleaved with several "▶ Orchestrator · claude-opus-4-8" banners. Purely cosmetic, but it is the
kind of thing only seen in a real multi-step run.

**Why it matters.** Polish/readability only; no correctness impact.

**Suggested fix.** Pass `header: false` for the second-and-later calls to the same agent within a run, or print
the header once per (runId, agentId) by tracking emitted headers.

---

### [Minor] `contextThumbnail` IPC + `getPathForFile` are wired in preload but the live drag-drop path silently swallows non-file drops, and image context is given to agents only as a filesystem path (no multimodal)

**Location** `src/main/engine/agent-runner.ts:17-26` + `src/shared/context-files.ts:28-40`
(`buildContextBlock` injects only a bulleted list of `.ai-manager/context/<name>` paths);
`src/renderer/App.tsx:80-90` (drop handler filters out items whose `getPathForFile` is `''`).

**What's wrong.** This is wired and functions, but the live behavior differs from the "upload images … every
agent reads" framing: agents receive a *path* and must `Read` the file themselves; the engine never sends image
bytes to the SDK. For a model that can read images via the Read tool this works, but only if the agent actually
opens the file. The `buildContextBlock` instruction ("the Read tool shows images") is the only thing making it
happen — there is no enforcement. Worth a live check that agents actually open dropped images.

**Why it matters.** Low risk, but the feature's value depends entirely on the agent voluntarily reading the
listed files; a run could complete ignoring the context with no signal. Verify live that context is actually
consulted.

**Suggested fix.** None required for correctness; during live verification, confirm an agent opens a dropped
image (e.g. design mock) and references it. Consider surfacing "context read" in narration.

---

### [Minor] Goal `<textarea>` autosize runs on change only — pasting/programmatic set or reopening with a long goal won't size correctly, and there is no initial autosize

**Location** `src/renderer/run/GoalBar.tsx:13-16` (`autosize` called only inside `onChange`, line 106) and
`:99-115` (textarea `rows={1}`, no `ref`/effect to size on mount or external value change).

**What's wrong.** `autosize` is invoked only from `onChange`. The goal is local state initialized to `''`
(GoalBar.tsx:25) and never set externally, so today it's fine — but the textarea starts at `rows={1}` and only
grows as the user types. A paste that triggers `onChange` is covered; however there is no `ref` + mount effect,
so if the component ever renders with a non-empty `goal` (future: restore last goal, prefill from history) it
would render collapsed. Pure forward-risk, included for completeness of the auto-growing-textbox review.

**Why it matters.** Negligible today; a latent gap if the goal is ever pre-populated.

**Suggested fix.** Add a `ref` and a `useEffect([goal])` that calls `autosize`, so size always tracks the value
regardless of how it changed.

---

### [Minor] Live-verification checklist

**Location** this file (the table below).

The features are reachable and wired; this table is the concrete script to prove each one actually works against
real Claude in the running app. "Headless?" = whether it can be verified without a full real-Claude run.

| Feature | Setting(s) to toggle (field — `types.ts` / `SettingsModal.tsx`) | Exact in-app steps | Expected observable result | What proves it BROKEN | Headless? |
|---|---|---|---|---|---|
| Two-tier review | `reviewMode='loop'` (radio, SettingsModal.tsx:27-42), `maxRepairAttempts` (SettingsModal.tsx:48), `reflection=true` | Build a team with ≥1 manager over ≥2 workers; run a goal that produces a fixable defect. | Manager pill flips to `reviewing` (domain), then Orchestrator `reviewing` (integration); a failed task gets a repair pass; verdict ✓/✗ in tree (RunView.tsx:157). | Integration review never runs for a managed team, or repair loop ignores `maxRepairAttempts`. | partial (logic unit-tested; tier ordering needs a real run) |
| Two-tier review v2 escalation | `maxReplans>0` (SettingsModal.tsx:96-110) | Same as above but craft a mis-scoped task; reviewer must classify `disposition:'replan'`. | ⚡ Re-planned line in tree (RunView.tsx:117); not-passed tasks re-broken-up; passed tasks frozen. | A `replan`-flagged failure still only repairs (never reaches `escalate`); or escalate loops past `maxReplans`. | no (needs real reviewer JSON with `disposition`) |
| Workflow phase 1 — edge ordering | none (canvas-only) | Canvas → "Order" toggle (OrgChart.tsx:175-183) → click top-level orchestrator edges in run order. | Edges show numbers + `edge-ordered` class; teams run in stages (later-team tasks wait). | Ordering doesn't gate execution (deriveOrderDeps not applied) — later team runs before earlier. | partial (derivation unit-tested; gating needs a run) |
| Workflow phase 2 — mid-run re-plan | `maxReplans>0` AND an order set on canvas | Order ≥2 teams; run a goal where stage-1 output should change stage-2 plan. | Run pauses at the stage boundary, ⚡ Re-planned line, revised remaining plan (replan event → store.ts:191). | Pause never fires (pendingStageBoundary returns null) or goal text mutates. | no (needs real replan decision) |
| Workflow phase 3 — peer handoff | `maxHandoffs>0` (SettingsModal.tsx:113-127) | Select a canvas edge → "Make handoff" (OrgChart.tsx:170); run a goal where a worker needs a peer. | ↪ Handoff line (RunView.tsx:122); peer terminal fills; asker continues with the answer. | Handoff block parsed but peer never runs; or asker resumes a stale session (Phase-3 bug class). NOTE per this audit the peer's tree pill stays idle (Important finding). | no |
| Run-result button | none | GoalBar → "Run result" (GoalBar.tsx:135-142) after a build. | Detection agent → editable manifest modal → "Launch & open" starts server, opens browser (RunResultModal). | Detector errors, or launch never reaches `running`/opens URL. | partial (manifest parse unit-tested; launch needs a built app) |
| Project context files | none | Top-bar paperclip (App.tsx:168) or drag-drop files; add an image + note; run. | File copied to `.ai-manager/context/`; badge count (App.tsx:174); agents reference it. | Context block missing from prompt, or agent ignores the file (Minor finding above). | partial (block built unit-tested; consumption needs a run) |
| Trusted skill catalog | `skillInstallThreshold` (SettingsModal.tsx:159) | Select an agent → AgentConfigPanel skills picker (AgentConfigPanel.tsx:78-107); check skills. | Only trusted plugins listed; checked skills load into the agent's SDK `skills`. | Picker empty when trusted plugins exist, or assigned skill not passed to SDK (agent-runner.ts:125-130). | partial (discovery + shaping unit-tested) |
| Agent skills pack | `skillsPackEnabled` (SettingsModal.tsx:177), `skillsPackPath` (SettingsModal.tsx:189) | Provision pack (`scripts/setup-skills-pack.mjs`); enable; run a UI/Playwright goal. | Pack skills available to every agent; headless Playwright note appended (skills-pack.ts:28). | Pack path resolves but skills not merged into SDK options; or note missing. | partial (assembly unit-tested; SDK load needs a run) |
| HITL Stage 3 | `maxUserRequests>0` (SettingsModal.tsx:131-144) | Run a goal where a worker is blocked on a decision. | Run pauses; HitlModal shows the question (HitlModal.tsx); Submit resumes that worker; answer NOT in any checkpoint/History. | Question never surfaces (see Critical finding — ask in a non-execute step is dropped); or answer persisted to checkpoint/History. | no (needs a real worker `ask`) |
| Run narration | none (always-on, live-only) | Any run; watch the ActivityFeed above the terminal (RunView.tsx:173). | Plain-English rows per tool call; click a row jumps the terminal to that agent (ActivityFeed.tsx:68). | Feed empty during a run (narration field missing on tool_use), or rows mis-attributed/un-phased (Important finding). | partial (narrateTool unit-tested; feed render needs a run) |
| Model-tier assignment + effort clamp | `autoAssignModels` (SettingsModal.tsx:88), `adaptiveEffort` (SettingsModal.tsx:77) | Enable both; Build team for a goal with mixed difficulty. | Spawned members get Sonnet/Opus per difficulty (never Haiku); effort badge shows clamped value + "capped from X" tooltip (RunView.tsx:152-156). | Auto-assign has no effect (Important finding: Draft-roles path); or Sonnet worker shows `xhigh` (clamp not applied). | partial (clamp + parse unit-tested; assignment needs a real Build-team) |
| Auto-growing goal textbox | none | Type a multi-line goal; Enter=run, Shift+Enter=newline (goalbar-keys.ts). | Textarea grows ~8 lines then scrolls (MAX_GOAL_HEIGHT=160). | Enter inserts newline instead of running, or box never grows. | yes (DOM-only; keys unit-tested) |

**Why it matters.** No single feature here has been run end-to-end with the others against real Claude (per the
memory notes, most are "live-smoke pending"). The "no" / "needs real run" rows are the highest residual risk.

**Suggested fix.** Execute the "no" rows once each in a throwaway project under git, with the relevant setting on,
and confirm the Expected column. The Notion dogfood Run 1 covered several "partial" rows already; the untested
"no" rows (escalation, mid-run re-plan, handoff, HITL) are the gap.

---

## Verification

Adversarial re-check of each finding against the cited code (read-only).

- **d1-live-verification-1 — ADJUSTED (Important → Minor).** The cited "reflect on a worker" path is non-fatal:
  `reflectStep` wraps `runStructured` in `try { ... } catch { return null }` (nodes.ts:822-838) and the header
  comment at nodes.ts:837 says "reflection failure is non-fatal" — a bad-JSON throw from runStructured is swallowed
  and returns null, it does NOT become a terminal run error. The other runStructured callers run on the
  orchestrator/manager, not workers: planStep (nodes.ts:713), assignStep (:733), replanStep (:868), escalateStep
  (:890), and reviewStep/integrationReviewStep (:760,:792) — the last two DO pass `consultFor(...)` so handoffs
  ARE parsed and handled there (runWithHandoffs → parseHandoff, nodes.ts:980-982), not dropped. `parseAskUser`
  runs only in executeNode (nodes.ts:306) and the `ask` affordance prompt is added only to the worker EXECUTE
  prompt (nodes.ts:291); reflectStep's base in runStructured sets no `resume` (nodes.ts:1021-1029) so a worker in
  reflect is a fresh session that was never shown the ask/handoff affordance. Net: the "recoverable pause →
  fatal error / dropped question" scenario does not hold on the cited path. There IS a residual smell (ask/handoff
  blocks aren't universally recognized by runStructured), but it is benign here, so Minor not Important.

- **d1-live-verification-2 — CONFIRMED (Important).** `resumeRun` is invoked in the renderer only at store.ts:226,
  and only with an `answer` (inside `answerInterrupt`). preload exposes `resumeRun(runId, answer)` (index.ts:45)
  but nothing calls it without an answer. The engine's crash-recovery branch exists (`resumeInput === undefined`
  re-emits `run-started`, orchestrator.ts:99-101) and `finishRun` keeps the checkpoint on `interrupted`
  (orchestrator.ts:107-113, no `store.remove`), so a reload mid-pause strands a resumable checkpoint with no UI
  affordance. Real wiring gap.

- **d1-live-verification-3 — CONFIRMED (Important).** `runWithHandoffs` (nodes.ts:974-1006) runs the peer with
  `agentId/stepId: peer.id` (nodes.ts:988-997) and emits the `handoff` event (nodes.ts:985) but never calls
  `setStatus` for the peer — `setStatus` is called at ~25 sites throughout nodes.ts but none inside
  runWithHandoffs, and `steps` is not even threaded into the function. The peer's tree pill keeps its prior
  status (idle/done) during a live consult while its terminal fills. Observable UI inconsistency the first time
  handoffs run.

- **d1-live-verification-4 — ADJUSTED (Important → Minor).** Accurate that ActivityFeed buckets purely by
  `e.agentId` and renders `time + name + text` with no phase/stepId (ActivityFeed.tsx:29-41,63-73), even though
  `stepId` is carried on every stream event (agent-runner.ts:94) and is unused in the feed; the orchestrator's
  plan/route/review/synth rows interleave unlabeled. But this is a readability/polish gap with zero correctness
  or data impact (no wrong attribution — `agentId` is who ran). By the audit rubric (Important = correctness gap
  that bites; Minor = polish/nit) this is Minor.

- **d1-live-verification-5 — ADJUSTED (Important → Minor).** Accurate that `pickSpawnModel(m, autoAssignModels)`
  is applied only in `applySpawnedTeam` (project-store.ts:782) and `draftRoles` returns only
  `{agentId, name, role, skills?}` with no model (role-drafter.ts:21,46-54). But the user-facing Settings copy
  is already correctly scoped: "orchestrator picks Sonnet/Opus per worker when building a team"
  (SettingsModal.tsx:91) — it does NOT promise Draft-roles assignment. So there is no wrong UI label and no
  broken behavior; only the design-doc/memory "builds/drafts" wording is unfulfilled. A doc/expectation gap,
  not a correctness bug → Minor.

- **d1-live-verification-6 — ADJUSTED (Important → Minor).** Accurate that `effortForModel` short-circuits to
  `requested` when `!adaptiveEnabled` (nodes.ts:1134) and execution only sets effort under adaptive
  (nodes.ts:286). But this is the documented, internally-consistent design, not a contradiction: the design doc
  states the clamp "is a pure no-op when adaptiveEffort is off (effort is undefined)" (spec line 46-47) precisely
  because no effort is dispatched when adaptive is off, so there is nothing to clamp and no badge mismatch can
  arise. "Always on" means "no setting of its own," which holds. The finding restates documented behavior as a
  trap; it is a forward-looking doc-clarity nit → Minor.

- **d1-live-verification-7 — CONFIRMED (Minor).** agent-runner.ts:101-103 prints the `▶ name · model` header
  unless `header === false`; role-drafter.ts:41 and manifest-detector pass `header:false`, but the graph node
  calls (executeNode, review, repair, reflectStep, runWithHandoffs, runStructured) never pass `header`, so each
  in-run sub-call re-prints the banner into the same agentId-keyed terminal buffer. Cosmetic.

- **d1-live-verification-8 — CONFIRMED (Minor).** `buildContextBlock` (context-files.ts:28-40) emits only a
  bulleted list of `.ai-manager/context/<fileName>` paths plus a "read the relevant ones (the Read tool shows
  images)" instruction; no image bytes are sent to the SDK (agent-runner.ts:110 appends only the text block).
  Consumption relies entirely on the agent voluntarily Read-ing the file — worth a live check, as stated.

- **d1-live-verification-9 — CONFIRMED (Minor).** GoalBar `autosize` (GoalBar.tsx:13-16) is invoked only from
  `onChange` (GoalBar.tsx:106); the textarea has `rows={1}` and no `ref`/`useEffect` (GoalBar.tsx:99-115), and
  `goal` is initialized to `''` (GoalBar.tsx:25) and never set externally — so it is fine today but would render
  collapsed for any future pre-populated value. Pure forward-risk.

- **d1-live-verification-10 — CONFIRMED (Minor).** The checklist table accurately maps each audited feature to
  its real setting field, in-app step, expected observable, broken-signal, and headless-verifiability; the
  "no" rows (escalation, mid-run re-plan, handoff, HITL) are correctly identified as the highest untested-together
  risk. A documentation deliverable, not a bug claim.
