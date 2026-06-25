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
- **Decisions:** Bedrock dropped (provider + Knowledge Bases). Multi-chart-within-a-project dropped.

---

## 1. Dynamic agent spawning — orchestrator CREATES the team  ← NEXT (bigger — brainstorm before building)
The named follow-on to role-drafting: the orchestrator reads the goal and creates the agents (+ topology
+ roles), not just roles for a team you placed. Reverses the manual free-form default, so it needs its
own design pass. Partly unblocked — role-authoring (done) is the role half; this adds creating the nodes.

## 2. Stage 3 — resume usable + memory-approval gate (HITL)  ⏸ ON HOLD (user — until needed)
Runtime already supports resume/interrupts; not reachable from the app. Wire `resumeRun` to IPC,
add a resume-on-launch banner, and `reflectNode` interrupt for a `requireMemoryApproval` setting.

## 3. Local semantic-memory RAG  (lowest)
sqlite-vec/LanceDB once an agent's memory outgrows a single prompt. (Ephemeral memory-seeded spawn
agents fold into #1's dynamic-spawn design.) The compounding-team foundation (a + b1 + b2a + b2b) exists.

## Intentionally NOT doing
Amazon Bedrock (provider + Knowledge Bases); multiple charts within one project folder.
