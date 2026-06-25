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
- **Decisions:** Bedrock dropped (provider + Knowledge Bases). Multi-chart-within-a-project dropped.

---

## 1. Compounding-team (b) — portable team across folders  ← NEXT (bigger — brainstorm before building)
Carry a roster + its memories across project folders (today a team is folder-locked; stopgap = copy
`.ai-manager/graph.json` + `agents/`). *Where:* `project-store.ts` storage model — needs its own
design pass. **Now unblocked:** sub-project (a) lesson tagging is done, so B can carry only `[portable]`
lessons and treat untagged as project-specific (don't transfer) per the documented asymmetry.

## 2. Stage 3 — resume usable + memory-approval gate (HITL)  ⏸ ON HOLD (user — until needed)
Runtime already supports resume/interrupts; not reachable from the app. Wire `resumeRun` to IPC,
add a resume-on-launch banner, and `reflectNode` interrupt for a `requireMemoryApproval` setting.

## 3. Deferred to the dynamic-spawn era  (lowest)
Local semantic-memory RAG (sqlite-vec/LanceDB) once memory outgrows a prompt; ephemeral
memory-seeded spawn agents. Need #1 first.

## Intentionally NOT doing
Amazon Bedrock (provider + Knowledge Bases); multiple charts within one project folder.
