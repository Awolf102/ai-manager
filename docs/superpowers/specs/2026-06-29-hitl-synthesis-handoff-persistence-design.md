# Spec — HITL resume→synthesis + Handoff persistence (batched remediation cycle)

**Date:** 2026-06-29
**Cycle:** the first item of the `nodes.ts` run-loop cluster (the live-verify follow-on), batching the
**NEW HITL resume→synthesis bug** with **R2 (handoff persistence & observability, audit #23/#27/#25)**.
**Why batched:** both are the same theme — *a resumed/consulted sub-run's activity isn't captured into the
durable record/synthesis* — both live in `nodes.ts` (the serial run-loop file, never parallel-branch), and
they share no merge-safe seam to split.
**Repros:** `docs/audits/2026-06-28-live-verification-findings.md` (Test 1 = HITL; Test 2 att.2 = handoff).

---

## Background & root causes (verified by reading source)

### HITL resume→synthesis
- `synthNode` (`nodes.ts:672`) builds its synthesis input as
  `formatResults(state) + formatVerdicts(state)`.
- `formatResults` (`nodes.ts:1202`) reads **only** `state.tasks[t.id].output`; `formatVerdicts`
  (`nodes.ts:1213`) reads **only** `state.tasks[t.id].verdict`.
- **Neither reads `state.userRequests`.** So the orchestrator's final synthesis has *zero awareness* that a
  worker paused to ask the user a question or that the user answered. Seeing only the worker's text (which, on
  a resumed session, tends to **recap** "I won't touch X until you answer…") plus files on disk, it concludes
  "you haven't answered / the values are placeholders."
- The resume block (`nodes.ts:238–275`) **does** capture the resumed worker's output into both
  `tasks[].output` and `steps[].output` (via `redactUserAnswer`), and the existing unit test
  (`nodes.test.ts` — "redacts an echoed answer…") asserts `final.tasks['t1'].output` contains the redacted
  reply. So the static evidence says capture works; the live "resumed reply not captured" symptom is **not
  reproducible from reading alone** and is most likely the recap-misread above, not a capture gap.

### R2 — handoff persistence & observability
- A handoff fires inside `runWithHandoffs` (`nodes.ts:974`): it **emits** an event
  (`eng.emit({type:'handoff', askerId, peerId, ask})`, `nodes.ts:985`) but **never writes to
  `state.handoffs`**.
- `RunState.handoffs?` and `RunRecord.handoffs?` already exist (`shared/types.ts`); `toRunRecord`
  (`shared/run-state.ts:29`) already spreads `s.handoffs` when present; `HistoryView.tsx:169` already renders a
  `Handoffs (N)` section. So the **only** missing link is populating `state.handoffs`. Persistence is
  therefore **engine-only** — no renderer change.
- The consulted **peer's status pill stays "idle"** because `runWithHandoffs` never calls
  `setStatus(eng, …, peer.id, 'working')` around the peer run (workers/repair/review all do this; the peer
  consult path doesn't).
- `runWithHandoffs` is reached from three sites: the worker site (`runGroup`, `nodes.ts:299`) and the
  reviewer/orchestrator structured-call site (`runStructured`, `nodes.ts:1031`, used by `reviewStep` and
  `integrationReviewStep`). Gated by `maxHandoffs` (default 0 = off).

---

## Goals

1. The orchestrator's **final report no longer claims a HITL question was unanswered** (and no longer
   mislabels an applied answer as a placeholder) when the user *did* answer — **without re-leaking the raw
   answer** into synthesis.
2. A handoff that fires is **persisted** into the run record (`handoffs: {askerId, peerId, ask}[]`), so
   History shows it after the run / after a crash-resume.
3. The **consulted peer's live status pill** reflects that it is working during a handoff.
4. Off-by-default paths (`maxUserRequests=0`, `maxHandoffs=0`) remain **byte-for-byte** unchanged.

## Non-goals (YAGNI — explicitly out of scope)

