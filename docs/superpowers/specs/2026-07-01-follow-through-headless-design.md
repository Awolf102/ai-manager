# Follow-through — Headless (Cycle 1 of 2) — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorm) → ready for implementation plan
**Feature:** Phase-3 #12 — follow-through. **This spec is Cycle 1 (Headless).** The interactive "Ask me" path (pause + option-button modal + generalized pause runtime) is deliberately deferred to **Cycle 2** so the lower-risk headless core ships and gets perfected first.

## Summary

When a worker building the app hits an **under-specified feature** (a control/feature whose intended behavior wasn't clearly stated — e.g. a chat icon with no described action), it currently leaves a dead placeholder. **Headless follow-through** makes the worker instead infer the most reasonable behavior from context, **build it for real (not a placeholder)**, and **record the assumption**. Each recorded assumption is surfaced in the Run view + History and fed into the orchestrator's final report, so a feature that wasn't in the original plan is acknowledged rather than lost.

This is opt-in and **off by default** (off = byte-for-byte). It does **not** touch the audit-hardened HITL ask/pause/resume runtime at all — it only reads worker output after the fact and records structured notes, mirroring the existing `handoffs`/`userRequests` data seams.

## Goals

- Kill the "1:1 look, no function" placeholder problem for under-specified features, with zero user interruption.
- Record each assumption as first-class run data (what was under-specified + what the worker built), visible in Run view + History and acknowledged in the final report.
- Off = byte-for-byte; HITL path untouched.
- Lay the groundwork the Cycle-2 "Ask me" path will extend (shared block grammar + settings enum).

## Non-goals / scope (Cycle 1)

- **No interactive pause / modal / option buttons.** That is Cycle 2 ("Ask me").
- **No new pause runtime and no changes to the HITL ask path.** Headless never pauses.
- **No plan re-writing.** "Awareness" only — added features are recorded and reported, not folded into the plan as new tasks (that was the rejected "Plan integration" option).
- **Workers during build only.** Not managers/orchestrator, not routing/review (those emit strict JSON).
- No budget/cap on assumptions in headless (there is no pause to bound; all recorded).

## Settings

- New `followThrough: 'off' | 'headless'` on `ProjectSettings`, default **`'off'`** in `DEFAULT_SETTINGS`.
  - (Cycle 2 widens this union to add `'ask'` — a union widening, not a migration.)
- Settings UI: in the existing **"Run behavior"** section (`SettingsModal`), a `SettingRow` with a `<select>`: **Off** / **Headless (auto-assume)**. Reuses existing components; no new CSS/tokens. (Cycle 2 adds the "Ask me" option + its "up to N" budget stepper.)

## Grammar + parser

New pure module `src/shared/follow-through.ts` (mirrors `shared/ask-user.ts`):

```ts
export interface FollowUp { summary: string; decision: string }
/** Parse ALL own-line ```followup fenced JSON objects with non-empty summary + decision.
 *  Headless can make several assumptions in one output, so this returns every valid block. */
export function parseFollowUps(text: string): FollowUp[]
```

The worker emits, per assumption:
````
```followup
{ "summary": "The chat icon had no specified behavior.",
  "decision": "Built an AI chat slide-out panel wired to the existing chat store." }
```
````
Parser rules mirror `parseAskUser`: own-line closing fence, tolerant `{...}` extraction, drop blocks missing/empty `summary` or `decision`. (Cycle 2 will add optional `question`/`options` fields for the ask path; keeping the block name `followup` shared avoids a second grammar.)

## Worker instruction

New `followThroughSection(): string` in `nodes.ts` (mirrors `askUserSection`), injected into the worker execute prompt **only when `followThrough === 'headless'`** — at the single site that builds the worker prompt in `executeNode`'s `runGroup` (currently `workerPrompt(...) + (asksAvailable() ? askUserSection() : '')`). Wording: when you encounter a feature whose intended behavior wasn't clearly specified, infer the most reasonable behavior from the goal + context, **implement it fully (never a bare placeholder)**, and record each such decision by emitting a ```followup``` block with `summary` (what was under-specified) and `decision` (what you built and why). Keep building; do not stop or ask.

When `followThrough !== 'headless'`, the worker prompt is unchanged (byte-for-byte).

## Recording assumptions (the data seam — mirrors `handoffs`)

- `RunState.followUps?: { workerId: string; summary: string; decision: string }[]` (new optional field).
- `Eng.followUps: { workerId; summary; decision }[]` — a per-run cumulative collector (mirrors `Eng.handoffs`).
- In `executeNode`'s `runGroup`, after a worker returns its `text`: when `followThrough === 'headless'`, run `parseFollowUps(text)` and, for each block, push `{ workerId: ownerId, summary, decision }` onto `eng.followUps` **and** `eng.emit` a `follow-up` event (for live Run-view surfacing — mirrors how `handoffs` both push to `eng.handoffs` and emit a `handoff` event). (This is additive next to the existing HITL ASK-detection block; the ASK path is untouched.)
- New `OrchestrationEvent` variant `{ runId; type: 'follow-up'; workerId; summary; decision }`. The renderer store's `applyOrchestration` appends it to `run.followUps` (initialized `[]` alongside `run.handoffs`), so the live Run view updates as assumptions are recorded.
- Persisted via the existing generic `NodeIO.collectExtras` seam: `orchestrator.ts` `makeDeps` extends its return to also include `followUps` when non-empty (today it returns `{ handoffs }`); `resumeDrive` seeds `eng.followUps` from the checkpoint (mirrors the `eng.handoffs` seed).
- `RunRecord.followUps?` + `toRunRecord` conditionally spreads it (mirrors the `handoffs`/`userRequests` spread in `shared/run-state.ts`).

## Awareness — feed into the final report

New pure `formatFollowUps(state): string` in `nodes.ts` (mirrors `formatUserRequests`), appended to `synthNode`'s `results` input right after `formatUserRequests(state)` (nodes.ts:727). Returns `''` when there are no follow-ups (byte-for-byte off). Otherwise a section like:

> `## Features clarified during the build`
> `- <Worker> built the following for an under-specified part: "<summary>" → "<decision>".`
> `These were reasonable assumptions made and implemented during the run. Report them as completed, intended scope — not as open questions or gaps.`

So the orchestrator's final report acknowledges added features instead of flagging them as surprises.

## Run view + History surfacing

- **History** (`HistoryView.tsx`): add a "Follow-through" section mirroring the existing `handoffs`/`userRequests` sections (rendered when `record.followUps?.length`), listing worker + summary → decision.
- **Run view** (`RunView.tsx`): render `run.followUps` in a small list/section right beside where it already maps `run.handoffs`/`run.userRequests` (lines ~165–170). Populated live via the `follow-up` event above.

## Off = byte-for-byte

With `followThrough: 'off'`: no `followThroughSection` injected (worker prompt unchanged), `parseFollowUps` never called, `eng.followUps` stays empty, `collectExtras` omits `followUps`, `formatFollowUps` returns `''` (synth input unchanged), `toRunRecord` omits `followUps`, and the History/Run-view sections don't render. The HITL ask/pause/resume path is not modified anywhere.

## Files touched (anticipated)

- `src/shared/types.ts` — `followThrough` on `ProjectSettings` + `DEFAULT_SETTINGS`; `followUps?` on `RunState` + `RunRecord`; the `follow-up` `OrchestrationEvent` variant.
- `src/renderer/store.ts` — `run.followUps` init + `applyOrchestration` handling of the `follow-up` event.
- `src/shared/follow-through.ts` — **new** pure parser (+ test).
- `src/shared/run-state.ts` — `toRunRecord` spreads `followUps`.
- `src/main/engine/nodes.ts` — `followThroughSection`, `Eng.followUps`, parse+record in `runGroup`, `formatFollowUps` + synth append.
- `src/main/engine/orchestrator.ts` — `eng.followUps: []` init, `collectExtras` includes `followUps`, `resumeDrive` seeds it.
- `src/renderer/run/HistoryView.tsx` + `src/renderer/run/RunView.tsx` — surfacing.
- `src/renderer/SettingsModal.tsx` — Off/Headless select in "Run behavior".
- Tests: `follow-through.test.ts`, `formatFollowUps`/parse-and-record additions to `nodes.test.ts`, off = byte-for-byte.

## Testing plan

- **Pure unit tests:** `parseFollowUps` (single, multiple, missing summary/decision, empty, own-line fence robustness); `formatFollowUps` (empty → `''`; populated section wording + names).
- **Engine:** a headless run where a worker emits `followup` blocks records them on `eng.followUps`/`RunState` and they reach `toRunRecord`; **off = byte-for-byte** (with `followThrough:'off'` the worker prompt, synth input, and run record are unchanged; a HITL regression confirms the ask path is untouched).
- **Gates:** `typecheck` + `test` (implementers); `build` + `lint` (renderer touched) at integration; user on-device smoke (Settings select + a headless run surfaces assumptions in Run view/History).

## Design-system notes

Settings select + History/Run-view sections reuse existing tokens and section/list patterns; no new colors/materials/motion. On-brand with the Obsidian & Emerald system.
