# Spec — Papercuts sweep (lean: correctness + security + robustness Minors)

**Date:** 2026-06-29
**Cycle:** the optional Minor-cleanup sweep after the audit's must-fix backlog (12 cycles) + the live-verify
session are complete. Scope = the **genuinely-open, worth-now, won't-be-redone-by-the-overhaul** Minor findings
from `docs/audits/2026-06-27-tool-audit.md` (aggregated as row #36; details in `docs/audits/findings/`).

**Approved scope:** "Lean" — 10 small correctness/security/robustness fixes, grouped into 4 file-cohesive tasks.
UX Minors are **deferred to the Phase-2 Orkestr overhaul**; the `nodes.ts` 1505-line refactor and the
multimodal-image-context item are **excluded**. The OS-sandbox spike is **deferred** (post-overhaul).

**Explicitly dropped from the lean set (with reason):**
- `setStatus` "drops step fields" (#d2-persistence) — premise inaccurate: `stepBase` spreads the existing
  step, so `tasks`/`assignments`/`output` are preserved; the only real concern is a cosmetic parallel-wave
  race, not worth a fix.
- `effortByTask` insertion-order (#d2-shared) — the "deepest router wins" invariant is already documented in
  the function's comment, and a real fix needs depth threaded onto each step (more than a papercut). Left as-is.

**Already fixed by prior cycles (NOT in scope — confirmed in code):** `addRecent` non-atomic (S5), run-store
`.tmp` sweep (P1), `saveGraph` non-atomic/parallel race (P1/P2), HITL abort-path scrub (S5), context-file
symlink/size cap (S3+S4).

---

## Goals

Close 10 leftover Minor defects, each small, independent, and (where practical) unit-tested, without changing
any off-path behavior. No new dependencies. Full suite + `tsc` (node+web) + `build` stay green.

## Non-goals

- Any UX Minor (success toasts, disabled-button reasons, legends, reset-to-defaults, dirty-state guards,
  HITL-Skip copy, run-result `alert()`, drag-drop polish, goal-textarea autosize) — Orkestr overhaul.
- The `nodes.ts` refactor; multimodal image context; the OS-sandbox spike.

---

## The 10 fixes (grouped by task)

### Task 1 — shared pure-function correctness (`src/shared/*`, unit-tested)
1. **`narrate.ts` `basename`/`host`** (`narrate.ts:55-68`): `basename` returns the whole path for a
   trailing-separator path (`/a/b/c/` → `/a/b/c/`). Fix: strip trailing `/`/`\` before the last-segment split.
   `host` returns the whole string for a scheme-less URL and keeps `userinfo@`. Fix: strip a leading
   `userinfo@` from the matched host. Both are display-only (activity feed); keeps long abs paths / creds out
   of narration.
2. **`context-files.ts` `uniqueContextName`** (`context-files.ts:16-25`): a leading-dot name yields an empty
   stem (`.env` → `-2.env`); multi-dot splits at the last dot (`a.tar.gz` → `a.tar-2.gz`). Fix: for a
   leading-dot name treat the whole name as the stem (no extension split). Cosmetic, collision-safe either way.
3. **`effort.ts` capped-from display** (`effort.ts:12-30`, consumed `RunView.tsx:152-154`): the badge mixes
   two independent maxima so the tooltip can read "effort max (capped from xhigh)" — claiming a cap *down to a
   lower* level. Fix: add a pure `cappedFromDisplay(assignments, workerId): Effort | undefined` returning the
   pre-clamp effort **only when it is strictly above** `effortOfWorker`; `RunView` swaps `cappedFrom` →
   `cappedFromDisplay`.

### Task 2 — team-brain / import integrity (`src/shared/*`, unit-tested)
4. **`team-brain.ts` lessons cap** (`team-brain.ts:14-24` `unionLessons`, called from `mergeBrainPush:34`):
   the push side has no cap while the pull side caps at 40 (`team-brain.ts:95`), so a brain member's `lessons`
   grows unbounded. Fix: cap the unioned lessons at 40 newest-first in `mergeBrainPush` (mirror the read side).
5. **`team-bundle.ts` `memberId` uniqueness** (`validateTeamBundle`; consumed by `importTeam`
   `project-store.ts:710-737` + `mergeBrainPush` keying `team-brain.ts:31`): a crafted/duplicate `memberId`
   can mis-wire imported edges or collapse brain members. Fix (simple, unambiguous normalization): in
   `validateTeamBundle`, **drop a member whose `memberId` duplicates an earlier member's (keep the first)**.
   Because imported edges are already filtered to known endpoints (`importTeam` only pushes an edge when both
   `idByMember` lookups resolve), edges referencing a dropped member are skipped — no collapse, no mis-wire.
   Record the drop in the returned `warnings` (validateTeamBundle already surfaces warnings).

### Task 3 — project-store security (`src/main/engine/project-store.ts`, unit-tested)
6. **`contextThumbnail` SVG** (`project-store.ts:366-378`, mime at `:373`; rendered `<img src>` in
   `ContextModal.tsx:25`): returns `data:image/svg+xml;base64,…` for `.svg`. Fix: skip the data-URL thumbnail
   for `.svg` (return the generic-file-icon path / no thumbnail), so an attacker-influenced SVG is never handed
   to the renderer as an image source.
7. **Team-brain auto-sync path re-validation** (`autoPushToTeam`/`autoPullFromTeam` →
   `syncToTeam`/`readTeamBrain`, `project-store.ts:598-688`): the persisted `linkedTeam.path` is auto-written
   on every finished run with no re-check. Fix: before an auto-sync write/read, re-validate the linked path
   (exists, is a regular file, `.json`); skip silently (best-effort, as today) if it fails, rather than blindly
   overwriting a relocated/symlinked target. (Manual sync via dialog is unchanged.)

### Task 4 — main-process hardening
8. **`pty-manager.ts` `writePty`** (`pty-manager.ts:59-61`): no try/catch (unlike `resizePty`); a keystroke
   after pty exit but before session deletion can throw. Fix: wrap the write in try/catch (swallow — at worst a
   lost keystroke), mirroring `resizePty`.
9. **`orchestrator.ts` per-run terminal header gate** (header printed in `agent-runner.ts:101-103` when
   `opts.header !== false`; the 7 in-run `eng.runAgent` call sites never pass `header`, so the
   "▶ name · model" banner re-prints on every sub-step into the agentId-keyed buffer): fix at the **single
   seam** — the orchestrator's `runAgent` wrapper tracks a per-run `Set<agentId>` and passes
   `header: opts.header ?? !seen.has(agentId)` (then records it), so the banner prints once per agent per run.
   No `nodes.ts` changes; role-drafter/manifest-detector (which call `streamAgent` directly with
   `header:false`) are unaffected.
10. **`main/index.ts` production CSP** (`src/main/index.ts:17-28` window/`setWindowOpenHandler`; renderer has
    no CSP today): add a restrictive CSP **for production only**, via
    `session.defaultSession.webRequest.onHeadersReceived` gated on the app NOT being in the dev
    (`ELECTRON_RENDERER_URL`) path, so Vite HMR is untouched. Directives:
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
    connect-src 'self'`. Defense-in-depth (current rendering is xterm/React text nodes, not `innerHTML`).

---

## Testing

- **Tasks 1 & 2 (pure shared):** unit tests in the existing `narrate.test.ts`, `context-files.test.ts`,
  `effort.test.ts`, `team-brain.test.ts`, and `team-bundle.test.ts` (or the import test) — each fix gets a
  RED→GREEN case (trailing-slash basename, userinfo host, dotfile context name, capped-from-only-when-higher,
  100-lessons→40 cap, duplicate-memberId de-dup).
- **Task 3 (project-store):** tests in `project-store*.test.ts` — `contextThumbnail` returns no `image/svg+xml`
  data URL for an `.svg`; auto-sync skips (no write) when the linked path is missing / not `.json`.
- **Task 4:** `writePty` after a killed/absent session does not throw (pty-manager unit test or a guarded
  call); the header-gate logic is unit-tested via a small pure helper or the wrapper with a fake `runAgent`
  (first call → header on, second → off). The CSP is verified by the directive constant + `build` (Electron
  session config isn't unit-tested; assert the header string / production-gate logic where extractable).

## Acceptance criteria

- Each of the 10 defects is fixed and covered by a test where practical; off-path behavior unchanged.
- `maxHandoffs`/HITL/team-sync default-off paths and non-`.svg` context thumbnails behave as today.
- Production CSP present without breaking the dev server; dev HMR unaffected.
- Full suite + `tsc` (node+web) + `build` green.

## Risks

- **CSP (item 10) is the one fiddly fix:** too tight breaks the app, dev gating must be correct. Keep it
  production-only via `onHeadersReceived`; verify with a production `build` + a manual launch smoke (the
  renderer must load, context thumbnails (`data:`) must render, terminals must work). If it proves disruptive,
  it can be split out — but the conservative directive set above should be safe.
- **`memberId` de-dup (item 5):** must not change the happy-path import (unique ids) — only collisions are
  altered. Re-keying must keep edges consistent with the chosen ids.
- All other items are isolated and low-risk.
