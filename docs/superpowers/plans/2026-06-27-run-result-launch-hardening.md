# Run-result Launch Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Run-result feature from running any launch command through a shell, closing the command-injection hole (audit Critical #1).

**Architecture:** Add one pure validator `parseStartCommand` to `src/shared/run-manifest.ts` that tokenizes a command string into `{command, args[]}` and rejects shell-dependent input. `server-manager.ts` calls it and spawns with `shell:false` (the real fix; no shell ⇒ no injection). `RunResultModal.tsx` calls the same validator for live UX feedback. IPC contract is unchanged.

**Tech Stack:** TypeScript, Electron (main + preload + renderer), React 19, vitest, electron-vite. Pure logic in `src/shared/*` is unit-tested in plain Node.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-27-run-result-launch-hardening-design.md`. Branch: `fix/run-result-launch-hardening`.
- `src/shared/run-manifest.ts` must stay free of node/DOM imports (plain-Node testable).
- Rejected shell operators (exact set, unquoted only): `;  &  |  $  ` + "`" + `  (  )  <  >`, plus `\n` and `\r`.
- Reject a leading env-assignment command token matching `^[A-Za-z_][A-Za-z0-9_]*=`.
- Operators **inside** single/double quotes are literal and allowed (e.g. `node "a;b.js"` is valid).
- No shell escape hatch, no launcher allow-list, no env-var-prefix support (explicit YAGNI).
- IPC signature for `launchServer` stays `{ startCommand: string; port?: number; path?: string }`.
- `parseManifest` keeps returning `startCommand` as a raw display string (no contract change); its existing tests stay green.
- POSIX/macOS only (the app targets darwin); Windows is out of scope.
- Verification commands: `npm test` (vitest run), `npm run typecheck` (tsc node+web), `npm run build` (electron-vite).

---

### Task 1: `parseStartCommand` validator (pure, shared)

**Files:**
- Modify: `src/shared/run-manifest.ts` (add `ParsedCommand` type + `parseStartCommand` export)
- Test: `src/shared/run-manifest.test.ts` (add a `describe('parseStartCommand')` block)

**Interfaces:**
- Produces:
  ```ts
  export type ParsedCommand =
    | { ok: true; command: string; args: string[] }
    | { ok: false; error: string }
  export function parseStartCommand(raw: string): ParsedCommand
  ```

- [ ] **Step 1: Write the failing tests**

Add to the top import of `src/shared/run-manifest.test.ts`:
```ts
import { detectManifestPrompt, parseManifest, parseStartCommand } from './run-manifest'
```

Append this block to `src/shared/run-manifest.test.ts`:
```ts
describe('parseStartCommand', () => {
  it('splits a simple command into command + args', () => {
    expect(parseStartCommand('npm run dev')).toEqual({ ok: true, command: 'npm', args: ['run', 'dev'] })
    expect(parseStartCommand('vite --port 5173')).toEqual({ ok: true, command: 'vite', args: ['--port', '5173'] })
    expect(parseStartCommand('python3 -m http.server 8000')).toEqual({
      ok: true,
      command: 'python3',
      args: ['-m', 'http.server', '8000']
    })
  })

  it('honors single and double quotes, keeping operators inside them literal', () => {
    expect(parseStartCommand('node "my server.js"')).toEqual({ ok: true, command: 'node', args: ['my server.js'] })
    expect(parseStartCommand("node 'my server.js'")).toEqual({ ok: true, command: 'node', args: ['my server.js'] })
    expect(parseStartCommand('node "a;b.js"')).toEqual({ ok: true, command: 'node', args: ['a;b.js'] })
  })

  it('collapses surrounding and repeated whitespace', () => {
    expect(parseStartCommand('  npm   run  dev ')).toEqual({ ok: true, command: 'npm', args: ['run', 'dev'] })
  })

  it('rejects empty input', () => {
    expect(parseStartCommand('')).toEqual({ ok: false, error: 'Enter a start command.' })
    expect(parseStartCommand('   ')).toEqual({ ok: false, error: 'Enter a start command.' })
  })

  it('rejects unquoted shell operators', () => {
    for (const bad of [
      'npm run dev; rm -rf /',
      'a && b',
      'a | b',
      'echo $(whoami)',
      'echo `whoami`',
      'a > b',
      'a < b',
      'a\nb'
    ]) {
      expect(parseStartCommand(bad).ok).toBe(false)
    }
  })

  it('rejects a leading VAR=value env assignment', () => {
    expect(parseStartCommand('PORT=3000 npm start').ok).toBe(false)
  })

  it('rejects an unbalanced quote', () => {
    expect(parseStartCommand('node "server.js')).toEqual({ ok: false, error: 'Unbalanced quote in command.' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/shared/run-manifest.test.ts`
