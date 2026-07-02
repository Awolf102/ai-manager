# Open Terminal + Branch Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add (1) a top-bar Shell button that opens a plain login shell at the project root as a dock tab, and (2) a top-bar git branch chip that shows + switches the project's branch (gated to a clean tree + no active run).

**Architecture:** Two independent additions. Shell: a new `'shell'` `TerminalMode` + `openShellTerminal` store action + a `spawnShellPty` sibling to the agent PTY (reusing all the write/resize/kill/data/exit plumbing) + a `TerminalPane` branch. Branch: a `git.ts` engine module over `execFile('git', …)` + a pure `parseBranchList` + a `BranchChip` component modeled on `TeamMenu`. Zero engine/agent-run change.

**Tech Stack:** TypeScript, Electron (electron-vite), React 19, `node-pty`, `@xterm/xterm`, Vitest.

## Global Constraints

- **No engine/agent-run change.** Nothing here touches the orchestration engine, agent-runner, or run paths. Both features are inert until the user clicks them.
- **Shell = the user's `$SHELL` at the project root** (`getCurrentProjectPath()`), interactive login shell (`['-il']` on posix), reusing `pty-manager`'s existing `sessions` map + `writePty`/`resizePty`/`killPty`/`ptyData`/`ptyExit`.
- **Branch switching is doubly guarded:** the renderer disables it during an active run (`run.running`) and on a dirty tree; `gitCheckout` in main re-checks the tree is clean and NEVER force-checkouts. `execFile` argv form (no shell) — no injection.
- **Branch chip renders nothing when the folder isn't a git repo.**
- **Exact shapes:** `TerminalMode` gains `'shell'`; shell tab `{ id, agentId: '', agentName: 'Shell', mode: 'shell' }`; `spawnShellPty(wc, { cols, rows }): Promise<{ ptyId }>`; IPC `spawnShell: 'pty:spawnShell'`, `gitInfo: 'git:info'`, `gitCheckout: 'git:checkout'`; `gitInfo(): Promise<{ isRepo: boolean; branch: string; dirty: boolean; branches: string[] }>`; `gitCheckout(branch): Promise<{ ok: boolean; error?: string }>`; `parseBranchList(text): string[]`.
- **On-brand:** reuse `.btn`, the `topmenu`/`topmenu-list` dropdown pattern + `roving.ts`, lucide icons (`SquareTerminal`, `GitBranch`, `ChevronDown`), tokens; no new CSS/colors.
- **Gates:** implementers run `npm run typecheck` + `npm run test`; controller runs `npm run build` + `npm run lint` at integration; user runs the on-device smoke.
- **Commit trailer:** end commits with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Branch: `feat/shell-terminal-branch`.

---

### Task 1: Shell PTY backend + store action + IPC wiring

**Files:**
- Modify: `src/main/engine/pty-manager.ts` (`spawnShellPty`), `src/shared/types.ts` (`IPC.spawnShell` + `RendererApi.spawnShell`), `src/main/ipc.ts` (handler), `src/preload/index.ts` (method), `src/renderer/store.ts` (`TerminalMode` + `openShellTerminal` + its action-type)

**Interfaces:**
- Produces: `spawnShellPty(wc, { cols, rows }): Promise<{ ptyId: string }>`; `window.api.spawnShell({ cols, rows }): Promise<{ ptyId }>`; store `openShellTerminal(): void`; `TerminalMode` includes `'shell'`.

> Thin PTY/store wiring — verified by `npm run typecheck` (no unit test; consistent with the existing `spawnPty`/`openTerminal` which have none).

- [ ] **Step 1: Add `spawnShellPty` to `pty-manager.ts`**

Add `getCurrentProjectPath` to the existing `./project-store` import. After `spawnPty` (ends ~line 59), add:

