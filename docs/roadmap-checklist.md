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
- **Decisions:** Bedrock dropped (provider + Knowledge Bases). Multi-chart-within-a-project dropped.

---

## 1. Two-tier review — domain managers as QA specialists  ← NEXT active design (brainstorm + spec first)
Make managers earn their keep at RUNTIME. **Today:** routing is hierarchical (a manager sub-assigns tasks to its
children via `routeTasks`), but review/test/reflect are CENTRALIZED on the orchestrator — `reviewNode` runs one
pass as `state.orchestratorId` over all tasks, `repairNode` re-runs the worker with the orchestrator's feedback,
`reflectNode` writes memory for WORKERS only — and `spawnTeamPrompt` biases teams flat. Net: the orchestrator does
all the checking and manager nodes have no teeth. **Idea (two changes):** (a) dynamic-spawn creates MORE domain
managers — cluster several related roles (e.g. 3 software + 3 web) under a QA-capable specialist manager [small
prompt/role tweak in `spawnTeamPrompt` + manager role template]; (b) make managers actually REVIEW + TEST + give
feedback + REFLECT for their subtree [engine change: `reviewNode`/`repairNode`/`reflectNode` become per-manager].
**Two-tier labor split:** managers = DEPTH (deep domain review + testing; specialists catch domain bugs and hand
WELL-WRITTEN, LESS-BUGGY code UP; the manager owns testing so workers just write code; managers COMPOUND QA
expertise via reflect→`lessonsDigest` and use recorded lessons for better feedback). Orchestrator = BREADTH (the
broader review — mainly compares the integrated result against the PLAN + GOAL; lighter now that managers pre-filter
domain bugs). **Watch:** each manager = another review pass (latency/tokens); a manager with 1 worker is overhead →
keep the spawn threshold at "a cluster of several roles"; the manager-tester must ACTUALLY run the app/tests
(render-verify lesson → acting mode + Bash). **v2 (defer):** manager ESCALATES a mis-scoped task back to the
orchestrator to re-break-up (loops back to plan — control-flow change). Pairs with dynamic-spawn (creates the
managers) + compounding-memory (they get better over time). Meatier than dynamic-spawn (touches the core run loop)
→ own brainstorm + spec. Priority vs Stage 3 is adjustable.

## 2. Workflow-graph canvas — edge ordering + goal-locked re-planning + lateral handoffs  ← later (big arc; brainstorm + spec)
Evolve the canvas from an ORG CHART (who reports to whom) into ALSO a WORKFLOW GRAPH (what flows where, in what
order); the orchestrator stays the goal-owning hub. Today a `GraphEdge` means only "delegates to" and routing is a
strict tree (`childrenOf`); Stage 4 `dependsOn` already sequences tasks in waves but planner-decided, not canvas-
editable. Three phases, cheapest→deepest: **(1) clickable edge ordering** — click a flow line to set order
(click-once = first, click-twice = next); rides the wave/`dependsOn` machinery, doesn't break the tree [low risk];
**(2) goal-locked mid-run re-planning** — a stage returns (e.g. research) → orchestrator rewrites the REMAINING plan,
GOAL NEVER TOUCHED; `graph.ts` has loops/checkpoints but node logic plans once today [this is ALSO the two-tier #1
v2 escalation — build once]; **(3) lateral team handoffs** ("side flow lines", e.g. marketing↔compliance) — a CYCLE
+ non-parent-child edge the routing core currently forbids; needs TWO EDGE TYPES (solid reporting vs dashed
flow/handoff), loop-termination bounds, orchestrator kept in the loop [re-architecture — do last]. #1 two-tier review
is the natural first step in. Detail → memory `ai-manager-workflow-graph`.

## 3. Stage 3 — resume usable + memory-approval gate (HITL)  ⏸ ON HOLD (user — until needed)
Runtime already supports resume/interrupts; not reachable from the app. Wire `resumeRun` to IPC,
add a resume-on-launch banner, and `reflectNode` interrupt for a `requireMemoryApproval` setting.

## 4. Local semantic-memory RAG  (lowest)
sqlite-vec/LanceDB once an agent's memory outgrows a single prompt. (Ephemeral memory-seeded spawn
agents were folded into the now-shipped dynamic-spawn design.) The compounding-team foundation
(a + b1 + b2a + b2b) exists.

## Intentionally NOT doing
Amazon Bedrock (provider + Knowledge Bases); multiple charts within one project folder.
