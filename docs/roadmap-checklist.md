# AI Manager — Roadmap Checklist

The single prioritized to-do. **1 = do next / most important; higher = later.**
(Companion design: `orchestrator-durable-state.md`. History/decisions: project memory.)

## ✅ Done & verified
- **Stage 1 — durable checkpoints.** Built + smoke-test verified live (checkpoint appears during a
  run, removed on clean finish; crash leaves a resumable one).
- **Stage 2 — graph runtime + carve-over.** Built (graph.ts + nodes.ts; orchestrator.ts is a thin
  driver), ran a real goal end-to-end live.
- **Per-agent skills.** Real Anthropic `data`/`design`/`engineering` + `frontend-design` plugins,
  toggled per agent. `npm run skills:check` verifies plugin paths.
- **Manager-assigned adaptive effort.** Manager assesses each task's difficulty and assigns a
  reasoning `effort` (low→max; "ultra"=max) applied to the worker's run. Settings toggle.
- **Render-verify prompts.** Worker + reviewer (+ worker role template) now instruct: for web apps,
  run it and confirm the entry page AND every referenced asset return 200 — catches the
  static-path/404 class of bug that renders a page unstyled. (From the throwaway audit.)
- **Manager-stuck-on-"assigning" fix**, `smoke:check` + `skills:check` helpers.
- **Routers read their reports' memory.** Routing now weighs **track record, not just role text**:
  `routeTasks` injects a capped `memory.md` *Lessons* digest per child into `assignPrompt` (new pure
  `lessonsDigest()` in `nodes.ts`, via `readMemory`); generalizes to any node with children. Manager
  role template updated. Unit-tested + build green; **live-verified.**
- **Polish: PTY spawn errors + interactive-terminal hint.** `TerminalPane.tsx` interactive spawn now
  has a `.catch` that prints the failure in red and clears `busy` (was silently swallowed → pane hung
  blank). Plus a dim "Type a prompt to drive this agent — live `claude` session" hint (`.term-hint`).
  Typecheck + build green; **live-verified.**
- **Show assigned effort in the Run view.** Per-level effort pill (cool→warm: low→max). New pure
  `shared/effort.ts` (`effortOfWorker` / `effortByTask`, 7 tests). RunView badges each leaf worker
  with the effort it ran at; HistoryView badges each task in the Plan list. Effort data was already
  in the store/run-record (`assignments`), so no new plumbing. Typecheck + build green; **live-verified.**
- **Stage 4 — task dependencies (`dependsOn`).** `planPrompt` emits per-task `dependsOn`; `planStep`
  parses + sanitizes (drops self/unknown ids); `executeNode` is now a wave loop gated by exported
  `depsSatisfied` (only blocks on owned, not-yet-executed deps) with a cycle guard (run-the-rest when
  nothing's ready) so it can never hang. No-deps runs are byte-for-byte the old single-wave behavior.
  Orchestrator role template notes deps. 59 tests green; **live-verified.**
- **Compounding-team (a) — memory quality.** Reflected lessons are tagged `[portable]` (general SWE)
  vs `[project]` (this-codebase fact) inline in memory.md; routing digest (`lessonsDigest`) excludes
  `[project]` so managers route on capability not trivia. New `src/shared/lessons.ts` is the single
  marker source of truth; `mergeMemory` dedups by stripped text; no shared-type churn. Built via
  subagent-driven TDD (74 tests green, whole-branch review clean). **Repo is now git-initialized.**
  Spec/plan under `docs/superpowers/`. **live smoke pending.**
- **Compounding-team (b1) — portable team export/import.** Export the open project's team (roster +
  roles + PORTABLE-only lessons) to a versioned `.json` bundle; import into another project → new
  agents with seeded `[portable]` memory + empty task log, edges remapped by stable `memberId`.
  Pure core in `src/shared/team-bundle.ts` (+ extracted `shared/slug.ts`, `portableLessons`);
  `exportTeam`/`importTeam` in project-store (saveGraph last); IPC + top-bar Export/Import buttons.
  `AgentNodeData.memberId?` added for B2. Project settings NOT carried. Built via subagent-driven TDD
  (89 tests green incl. fs round-trip + edge-remap; whole-branch review clean). **live-verified.**
