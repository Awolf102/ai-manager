# Open Terminal + Branch Switcher — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorm) → ready for implementation plan
**Feature:** Phase-3 #11 — (1) open a plain shell terminal in the dock (not tied to an agent), and (2) a top-bar git branch chip to view + switch the project's branch.

## Summary

Two independent, low-risk additions:
1. **Plain shell terminal** — a top-bar **Shell** button opens a real login shell at the project root as a dock tab, reusing the existing PTY plumbing. Lets the user run `git`, `npm`, anything — not just agent-driven terminals.
2. **Branch switcher** — a **branch chip** by the project name shows the project's current git branch and, via a dropdown, lists + one-click-switches branches. Hidden when the folder isn't a repo; disabled (with a reason tooltip) during an active run or with a dirty tree.

Both are pure additions with **no engine/agent-run change**.

## Goals

- Give the user (and power users) a normal shell + branch control inside the app.
- Reuse the existing PTY + top-bar patterns; keep it small and safe.
- Never risk work: branch switching is gated to a clean tree + no active run, doubly (UI + main).

## Non-goals / scope

- **Shell terminal:** the user's `$SHELL` at the project root; no custom shells/profiles config, no persisted shell history beyond the process. Multiple shells allowed (each a tab labeled "Shell").
- **Branch switcher:** local branches only; **switch** (checkout) only — no create/delete/merge/stash/commit (the shell covers those). No remote fetch/pull. Never force-checkout.
- No new engine, run-path, or agent involvement.

## Part 1 — Plain shell terminal

- **Types:** widen `TerminalMode` (renderer store) from `'interactive' | 'headless'` to `'interactive' | 'headless' | 'shell'`. A shell `TerminalTab` is `{ id, agentId: '', agentName: 'Shell', mode: 'shell' }`.
- **Store:** new `openShellTerminal()` action — mirrors `openTerminal` but builds a shell tab (no agent), reuses `activeDockAfterOpenTerminal`, opens the dock.
- **Main:** `spawnShellPty(wc, { cols, rows }): Promise<{ ptyId }>` in `pty-manager.ts` — spawns `process.env.SHELL || '/bin/zsh'` as an interactive login shell (`['-il']` on posix) at `getCurrentProjectPath()`, with the existing `cleanEnv()`, registered in the same `sessions` map so `writePty`/`resizePty`/`killPty`/`onData`/`onExit` all work unchanged. New IPC channel `spawnShell` + preload + `RendererApi.spawnShell({ cols, rows }): Promise<{ ptyId }>`.
- **`TerminalPane`:** generalize the existing interactive spawn effect to also handle `'shell'`: same `term.onData → writePty` + `spawn* → onPtyData/onPtyExit` wiring; branch only on **which spawn IPC** (`spawnPty({agentId,…})` for interactive vs `spawnShell({cols,rows})` for shell) and the **exit label** (`[shell exited (code)]`). The `term-hint`/`headless-input` footers stay gated to interactive/headless (shell shows just the terminal). `tab.agentId` is unused for shell.
- **Entry point:** a top-bar **Shell** button (lucide `SquareTerminal` or `TerminalSquare`) in the same `topbar-group` as the existing **Terminal** button → `openShellTerminal()`.
- **Dock tab label** (`App.tsx` ~line 339): show **"Shell"** for a shell tab instead of `"{agentName} · shell"` — `{t.mode === 'shell' ? 'Shell' : `${t.agentName} · ${t.mode === 'headless' ? 'run' : 'shell'}`}`.

## Part 2 — Branch switcher

- **Main `git.ts`** (new engine module; `execFile('git', argv, { cwd: getCurrentProjectPath() })` — argv form, no shell, so no injection):
  - `gitInfo(): Promise<{ isRepo: boolean; branch: string; dirty: boolean; branches: string[] }>` — `rev-parse --is-inside-work-tree` (repo?), `rev-parse --abbrev-ref HEAD` (branch), `status --porcelain` (dirty = non-empty), `branch --format='%(refname:short)'` (list). Not a repo / git missing → `{ isRepo: false, branch: '', dirty: false, branches: [] }`.
  - `gitCheckout(branch: string): Promise<{ ok: boolean; error?: string }>` — re-run the dirty check; if dirty → `{ ok: false, error: 'Working tree has uncommitted changes — commit or stash first.' }`; else `git checkout <branch>` → `{ ok: true }` or `{ ok: false, error: <stderr first line> }`.