Expected: FAIL — `parseStartCommand is not a function` (or a type error that it is not exported).

- [ ] **Step 3: Implement `parseStartCommand`**

Append to `src/shared/run-manifest.ts`:
```ts
export type ParsedCommand =
  | { ok: true; command: string; args: string[] }
  | { ok: false; error: string }

const SHELL_OPERATORS = new Set([';', '&', '|', '$', '`', '(', ')', '<', '>', '\n', '\r'])
const OPERATOR_ERROR = 'Remove shell characters (; & | $ ` ( ) < >). The launcher runs without a shell.'

// Tokenize a launch command into argv WITHOUT a shell. Quotes group tokens and make
// their contents literal; unquoted shell operators and leading VAR= prefixes are refused
// so shell-dependent commands fail loudly instead of being mangled or injected.
export function parseStartCommand(raw: string): ParsedCommand {
  const tokens: string[] = []
  let cur = ''
  let inToken = false
  let quote: '"' | "'" | null = null

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (inToken) {
        tokens.push(cur)
        cur = ''
        inToken = false
      }
      continue
    }
    if (SHELL_OPERATORS.has(ch)) return { ok: false, error: OPERATOR_ERROR }
    cur += ch
    inToken = true
  }
  if (quote) return { ok: false, error: 'Unbalanced quote in command.' }
  if (inToken) tokens.push(cur)

  if (tokens.length === 0) return { ok: false, error: 'Enter a start command.' }
  const [command, ...args] = tokens
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command)) {
    return {
      ok: false,
      error: 'Set environment in the app, not an inline VAR=value prefix; put the port in the Port field.'
    }
  }
  return { ok: true, command, args }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/shared/run-manifest.test.ts`
Expected: PASS — all `parseStartCommand` cases plus the unchanged `detectManifestPrompt`/`parseManifest` cases.

- [ ] **Step 5: Commit**

```bash
git add src/shared/run-manifest.ts src/shared/run-manifest.test.ts
git commit -m "feat(s2): add shell-free parseStartCommand validator"
```

---

### Task 2: Spawn the launcher without a shell

**Files:**
- Modify: `src/main/engine/server-manager.ts:29-41` (`launchServer`: validate + `shell:false`)

**Interfaces:**
- Consumes: `parseStartCommand` from Task 1 (`{ ok, command, args } | { ok:false, error }`).
- Produces: no signature change — `launchServer(wc, { startCommand, port?, path? }) => { serverId }`.

- [ ] **Step 1: Add the import**

At the top of `src/main/engine/server-manager.ts`, below the existing `run-manifest`-adjacent imports, add:
```ts
import { parseStartCommand } from '../../shared/run-manifest'
```

- [ ] **Step 2: Validate and spawn shell-free**

In `launchServer`, replace this block:
```ts
  const serverId = randomUUID()
  const projectPath = getCurrentProjectPath()
  const proc = spawn(input.startCommand, {
    shell: true,
    detached: true,
    cwd: projectPath,
    env: cleanEnv()
  })
  active = { serverId, proc }
```
with:
```ts
  const serverId = randomUUID()
  const projectPath = getCurrentProjectPath()
  const parsed = parseStartCommand(input.startCommand)
  if (!parsed.ok) {
    sendStatus(wc, serverId, 'error')
    if (!wc.isDestroyed())
      wc.send(IPC.serverLog, { serverId, data: `[cannot launch] ${parsed.error}\n` })
    return { serverId }
  }
  const proc = spawn(parsed.command, parsed.args, {
    shell: false,
    detached: true,
    cwd: projectPath,
    env: cleanEnv()
  })
  active = { serverId, proc }