- **Compounding-team (b2a) — living team / manual brain sync.** Team brain = a B1 bundle file + a
  `teamId`; a project records `linkedTeam` and gets **Sync to team** (push `[portable]` lessons into
  the brain by `memberId`, roster-growth) + **Refresh from team** (pull lessons into matching agents
  via the new `mergeLessons`). Implicit linking (first sync = save/open dialog; B1 import auto-links).
  New pure `src/shared/team-brain.ts` (`mergeBrainPush`/`planBrainPull`/`mergeLessons`); union +
  dedup-by-text (lossless, idempotent). Built via subagent-driven TDD (96 tests green; whole-branch
  review clean). **live smoke pending.**
- **Orchestrator-drafted agent roles.** A **Draft roles** button (GoalBar) has the orchestrator author
  a complete, complementary `role.md` for each non-orchestrator agent from the goal + roster (read-only
  call), shown in an editable preview; nothing writes until Apply (reuses `writeRole`). New pure
  `shared/role-draft.ts` + `engine/role-drafter.ts` (seam-tested) + `rosterForDrafting`. Built via
  subagent-driven TDD (103 tests green; whole-branch review clean). **live smoke pending.**
- **Compounding-team (b2b) — automatic brain sync.** Opt-in `autoSyncTeam` setting (default off,
  Settings checkbox): when on + linked, `orchestrator.ts` auto-pulls the team brain before a run and
  auto-pushes new `[portable]` lessons after. New `project-store` `readTeamBrain`/`autoPullFromTeam`/
  `autoPushToTeam` wrap b2a's sync; double-walled try/catch so it never blocks/breaks a run. Built via
  subagent-driven TDD (105 tests green; whole-branch review clean). **Compounding-team a+b1+b2a+b2b
  complete.** **live smoke pending.**
- **Dynamic agent spawning — orchestrator CREATES the team.** A **Build team** button (GoalBar) has the
  orchestrator PROPOSE a hierarchical team (agents + roles + reporting tree) from the goal — read-only
  call — shown in an editable, depth-indented preview; nothing is created until Apply. New pure
  `shared/team-spawn.ts` (`spawnTeamPrompt` + cycle-safe `parseSpawnedTeam`) + `engine/team-spawner.ts`
  (seam-tested, retry-once) + `project-store.applySpawnedTeam` (mirrors `importTeam`: create agents +
  roles + reporting edges, non-destructive) + IPC `team:spawn`/`team:applySpawn` + `TeamSpawnModal`.
  The named follow-on to role-drafting (which authored roles for a team you placed; this also creates the
  nodes + topology). Built via subagent-driven TDD (115 tests green; whole-branch review clean; merged to
  main `--no-ff`). **LIVE-VERIFIED 2026-06-25** (user confirmed Build-team propose → editable preview → Apply works end to end).
- **"Run result" button — one-click launch+open of the built app.** A **Run result** button (GoalBar,
  lucide `Rocket`) → a read-only detection agent (mirrors `role-drafter`/`team-spawner`: `default`+
  THINK_DISALLOW, retry-once, `runAgent` seam) inspects the project + last run report and emits an editable
  `RunManifest` (`{type,startCommand,port,path,notes}`) → a preview modal (editable command/port/path) →
  Launch spawns the server via `child_process` (`shell:true`+`detached:true`, process-group kill), streams
  its logs into the modal, polls the TCP port until ready, then opens the system browser; non-web types →
  Open-project-folder. New pure `shared/run-manifest.ts` (`detectManifestPrompt`+`parseManifest`) +
  `engine/manifest-detector.ts` (seam-tested) + `engine/server-manager.ts` (mirrors `pty-manager`,
  killed on quit + project switch) + IPC `manifest:detect`/`server:launch`/`server:stop`/`app:openPath`
  + 3 server events + `RunResultModal.tsx`. System browser now; the `server:ready` event carries the URL
  so an in-app webview can drop in later. Built via subagent-driven TDD (123 tests green; whole-branch opus
  review "Ready to merge: Yes"; merged to main `--no-ff`, commits `75ab8a8..8e68efa`, merge `eb7e77a`).
  **live smoke pending.**