```ts
/** Spawn a plain interactive login shell at the project root (no agent). Reuses the
 *  same sessions map + writePty/resizePty/killPty/ptyData/ptyExit plumbing. */
export async function spawnShellPty(
  wc: WebContents,
  input: { cols: number; rows: number }
): Promise<{ ptyId: string }> {
  const ptyId = randomUUID()
  const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')
  const args = process.platform === 'win32' ? [] : ['-il']
  const proc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: Math.max(2, input.cols || 80),
    rows: Math.max(2, input.rows || 24),
    cwd: getCurrentProjectPath(),
    env: cleanEnv()
  })
  sessions.set(ptyId, { proc })
  proc.onData((data) => {
    if (!wc.isDestroyed()) wc.send(IPC.ptyData, { ptyId, data })
  })
  proc.onExit(({ exitCode }) => {
    sessions.delete(ptyId)
    if (!wc.isDestroyed()) wc.send(IPC.ptyExit, { ptyId, exitCode })
  })
  return { ptyId }
}
```

- [ ] **Step 2: Add the IPC channel + RendererApi type**

In `src/shared/types.ts`, in the `IPC` const (near `spawnPty: 'pty:spawn'`), add:
```ts
  spawnShell: 'pty:spawnShell',
```
In `interface RendererApi` (near `spawnPty`), add:
```ts
  spawnShell: (input: { cols: number; rows: number }) => Promise<{ ptyId: string }>
```

- [ ] **Step 3: Add the IPC handler**

In `src/main/ipc.ts`, after the existing `spawnPty` handler (`ipcMain.handle(IPC.spawnPty, (e: IpcMainInvokeEvent, input: SpawnPtyInput) => ptyMgr.spawnPty(e.sender, input))`), add — matching that exact typed-`e.sender` form (`IpcMainInvokeEvent` is already imported at the top of the file):
```ts
  ipcMain.handle(IPC.spawnShell, (e: IpcMainInvokeEvent, input: { cols: number; rows: number }) =>
    ptyMgr.spawnShellPty(e.sender, input)
  )
```

- [ ] **Step 4: Add the preload method**

In `src/preload/index.ts`, near `spawnPty`, add:
```ts
  spawnShell: (input) => ipcRenderer.invoke(IPC.spawnShell, input),
```

- [ ] **Step 5: Widen `TerminalMode` + add `openShellTerminal` to the store**

