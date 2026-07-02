# Env-var Editor (no AI) — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorm) → ready for implementation plan
**Feature:** Phase-3 #13 — a main-screen button to view/edit the project's `.env` directly, with plain-English labels, without any agent involvement.

## Summary

A top-bar button opens a modal that reads and writes the project's root **`.env`** file. Each variable shows a **plain-English label** ("Anthropic API key", not `ANTHROPIC_API_KEY`) alongside its raw key, with the value **masked** by default (per-row reveal). The user can edit values, add variables, and delete them, then Save. **No AI is involved** — the editing path is pure UI + filesystem, so secrets are never routed through an agent's context.

## Goals

- Let the user manage the target app's env vars safely and readably, without asking an agent (which would put secrets in a transcript).
- Preserve the `.env` file's comments, blank lines, and ordering on edit (don't clobber).
- Plain-English labels for common vars, with a readable fallback for anything else.
- On-brand, self-contained; zero engine/agent change.

## Non-goals / scope

- **v1 = the single project-root `.env`** (`<projectPath>/.env`), created on first Save if absent. Other files (`.env.local`, `.env.production`) are out of scope.
- **This is an AI-free *editor*, not a sandbox.** The `.env` still lives in the project folder, so agents *can* read it with their file tools like any file. The protection is only that *editing* doesn't route secrets through an AI. (State this plainly in the modal + spec.)
- No user-defined custom labels in v1 (curated map + humanized fallback is enough).
- No secret encryption/at-rest protection beyond what the filesystem provides.

## The `.env` model — comment/format-preserving (pure)

New pure module `src/shared/env-file.ts` (no node/DOM imports; unit-tested):

```ts
export interface EnvEntry { key: string; value: string }

/** Parse KV entries from .env text for display. Handles `KEY=value`, `export KEY=value`,
 *  single/double-quoted values (unquoted in the result), `KEY=` (empty). Ignores comment
 *  (`#`) and blank lines. Duplicate keys: last wins. */
export function parseEnvEntries(text: string): EnvEntry[]

/** Reconcile the desired KV set into the existing .env text, preserving every non-KV line
 *  (comments/blanks) and the position of retained keys:
 *   - existing key in `desired`  → rewrite its line with the new value (in place)
 *   - existing key NOT in `desired` → drop that line (deleted)
 *   - `desired` key not in the file → append at the end
 *  Values needing it (space, #, =, quotes, empty) are double-quoted with escaping; else bare. */
export function applyEnvEdits(existingText: string, desired: EnvEntry[]): string

/** Plain-English label for a key: a curated map for common vars, else a humanized fallback
 *  (split on _, lowercase, capitalize first word, uppercase known acronyms API/URL/ID/DB/JWT/…). */
export function labelFor(key: string): string
```

- `labelFor` curated map (starter set; extend freely): `ANTHROPIC_API_KEY`→"Anthropic API key", `OPENAI_API_KEY`→"OpenAI API key", `DATABASE_URL`→"Database URL", `PORT`→"Port", `NODE_ENV`→"Environment", `JWT_SECRET`→"JWT secret", `REDIS_URL`→"Redis URL", `STRIPE_SECRET_KEY`→"Stripe secret key", `STRIPE_PUBLISHABLE_KEY`→"Stripe publishable key", `SUPABASE_URL`→"Supabase URL", `SUPABASE_ANON_KEY`→"Supabase anon key". Fallback example: `MY_TOKEN`→"My token".

## Main process

New focused module `src/main/engine/env-store.ts` (uses `getCurrentProjectPath` + `atomicWrite`):

```ts
export async function readEnvFile(): Promise<EnvEntry[]>   // parseEnvEntries of <projectPath>/.env; [] if the file is missing
export async function writeEnvFile(desired: EnvEntry[]): Promise<void>  // read current text ('' if missing) → applyEnvEdits → atomicWrite <projectPath>/.env
```

`writeEnvFile` re-reads the current file at write time so `applyEnvEdits` preserves any comments/lines present on disk.

IPC (mirror `readRole`/`writeRole`): channels `readEnv: 'env:read'`, `writeEnv: 'env:write'` on the `IPC` const; handlers in `ipc.ts` (`() => env.readEnvFile()`, `(_e, entries) => env.writeEnvFile(entries)`); preload methods + `RendererApi` types `readEnv: () => Promise<EnvEntry[]>`, `writeEnv: (entries: EnvEntry[]) => Promise<void>`. No engine/agent path touched.

## Renderer

- **Top-bar button** in `App.tsx` — a key icon (lucide `KeyRound`), placed in the config group near **Context**; opens `EnvModal` (like `showContext`).
- **`EnvModal.tsx`** (reuses the `Modal` primitive):
  - On open, calls `window.api.readEnv()` into local editable state.
  - One row per entry: **label** (`labelFor(key)`) + raw `key` (small mono) + **masked value** input (`type=password` style / `••••`) with a per-row **reveal** (eye) toggle + inline edit; a **delete** (×) per row.
  - An **Add variable** control: inputs for raw `KEY` + value (label auto-derived via `labelFor`); appends a row.
  - A short note: *"Edited directly on disk — no AI involved. Agents can still read `.env` like any file in the project."*
  - **Save** → `window.api.writeEnv(entries)` then close (or toast "Saved"). **Cancel** discards.
  - On-brand: reuse tokens, `.btn`, `Modal`, existing field styles; no new colors.

## Off / safety

- No settings flag — the feature is inert unless the user opens the modal and Saves. It never runs during an agent run and adds no engine behavior. Reading/writing `.env` is independent of everything else (a project with no `.env` shows an empty editor; not saving leaves the file untouched).

## Files touched (anticipated)

- `src/shared/env-file.ts` — **new** pure module (+ test).
- `src/main/engine/env-store.ts` — **new** read/write.
- `src/main/ipc.ts` — two handlers; `src/shared/types.ts` — `IPC.readEnv`/`IPC.writeEnv` + `RendererApi` methods + export `EnvEntry` (or import from env-file); `src/preload/index.ts` — two methods.
- `src/renderer/EnvModal.tsx` — **new** modal; `src/renderer/App.tsx` — top-bar button + mount.
- Tests: `env-file.test.ts`.

## Testing plan

- **Pure unit tests (`env-file.test.ts`):** `parseEnvEntries` (KV, `export`, quoted, empty value, comments/blanks ignored, dup-last-wins); `applyEnvEdits` (edit one value preserves comments + position; delete drops the line + keeps comments; add appends; quoting of values with spaces/#; round-trip a file with comments unchanged when desired == parsed); `labelFor` (curated hits + humanized fallback + acronym casing).
- **Main:** `readEnvFile`/`writeEnvFile` verified by typecheck (thin wrappers over the tested pure module + fs).
- **Gates:** typecheck + test (implementers); build + lint (renderer touched) at integration; user on-device smoke (open the modal on a project with a `.env`, reveal/edit/add/delete, Save, confirm the file on disk updated + comments preserved).

## Design-system notes

`EnvModal` reuses the `Modal` primitive, existing field/`.btn` styles, and tokens; the key icon is an existing lucide icon; no new colors/materials/motion. On-brand with Obsidian & Emerald.