- **Two-tier review — domain managers as first-line QA.** `reviewNode` split into `domainReviewNode`
  (tier 1, DEPTH — each leaf's immediate manager reviews its own subtree in parallel; orchestrator for
  flat workers) + `integrationReviewNode` (tier 2, BREADTH — orchestrator checks the assembled result vs
  plan+goal, SKIPPED for flat teams); `repair → domainReview` so a fix is re-verified by its manager,
  bounded by the new `RunState.repairAttempts` (not `reviews.length`). Hierarchy-aware `reflectNode`:
  managers + the orchestrator's integration pass reflect on their QA work via `qaReflectPrompt` (the
  compounding-QA loop; `[portable]`/`[project]` scope reused). Topology helpers `parentOf`/`hasManagers`/
  `reviewerIdsOf`. Manager role template gained review/test/reflect duties; `spawnTeamPrompt` flat-bias
  softened toward domain managers for a cluster of related roles. **Flat (no-manager) teams behave
  byte-for-byte as before** (regression-tested). Built via executing-plans TDD over the deterministic
  `nodes.test.ts` seam (131 tests green; typecheck + build clean; merged to main `--no-ff`, commits
  `f5079aa..36fe4f7`, merge `8c9fc3f`). Spec/plan under `docs/superpowers/`. **live smoke pending**
  (no real two-tier team has run against Claude yet). **v2 (deferred):** manager escalates a mis-scoped
  task back to the orchestrator to re-plan — shared with workflow-graph #1 phase 2.
- **Project context files — upload images/files for the team.** (Out-of-band user request, not a numbered
  roadmap item.) The user attaches images/files to a project as PERSISTENT reference context (each with an
  optional note), available to EVERY agent. Files are copied into `.ai-manager/context/` and recorded in
  `ProjectGraph.context` (`ContextFile[]`); a pure `shared/context-files.ts` (`isImageName`,
  `uniqueContextName`, `buildContextBlock`) builds a system-prompt section that `composeAppend` injects
  into every agent (the ONLY engine change — no `nodes.ts` edits); agents read the files with their
  existing tools (the Read tool renders images) — NO SDK multimodal plumbing. project-store gains
  `addContextFiles`/`updateContextFile`/`removeContextFile`/`contextThumbnail`/`getContextFiles`/`getGraph`;
  `addContextFiles` returns `{ graph, skipped }` so the UI alerts on skipped (non-file/unreadable) sources.
  IPC `context:add|update|remove|thumbnail` + a `webUtils.getPathForFile` preload bridge (Electron 42).
  UI: a top-bar Context manager modal (`ContextModal.tsx`, thumbnails via data-URL ≤5MB, editable notes) +
  count badge + window-wide canvas drag-and-drop. **A project with no context is byte-for-byte unchanged**
  (`buildContextBlock([]) === ''`). Built via subagent-driven TDD (5 tasks; final opus whole-branch review
  "Ready to merge"; 143 tests green; merged to main `--no-ff`, commits `2e3aad0..f24b460`, merge `6f63769`).
  Spec/plan under `docs/superpowers/` (2026-06-26). **live smoke pending.**
- **Trusted skill catalog + auto-assigned skills.** (Out-of-band user request.) The app now AUTO-DISCOVERS the
  skills of TRUSTED installed Claude Code plugins instead of a hardcoded list, and the orchestrator equips
  dynamically-created agents with them. **Trust rule:** author Anthropic, OR an `anthropics/*` marketplace repo,
  OR `unique_installs >= skillInstallThreshold` (Settings, default 100k). Discovery reads `~/.claude/plugins`
  metadata (`installed_plugins.json` + `plugin-catalog-cache.json` [has `components.skills`, `unique_installs`,
  `marketplace_entry.author`] + `known_marketplaces.json`), resolves each plugin's on-disk `skills/` dir
  (installed-cache / marketplace-clone / `plugins/` layouts), with an Anthropic-only filesystem fallback when
  the cache is absent. New pure `shared/skill-trust.ts` (`isTrusted`/`shapeCatalog`/`skillOptionsFor`/
  `offeredSkills`); `main/engine/skill-discovery.ts` (`discoverSkills(threshold, root?)`) + `skills:list` IPC;
  `agent-runner` loads skills from discovery (cached per run; hardcoded `resolvePluginPath` dropped);
  `skill-catalog.ts` RETIRED; AgentConfigPanel picker is dynamic (author / "Nk installs" badges). The orchestrator
  assigns ≤5 skills/member in **Build-team** and **Draft-roles** (offered a ≤40 condensed catalog ranked
  Anthropic+installs), shown in the editable previews, persisted to `node.skills`. **No trusted skills installed =
  byte-for-byte today's behavior** (`skillOptionsFor → null`); discovery never throws into a run. Built via
  subagent-driven TDD (6 tasks + 5 review fixes; final opus review "Ready to merge: Yes"; 156 tests green;
  merged `--no-ff`, commits `4ab4bb1..f0b161a`, merge `280b9fa`). Spec/plan under `docs/superpowers/` (2026-06-26).
  **live smoke pending.** Note: `plugin-catalog-cache.json` is an internal/undocumented CC file (parsed tolerantly).
