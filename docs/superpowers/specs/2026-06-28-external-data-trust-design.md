# External-data Trust + Security Controls — Design (cycle S3+S4)

**Date:** 2026-06-28
**Cycle:** batched **S3 + S4** from `docs/audits/2026-06-27-remediation-cycles.md`
**Audit findings closed:** #2, #19 (S3); #17, #18 (S4); context-file symlink/size Minor.
**Plus user-requested security controls:** a new Settings → **Security** section housing a Full-auto
permission lock and the relocated autonomy + skills-pack toggles, and routing automatic team-brain
sync through the same import validation.

---

## 1. Principle & threat model

Both areas ingest data the user did not author:

- **S3** — third-party plugin **code** discovered from `~/.claude/plugins`. "Loading a skill" loads the
  whole plugin directory, including **hooks** (shell/HTTP/MCP commands that run at tool-lifecycle events).
  Confirmed against the Agent SDK docs: a `{type:'local', path}` plugin loads & executes its hooks, and the
  SDK exposes **no** skills-only / skip-hooks flag.
- **S4** — team **bundles** imported from arbitrary `.aimteam.json` files (manual import *and* the automatic
  B2b brain sync), plus user-dragged **context files**.

**Principle:** establish trust **at the boundary**. Defaults are safe (audit findings remediated out of the
box); the user may *explicitly* opt into broader trust through clearly-warned toggles — the same
"honest danger + user-in-control" pattern S1 used for Full-auto.

**Honest residual (carried forward, not fixed here):** every S3 trust signal (author, repo, install count)
originates from locally-writable cache files under `~/.claude/plugins`. An attacker who can already write
those files has code-exec on the machine — the same residual the **OS-level sandbox spike** (backlog) must
address. S3 closes trusting *untampered* third-party plugins; the hook-block toggle additionally refuses to
*execute* hook code even from an author-spoofed plugin. True filesystem confinement and network-egress
blocking are **explicitly out of scope** (agents have Bash + WebFetch via the `claude_code` preset, so a
"block network" toggle would leak through `curl` — security theater). Those need the OS-sandbox spike.

---

## 2. Settings changes (`src/shared/types.ts`)

Add to `ProjectSettings` + `DEFAULT_SETTINGS`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `trustAnthropicOnly` | `boolean` | `true` | ON ⇒ only auto-trust plugins whose **own** author is Anthropic in a verified anthropics-owned repo (strict). OFF ⇒ trust any skill from a verified anthropics-owned marketplace (broad). |
| `blockPluginHooks` | `boolean` | `true` | ON ⇒ exclude any discovered plugin that ships hooks. |
| `lockBypassPermissions` | `boolean` | `false` | ON ⇒ clamp any `bypassPermissions` run down to `acceptEdits`, engine-wide. |

