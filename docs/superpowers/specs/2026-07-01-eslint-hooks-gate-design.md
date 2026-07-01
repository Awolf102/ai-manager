# ESLint Rules-of-Hooks Gate

A small, targeted tooling addition: a lint gate that catches React **Rules of Hooks** violations at lint time. Direct response to the blank-screen bug of 2026-07-01 (`e840e47`) — a `useRef` placed below the `if (!graph) return <ProjectPicker/>` early return in `App.tsx` crashed the app on project-open, and **no existing gate caught it** (typecheck doesn't check hook rules; no test renders `App.tsx`; the build never runs the app). See the `ai-manager-gotchas` memory for the full lesson.

## Motivation

Renderer render-crashes are invisible to every automated check this repo runs. On-device smoke is currently the only net. This gate closes the specific, highest-value hole — the Rules-of-Hooks class, which is app-breaking and mechanically detectable.

## Goals

- Fail a lint check (non-zero exit) on any `react-hooks/rules-of-hooks` violation.
- Surface (but not block on) `react-hooks/exhaustive-deps` advisories.
- Stay **minimal** — only the two react-hooks rules; no sweeping lint regime.

Non-goals: a full ESLint/typescript-eslint ruleset; cleaning up `exhaustive-deps` warnings; wiring lint into `npm run test` or CI (there is no CI — local only).

## Decisions locked in brainstorming

- **Scope = react-hooks only** (over a fuller lint setup) — a focused tripwire, not a cleanup project.
- **Severities:** `rules-of-hooks: 'error'` (blocks), `exhaustive-deps: 'warn'` (non-blocking; kept as `warn` not `off` so the existing `eslint-disable-next-line react-hooks/exhaustive-deps` comments in OrgChart/TerminalPane stay valid and new cases still surface).
- User (non-technical on this topic) delegated the call — "if it's the correct fix, just go ahead." Executed **inline** (not subagent-driven): it's a self-contained config addition with no testable logic.

## Implementation (as built)

- **Dev deps:** `eslint` (10.6.0), `@typescript-eslint/parser` (8.62.1, to parse `.tsx`), `eslint-plugin-react-hooks` (7.1.1). `npm install` resolved cleanly — no ERESOLVE against the TS6/electron-vite stack (the anticipated risk did not materialize).
- **Config:** `eslint.config.mjs` (flat config; `.mjs` because `package.json` has no `"type": "module"`). Scoped to `src/**/*.{ts,tsx}`, ignoring `out/`/`node_modules`/`dist`. Parser = `@typescript-eslint/parser` with JSX enabled; plugin = `eslint-plugin-react-hooks`; the two rules wired explicitly (not via a bundled `recommended`, for exact control).
- **Script:** `"lint": "eslint ."` in `package.json`. Exits non-zero on errors, 0 on warnings-only.

## Verification

- `npm run lint` → **0 errors** (rules-of-hooks clean, confirming the `App.tsx` fix and no other lurking violations), 1 non-blocking `exhaustive-deps` warning (`HistoryView.tsx:33`, pre-existing advisory — left as-is per scope), exit 0.
- `npm run typecheck`, `npm run test` (476), `npm run build` all still green after the dependency install.
- No unit tests — it is configuration, not logic.

## Process note

Renderer cycles should run `npm run lint` at the integration gate from now on (alongside typecheck/test/build), since it is the only automated catch for the Rules-of-Hooks bug class. Recorded in the `ai-manager-gotchas` / `ai-manager-cycle-workflow-prefs` memory.

## Follow-ups (out of scope)

- The one `exhaustive-deps` warning in `HistoryView.tsx` (missing `refreshResumable` dep) — could be a real staleness bug or intentional; investigate or suppress in a future pass.
- A broader ESLint ruleset (typescript-eslint recommended, etc.) if desired later — deliberately excluded here to keep this a focused safety net.