- **Workflow-graph canvas — Phase 1: clickable edge ordering.** (Roadmap #1, Phase 1 of 3.) The user stamps an
  execution order onto the canvas's top-level flow lines (the orchestrator's direct-child edges) and the engine runs
  those teams in that order — by DERIVING the order onto the existing Stage-4 `dependsOn` waves (`executeNode`
  untouched). New `GraphEdge.order?` + pure `shared/workflow-order.ts` (`deriveOrderDeps(edges,orchestratorId,tasks)`
  run-time: every task under team ordered k depends on all tasks under teams <k, subtree-gated; `applyOrderClick`
  UI: stamp-next / clear+re-pack). `project-store.getEdges()`; `routeNode` merges the derived deps after routing.
  `OrgChart` gets an "Order" mode toggle (React Flow `<Panel>`) + click-in-sequence; ordered edges render solid +
  numbered, unordered stay animated (= parallel); `edgeSig` includes `order` so re-stamps re-render. **No ordering
  set = byte-for-byte today** (`deriveOrderDeps → {}`); sequencing gates on EXECUTED (not reviewed); top-level only.
  Built via subagent-driven TDD (3 tasks, NO fix rounds — clean; final opus review "Ready to merge: Yes"; 168 tests
  green; merged `--no-ff`, commits `e70b5bd..df2346b`, merge `26467f2`). Spec/plan under `docs/superpowers/`
  (2026-06-26). **live smoke pending** (eyeball: ordered edge not "stuck selected" after a stamp; badge re-renders on
  re-stamp/clear). Phases 2 (goal-locked re-plan) + 3 (lateral handoffs) remain — still #1.