In `src/renderer/store.ts`:
- Change `export type TerminalMode = 'interactive' | 'headless'` to `export type TerminalMode = 'interactive' | 'headless' | 'shell'`.
- Add `openShellTerminal: () => void` to the store actions interface (near `openTerminal: (agent: AgentNodeData, mode: TerminalMode) => void`).
- Add the action (right after `openTerminal`'s definition, ~line 210):
```ts
  openShellTerminal: () =>
    set((s) => {
      const id = `term-${++counter}`
      const tab: TerminalTab = { id, agentId: '', agentName: 'Shell', mode: 'shell' }
      const activeDockId = activeDockAfterOpenTerminal({
        running: s.run.running,
        currentActive: s.activeDockId,
        newTermId: id
      })
      return { terminals: [...s.terminals, tab], activeDockId, dockOpen: true }
    }),
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/engine/pty-manager.ts src/shared/types.ts src/main/ipc.ts src/preload/index.ts src/renderer/store.ts
git commit -m "feat(shell): spawnShellPty + openShellTerminal + IPC

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: TerminalPane shell branch + App Shell button + dock label

**Files:**
- Modify: `src/renderer/terminal/TerminalPane.tsx` (spawn effect handles `'shell'`; resize effect; exit label), `src/renderer/App.tsx` (import + `openShellTerminal` + Shell button + dock tab label)

**Interfaces:**
- Consumes: `window.api.spawnShell` (Task 1); store `openShellTerminal` (Task 1).

> Renderer JSX — verified by typecheck + lint + build + on-device smoke.

- [ ] **Step 1: Generalize the live-PTY spawn effect for shell**

In `src/renderer/terminal/TerminalPane.tsx`, the interactive spawn effect starts `if (tab.mode !== 'interactive') return`. Change it to also run for `'shell'`, and branch the spawn call + exit label. Replace the effect body from the guard through the `.catch(...)` with:

```tsx
  // Interactive claude OR plain shell: spawn a live PTY and wire I/O.
  useEffect(() => {
    if (tab.mode !== 'interactive' && tab.mode !== 'shell') return
    const term = termRef.current!
    let unsubData: (() => void) | undefined
    let unsubExit: (() => void) | undefined
    const label = tab.mode === 'shell' ? 'shell' : 'claude'

    const input = term.onData((d) => {
      if (ptyIdRef.current) window.api.writePty(ptyIdRef.current, d)
    })

    setBusy(true)
    const spawn =
      tab.mode === 'shell'
        ? window.api.spawnShell({ cols: term.cols, rows: term.rows })
        : window.api.spawnPty({ agentId: tab.agentId, cols: term.cols, rows: term.rows, resume })
    void spawn
      .then(({ ptyId }) => {
        ptyIdRef.current = ptyId
        unsubData = window.api.onPtyData((e) => {
          if (e.ptyId === ptyId) term.write(e.data)
        })
        unsubExit = window.api.onPtyExit((e) => {
          if (e.ptyId === ptyId) {
            term.write(`\r\n\x1b[2m[${label} exited (${e.exitCode})]\x1b[0m\r\n`)
            setBusy(false)
          }
        })
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        term.write(`\r\n\x1b[31m[failed to start ${label}: ${msg}]\x1b[0m\r\n`)
        setBusy(false)
      })

    return () => {
      input.dispose()
      unsubData?.()
      unsubExit?.()
      if (ptyIdRef.current) window.api.killPty(ptyIdRef.current)
      ptyIdRef.current = null
    }
    // resume captured once at spawn time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
```

Also, in the ResizeObserver effect near the top (the `new ResizeObserver(() => { ... if (tab.mode === 'interactive' && ptyIdRef.current) ...})`), change the condition to include shell:
```tsx
      if ((tab.mode === 'interactive' || tab.mode === 'shell') && ptyIdRef.current) {
        window.api.resizePty(ptyIdRef.current, term.cols, term.rows)
      }
```

(Leave the `term-hint` / `headless-input` footers as-is — they stay gated to `interactive`/`headless`, so a shell pane shows just the terminal.)

- [ ] **Step 2: Add the Shell button + dock label in `App.tsx`**

- Add `SquareTerminal` to the `lucide-react` import.
- Add `const openShellTerminal = useStore((s) => s.openShellTerminal)` with the other store selectors.
- In the `topbar-group` that holds the Terminal button, add a Shell button immediately before the Terminal toggle button:
```tsx
          <button className="btn" title="Open a shell at the project root" onClick={() => openShellTerminal()}><SquareTerminal size={14} /> Shell</button>
```
- Change the dock tab label (the `<span className="dot" /> {t.agentName} · {t.mode === 'headless' ? 'run' : 'shell'}` line) to:
```tsx
                      <span className="dot" /> {t.mode === 'shell' ? 'Shell' : `${t.agentName} · ${t.mode === 'headless' ? 'run' : 'shell'}`}
```

- [ ] **Step 3: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/terminal/TerminalPane.tsx src/renderer/App.tsx
git commit -m "feat(shell): TerminalPane shell branch + top-bar Shell button

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Pure `shared/git-parse.ts`

**Files:**
- Create: `src/shared/git-parse.ts`
- Test: `src/shared/git-parse.test.ts`

**Interfaces:**
- Produces: `parseBranchList(text: string): string[]`.

- [ ] **Step 1: Write the failing test**

Create `src/shared/git-parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseBranchList } from './git-parse'

describe('parseBranchList', () => {
  it('parses the --format=%(refname:short) form (clean lines)', () => {
    expect(parseBranchList('main\nfeature/x\ndev\n')).toEqual(['main', 'feature/x', 'dev'])
  })
  it('strips the leading "* "/"+ " markers of plain `git branch`', () => {
    expect(parseBranchList('* main\n  dev\n+ wt-branch')).toEqual(['main', 'dev', 'wt-branch'])
  })
  it('drops a detached-HEAD parenthetical line and blanks; handles CRLF', () => {
    expect(parseBranchList('* (HEAD detached at abc123)\r\n  main\r\n\r\n')).toEqual(['main'])
  })
  it('empty input → []', () => {
    expect(parseBranchList('')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/git-parse.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the module**

Create `src/shared/git-parse.ts`:

```ts
// Pure parsing of `git branch` output. No node/DOM imports — unit-tested in plain Node.
// Handles both `--format=%(refname:short)` (clean names) and plain `git branch`
// (with a leading '* '/'+ ' current/worktree marker + a "(HEAD detached…)" line).

export function parseBranchList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[*+]\s+/, '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('('))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/git-parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/git-parse.ts src/shared/git-parse.test.ts
git commit -m "feat(branch): parseBranchList pure parser

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Main `git.ts` + IPC wiring

**Files:**
- Create: `src/main/engine/git.ts`
- Modify: `src/shared/types.ts` (`IPC.gitInfo`/`gitCheckout` + `RendererApi`), `src/main/ipc.ts` (2 handlers), `src/preload/index.ts` (2 methods)

**Interfaces:**
- Consumes: `parseBranchList` (Task 3); `getCurrentProjectPath` (project-store).
- Produces: `gitInfo(): Promise<{ isRepo: boolean; branch: string; dirty: boolean; branches: string[] }>`; `gitCheckout(branch: string): Promise<{ ok: boolean; error?: string }>`; `window.api.gitInfo()` / `window.api.gitCheckout(branch)`.

> Thin `execFile` wiring over the tested parser — verified by `npm run typecheck` (no unit test; consistent with `auth.ts`, which also shells out and has none).

- [ ] **Step 1: Create `git.ts`**

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getCurrentProjectPath } from './project-store'
import { parseBranchList } from '../../shared/git-parse'

const exec = promisify(execFile)
const git = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
  exec('git', args, { cwd: getCurrentProjectPath(), timeout: 8000 })

export async function gitInfo(): Promise<{ isRepo: boolean; branch: string; dirty: boolean; branches: string[] }> {
  try {
    await git(['rev-parse', '--is-inside-work-tree'])
  } catch {
    return { isRepo: false, branch: '', dirty: false, branches: [] }
  }
  const [branch, status, branchList] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']).then((r) => r.stdout.trim()).catch(() => ''),
    git(['status', '--porcelain']).then((r) => r.stdout).catch(() => ''),
    git(['branch', '--format=%(refname:short)']).then((r) => r.stdout).catch(() => '')
  ])
  return { isRepo: true, branch, dirty: status.trim() !== '', branches: parseBranchList(branchList) }
}

export async function gitCheckout(branch: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { stdout } = await git(['status', '--porcelain'])
    if (stdout.trim() !== '') {
      return { ok: false, error: 'Working tree has uncommitted changes — commit or stash first.' }
    }
    await git(['checkout', branch])
    return { ok: true }
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr
    const msg = (stderr && stderr.trim()) || (err instanceof Error ? err.message : String(err))
    return { ok: false, error: String(msg).split('\n')[0].trim() || 'checkout failed' }
  }
}
```

- [ ] **Step 2: Add IPC channels + RendererApi types**

In `src/shared/types.ts`, in the `IPC` const, add:
```ts
  gitInfo: 'git:info',
  gitCheckout: 'git:checkout',
```
In `interface RendererApi`, add:
```ts
  gitInfo: () => Promise<{ isRepo: boolean; branch: string; dirty: boolean; branches: string[] }>
  gitCheckout: (branch: string) => Promise<{ ok: boolean; error?: string }>
```

- [ ] **Step 3: Add the IPC handlers**

In `src/main/ipc.ts`, add `import * as gitEngine from './engine/git'` (near the other `import * as … from './engine/…'`), and add:
```ts
  ipcMain.handle(IPC.gitInfo, () => gitEngine.gitInfo())
  ipcMain.handle(IPC.gitCheckout, (_e, branch: string) => gitEngine.gitCheckout(branch))
```

- [ ] **Step 4: Add the preload methods**

In `src/preload/index.ts`, add:
```ts
  gitInfo: () => ipcRenderer.invoke(IPC.gitInfo),
  gitCheckout: (branch: string) => ipcRenderer.invoke(IPC.gitCheckout, branch),
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/shared/git-parse.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/engine/git.ts src/shared/types.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat(branch): git.ts gitInfo/gitCheckout + IPC

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `BranchChip` renderer + App mount

**Files:**
- Create: `src/renderer/BranchChip.tsx`
- Modify: `src/renderer/App.tsx` (import + mount after the project-name span)

**Interfaces:**
- Consumes: `window.api.gitInfo()` / `window.api.gitCheckout(branch)` (Task 4); store `run.running`, `graph.project.path`, `notify`; `roving.ts`.

> Renderer JSX — verified by typecheck + lint + build + on-device smoke.

- [ ] **Step 1: Create `BranchChip.tsx`** (models `TeamMenu`'s dropdown + roving keys)

```tsx
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, GitBranch } from 'lucide-react'
import { useStore } from './store'
import { rovingIndex } from './roving'

interface GitInfo { isRepo: boolean; branch: string; dirty: boolean; branches: string[] }

export default function BranchChip() {
  const projectPath = useStore((s) => s.graph?.project.path)
  const running = useStore((s) => s.run.running)
  const notify = useStore((s) => s.notify)
  const [info, setInfo] = useState<GitInfo | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const refresh = (): void => { void window.api.gitInfo().then(setInfo) }
  useEffect(() => { refresh() }, [projectPath])
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!info?.isRepo) return null

  const disabled = running || info.dirty
  const reason = running
    ? 'Can’t switch branches during a run'
    : info.dirty
      ? 'Commit or stash your changes first'
      : 'Switch branch'

  const pick = async (branch: string): Promise<void> => {
    setOpen(false)
    if (branch === info.branch) return
    const r = await window.api.gitCheckout(branch)
    if (!r.ok) notify({ kind: 'error', message: r.error ?? 'Could not switch branch.' })
    refresh()
  }
  const onItemKeyDown = (e: React.KeyboardEvent, i: number): void => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); document.getElementById('branch-chip-trigger')?.focus(); return }
    const ni = rovingIndex(e.key, i, info.branches.length, 'vertical')
    if (ni == null) return
    e.preventDefault(); itemRefs.current[ni]?.focus()
  }

  return (
    <div className="topmenu" ref={ref}>
      <button
        className={`btn ${open ? 'active' : ''}`}
        id="branch-chip-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={reason}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !open) {
            e.preventDefault(); setOpen(true); requestAnimationFrame(() => itemRefs.current[0]?.focus())
          }
        }}
      >
        <GitBranch size={13} /> {info.branch}{info.dirty ? '*' : ''} <ChevronDown size={12} />
      </button>
      {open && (
        <div className="topmenu-list" role="menu" aria-labelledby="branch-chip-trigger">
          {info.branches.map((b, i) => (
            <button
              key={b}
              ref={(el) => { itemRefs.current[i] = el }}
              role="menuitem"
              tabIndex={-1}
              onClick={() => void pick(b)}
              onKeyDown={(e) => onItemKeyDown(e, i)}
            >
              {b === info.branch ? '● ' : ''}{b}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Mount it in `App.tsx`**

- Add `import BranchChip from './BranchChip'` with the other component imports.
- Immediately after the project-name span (`<span className="project">{graph.project.name}</span>`), add:
```tsx
        <BranchChip />
```

- [ ] **Step 3: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/BranchChip.tsx src/renderer/App.tsx
git commit -m "feat(branch): BranchChip top-bar branch switcher

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Integration gate (controller, after all tasks)

- [ ] `npm run typecheck` — PASS
- [ ] `npm run test` — PASS (note the known `run-store.test.ts` full-suite flake; re-run in isolation if it trips)
- [ ] `npm run lint` — PASS (renderer touched)
- [ ] `npm run build` — PASS
- [ ] Opus whole-branch review — no Critical/Important
- [ ] User on-device smoke: click **Shell** → a real shell opens in the dock at the project root; run `ls` / `git status`. On a git-repo project: the branch chip shows the current branch; open the dropdown and switch to another branch on a clean tree (confirm HEAD moved via `git status` in the shell); make the tree dirty → the chip is disabled with "commit or stash" tooltip; start a run → chip disabled with the run tooltip. On a non-repo project: the chip is absent; the Shell button still works.

## Self-review notes (spec coverage)

- Shell mode + agent-less tab → Task 1 (`TerminalMode`/`openShellTerminal`) + Task 2 (label).
- `spawnShellPty` at project root reusing PTY plumbing → Task 1.
- TerminalPane shell branch → Task 2.
- Top-bar Shell button → Task 2.
- `git.ts` gitInfo/gitCheckout (execFile, clean-tree guard, no force) → Task 4.
- Pure `parseBranchList` → Task 3.
- Branch chip (hidden off-repo; disabled on run/dirty with tooltip; dropdown switch) → Task 5.
- No engine/agent change; double-guard → Tasks 4 (main guard) + 5 (UI guard).