- The planner-resolution ↔ handoff **redundancy** the live session noted (orchestrator also planning "get the
  greeting word from Docs"). That's prompt-tuning behavior, not persistence — not touched here.
- Surfacing **handoffs into synthesis** (R2 is record/observability only; not flagged as a synthesis-blindness
  bug). Skip.
- Deleting/altering the SDK `{sessionId}.jsonl` transcript (out of scope, per S5's accepted residual).
- Any change to the redaction policy itself (S5 stands).

---

## Design

### Part 1 — HITL synthesis awareness

**1a. New pure helper `formatUserRequests(state)`** (in `nodes.ts`, beside `formatResults`/`formatVerdicts`):
- Returns `''` when `state.userRequests` is empty/absent (→ off-path byte-for-byte).
- Otherwise returns a section like:
  ```
  ## User consultations during this run
  - {askerName} paused to ask the user: "{question}". The user provided an answer, which {askerName}
    incorporated into its work. (The answer itself is redacted from this record.)
  ```
  - `askerName` resolved via `getAgent(askerId).name` (guard a missing agent → fall back to the id).
  - Built **only** from `state.userRequests` (questions; already persisted; S5-safe). The raw answer is never
    read here.

**1b. Wire it into synthesis.** In `synthNode` (`nodes.ts:676`), append `formatUserRequests(state)` to the
`results` string passed to `synthesizeStep`. Keep the `owned.length > 0` gating intact (a consultation
section may appear even when results exist; when no work was assigned but a consult happened, still surface
the consultation).

**1c. Synth prompt guidance.** Add one sentence to `synthPrompt` instructing the orchestrator: when a "User
consultations" section is present, treat those questions as **answered and resolved** — do not report them as
open or describe incorporated values as assumptions/placeholders. (Keep the prompt change minimal and
additive so non-HITL runs read identically.)

**1d. Investigative repro (per approved scope "repro-and-fix-if-real").** Using **systematic-debugging**,
write a *faithful, live-shaped* test: full `runGraph` → worker asks → pause → `resumeGraph` with an answer →
run to synthesis; assert the resumed worker's post-resume output is present in `final.tasks[].output` AND that
the synthesized `final.final` reflects "answered" (via the new section).
- If this reproduces a **real capture gap** (resumed output missing from the record), fix it at the resume
  block and document the cause.
- If capture works (expected, matching the existing unit test), the test stands as a **regression guard** and
  the cycle notes record that the live symptom was synthesis-blindness (Part 1a–c), not a capture gap.
- Either way: an honest, evidence-backed outcome — no speculative code.

### Part 2 — Handoff persistence & peer status

**2a. `Eng` gains a handoffs collector.** Add `handoffs: { askerId: string; peerId: string; ask: string }[]`
to the `Eng` interface (`nodes.ts:54`). Seed it from the initial `RunState.handoffs` at engine construction
(in `orchestrator.ts`, where `Eng` is built) so it continues accumulating across a resume. (Seed `[]` when
absent → off-path unchanged.)

**2b. Record at the single origin.** In `runWithHandoffs` (`nodes.ts:985`), immediately after the existing
`eng.emit({type:'handoff', …})`, push `{ askerId: consult.asker, peerId: peer.id, ask: req.ask }` onto
`eng.handoffs`.

**2c. Thread into persisted state with a minimal surface.** The nodes from which a handoff can actually fire —
`executeNode` (worker site), `domainReviewNode` and `integrationReviewNode` (their reviewers consult via
`reviewStep`/`integrationReviewStep`) — include `...(eng.handoffs.length ? { handoffs: [...eng.handoffs] } : {})`
in their returned patch(es). (`synthNode` does **not** consult — `synthesizeStep` calls `eng.runAgent`
directly with no `Consult` — so it doesn't need the key; later nodes preserve an already-set `state.handoffs`
through the graph's cumulative `{...state, ...patch}` merge.) Reading from the `eng` collector avoids changing
`runWithHandoffs`/`runStructured`/`reviewStep`/`integrationReviewStep` **signatures** (no helper churn in the
1,500-line serial file). Graph merge persists the patch; `io.checkpoint` calls inherit it via `{...state}`.
This mirrors the existing `replans`/`userRequests` persistence pattern and is checkpoint-safe.
- Keep the existing `scrub`/field-spread shape of each patch return; only add the conditional `handoffs` key.

**2d. Peer status pill.** In `runWithHandoffs`, around the peer run (`nodes.ts:988–997`), emit the peer's live
status so its pill flips: `eng.emit({type:'status', nodeId: peer.id, status:'working', taskTitles:[…]})`
before the call and a terminal `status` (`'done'`, or `'idle'`/`'error'` on failure) after. Use the existing
`status` event shape the renderer already consumes (`store.ts` `case 'status'`). Do **not** mutate the
reporting `steps` record for the peer (the peer isn't an owned task step); a live status emit is sufficient
for the pill. (If a `steps` entry is the cleaner path, mirror `setStatus` but confirm it doesn't corrupt the
peer's real step record elsewhere — prefer the pure emit.)

---

## Files touched

- `src/main/engine/nodes.ts` — `Eng` type; `formatUserRequests`; `synthNode` results wiring; `synthPrompt`
  sentence; `runWithHandoffs` (push + peer status); `handoffs` in the three handoff-capable nodes' patches
  (`executeNode`, `domainReviewNode`, `integrationReviewNode`).
- `src/main/engine/orchestrator.ts` — seed `eng.handoffs` from initial state.
- `src/main/engine/nodes.test.ts` — new tests (below). Possibly `shared/run-state.test.ts` if a
  `toRunRecord(handoffs)` unit is warranted (already covered by type spread; add only if missing).
- **No renderer changes** (HistoryView + store already handle `handoffs` and `status`).
- `shared/types.ts` — no change (fields already exist).

## Tests (TDD)

1. `formatUserRequests` (pure): empty → `''`; one/many requests → expected section text; missing-agent →
   id fallback; never contains an answer (only questions are inputs).
2. Synthesis-awareness: a full HITL run (ask → resume → synth) produces a `final.final` /
   `synthPrompt` input containing the "User consultations" section; the raw answer appears nowhere in
   persisted state (re-assert the S5 invariant end-to-end).
3. Faithful HITL repro (Part 1d): asserts resumed output reaches `final.tasks[].output`; outcome documented.
4. Handoff persistence: a run with `maxHandoffs>0` and a firing handoff yields
   `final.handoffs` / `toRunRecord(final).handoffs` containing `{askerId, peerId, ask}`; survives across a
   checkpoint. Cover both the worker site and a review/structured site.
5. Peer status: a `status` event with `nodeId === peer.id` and `status:'working'` is emitted during a handoff.
6. Off-path byte-for-byte: `maxUserRequests=0` and `maxHandoffs=0` runs emit no `handoffs` key and no
   user-consultation section (existing snapshot/flat-team tests stay green).

## Acceptance criteria

- A HITL run where the user answers produces a final report that acknowledges the answer (no "unanswered" /
  no "placeholder" mislabel), with the raw answer absent from all persisted records.
- A run with a firing handoff persists it into the saved `RunRecord` (History shows it) and the consulted
  peer's pill shows activity live.
- `maxUserRequests=0` / `maxHandoffs=0` paths unchanged (tests prove byte-for-byte).
- Full suite green (340 + new), `tsc` (node+web) clean, `build` clean.

## Risks

- **Serial-file collision:** this is the start of the `nodes.ts` R-cluster — run it alone; do not branch R1
  in parallel.
- **Synth prompt drift:** the added sentence must be additive so non-HITL synthesis output is unaffected;
  verify with an existing non-HITL synth test.
- **Patch-spread correctness:** adding `handoffs` to four patch returns must not drop the existing
  `scrub`/`userRequests`/`tasks`/`steps` fields — review each return carefully (a reviewer focus area).