- **Workflow-graph canvas — Phase 2: goal-locked mid-run re-planning.** (Roadmap #1, Phase 2 of 3.) PROACTIVE, between-stages
  re-plan: `executeNode` pauses at a Phase-1 ordered-stage boundary; a new goal-locked `replan` node lets the orchestrator
  rewrite the NOT-YET-RUN plan from what earlier stages produced (research → re-plan the build), then execution resumes.
  GOAL is never touched (structural). New pure `shared/replan.ts` (`pendingStageBoundary` + `mergeReplan`, freeze executed /
  replace pending) + `deriveStages` in `shared/workflow-order.ts`; engine: `replan` graph node, `executeNode` boundary pause,
  `replanNode`/`replanStep`/`replanPrompt`, shared `parseTasksAndDeps` (planStep+replanStep), `routeNode` routes only un-owned
  + stamps `stage`. `maxReplans` setting (**default 0 = off = byte-for-byte today**); bounded by `replanAttempts` + a
  per-boundary `replanStageCursor` (offers each boundary once). Surfaced via a `replan` event → Run-view `⚡ Re-planned` banner
  + History "Re-plans" section. Built via subagent-driven TDD (9 tasks, 1 fix round + 1 final-review simplification; opus
  whole-branch review "Ready to merge: Yes" — all 5 invariants verified; 190 tests green; typecheck+build clean; merged to
  main `--no-ff`, commits `a74ed28..c6c9668`, merge `7996f31`). Spec/plan under `docs/superpowers/` (2026-06-26). **live smoke
  pending** (eyeball: with `maxReplans>=1` + ordered research(1)→build(2), run pauses after research, banner shows the reason,
  build runs on the revised plan; `maxReplans=0` unchanged). **ESCALATION re-plan (two-tier v2) + lateral peer handoffs =
  Phase 3, still deferred.**
- **Workflow-graph canvas — Phase 3: lateral peer handoffs (edge types + handoff runtime).** (Roadmap #1, Phase 3 of 3 —
  COMPLETES the arc.) A new `GraphEdge.kind` ('report'|'handoff') the reporting tree IGNORES (`childrenOf`/`parentOf`/
  `deriveOrderDeps`/`deriveStages` exclude handoff edges) + an engine-mediated CONSULT runtime: a worker (mid-task) OR a
  reviewer (manager `domainReview` / orchestrator `integrationReview`) emits a ` ```handoff {to,ask} ``` ` block; the engine
  runs the connected peer with the ask and RESUMES the asker's session with the answer so it continues with context. New pure
  `shared/handoff.ts` (`parseHandoff`); `project-store.handoffPeersOf`; `nodes.ts` `runWithHandoffs`/`consultFor`/prompts wired
  into `runGroup` (worker) + `runStructured` (review, consult on attempt 0 only). `maxHandoffs` setting (**default 0 = off =
  byte-for-byte**); bounded per agent-run; the dispatched **peer's answer is terminal** (never re-parsed) → no recursion/
  ping-pong. Single-agent dispatch (no subtree orchestration). Canvas: select an edge → **Make handoff** (dashed). Surfaced via
  a `handoff` event → Run-view `↪ Handoff` line + History "Handoffs" section. Built via subagent-driven TDD (11 tasks + 2 fix
  rounds; OPUS review of the core runtime + review-integration + the final whole-branch). **Final review caught a CRITICAL** —
  the asker resumed a STALE on-disk session because `runWithHandoffs` never threaded its in-run `sessionId` before `resume:true`
  (the fake test runner masked it); fixed by adding `StreamAgentOptions.resumeSessionId` and threading `result.sessionId` (also
  closed a concurrent-`updateAgent` race) + a resume-honoring test. 209 tests green; typecheck+build clean; merged to main
  `--no-ff`, commits `fb7e08a..580d558`, merge `c0d88a7`. Spec/plan under `docs/superpowers/` (2026-06-26). **live smoke
  pending.** **The deferred two-tier-review v2 escalation (reactive manager kick-back → re-plan, reusing the Phase-2 `replan`
  node from the review exit) is the only remaining workflow-graph follow-on.**
- **Decisions:** Bedrock dropped (provider + Knowledge Bases). Multi-chart-within-a-project dropped.

---

## ✅ Workflow-graph canvas arc (Phases 1–3) — COMPLETE
Phases 1 (clickable edge ordering), 2 (goal-locked proactive mid-run re-planning), and 3 (lateral peer handoffs) all
SHIPPED to main (see Done above). The canvas now expresses structure (reporting tree), order (Phase 1), in-flight
re-planning (Phase 2), and lateral peer consults (Phase 3). Detail → memory `ai-manager-workflow-graph`.

## 1. Two-tier-review v2 escalation (reactive manager kick-back → re-plan)  ← NEXT (small; reuses the replan node)
The only remaining workflow-graph follow-on: a manager (or the orchestrator's integration review) escalates a mis-scoped
task back to be RE-PLANNED rather than just repaired — REACTIVE (failure-driven), vs Phase 2's PROACTIVE between-stages
re-plan. Reuses the Phase-2 `replan` node, triggered from the review exit instead of an execute-stage boundary (today an
unfixable plan-level gap is surfaced in integration feedback, not re-planned). Bounded like `maxReplans`. Smaller than a
phase — its own brainstorm + spec. Detail → memory `ai-manager-two-tier-review`, `ai-manager-workflow-graph`.

## 2. Stage 3 — resume usable + memory-approval gate (HITL)  ⏸ ON HOLD (user — until needed)
Runtime already supports resume/interrupts; not reachable from the app. Wire `resumeRun` to IPC,
add a resume-on-launch banner, and `reflectNode` interrupt for a `requireMemoryApproval` setting.

## 3. Local semantic-memory RAG  (lowest)
sqlite-vec/LanceDB once an agent's memory outgrows a single prompt. (Ephemeral memory-seeded spawn
agents were folded into the now-shipped dynamic-spawn design.) The compounding-team foundation
(a + b1 + b2a + b2b) exists.

## Intentionally NOT doing
Amazon Bedrock (provider + Knowledge Bases); multiple charts within one project folder.
