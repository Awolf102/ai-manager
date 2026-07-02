# Follow-through — "Ask me" (Cycle 2 of 2) — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorm) → ready for implementation plan
**Feature:** Phase-3 #12 — follow-through. **This spec is Cycle 2 (interactive "Ask me").** Cycle 1 (Headless) already shipped (merge `45baa30`): the `followThrough` setting, the `followUps` run data + `follow-up` event + store/RunView/HistoryView surfacing + synthesis feed, and `parseFollowUps`. Cycle 2 adds the interactive pause path and reuses all of cycle 1's recording/surfacing.

## Summary

Add an **"Ask me"** mode to follow-through. When a worker hits an under-specified feature, instead of assuming (headless) it emits a richer follow-up block `{ summary, question, options }`, the run **pauses**, and a modal shows the summary + question with the agent's **clickable suggested options** (plus free-text). The user's pick resumes the worker with that decision, which is recorded and surfaced exactly like a headless follow-through (cycle 1's `followUps` → Run view + History + final report). **Skip** → the worker proceeds with a reasonable assumption, recorded as the decision.

The interactive pause **reuses the existing HITL pause/queue/resume runtime additively** (Approach A): the same `asks`/`askQueue`/`pendingAsk`/`resumeAsker`/interrupt/`resumeRun` machinery, with each pause tagged by `source` and follow-through-specific branches guarded so that **when Ask-me is off the HITL path is byte-for-byte unchanged**.

## Goals

- Let non-technical users steer under-specified features via clickable, agent-proposed options — without editing prompts.
- Reuse cycle 1's recording/surfacing/synthesis so a chosen feature "sticks" (awareness) with zero new data plumbing.
- Reuse the proven HITL pause runtime; add only guarded branches; keep HITL byte-for-byte when Ask-me is off.
- Off = byte-for-byte overall.

## Non-goals / scope

- **Workers during build only** (same as cycle 1). No manager/orchestrator/routing/review pausing.
- **No plan integration** — awareness only (a chosen feature is recorded + reported, not turned into new plan tasks).
- **No generalized pause-engine refactor.** We extend the HITL machinery in place (Approach A), not rewrite it into a kind-dispatcher (Approach C) nor duplicate it (Approach B).
- Options are a small list (0–4) the agent proposes; free-text is always available.

## Settings

- Widen `ProjectSettings.followThrough` from `'off' | 'headless'` to **`'off' | 'headless' | 'ask'`** (default stays `'off'`).
- Add `maxFollowThrough: number` (default **0**) — the pause budget for `'ask'` mode (how many times the run may pause for a follow-through). `0` with `followThrough: 'ask'` means the mode is selected but no pauses are allowed (treated as off for pausing); the Settings UI keeps them consistent by defaulting the budget to a sensible value when Ask-me is chosen (see UI).
- Settings UI (`SettingsModal`, Run behavior section): the existing Off/Headless select gains **"Ask me"**; when "Ask me" is selected, reveal an "up to N" stepper bound to `maxFollowThrough` (default 3 when first switched on). Reuses existing components; no new CSS.

## Grammar + parser

Extend `src/shared/follow-through.ts` with a sibling parser (keep `parseFollowUps` for headless unchanged):

```ts
export interface FollowUpAsk { summary: string; question: string; options: string[] }
/** Parse the LAST own-line ```followup block carrying a non-empty summary + question
 *  (options optional, capped to 4, empties dropped). Returns null when absent/malformed.
 *  Prefers the last block (mirrors parseAskUser's "last block" rule for a pause trigger). */
export function parseFollowUpAsk(text: string): FollowUpAsk | null
```

Ask-mode block shape:
````
```followup
{ "summary": "The chat icon has no specified behavior.",
  "question": "What should this button do?",
  "options": ["Open an AI chat slide-out panel", "Link to a help page", "Remove it"] }
```
````
(Headless keeps `{ summary, decision }` via the existing `parseFollowUps`; the two shapes are distinguished by the mode's instruction, and by which parser the engine runs.)

## Worker instruction

Add `followThroughAskSection(): string` in `nodes.ts` (parallel to the existing headless `followThroughSection`). Injected into the worker execute prompt **only when `followThrough === 'ask'`** (at the same site cycle 1 injects the headless section). Wording: when you hit a feature whose behavior wasn't specified, do NOT assume — pause and ask by replying with ONLY a ```followup``` block carrying `summary` (what's under-specified), `question` (what you need decided), and `options` (2–4 concrete choices you propose). Ask only for genuinely under-specified features; otherwise finish normally.

When `followThrough !== 'ask'`, the worker prompt is unchanged.

## Runtime — Approach A (reuse + extend the HITL pause path)

The HITL machinery in `executeNode` collects worker `ask` blocks into `asks[]`, pauses on one (interrupt `kind: 'ask-user'`), queues the rest in `askQueue`, and on re-entry resumes via `resumeAsker` + drains the queue. Cycle 2 extends this **additively**:

1. **Tagged pause items.** The `asks[]` items and the `RunState.pendingAsk`/`askQueue` items gain `source: 'ask-user' | 'follow-through'` and, for follow-through, `summary: string` + `options: string[]`. Existing HITL items are `source: 'ask-user'` (no summary/options).
2. **New budget/state.** `RunState.followThroughCount: number` (mirrors `userRequestCount`). Helper `followThroughAskAvailable() = getSettings().followThrough === 'ask' && followThroughCount < maxFollowThrough`.
3. **Detection** (in `runGroup`, right after the cycle-1 headless-record block and before/alongside the existing HITL ASK DETECTION): when `followThroughAskAvailable()`, run `parseFollowUpAsk(text)`; if present, set the group's tasks `pending` and push an `asks` item with `source: 'follow-through'`, `question: fa.question`, `summary: fa.summary`, `options: fa.options`, then `return` (leaving the group pending — same shape as the HITL ask branch). The existing HITL `parseAskUser` branch is unchanged and still gated by `asksAvailable()`. A worker in 'ask' mode won't have HITL asks unless `maxUserRequests>0` too; both can coexist.
4. **Wave-end presentation** (the existing `asks.length > 0` block): generalize the single-budget slot logic to per-source. Partition `asks` by source; a follow-through ask is "presentable" while `followThroughCount + (already-presented follow-through count) < maxFollowThrough`, an HITL ask while under `maxUserRequests` (as today). Overflow items of either source are resumed best-effort (HITL with `''` as today; follow-through with `''` → its Skip behavior). Pause on the head (plan-ordered), queue the rest (mixed sources allowed), and build the interrupt from the head's source:
   - `source: 'ask-user'` → `{ kind: 'ask-user', prompt, payload: { askerId, askerName, question } }` (unchanged).
   - `source: 'follow-through'` → `{ kind: 'follow-through', prompt: question, payload: { askerId, askerName, summary, question, options } }`.
5. **Re-entry** (the existing `resumeInput && pendingAsk` block): branch on `pendingAsk.source`:
   - `'ask-user'` → `resumeAsker` (with `redactUserAnswer` scrubbing, as today); `userRequestCount += 1`.
   - `'follow-through'` → `resumeFollowUpAsk` (below); `followThroughCount += 1`.
   Then drain `askQueue` (mixed sources) exactly as today, building the next interrupt from the next item's source.
6. **`resumeFollowUpAsk`** (new, mirrors `resumeAsker` minus scrubbing): resume the asking worker's session with the decision, set task output, and — crucially — **record a follow-up** by pushing `{ workerId: ownerId, summary: pendingAsk.summary, decision }` onto `eng.followUps` and emitting the `follow-up` event (reuses cycle 1's recording/surfacing/synthesis). No `redactUserAnswer` (a scope decision isn't a secret). `decision` = the user's answer, or on Skip (`answer === ''`) a sentinel like `"(skipped — the worker proceeded with a reasonable assumption)"` while the worker is resumed with the existing `answerResumePrompt('')` (which already says "make a reasonable assumption … note the assumption").

**Byte-for-byte guarantee:** every follow-through branch is guarded on `source === 'follow-through'` / `followThrough === 'ask'` / `followThroughAskAvailable()`. With Ask-me off, `asks` items are all `source: 'ask-user'`, the detection/presentation/re-entry take only the HITL paths, and `resumeAsker` + its scrubbing are unchanged.

## Renderer

- **Interrupt/store:** the `Interrupt` already carries `kind` + `payload`. Extend the store's `pendingInterrupt` to `{ kind: 'ask-user' | 'follow-through'; question; askerName; askerId; summary?; options? }`. In `applyOrchestration`'s `interrupt` case, branch on `e.interrupt.kind`: for `'ask-user'` set the fields + push `userRequests` (as today); for `'follow-through'` set the fields incl. `summary`/`options` and do **not** push `userRequests` (it becomes a `followUps` entry via the `follow-up` event on resume).
- **Modal:** new `src/renderer/FollowThroughModal.tsx` (reuses the `Modal` primitive): renders when `pendingInterrupt.kind === 'follow-through'` — shows the summary, the question, one **clickable button per option** (click → submit that option), a free-text box + Submit, and Skip / Minimize (mirrors `HitlModal`'s controls + `resumeRun` wiring via `answerInterrupt`). Add a `kind === 'ask-user'` guard to `HitlModal` so exactly one modal shows. Mount `FollowThroughModal` next to `HitlModal` in `App.tsx`.
- On-brand: reuse tokens/`Modal`/button styles; option buttons use existing `.btn` styling; no new colors/motion.

## Off = byte-for-byte

`followThrough !== 'ask'` (and `maxFollowThrough` unread): no ask-instruction, no `parseFollowUpAsk`, no follow-through `asks` items, no `follow-through` interrupt, `FollowThroughModal` renders nothing. The HITL ask path (parseAskUser, resumeAsker, scrubbing, userRequestCount, the modal) is unchanged. Cycle-1 headless behavior is unchanged.

## Files touched (anticipated)

- `src/shared/types.ts` — widen `followThrough` union; `maxFollowThrough` on `ProjectSettings` + `DEFAULT_SETTINGS`; `followThroughCount` on `RunState`; `source`/`summary`/`options` on `pendingAsk`/`askQueue` item types; `follow-through` interrupt payload shape (via existing `Interrupt`).
- `src/shared/follow-through.ts` — `parseFollowUpAsk` (+ test).
- `src/main/engine/nodes.ts` — `followThroughAskSection`; detection; per-source wave-end presentation; re-entry branch; `resumeFollowUpAsk`; `asks` item type.
- `src/renderer/store.ts` — `pendingInterrupt` shape + `interrupt`-case branch on kind.
- `src/renderer/FollowThroughModal.tsx` — new modal; `src/renderer/HitlModal.tsx` — kind guard; `src/renderer/App.tsx` — mount.
- Tests: `follow-through.test.ts` (parseFollowUpAsk); `nodes.test.ts` (ask-mode pause records a followUp on resume; Skip records the sentinel; **HITL byte-for-byte regression**; a combined HITL + follow-through same-wave test).

## Testing plan

- **Pure:** `parseFollowUpAsk` (summary+question required, options optional/capped, last-block, malformed → null).
- **Engine (nodes.test.ts):** ask-mode → a worker `followup`-ask block pauses with interrupt `kind: 'follow-through'` (payload carries summary+options) and `pendingAsk.source === 'follow-through'`; resuming with an answer records a `followUp {workerId, summary, decision}` (via `eng.followUps` + emitted event) and does NOT scrub; Skip records the sentinel decision; **with Ask-me off, the HITL ask path is byte-for-byte** (existing HITL tests still pass unchanged); a same-wave HITL+follow-through case pauses/queues/resumes both with the right counters.
- **Gates:** typecheck + test (implementers); build + lint (renderer touched) at integration; user on-device smoke (Settings → Ask me; a run that pauses with option buttons; pick + Skip both work and show in Run view/History).

## Design-system notes

`FollowThroughModal` reuses the `Modal` primitive, existing `.btn` styles for option buttons, and tokens; no new colors/materials/motion. On-brand with Obsidian & Emerald.
