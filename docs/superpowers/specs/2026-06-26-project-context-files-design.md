# Project Context Files — Upload Images/Files as Team Context

**Date:** 2026-06-26
**Status:** Approved design, ready for implementation planning
**Roadmap:** Out-of-band user request (slotted before the next checklist item). Small feature.

## Motivation

Today the only context the team gets for a goal is the goal STRING (`GoalBar` → `startRun({goal})`
→ `seedRunState` → `planPrompt`/`workerPrompt`/`reviewPrompt`) plus whatever already lives in the
project folder. There is no way for the user to hand the team reference material — a target mockup, a
screenshot of the desired UI, a PRD, an API spec, brand assets. The user wants to **upload images or
files that the team uses as additional context.**

Agents already run with `cwd: projectPath` and have full file tools — crucially, the **Read tool
renders images** — so they can already *consume* any file that lives in the project folder. The missing
pieces are: (1) a way to get the user's files INTO the project and (2) telling the agents the files are
there and what each is for. This feature adds exactly those, project-wide and persistent.

## Goals

- Attach files/images to a project as **persistent reference context** (survives across runs, available
  to every agent).
- Each attachment carries an **optional note** ("target mockup — match this layout", "API the backend
  must follow") passed to the agents so they know why the file matters.
- Two ways to add: a **top-bar "Context" button** opening a small manager panel, and **drag-and-drop**
  onto the canvas.
- Agents consume the files through their existing file tools — **no SDK multimodal plumbing.**
- A project with no context behaves byte-for-byte as today.

## Non-goals (out of scope, YAGNI)

- **Inline multimodal prompts** (base64 image content-blocks via the SDK's async-iterable message form).
  Worse fit for a multi-agent system: only the orchestrator-planner would benefit; workers/reviewers
  still read from disk; re-sends image tokens every call; text files need a separate path anyway.
- **Per-run or per-agent scoping** — context is project-level only. (Per-run/per-agent could layer on
  later; not now.)
- **Editing file contents in-app**, cloud/remote files, OCR/transcription, or carrying context inside
  the team export bundle (`team-bundle.ts` is unchanged — context is project material, not team
  knowledge, mirroring the B1 "settings not carried" decision).

## Decisions locked in brainstorming

- **Scope:** the whole project (persistent), NOT per-run or per-agent.
- **Consumption:** file-copy + system-prompt reference (approach A), NOT inline multimodal (B).
- **UI:** both a top-bar Context button (manager panel) AND canvas drag-and-drop.
- **Per-file note:** yes — an optional, editable note per file.
- **Injection point:** `composeAppend` in `agent-runner.ts` (the existing role+memory system-prompt
  builder) — so EVERY agent gets it through one seam, with no `nodes.ts` prompt edits.

## Architecture

### Data model — `shared/types.ts`

```ts
export interface ContextFile {
  id: string         // randomUUID — React key + remove/update handle
  fileName: string   // name AS STORED under .ai-manager/context/ (collision-uniquified)
  note: string       // optional user note ('' when none)
  addedAt: string    // ISO timestamp
  bytes: number      // file size, for display
  isImage: boolean   // precomputed from extension (png/jpg/jpeg/gif/webp/svg/bmp/…)
}

export interface ProjectGraph {
  // …existing fields…
  context?: ContextFile[]   // optional; defaults to [] on openProject (like linkedTeam)
}
```

`context` rides `graph.json` through the existing `saveGraph`. `openProject` already merges/normalizes
the loaded graph; it will treat a missing `context` as `[]`.

### Storage

Files are copied into **`.ai-manager/context/<fileName>`** inside the project folder (`AIM_DIR` already
exists; create `context/` lazily on first add). The path agents read is the project-relative
`.ai-manager/context/<fileName>`.

### Pure core — `src/shared/context-files.ts` (node/DOM-free, unit-tested)

Mirrors `lessons.ts` / `run-manifest.ts` — the testable heart of the feature.

```ts
export function isImageName(name: string): boolean
export function uniqueContextName(existing: string[], original: string): string  // collision suffixing: a.png → a-2.png
export function buildContextBlock(context: ContextFile[]): string
```

`buildContextBlock` returns the system-prompt section, or `''` when `context` is empty:

```
## Reference context the user provided
The user attached these reference files for this project. Read the relevant ones before you plan,
build, or review — the Read tool shows images. Treat them as authoritative context for the goal.
- .ai-manager/context/login-mockup.png (image) — target mockup, match this layout
- .ai-manager/context/api-spec.md — the API the backend must follow
```

(Image entries are tagged `(image)`; a file's note is appended after `— ` when present.)

### Injection — `agent-runner.ts`

- `buildAgentContext(agentId)` (in `project-store.ts`) gains a `context: ContextFile[]` field in its
  return (read from the current graph).
- `composeAppend(role, memory, context)` appends `buildContextBlock(context)` as a third section after
  role and memory. This is the ONLY engine change and it covers every code path that runs an agent
  (orchestration nodes, manual headless run, interactive — all go through `streamAgent`).

### Main process — `project-store.ts` (impure; `saveGraph` LAST for atomicity)

```ts
addContextFiles(sourcePaths: string[]): Promise<ProjectGraph>
//   for each path: stat for bytes, compute uniqueContextName vs existing, copy into
//   .ai-manager/context/, push a ContextFile (note ''); unreadable paths are skipped.
updateContextFile(id: string, patch: { note?: string }): Promise<ProjectGraph>
removeContextFile(id: string): Promise<ProjectGraph>
//   unlink the stored file (tolerate already-missing), drop the entry.
contextThumbnail(id: string): Promise<string | null>
//   image + under size cap (≈5 MB) → 'data:<mime>;base64,…'; else null.
```

### IPC — `ipc.ts` + `preload/index.ts` + `IPC`/`Api` in `types.ts`

| Channel | Renderer call | Behavior |
|---------|---------------|----------|
| `context:add` | `addContext(paths?)` | `paths` omitted → main opens a multi-select file dialog (`dialog.showOpenDialog`); `paths` given → drag-drop. Copies, returns updated `ProjectGraph`. |
| `context:update` | `updateContext(id, note)` | edit a note; returns graph |
| `context:remove` | `removeContext(id)` | delete; returns graph |
| `context:thumbnail` | `contextThumbnail(id)` | returns a data-URL or null |

Preload also exposes `getPathForFile(file: File): string` → `webUtils.getPathForFile(file)` (Electron 42
removed `File.path`; `webUtils` is imported in the preload, which runs with `sandbox:false`). Each
mutating channel returns the updated `ProjectGraph`; the renderer stores it (same refresh pattern as
import/`updateAgent`).

### Renderer

- **`ContextModal.tsx`** (mirrors `TeamSpawnModal`/`RoleDraftModal`): a scrollable list of attached
  files — image thumbnail (lazy `context:thumbnail`) or a lucide file icon, the file name + size, an
  editable note `<input>` (commits on blur via `updateContext`), and a remove `×`. An **"Add files"**
  button calls `addContext()` (dialog). Footer: Close.
- **Top-bar "Context" button** in `App.tsx` near Export/Import (lucide `Paperclip`), with a small count
  badge when `graph.context?.length`. Opens `ContextModal`.
- **Canvas drag-and-drop:** a drop handler on the canvas/App container — `onDragOver` shows a dashed
  "Drop files to add as context" overlay; `onDrop` maps `e.dataTransfer.files` through
  `window.api.getPathForFile(file)` to absolute paths and calls `addContext(paths)`.

## Data flow

Add (button → dialog, or drop → `getPathForFile`) → `context:add` → main copies into
`.ai-manager/context/`, records `ContextFile`, `saveGraph` → returns `ProjectGraph` → store updates →
modal/badge reflect it. On any run, `streamAgent` → `buildAgentContext` returns `context` →
`composeAppend` injects `buildContextBlock(context)` into the agent's system prompt → the agent uses the
Read tool to view the referenced files (images rendered) as it plans/builds/reviews.

## Error handling

- Unreadable/missing source path on add → skip that file, surface a non-fatal alert; the rest still add.
- `removeContextFile` tolerates an already-deleted file (drop the entry regardless).
- `buildContextBlock([])` → `''` → no system-prompt section and zero overhead → projects without context
  are byte-for-byte unchanged.
- Thumbnail generation failure or non-image → renderer shows the generic file icon.
- Drag-drop of a non-file (text/URL) → `getPathForFile` returns `''`; filter those out before `add`.

## Testing

- **Pure unit (`src/shared/context-files.test.ts`)** — the real coverage:
  - `buildContextBlock`: `[]` → `''`; renders project-relative paths; appends notes after `— `; tags
    images `(image)`; includes the read-these instruction.
  - `uniqueContextName`: no collision → unchanged; collision → `-2`, `-3` suffix before the extension.
  - `isImageName`: common image extensions true; `.md`/`.txt`/`.pdf` false; case-insensitive.
- **`project-store.test.ts`** (mocks electron, fs round-trip like existing tests): `addContextFiles`
  copies the file into `.ai-manager/context/` and records an entry; `removeContextFile` unlinks + drops;
  `updateContextFile` persists a note; uniquification on a duplicate name.
- **IPC / preload / renderer / `composeAppend`** — verified by `npm run typecheck` + `npm run build`
  (house precedent: the renderer and IPC layers are not unit-tested; pure + store logic is).

## File-by-file summary

| File | Change |
|------|--------|
| `src/shared/types.ts` | `ContextFile` interface; `ProjectGraph.context?`; `IPC` channels + `Api` methods (`addContext`/`updateContext`/`removeContext`/`contextThumbnail`/`getPathForFile`) |
| `src/shared/context-files.ts` | NEW pure module: `isImageName`, `uniqueContextName`, `buildContextBlock` |
| `src/shared/context-files.test.ts` | NEW unit tests |
| `src/main/engine/project-store.ts` | `addContextFiles`/`updateContextFile`/`removeContextFile`/`contextThumbnail`; `buildAgentContext` returns `context`; `openProject` defaults `context` to `[]` |
| `src/main/engine/project-store.test.ts` | add/remove/update + uniquification tests |
| `src/main/engine/agent-runner.ts` | `composeAppend(role, memory, context)` appends `buildContextBlock` |
| `src/main/ipc.ts` | `context:add`/`update`/`remove`/`thumbnail` handlers (dialog when no paths) |
| `src/preload/index.ts` | expose the four context methods + `getPathForFile` (webUtils) |
| `src/renderer/ContextModal.tsx` | NEW modal: list, thumbnails, editable notes, add/remove |
| `src/renderer/App.tsx` | Context top-bar button + badge; canvas drag-drop handler + overlay |
| `src/renderer/store.ts` | hold/refresh `graph.context` from the mutating IPC returns (if not already generic) |
| `src/renderer/styles.css` | context modal rows, thumbnail, drag overlay, badge |

No changes to `nodes.ts`, the run record/history, the orchestration graph, or `team-bundle.ts`.

## Risks / edge cases

- **Electron 42 dropped-file paths** — must use `webUtils.getPathForFile` (preload, `sandbox:false`),
  NOT the removed `File.path`. Flagged; the preload bridge is the mechanism.
- **`webSecurity` defaults on** → `file://` thumbnails are blocked from the app origin → thumbnails come
  from a main-process `data:`-URL IPC, not `<img src="file://…">`.
- **Prompt bloat** — many files lengthen every agent's system prompt. Mitigated: only file paths + short
  notes are injected (not contents); agents read on demand. (A future cap/summary is possible but YAGNI.)
- **Duplicate / same-name uploads** — `uniqueContextName` suffixes (`a.png` → `a-2.png`) so the store
  never overwrites.
- **Stale entry vs deleted file** — `removeContextFile` tolerates a missing file; an externally-deleted
  context file would surface as a failed agent Read (acceptable; agents handle missing files).
- **Large/binary files** — copied as-is; thumbnails skipped above the size cap; non-images never get one.
