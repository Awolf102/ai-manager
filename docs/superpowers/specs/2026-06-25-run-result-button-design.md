# Run Result Button — Launch and Open the Built App

**Date:** 2026-06-25
**Status:** Approved design, ready for implementation planning
**Roadmap:** "Run result" button (#3). A UX/polish quick-win that closes the loop — the agents build a
runnable artifact and the user is one click from seeing it, instead of dropping to a terminal.

## Motivation

Today, after the agents build a web app, the user manually opens a terminal, figures out the start
command (`npm run dev`, `flask run`, …), runs it, and opens `localhost:PORT` in a browser. This is the
slowest part of the live-smoke loop. The "Run result" button makes it one click: detect how to launch
the built app, let the user confirm/fix the command, launch the server, and open it in the browser.

## Goals

- A **Run result** button (GoalBar) that, on click, runs a **read-only detection agent** to figure out
  the start command + port + entry path for the built app, shown in an **editable preview**.
- A **Launch** action that spawns the server, streams its logs into the app, waits for the port to
  accept connections, then opens `http://localhost:PORT<path>` in the system browser.
- **Process lifecycle**: a Stop button; kill on app quit and on project switch; one launched server at a
  time (a new launch stops the previous one).
- Detection and launch are **two distinct, independently testable steps** — the launch runtime does not
  depend on the agent.

## Non-goals (out of scope)

- **Capturing the manifest during the run** (augmenting synth). Detection is on-demand at click time —
  it works from any open project, including older runs, and stays out of the core run loop.
- **In-app webview** rendering. v1 opens the **system browser** (`shell.openExternal`). The design keeps
  the URL/port flowing through a `server:ready` event so an Electron webview can subscribe later with no
  rework, but the webview itself is not built now.
- **CLI / library "run"** beyond a folder-open fallback. For `cli`/`library`/`unknown` types the modal
  explains it's not a web app and offers **Open project folder** (`shell.openPath`). The existing
  interactive PTY terminal already covers running CLIs separately; we do **not** auto-wire it here.
- **A persisted manifest / settings.** No new `ProjectSettings` field; detection is recomputed per click
  (the editable preview is the override).
- **Multi-server / port management UI.** One server tracked at a time; port collisions surface as the
  server's own stderr and the user edits the port in the preview.

## Decisions locked in brainstorming

- **On-click detection agent** (not heuristics, not in-run capture) → editable preview → launch. Mirrors
  the Draft-roles / Build-team pattern.
- **System browser now, webview later** — built so the webview can drop in via the `server:ready` event.
- **v1 scope = `web` + `static`** launch + open; **`cli`/`library`/`unknown` → Open-project-folder
  fallback**, no CLI-terminal wiring.
- **Static collapses into the launch path** — the detector emits a serving command (e.g.
  `python3 -m http.server 8000`) rather than `file://`, so the served result honors the static-path
  render-verify lesson (relative asset paths resolve the same way the reviewer saw them).

## Architecture

Three layers + UI, mirroring `role-drafter` / `team-spawner`, plus one genuinely new runtime piece
(`server-manager`) modeled on `pty-manager`:

| Layer | File | Mirrors |
|------|------|---------|
| Pure prompt/parse (no node/DOM) | `src/shared/run-manifest.ts` | `shared/role-draft.ts`, `shared/team-spawn.ts` |
| Read-only detection agent (seam) | `src/main/engine/manifest-detector.ts` | `engine/role-drafter.ts`, `engine/team-spawner.ts` |
| Server runtime (impure) | `src/main/engine/server-manager.ts` | `engine/pty-manager.ts` |
| UI | `src/renderer/run/RunResultModal.tsx` + GoalBar button | `RoleDraftModal.tsx` / `TeamSpawnModal.tsx` |

### Shared type — `src/shared/types.ts`

```ts
/** How to launch and open the app the agents built. Produced by the detection agent,
 *  editable in the preview, replayed by the server runtime. */
export interface RunManifest {
  type: 'web' | 'static' | 'cli' | 'library' | 'unknown'
  startCommand: string   // e.g. "npm run dev", "flask run", "python3 -m http.server 8000"
  port?: number          // e.g. 5173, 5000, 8000
  path?: string          // entry path, default "/"
  notes?: string         // why it chose this / caveats, shown in the preview
}
```
Plus IPC channels `manifest:detect`, `server:launch`, `server:stop`, and events `server:log`,
`server:status`, `server:ready`; and the matching `RendererApi` methods (below). `RunManifest` lives in
`types.ts` so `run-manifest.ts`, `manifest-detector.ts`, `server-manager.ts`, `RendererApi`, and the
renderer all import it without a circular dependency.

### Pure core — `src/shared/run-manifest.ts`

```ts
export function detectManifestPrompt(
  goal: string,
  projectFiles: string,   // a listing / digest: package.json scripts, requirements.txt, app.py, index.html presence
  lastRunReport: string    // the most recent run's `final` text, or "" if none
): string

export function parseManifest(text: string): RunManifest | null
```

- `detectManifestPrompt` asks the agent to inspect the project and emit a single JSON manifest for how to
  **launch and open** the built app: `type`, `startCommand`, `port`, `path`, `notes`. It instructs: for a
  static site with no server, emit a serving command (`python3 -m http.server <port>`) rather than a file
  path; pick the conventional port for the framework if not configured; default `path` to `"/"`; set
  `type: "cli"`/`"library"`/`"unknown"` (with empty `startCommand` allowed) when there's nothing to serve.
  JSON shape: `{ "type", "startCommand", "port", "path", "notes" }`.
- `parseManifest`: parse the last ```json block; coerce `type` to one of the five (unknown values →
  `"unknown"`); `startCommand` trimmed string (may be empty); `port` a positive integer or undefined;
  `path` defaults to `"/"` and is normalized to start with `/`; `notes` optional string. Returns `null`
  only if no JSON object is found.

### Read-only detection — `src/main/engine/manifest-detector.ts`

```ts
export type AgentRunner = (opts: StreamAgentOptions) => Promise<{ text: string; sessionId?: string }>

export async function detectManifest(
  opts: { goal: string; orchestratorId: string; wc: WebContents; abort: AbortController; runId: string },
  runAgent?: AgentRunner // defaults to streamAgent; injected in tests
): Promise<RunManifest>
```
Gathers a project-files digest (read the project path's `package.json` scripts, presence of
`requirements.txt` / `app.py` / `index.html`, etc.) and the last run's `final` report (via the existing
run-loading helpers, best-effort `""` if none), builds `detectManifestPrompt(...)`, runs the orchestrator
**read-only** (`permissionMode: 'default'`, `disallowedTools: THINK_DISALLOW`, `header: false`), parses
with `parseManifest`, retries once with a strict reminder, then throws. Returns the validated manifest —
**launches nothing**. (The agent may also use its own read tools to inspect files; the digest just seeds it.)

### Server runtime — `src/main/engine/server-manager.ts`

```ts
export function launchServer(
  wc: WebContents,
  input: { startCommand: string; port?: number; path?: string }
): { serverId: string }
export function stopServer(serverId: string): void
export function killAllServers(): void
```
Modeled on `pty-manager.ts` (a `Map<string, { proc }>` of tracked processes) but using
`child_process.spawn(startCommand, { shell: true, detached: true, cwd: projectPath, env: cleanEnv() })`
so shell forms like `"npm run dev"` work **and** the server can be killed cleanly: with `shell: true`
the spawned process is a shell whose child is the actual server, so killing the shell PID alone can
orphan the server. `detached: true` puts them in a new process group; `stopServer` kills the whole group
via `process.kill(-proc.pid, 'SIGTERM')` (negative PID = group), falling back to `proc.kill()` if the
group kill throws.
- Tracks the process; streams **stdout + stderr** to the renderer as `server:log` events (so the user
  sees the server's own output/errors).
- Emits `server:status` (`'starting' | 'running' | 'exited' | 'error'`).
- If `port` is set, **polls the TCP port** (`net.connect`, short interval, bounded timeout) until it
  accepts a connection → emits `server:ready` with `{ url: 'http://localhost:<port><path>' }` and calls
  `shell.openExternal(url)`. If the port never opens before the timeout (or the process exits first),
  emits `server:status: 'error'` and leaves the logs visible — no browser open.
- `stopServer` kills the tracked process group (see above). **One server at a time:** a new
  `launchServer` stops any currently-tracked server first.
- `killAllServers()` is wired to Electron `before-quit` and to project-switch (in the open-project flow)
  so no orphan servers survive.

`shell.openExternal` is already imported in `src/main/index.ts`; the open call lives in/near the runtime.

### IPC + preload

- `manifest:detect` handler: `detectManifest({ goal, orchestratorId, wc: e.sender, abort: new AbortController(), runId: 'detect-manifest' })` in try/catch → `{ ok: true, manifest }` / `{ ok: false, error }`.
- `server:launch` handler (invoke): `server-manager.launchServer(e.sender, input)` → `{ serverId }`.
- `server:stop` handler (invoke or send): `server-manager.stopServer(serverId)`.
- `app:openPath` handler (send): `shell.openPath(getCurrentProjectPath())` — the non-web fallback.
- Event channels `server:log`, `server:status`, `server:ready` pushed via `wc.send` (subscribed in the
  renderer with the existing `sub<T>` preload helper, like `onPtyData`/`onPtyExit`).
- `RendererApi`:
  - `detectManifest: (input: { goal: string; orchestratorId: string }) => Promise<{ ok: boolean; manifest?: RunManifest; error?: string }>`
  - `launchServer: (input: { startCommand: string; port?: number; path?: string }) => Promise<{ serverId: string }>`
  - `stopServer: (serverId: string) => void`
  - `onServerLog: (cb: (e: { serverId: string; data: string }) => void) => () => void`
  - `onServerStatus: (cb: (e: { serverId: string; status: ServerStatus }) => void) => () => void`
  - `onServerReady: (cb: (e: { serverId: string; url: string }) => void) => () => void`
  - `openProjectPath: () => void` — the non-web fallback (`app:openPath`)

### Renderer

- **`GoalBar.tsx`**: a **Run result** button (lucide `Rocket`) next to Build team. Enabled when a project
  is open and no orchestration run is in progress. Click → spinner → `window.api.detectManifest(...)` →
  open the modal with the detected manifest, or `window.alert(error)`.
- **`RunResultModal.tsx`** (new): shows the manifest with **editable** `startCommand`, `port`, `path`
  fields and read-only `type` + `notes`. For `web`/`static`: a **Launch** button → `launchServer(...)`,
  after which the modal shows a **live log pane** (subscribes to `server:log`), a status line that
  advances `starting → waiting for port → opening browser → running` (from `server:status`/`server:ready`),
  and a **Stop** button (`stopServer`). For `cli`/`library`/`unknown`: a short explanation + an **Open
  project folder** button backed by a small new `app:openPath` IPC (`shell.openPath(projectPath)`)
  instead of Launch. Closing the modal does not stop the server; Stop is explicit (and quit/project-switch
  kill it). Mirrors the structure of `TeamSpawnModal`.

## Data flow

Run result → `manifest:detect` → `detectManifest` (project digest + last-run report → prompt →
orchestrator read-only → `parseManifest`, retry once) → manifest → editable preview → Launch →
`server:launch` → `launchServer` (spawn + stream logs + poll port) → `server:ready` → `shell.openExternal`
→ browser opens the running app. Stop → `server:stop` → process killed.

## Error handling

- **No orchestrator / no project / a run active:** button disabled with a hint.
- **Unparseable manifest after one retry:** `{ ok: false, error }`; nothing launched.
- **Non-web type:** no Launch; Open-project-folder fallback offered.
- **Server fails to bind / wrong port / crashes on start:** stderr streamed to the log pane; `server:status`
  → `error`; no browser open. User edits the port/command and re-launches.
- **Port never becomes ready before timeout:** `error` status, logs left visible, no browser open.
- **App quit / project switch while a server runs:** `killAllServers()` kills it (no orphans).
- Detection is read-only; only Launch spawns a process; only Stop/quit kills it.

## Testing

- `src/shared/run-manifest.test.ts` (new): `detectManifestPrompt` includes the goal, the JSON shape, the
  static→serve-command instruction, and the default-path rule; `parseManifest` parses a valid manifest,
  tolerates a fenced ```json block, coerces an unknown `type` → `"unknown"`, defaults/normalizes `path`,
  drops a non-positive `port`, and returns `null` on no JSON.
- `src/main/engine/manifest-detector.test.ts` (new): mock `project-store` (current project + run loading)
  and inject a canned `runAgent` returning a manifest JSON; assert `detectManifest` returns the validated
  manifest and **retries-once-then-throws** on bad output (mirrors `role-drafter.test` / `team-spawner.test`).
- `src/main/engine/server-manager.ts`: follows the `pty-manager` precedent (impure `child_process`, not
  unit-tested). Verified by `typecheck` + `build` + live smoke. *(Optional, if desired: one test that
  spawns a trivial `node -e` HTTP server and asserts a `server:ready` event + opened URL — decide at plan
  time.)*
- IPC / preload / renderer (button + modal) verified by `typecheck` + `build`.

## File-by-file summary

| File | Change |
|------|--------|
| `src/shared/types.ts` | `RunManifest` + `ServerStatus` types; 4 IPC channels (`manifest:detect`, `server:launch`, `server:stop`, `app:openPath`) + 3 event channels; ~7 `RendererApi` methods |
| `src/shared/run-manifest.ts` | **new** — `detectManifestPrompt`, `parseManifest` |
| `src/shared/run-manifest.test.ts` | **new** — pure tests |
| `src/main/engine/manifest-detector.ts` | **new** — `detectManifest` (read-only detection, seam) |
| `src/main/engine/manifest-detector.test.ts` | **new** — seam tests |
| `src/main/engine/server-manager.ts` | **new** — `launchServer` / `stopServer` / `killAllServers` |
| `src/main/ipc.ts` | `manifest:detect`, `server:launch`, `server:stop`, `app:openPath` handlers |
| `src/main/index.ts` | wire `killAllServers()` to `before-quit` |
| `src/main/engine/project-store.ts` | call `killAllServers()` on project switch (if not handled in index) |
| `src/preload/index.ts` | expose detect/launch/stop + the 3 event subscriptions |
| `src/renderer/run/GoalBar.tsx` | Run-result button + open the modal |
| `src/renderer/run/RunResultModal.tsx` | **new** — editable manifest preview + live log/launch pane |
| `src/renderer/styles.css` | modal + log-pane styling (follow existing modal CSS) |

No changes to the orchestration graph, run model, or the team/brain features.

## Risks / edge cases

- **Wrong start command / port** — the editable preview is the guard; the streamed logs make a bad guess
  obvious, and the user re-launches after editing.
- **Long-running orphan processes** — mitigated by `killAllServers()` on quit + project switch and the
  one-server-at-a-time rule; Stop is always available.
- **Readiness detection across frameworks** — TCP-port polling is framework-agnostic (works for any
  server that binds the port); the bounded timeout + visible logs cover the cases where it never binds.
- **Static sites served vs `file://`** — serving (not `file://`) is deliberate so relative asset paths
  resolve as the reviewer saw them (the static-path render-verify lesson).
- **A goal with no runnable result** (pure library/CLI) — detected as `cli`/`library`/`unknown`; the
  folder-open fallback keeps the button useful without pretending to serve something.
