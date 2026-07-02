# Paired Directories (`/add-dir`) — Design

**Phase-3 feature #10.** Date: 2026-07-01. Status: approved, pre-implementation.

## Goal

Let a user pair a **second working directory** with a project from a top-bar button. A paired directory is **read-only by default** (agents reference it, read on demand — no access grant) and can be opted up to **writable** (the SDK and the interactive terminal can create/edit files in it). Off/empty = **byte-for-byte** no change to any existing behavior.

## Why this shape

- `contextFolders` already implements the read-only half completely (CRUD, native picker, per-agent scoping, prompt-text injection via `buildContextBlock`), stored on `ProjectGraph`. It is read-only because paths are only *mentioned* in the system prompt; nothing is granted to the SDK.
- `additionalDirectories` (SDK `Options` field, `agent-runner.ts` `options` object) is currently **unused**; it is the *writable* grant — a single attach point that covers every headless agent run.
- The interactive terminal is a **separate** execution path (`pty-manager.ts`) using raw `claude` CLI args; it needs its own `--add-dir` flag to see any extra dir.

So #10 reuses the read-only injection wholesale and adds the writable grant at the two execution surfaces (SDK + PTY), fronted by a dedicated top-bar surface so pairing is a first-class action.

## Data model

New optional list on `ProjectGraph` (in `src/shared/types.ts`), sibling to `contextFolders`:

```ts
interface PairedDir {
  id: string
  path: string        // absolute, resolved
  writable: boolean   // default false (read-only)
  addedAt: string   // ISO timestamp (matches ContextFolder.addedAt)
}
// on ProjectGraph:
pairedDirs?: PairedDir[]
```

- Persisted in `<project>/.ai-manager/graph.json` (same atomic-write/`.bak` path as `contextFolders`).
- Default-filled on open: `graph.pairedDirs = graph.pairedDirs ?? []` (forward-compat backfill; old projects unaffected).
- **Absent/empty ⇒ byte-for-byte.**

Kept **separate** from `contextFolders` so the existing Project-context modal is undisturbed. Conceptual overlap (a read-only paired dir behaves like a context folder) is acknowledged and acceptable; the top-bar panel is the quicker "pair a working directory" entry point, with writable one click away.

## Store CRUD (`src/main/engine/project-store.ts`)

Mirror the `contextFolders` functions:

- `getPairedDirs(): PairedDir[]` — returns a copy.
- `addPairedDirs(sourcePaths: string[])` — resolve each to absolute; **reject** symlinks, non-directories, duplicates (by `path`), and the **project root itself** (redundant with `cwd`). New entries default `writable: false`. Then `saveGraph()`.
- `setPairedDirWritable(id, writable: boolean)` — flip the flag; `saveGraph()`.
- `removePairedDir(id)` — filter out; nothing on disk to delete.

Validation reuses the same shape/logic as `addContextFolders`.

## Runtime split (the core)

