# AI Manager

A macOS desktop app to assemble a team of cooperating **Claude Code agents** as an
org chart, all working inside one local project folder.

- **Orchestrator** (top) — takes the goal, plans, and reviews.
- **Manager(s)** (middle) — route tasks to the worker whose role matches.
- **Workers** (bottom) — specialists that do the implementation.

Each agent has a **role** file (its specialty/behaviour) and a **memory** file (its
learning "brain"). Every agent can be run two ways:

- **Run** — a headless Claude Agent SDK task, streamed into a terminal-style pane.
- **Terminal** — a real interactive `claude` session (a PTY) on the same folder.

This is the **foundation (v1)**: building agents, the canvas, role/memory files, and
spawning both kinds of terminals. The automatic goal → plan → delegate → review →
memory-learning loop is designed into the data model and built in later phases.

## Prerequisites

- **Node** 18+ (developed on 26.x).
- **Claude Code CLI** installed and logged in (`claude` on your PATH). The app uses
  your existing Claude Code subscription login — no API key required.

## Install & run

```bash
npm install        # also rebuilds the native node-pty for Electron (postinstall)
npm run dev        # launch the app (electron-vite dev)
```

Other scripts:

```bash
npm run build      # production build into ./out
npm run typecheck  # tsc for main + renderer
npm run rebuild:pty # re-run the node-pty native rebuild if the interactive terminal fails to spawn
```

## Using it

1. **Open a project folder.** All agents operate inside it. (Tip: `git init` it first
   so you can review/revert what the agents change.) A hidden `.ai-manager/` folder is
   created to hold the org chart and per-agent files.
2. **Add agents** (top-right). Give each a name and a role in the chain
   (orchestrator / manager / worker). An icon is chosen automatically from the name.
3. **Wire the chain.** Drag from the **bottom** handle of one node to the **top** of
   another to make it *delegate* down.
4. **Edit role & memory** in the side panel (select a node). Per agent, these live at
   `.ai-manager/agents/<slug>/role.md` and `memory.md`.
5. **Run / Terminal** from a node:
   - **Run** opens a task box — type a task, ⌘/Ctrl+Enter, and watch the streamed
     output. The agent's session id is saved; tick **resume** to continue it.
   - **Terminal** opens a live, interactive `claude` session as that agent.

## Running a goal (orchestration)

Give the **whole chain** a goal and let it coordinate:

1. Type a goal in the **goal bar** at the top and hit **Run**. The goal goes to the
   selected Orchestrator (or the only one).
2. The **Orchestrator** plans (read-only), then **Manager(s)** read their workers' roles
   and assign each task to the best match (unmatched tasks are flagged). **Workers** run in
   parallel (≤3) and do the work; results bubble back up and the Orchestrator writes a
   final report.
3. Watch it in the **Run** tab (chain tree + the selected step's output) and on the canvas
   (nodes light up: planning / assigning / working / done). **Stop** halts everything.
4. The Orchestrator then **reviews** the work (read-only) and, depending on your Settings,
   sends failed tasks back for repair and writes **wins/losses to each worker's `memory.md`**
   — so the next run starts smarter. Per-worker ✓/✗ verdicts and "🧠+N" memory notes show in
   the Run view.
5. Each run is saved to `.ai-manager/runs/<timestamp>.json`. Open **History** (clock icon in
   the top bar) to browse past runs and re-inspect any one — its plan, ✓/✗ verdicts, each
   agent's output, reflections, and final report.

**Settings** (gear in the top bar), per project:
- **Review & repair** — *Review → memory only* / *+ one repair pass* / *+ repair loop* (with
  **max attempts**, default 3).
- **Update agent memory after runs** — toggle the `memory.md` writes on/off.
- **Autonomy** — the permission level for the *acting* steps (workers, repairs, the
  Orchestrator's review-that-runs-tests, and final synthesis):
  - **Auto** (default) — runs safe commands like `pytest`/build, a classifier blocks risky ones.
  - **Full auto** — bypass all permission checks (nothing is gated).
  - **Cautious** — edits only; command execution (incl. the review's tests) is blocked.

**Permissions model:** planning and routing always run **read-only** (the Orchestrator plans
first — no edits, no commands). Everything that *acts* obeys **Autonomy** above. Because acting
agents run real commands and edits, keep the project under **git**.

## How agents are configured

- Role + memory are injected per session (role as an appended system prompt, memory as
  context), so multiple agents sharing one folder don't collide. Headless runs also load
  the project's own Claude config (`settingSources: ['project']`) for codebase context.
- Default models: Opus 4.8 for orchestrator/manager, Sonnet 4.6 for workers — change per
  agent in the side panel. Permission mode defaults to `acceptEdits`.

## Project layout

```
src/
  main/            Electron main process
    engine/        env (PATH fix), project-store, agent-runner (SDK), pty-manager
    ipc.ts         typed IPC handlers
  preload/         contextBridge -> window.api
  shared/          types + IPC contract + icon map (used by both processes)
  renderer/        React UI: canvas (React Flow), panels, terminal (xterm)
```

## Notes & roadmap

- macOS GUI apps don't inherit your shell PATH; the app recovers it from a login shell at
  startup so `claude` is found. If a terminal fails to spawn, run `npm run rebuild:pty`.
- **Phase 2 (built):** the orchestration engine — goal → plan → route by role-match →
  execute in parallel → results bubble up → final synthesis. See
  `docs/phase2-orchestration.md`.
- **Phase 3 (built):** review verdict, a configurable repair loop, and memory learning —
  workers write wins/losses to `memory.md`, loaded on the next run. See
  `docs/phase3-learning-loop.md`.