`skillInstallThreshold` is **retained but no longer consulted for trust** (deprecated-inert; the broad-trust
toggle replaces it — the threshold came from a forgeable cache, audit #19). Leaving the field avoids a
settings migration; the Orkestr overhaul can remove it. Its JSDoc is updated to "deprecated; unused".

**Migration:** none needed. `openProject` already does
`graph.settings = { ...DEFAULT_SETTINGS, ...(graph.settings ?? {}) }` (`project-store.ts:214`), so existing
projects backfill the new fields with their defaults on next open.

---

## 3. S3 — Plugin/skill trust (audit #2, #19)

### 3.1 Trust predicate (`src/shared/skill-trust.ts`, pure)

Replace the threshold-based `isTrusted` with a **mode-aware** predicate:

```
type SkillTrustMode = 'anthropic-only' | 'anthropic-marketplaces'

isTrusted(p: { author?; marketplaceSource?; }, mode): boolean
  // 'anthropic-only'        ⇒ isAnthropicAuthor(p.author) AND isAnthropicOwnedRepo(p.marketplaceSource)
  // 'anthropic-marketplaces'⇒ isAnthropicOwnedRepo(p.marketplaceSource)
```

- `isAnthropicAuthor(author)` — `author?.trim().toLowerCase() === 'anthropic'` (per-plugin
  `marketplace_entry.author.name`, **not** the marketplace repo — the #2 fix).
- `isAnthropicOwnedRepo(source)` — **new pure helper** replacing the bare `startsWith('anthropics/')`
  (the #19 fix). Accept iff the marketplace source is a **github** source whose **owner is exactly
  `anthropics`** (case-insensitive). Parse `owner/name`, full `github.com/owner/name`, and
  `https://github.com/owner/name`; reject look-alikes (`anthropics-evil/…`, `notanthropics/…`),
  non-github source types, and local/git URLs. The owner segment must equal `anthropics` exactly.
- **Install count is removed from the trust decision entirely.**

`shapeCatalog(cacheJson, marketplacesJson, mode)` — signature changes from `threshold` to `mode`; passes
each plugin's own `author` **and** its marketplace `source` object (not just the repo string) into
`isTrusted`. Ranking in `offeredSkills` is unchanged (still Anthropic-first, then installs — display only).

### 3.2 Hook detection (`src/shared/skill-trust.ts` predicate + `src/main/engine/skill-discovery.ts` probe)

- **Pure predicate** `pluginShipsHooks(signals: { hasHooksJson; hasPluginJsonHooksKey; hooksDirNonEmpty })`
  → `boolean` (true if any signal set). Unit-testable without fs.
- **fs probe** in `skill-discovery.ts`: for each resolved plugin `path`, check
  `hooks/hooks.json` (exists), `.claude-plugin/plugin.json` (parses + has a `hooks` key), and a non-empty
  `hooks/` dir; feed the signals to `pluginShipsHooks`.
- When `blockPluginHooks` is ON, **exclude** any plugin for which `pluginShipsHooks` is true from the
  discovered set. (No SKILL.md extraction / temp-plugin copying — refuse, don't strip.)

### 3.3 Discovery wiring (`src/main/engine/skill-discovery.ts`)

`discoverSkills(opts: { mode, blockHooks, root? })` — replaces the `threshold` parameter.

- Catalog path: `shapeCatalog(cache, markets, mode)` → resolve on-disk path → **hook-exclude** when
  `blockHooks` → emit.
- Fallback path (`fallbackScan`, no catalog cache): cannot establish **per-plugin** authorship, so:
  - `mode === 'anthropic-only'` ⇒ return **empty** (the official marketplace contains third-party plugins;
    membership ≠ Anthropic authorship). The always-available skills-pack is a separate path, unaffected.
  - `mode === 'anthropic-marketplaces'` ⇒ trust marketplace-members from **verified anthropics-owned repos**
    (its current behavior, now using `isAnthropicOwnedRepo`), with the same hook-exclude applied.

### 3.4 Engine read (`src/main/engine/agent-runner.ts`)

`discoveredPlugins()` reads `getSettings()` and calls
`discoverSkills({ mode: settings.trustAnthropicOnly ? 'anthropic-only' : 'anthropic-marketplaces',
blockHooks: settings.blockPluginHooks })`. The `skillInstallThreshold` read at the current call site is
removed. No change to `skillOptionsFor` / `skipMcpDiscovery` (hooks handled by exclusion, not the SDK flag).

---

## 4. S4 — Team-bundle import (audit #17, #18)

### 4.1 Validate-and-normalize (`src/shared/team-bundle.ts`, pure)

`validateTeamBundle(raw)` becomes a **validate-and-normalize** that guarantees its consumer can neither
crash (#18) nor be escalated (#17). On success it returns a **fully-typed, safe** `TeamBundle` (every field
present and within bounds). Per member, coerce/clamp:

- `permissionMode` — whitelist against the `PermissionMode` union; unknown/missing → `'acceptEdits'`.
- `kind` — whitelist against `AgentKind`; unknown/missing → reject the member.
- `model` — whitelist against the app's known model ids (`DEFAULT_MODEL_BY_KIND` / model list in
  `shared/types`); unknown/missing → the kind's default model.
- `position` — coerce `{x,y}` to **finite numbers**; missing/NaN/Infinity → `{ x: 0, y: 0 }`.
- `role` — non-string → `''`; clamp length to **`MAX_ROLE_CHARS = 50_000`**.
- `lessons` — array of strings; drop non-strings; cap to **`MAX_LESSONS = 200`** items, each clamped to
  **`MAX_LESSON_CHARS = 2_000`**.
- `icon` / `name` / `memberId` — string-guard; `memberId`/`name` required (reject member if absent),
  `icon` → safe default if missing.
- **Member cap:** reject bundles with more than **`MAX_MEMBERS = 200`** members (DoS guard).
- `edges` — keep only `{source,target}` string pairs; drop malformed.

Rejection returns `{ ok:false, error }` as today (envelope errors unchanged). A member that can't be repaired
(missing `memberId`/`name`, bad `kind`) makes the whole bundle invalid with a clear error.

### 4.2 Force safe permission mode (#17) (`src/shared/team-bundle.ts`)

`planTeamImport` sets `permissionMode: 'acceptEdits'` for **every** member regardless of the (already
whitelisted) bundle value — matching `applySpawnedTeam` (`project-store.ts:834`). A bundle can never pin a
more permissive mode. (Round-trip note: an exported team re-imports at `acceptEdits`; the user re-adjusts
afterward — accepted.) `position` is read from the normalized bundle, so the `m.position.x` dereference can
no longer throw.

### 4.3 Import flow: validate → preview-confirm → apply

The import IPC path becomes three steps (renderer reuses the U1 `ConfirmDialog` / `requestConfirm` zustand):

1. **Validate** (main): read file → `validateTeamBundle`. On `ok:false`, surface the error, stop.
2. **Preview-confirm** (renderer): show a confirm dialog listing each imported member — name, kind, the
   **forced** `acceptEdits` mode, the (untrusted) **role prose**, and any **clamp/drop warnings** produced by
   validation (e.g. "role truncated to 50 000 chars", "3 members dropped"). The dialog frames role text as
   *untrusted data, not instructions* (same stance as S1's context-file reframing). Cancel ⇒ no writes.
3. **Apply** (main): on confirm, `importTeam` writes `role.md` / `memory.md` and graph nodes as today
   (now from normalized data).

Validation results + warnings are returned from a validate/preview IPC call so the renderer can render the
dialog before any disk write. `importTeam` itself is unchanged except that it consumes normalized data.

### 4.4 Auto-sync hardening (B2b) (`src/main/engine/project-store.ts`)

The automatic team-brain pull (`autoSyncTeam` → `autoPullFromTeam` → `refreshFromTeam`) ingests a bundle
with **no human in the loop**. Ground truth: that path **already reads brains via `readTeamBrain`, which
already calls `validateTeamBundle`**, and it merges **portable lessons into memory only** — it never applies
`permissionMode`, writes `role.md`, or creates nodes. So hardening `validateTeamBundle` (§4.1) to clamp
`lessons` count/length **covers the auto-sync path transitively with no new routing code**, and the
`acceptEdits` clamp is not relevant there (no perms are applied on this path). `readTeamBrain` already returns
`null` on an invalid bundle, so a malformed auto-synced brain is skipped, not applied. The only requirement
is that `validateTeamBundle`'s normalization (lessons clamp + member guards) is in place.

### 4.5 `runHeadless` — no change

The escalation risk (a manually-run imported agent inheriting a bundle's bypass mode) is closed **at the
source** by §4.2 forcing `acceptEdits` on import, and globally by the Full-auto lock (§6) when enabled.
`runHeadless` / `streamAgent`'s `opts.permissionMode ?? agent.permissionMode` fallback is left as-is.
Documented as considered-and-mooted so the reviewer knows it was deliberate.

---

## 5. Context files — symlink + size (Minor) (`src/main/engine/project-store.ts`)

`addContextFiles`:

- Replace `fs.stat` with **`fs.lstat`** and **reject symlinks** (`stat.isSymbolicLink()`).
- Enforce a per-file size cap **`MAX_CONTEXT_BYTES = 25 * 1024 * 1024`** (25 MB); reject larger.
- Surface the **reason** in the returned `skipped` array by suffixing the basename, e.g.
  `"secret (symlink)"`, `"big.psd (too large)"`, `"thing (not a file)"`. Keep `skipped: string[]` — no
  renderer-shape change. Existing copy logic is otherwise unchanged.

---

## 6. Full-auto permission lock (`src/main/engine/permission-options.ts`)

Single enforcement point at the SDK boundary (every agent run funnels through `streamAgent` →
`buildPermissionOptions`):

```
buildPermissionOptions(mode, opts?: { lockBypass?: boolean })
  // if opts.lockBypass && mode === 'bypassPermissions' ⇒ treat mode as 'acceptEdits'
  // (then the existing allowDangerouslySkipPermissions logic never triggers)
```

`streamAgent` reads `getSettings()` (as it already does for the skills pack / discovery) and passes
`{ lockBypass: getSettings().lockBypassPermissions }` at the single `buildPermissionOptions` call site
(`agent-runner.ts:113`). This clamps **all** paths — orchestrated
(`state.actingMode` from `actingModeFor('full')`), headless/manual (`agent.permissionMode`), handoff, and
review — because they all reach the SDK through this one call. `actingModeFor` is left unchanged (the clamp
is at the boundary, one place, to avoid drift). Pure + unit-testable.

---

## 7. UI — new Settings → Security section (`src/renderer/.../SettingsModal.tsx`)

Add a **Security** section to the Settings modal containing, in order:

1. **Autonomy** — the existing `autonomy` control (auto / cautious / full) **relocated** here, keeping S1's
   Full-auto danger copy + acknowledgement gate intact.
2. **Never bypass permissions** (`lockBypassPermissions`) — toggle, default off. Helper copy: clamps any
   Full-auto / per-agent bypass to acceptEdits.
3. **Auto-trust only Anthropic-authored skills** (`trustAnthropicOnly`) — toggle, default on. OFF shows an
   inline warning: third-party plugin code from anthropics-owned marketplaces will run under the agent's
   permission mode.
4. **Block skills whose plugin ships hooks** (`blockPluginHooks`) — toggle, default on. Helper copy: hooks
   run shell/HTTP/MCP code at tool events.
5. **Skills pack** — the existing `skillsPackEnabled` toggle (+ `skillsPackPath`) **relocated** here.

No new acknowledgement-modal gate for the toggles (the user asked for plain on/off buttons); persistent
inline warning copy is sufficient. Toggles bind to the existing settings-update IPC. This is a small
down-payment on the overhaul's planned grouped Settings (Safety/Cost/Review/Team).

---

## 8. Testing

**Pure (`src/shared/*.test.ts`):**
- `isAnthropicOwnedRepo` — accepts `anthropics/x`, `github.com/anthropics/x`,
  `https://github.com/anthropics/x`; rejects `anthropics-evil/x`, `notanthropics/x`, non-github sources,
  local/git URLs, empty.
- `isTrusted` — `anthropic-only`: Anthropic-author+verified-repo passes; third-party-in-anthropics-marketplace
  rejected; Anthropic-author in non-anthropics repo rejected. `anthropic-marketplaces`: any member of a
  verified anthropics repo passes; non-anthropics repo rejected. Install count never grants trust in either
  mode.
- `pluginShipsHooks` — true for each signal alone and combined; false for none.
- `validateTeamBundle` — every missing/malformed field yields a safe value and **never throws**;
  permissive `permissionMode` whitelisted; unknown `model`→default; non-finite `position`→`{0,0}`; oversized
  `role`/`lessons` clamped; `>MAX_MEMBERS` rejected; missing `memberId`/`name`/bad `kind` → invalid.
- `planTeamImport` — output `permissionMode` is always `acceptEdits`; no throw on a minimal/normalized bundle.
- `buildPermissionOptions` — `lockBypass:true` + `bypassPermissions` ⇒ `acceptEdits` (no
  `allowDangerouslySkipPermissions`); `lockBypass:false` ⇒ unchanged; non-bypass modes unaffected by the lock.

**Main (`src/main/engine/*.test.ts`):**
- `discoverSkills` — hook-bearing plugin excluded when `blockHooks`; included (trust permitting) when not;
  `anthropic-only` fallback (no cache) returns empty; `anthropic-marketplaces` fallback trusts verified-repo
  members.
- `addContextFiles` — symlink rejected with reason; oversized rejected with reason; normal file copied;
  reasons present in `skipped`.
- auto-sync ingestion — a malformed/over-permissive auto-synced brain is validated + clamped (or skipped
  with a logged reason), never escalates.

**Renderer:** Security section renders the five controls and writes settings; import shows the confirm dialog
**before** any disk write (apply only on confirm).

Full suite stays green (313 today) plus the net-new tests. `tsc` + `build` clean.

---

## 9. Scope / non-goals

- **No OS-level sandbox** (separate backlog spike) — true fs confinement + network-egress blocking are not
  achievable in-SDK and are explicitly excluded (no security-theater toggles).
- **No hook stripping** — refuse hook-bearing plugins, don't synthesize hooks-free copies.
- **No per-agent permission UI rework** (#21, deferred to the overhaul).
- **No changes to `buildTeamBundle` (export)** or the orchestrator spawn path (already forces `acceptEdits`).
- **No making skill discovery opt-in** — the safe-default trust narrowing makes auto-assigning the
  now-Anthropic-only set acceptable; the broad-trust toggle is the explicit opt-out.

---

## 10. File-by-file change list

| File | Change |
|---|---|
| `src/shared/types.ts` | +3 `ProjectSettings` fields + defaults; deprecate `skillInstallThreshold` doc. |
| `src/shared/skill-trust.ts` | mode-aware `isTrusted`; new `isAnthropicOwnedRepo`, `pluginShipsHooks`; `shapeCatalog(mode)`. |
| `src/main/engine/skill-discovery.ts` | `discoverSkills({mode,blockHooks,root})`; hook fs-probe + exclude; fallback per mode. |
| `src/main/engine/agent-runner.ts` | `discoveredPlugins()` reads new settings; `streamAgent` passes `lockBypass` to `buildPermissionOptions`. |
| `src/main/engine/permission-options.ts` | `buildPermissionOptions(mode, {lockBypass})` clamp. |
| `src/shared/team-bundle.ts` | validate-and-normalize `validateTeamBundle`; `planTeamImport` forces `acceptEdits`; new bound consts. |
| `src/main/engine/project-store.ts` | `addContextFiles` lstat/size/reasons; auto-sync routes through validate+clamp. |
| `src/main/ipc.ts` (+ `store.ts`) | import validate/preview step returning members+warnings for the confirm dialog. |
| `src/renderer/.../SettingsModal.tsx` | new Security section (relocate autonomy + skills-pack; +3 toggles). |
| `src/renderer/.../import flow` | role-preview `ConfirmDialog` before apply. |
| `*.test.ts` | new pure + main + renderer tests per §8. |