```

(Everything after — `sendStatus 'starting'`, the `onLog`/`error`/`exit` handlers, `waitForPort`, and `return { serverId }` — is unchanged. `detached:true` still creates the process group the negative-pid kill in `stopActive` relies on.)

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both PASS (no type errors; `out/main/index.js` rebuilt). `spawn(command, args, opts)` is a valid `child_process.spawn` overload.

- [ ] **Step 4: Commit**

```bash
git add src/main/engine/server-manager.ts
git commit -m "fix(s2): spawn the run-result launcher with shell:false"
```

---

### Task 3: Live validation in the Run-result modal

**Files:**
- Modify: `src/renderer/run/RunResultModal.tsx` (import validator; inline error; disable Launch)
- Modify: `src/renderer/styles.css` (add `.rr-error`)

**Interfaces:**
- Consumes: `parseStartCommand` from Task 1.

- [ ] **Step 1: Import the validator**

In `src/renderer/run/RunResultModal.tsx`, change the import block:
```ts
import { useEffect, useRef, useState } from 'react'
import type { RunManifest, ServerStatus } from '../../shared/types'
```
to add the validator import:
```ts
import { useEffect, useRef, useState } from 'react'
import type { RunManifest, ServerStatus } from '../../shared/types'
import { parseStartCommand } from '../../shared/run-manifest'
```

- [ ] **Step 2: Compute validity**

Immediately after `const launchable = manifest.type === 'web' || manifest.type === 'static'` (around line 21), add:
```ts
  const parsedCmd = parseStartCommand(cmd)
  const cmdError = cmd.trim() && !parsedCmd.ok ? parsedCmd.error : null
```

- [ ] **Step 3: Show the inline error under the Start-command field**

In the JSX, replace this field block:
```tsx
            <div className="field">
              <label>Start command</label>
              <input className="spawn-name" value={cmd} onChange={(e) => setCmd(e.target.value)} />
            </div>
```
with:
```tsx
            <div className="field">
              <label>Start command</label>
              <input className="spawn-name" value={cmd} onChange={(e) => setCmd(e.target.value)} />
              {cmdError && <p className="rr-error">{cmdError}</p>}
            </div>
```

- [ ] **Step 4: Disable Launch on invalid input**

Replace the Launch button line:
```tsx
              <button className="btn primary" onClick={() => void launch()} disabled={!cmd.trim() || launching}>
```
with:
```tsx
              <button className="btn primary" onClick={() => void launch()} disabled={!parsedCmd.ok || launching}>
```

- [ ] **Step 5: Add the error style**

In `src/renderer/styles.css`, immediately after the `.rr-notes { ... }` rule (around line 1230), add:
```css
.rr-error {
  margin: 4px 0;
  font-size: 12px;
  color: var(--danger);
}
```

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both PASS; the renderer bundle rebuilds with no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/run/RunResultModal.tsx src/renderer/styles.css
git commit -m "feat(s2): validate run-result command live in the modal"
```

---

### Task 4: Full-suite verification

**Files:** none (verification gate only).

- [ ] **Step 1: Run the whole suite**

Run: `npm test && npm run typecheck && npm run build`
Expected: vitest all green (287+ tests — the prior 286 plus the new `parseStartCommand` cases), typecheck clean (node + web), build clean.

- [ ] **Step 2: Manual smoke note (no code)**

Confirm by reading `server-manager.ts` that the only `spawn` call uses `shell: false` and `parsed.command`/`parsed.args` (grep: `grep -n "shell:" src/main/engine/server-manager.ts` → expect `shell: false`). This is the live-verification hook for the eventual guided run (launch a real built web app; try a `;`-containing command and confirm it is refused with the inline error and never spawns).

- [ ] **Step 3: Commit (if anything was left uncommitted)**

```bash
git status --short   # expect clean
```

---

## Self-Review

**Spec coverage:**
- §1 `parseStartCommand` (tokenizer grammar, reject rules, types) → Task 1. ✓
- §2 `server-manager` validate + `shell:false`, refuse invalid, unchanged IPC/kill/poll → Task 2. ✓
- §3 modal inline error + disable via shared validator → Task 3. ✓
- Test matrix (all happy + reject rows) → Task 1 Step 1. ✓
- `parseManifest` unchanged + its tests stay green → no task touches it; verified in Task 4. ✓
- Optional spawn-seam regression test → spec marked out of scope; intentionally omitted.

**Placeholder scan:** no TBD/TODO; every code step shows full code; every command has expected output. ✓

**Type consistency:** `ParsedCommand` / `parseStartCommand` signature defined in Task 1 is consumed identically in Tasks 2 and 3 (`parsed.ok`, `parsed.error`, `parsed.command`, `parsed.args`). The modal uses `parsedCmd`/`cmdError` locals consistently across Steps 2–4. ✓