Pure helper (in `src/shared/` so it's importable + unit-testable, e.g. `paired-dirs.ts`):

```ts
splitPairedDirs(dirs: PairedDir[]): { writablePaths: string[]; readOnlyPaths: string[] }
```

In `src/main/engine/agent-runner.ts` (the single SDK `query({ options })` attach point):

- **Writable:** `writablePaths` → `options.additionalDirectories = writablePaths` (only when non-empty; otherwise the field is omitted entirely). Also surfaced in the system-prompt append as a **new "## Working directories (read + write)"** block (distinct guard text from the read-only one) so agents know these dirs exist and may be edited.
- **Read-only:** `readOnlyPaths` → mapped to `{ path }` entries and concatenated with the existing `contextFolders` list, then passed through the **existing** `buildContextBlock` call. They render in the same "## Referenced folders" section, read-on-demand, no SDK grant — exact reuse.
- **Empty `pairedDirs`:** no `additionalDirectories` field, no new prompt block, folders arg unchanged ⇒ `options` byte-identical.

The writable-dirs prompt block is a **new sibling pure builder** `buildWritableDirsBlock(paths: string[]): string` in `src/shared/context-files.ts` — it returns `''` when `paths` is empty, otherwise a "## Working directories (read + write)" section with its own guard line. `composeAppend` gains a `writableDirs` argument and appends `buildWritableDirsBlock(writableDirs)` after the existing context block. `buildContextBlock` itself is left **unchanged** (protects its byte-for-byte behavior); empty `writableDirs` ⇒ empty string appended ⇒ no delta.

## Interactive terminal (`src/main/engine/pty-manager.ts`)

- The interactive **`claude` PTY** (the agent terminal, built from CLI args) gets `--add-dir <path>` appended for each **writable** paired dir. Read-only dirs are **not** passed (no read-only `--add-dir` exists, and read-only = no access grant anywhere — consistent).
- Pure arg-builder helper so it's unit-testable in isolation.
- The plain `$SHELL` **shell terminal** (`spawnShellPty`) is untouched — it is not `claude`, and the user can `cd` anywhere in a shell regardless.
- Empty writable set ⇒ no flags ⇒ unchanged spawn.

## UI

New top-bar **Add-dir button** (a folder-plus icon) next to Shell / Env / Branch, opening a compact popover modeled on `BranchChip.tsx` / `TeamMenu`:

- A list of paired dirs, each row: `path`, a **Writable** checkbox (`setPairedDirWritable`), and a remove ✕ (`removePairedDir`).
- An **+ Add directory** button → native picker via a new IPC channel mirroring `addContextFolder`: `dialog.showOpenDialog({ properties: ['openDirectory', 'multiSelections'] })` in the main process; passing explicit paths (e.g. drag-drop) skips the dialog.
- An **inline caution**, shown only when ≥1 dir is writable: "Agents and the terminal can create & edit files here." (No danger-confirm — proportionate, since agent write access is already governed by autonomy/permission mode.)
- Renders nothing intrusive when the list is empty (button still present; panel shows an empty state + Add button).

New wiring, all mirroring the existing `folders:add/update/remove` seam:

- IPC channel constants `pairedDir:add` / `pairedDir:update` / `pairedDir:remove` in `types.ts` `IPC`.
- `ipcMain.handle` handlers in `src/main/ipc.ts` (add opens the picker when no paths given, mirroring `addContextFolder`).
- `RendererApi` method types in `types.ts` + preload bridge in `src/preload/index.ts`.
- New renderer component (e.g. `AddDirButton.tsx`) in the top bar.

Styling stays on-brand with the shipped Obsidian & Emerald system; reuse existing modal/popover/checkbox patterns — no new tokens/CSS beyond what those patterns provide.

## Scope (v1 decision)

Paired dirs apply to **all agents** — no per-agent scope control in the compact panel (keeps it lean; `contextFolders` retain their own scoping). Per-agent scope is addable later if needed.

## Testing

- **Pure/unit:** store CRUD + validation (absolute-resolve, reject symlink/non-dir/dupe/project-root); `splitPairedDirs`; the PTY `--add-dir` arg-builder; the writable-dirs prompt block (empty ⇒ empty string).
- **Integration:** `agent-runner` attaches `additionalDirectories` for **writable only**, merges read-only into the folders passed to `buildContextBlock`, and with an empty list leaves `options` **byte-identical**; PTY spawn args gain `--add-dir` for writable only and are unchanged when empty.
- **Light component test:** the panel (add / toggle-writable / remove).
- Update `settings-defaults.test.ts` / `types.test.ts` only if the graph shape assertions require it.

## Byte-for-byte guarantee

Empty `pairedDirs` ⇒ no `additionalDirectories` field, no PTY flags, no prompt delta, and the `contextFolders` / HITL / shell-terminal paths are untouched.

## Out of scope (v1)

- Per-agent scoping of paired dirs.
- A `--add-dir` equivalent for the plain `$SHELL` shell terminal (not applicable).
- Any change to the existing Project-context "Referenced folders" feature.
- Read-only *enforcement* of writable dirs beyond the standard autonomy/permission posture (writable grants SDK/CLI access; write-prevention on read-only relies on not granting access + the existing folder guard, exactly as `contextFolders` do today).