- **Pure parser** `src/shared/git-parse.ts`: `parseBranchList(text): string[]` (one branch per non-empty trimmed line; also strips a leading `* ` / `+ ` if the plain `git branch` form is used). Unit-tested. (`dirty`/`branch` are trivial trims done in `git.ts`.)
- **IPC:** `gitInfo: 'git:info'`, `gitCheckout: 'git:checkout'` + preload + `RendererApi.gitInfo()`, `RendererApi.gitCheckout(branch)`.
- **Renderer — branch chip:** a small control right after the project-name span in the top bar (`App.tsx:197`): `⎇ {branch} ▾`. Loads via `gitInfo()` on project open (and re-loads after a checkout). **Renders nothing when `!isRepo`.** Clicking opens a dropdown (reuse the existing top-bar menu pattern — e.g. `TeamMenu`/`RecentPrompts` Menu-Button style with roving keys) listing `branches`; the current branch is marked; picking a different one calls `gitCheckout`, then refreshes `gitInfo` (and toasts on error via `notify`).
  - **Disabled** (chip greyed, dropdown blocked) with a `title` tooltip when: a run is active (`run.running` → "Can't switch branches during a run") OR `dirty` ("Commit or stash your changes first"). The current branch still shows in both cases.
- The branch state lives in local component state (loaded from `gitInfo`), refreshed on project change + post-checkout; no store/graph persistence needed.

## Off / safety

- No settings flag; both features are inert until used. **No engine/agent-run path is touched.** Checkout is guarded twice (renderer disables on run/dirty; `git.ts` re-checks clean + never force). `execFile` argv form avoids shell injection. The shell PTY runs with the same env/cwd as the agent PTYs (no new privilege).

## Files touched (anticipated)

- **Shell:** `src/renderer/store.ts` (`TerminalMode` + `openShellTerminal`), `src/main/engine/pty-manager.ts` (`spawnShellPty`), `src/shared/types.ts` (`IPC.spawnShell` + `RendererApi`), `src/main/ipc.ts` + `src/preload/index.ts` (wiring), `src/renderer/terminal/TerminalPane.tsx` (shell spawn branch), `src/renderer/App.tsx` (Shell button + dock label).
- **Branch:** `src/main/engine/git.ts` (**new**), `src/shared/git-parse.ts` (**new** + test), `src/shared/types.ts` (`IPC.gitInfo`/`gitCheckout` + `RendererApi`), `src/main/ipc.ts` + `src/preload/index.ts` (wiring), `src/renderer/App.tsx` (branch chip; may extract a small `BranchChip.tsx`).
- Tests: `src/shared/git-parse.test.ts`.

## Testing plan

- **Pure unit tests (`git-parse.test.ts`):** `parseBranchList` (`%(refname:short)` form, plain `git branch` form with `* `/`+ ` markers, blank lines, CRLF, empty → []).
- **Main/wiring:** `spawnShellPty`, `gitInfo`/`gitCheckout` verified by typecheck (thin wrappers over `node-pty`/`execFile` + the tested parser; not separately unit-tested, consistent with other pty/exec code here).
- **Gates:** typecheck + test (implementers); build + lint (renderer touched) at integration; user on-device smoke — open a **Shell** (run `ls`/`git status`), and on a git-repo project: see the branch chip, open the dropdown, switch to another branch on a clean tree (verify HEAD moved), confirm the chip is disabled with the right tooltip when the tree is dirty or a run is active, and that the chip is absent on a non-repo project.

## Design-system notes

The Shell button reuses `.btn` + a lucide icon; the branch chip reuses top-bar chip styling (like `.team-link`/`.auth-pill`) + the existing menu/dropdown pattern (`TeamMenu`), tokens only; no new colors/materials. On-brand with Obsidian & Emerald; APG Menu-Button semantics for the dropdown (reuse `roving.ts`).
