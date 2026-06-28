# HITL Secret-Handling Truth-Up — Design (cycle S5)

**Date:** 2026-06-28
**Cycle:** S5 from `docs/audits/2026-06-27-remediation-cycles.md`
**Audit findings closed:** #10 (Critical — HITL answer reaches disk despite app-level scrubbing) + the
abort-path scrub-gap Minor (`graph.ts`).

---

## 1. Principle

The Stage-3 HITL feature (a worker pauses to ask the user a question; the user's free-text **answer**
resumes that worker's session) was documented as "the answer never hits disk." That claim is **false
overall**. This cycle **truths it up**: redact/scrub what the **app durably owns**, and be honest about the
one channel we should not (and cannot cleanly) eliminate.

The answer reaches disk via three channels:

| Channel | Where | App-owned? | This cycle |
|---|---|---|---|
| (b) **Echoed output** — the resumed worker echoes the answer in its reply | `RunState.steps[].output` → checkpoint + permanent History `RunRecord.steps[].output` (`.ai-manager/runs/*.json`) | **Yes** | **Redact** at the capture point |
| Abort-path checkpoint | `graph.ts` abort branch persists a `cancelled` checkpoint still carrying `resumeInput` (the answer) | **Yes** | **Scrub** `resumeInput`, symmetric with the error path |
| (a) **SDK session transcript** — the answer is sent into the worker's Claude session | `~/.claude/projects/.../{sessionId}.jsonl` | No (user's own `~/.claude` data, needed for resume) | **Document honestly** (truthful UI copy + memory fix); do not touch |

The app already correctly scrubs its own two answer-bearing live fields (`resumeInput`/`pendingAsk`) from the
executed-path checkpoint returns, and `userRequests` stores **questions only**. This cycle closes the
remaining app-owned gaps and removes the false guarantee.

---

## 2. Redact the echoed answer from app records

### 2.1 Pure helper (`src/shared/ask-user.ts`)

Add next to `parseAskUser`:

```
redactUserAnswer(text: string, answer: string): string
```

- Let `a = answer.trim()`. If `a.length < MIN_REDACT_LEN` (**`MIN_REDACT_LEN = 6`**), return `text`
  unchanged. Otherwise replace **every verbatim occurrence** of `a` (the trimmed answer) in `text` with the
  placeholder `[user answer redacted]`, and return the result.
- No node/DOM imports (pure module, unit-tested in plain Node). Uses a literal global string replace
  (`text.split(a).join(placeholder)` — not a `RegExp`, so no escaping/catastrophic-match issues).

**Why the length threshold.** Most HITL answers are short non-secret decisions ("yes", "option B"); secrets
(API keys, passwords, tokens, URLs-with-tokens) are long. A literal global replace of a *short* string would
both (a) mangle the common case and (b) hit substrings of normal words ("no" inside "node"). Gating on
`length ≥ 6` protects long secret-like answers while leaving short decisions — and normal prose — intact. The
threshold is a tunable constant.

**Which string to match.** The engine injects the raw answer via `answerResumePrompt(answer)`, but a worker
that echoes it echoes the *content*, not the surrounding prompt whitespace — so the helper takes the raw
`answer`, trims it internally to `a`, and redacts `a` (boundary-whitespace-insensitive). `a.length ≥
MIN_REDACT_LEN` gates whether redaction runs at all.

**Honest caveat (documented, not fixed):** only *verbatim* echoes are caught. If the worker paraphrases or
transforms the answer, the paraphrase is not redacted. This is the inherent limit of output redaction; the
truthful UI copy (§4) covers it.

### 2.2 Apply at the single capture point (`src/main/engine/nodes.ts`)

The resumed worker's output is captured once, at the line currently reading:

```ts
const out = r.text || '(no output)'
```

Change to:

```ts
const out = redactUserAnswer(r.text || '(no output)', answer)
```

`answer` is already in scope (`const answer = String(state.resumeInput ?? '')`). This single change flows into
`t.output`, `steps[ask.ownerId].output`, the resume checkpoint (`io.checkpoint({...steps...})`), and History
(`toRunRecord`). No other site receives the answer, so one redaction point covers every app-owned echo path.
Import `redactUserAnswer` from `../../shared/ask-user` (alongside the existing `parseAskUser` import).

---

## 3. Close the abort-path scrub gap (`src/main/engine/graph.ts`)

The driver's abort branch currently sets `cancelled` **without** scrubbing the answer:

```ts
if (io.signal.aborted) {
  state = { ...state, status: 'cancelled', updatedAt: now() }
  break
}
```

Make it symmetric with the existing error-path scrub (`resumeInput: undefined` at the error branch):

```ts
if (io.signal.aborted) {
  state = { ...state, status: 'cancelled', resumeInput: undefined, updatedAt: now() }
  break
}
```

This closes the transient on-disk window where a `Stop`-during/after-a-HITL-resume persisted a `cancelled`
checkpoint still carrying the raw answer. `pendingAsk` (which holds only the non-secret question + sessionId,
already recorded in `userRequests`) is intentionally left as-is — matching the error-path scope, which also
leaves it. Only the secret (`resumeInput`) is scrubbed.

---

## 4. Truthful UI copy (`src/renderer/HitlModal.tsx`)

The current copy is already honest but pre-dates redaction:

> Your answer is sent to the agent and may appear in its output — don't paste secrets.

Update it to state the new reality precisely:

> Your answer is sent to the agent and saved in its session transcript (like any prompt). We redact it from
> the run history — but don't paste true secrets (API keys, passwords).

This is the security-correctness half of the modal copy (part of audit #10). It is **not** the deferred #30 UX
work: the "Skip" relabel, abort-while-paused, and renderer-reload recovery (#12) remain out of scope for S5.

---

## 5. Fix the false memory claim (post-merge, not code)

After merge, correct the `ai-manager-hitl-stage3` project-memory headline ("the answer never hits disk") to
the truthful statement: the app redacts the answer from its own records (History/checkpoint) and scrubs the
abort path, but the agent's Claude session transcript necessarily holds it like any prompt. Recorded here so
the truth-up is complete across code **and** the durable notes that overstated it.

---

## 6. Testing

**Pure (`src/shared/ask-user.test.ts`):**
- `redactUserAnswer`: a single verbatim occurrence of a ≥6-char answer → replaced with the placeholder;
  multiple occurrences → all replaced; an answer shorter than `MIN_REDACT_LEN` → text returned unchanged
  (including that its substrings in normal words are NOT touched); empty/whitespace answer → unchanged; an
  answer absent from the text → text unchanged.

**Engine (`src/main/engine/nodes.test.ts`, extending the existing HITL tests):**
- After a HITL resume where the worker **echoes** a long (≥6-char) answer in its output, the persisted step
  `output` (and the resume checkpoint) contains the placeholder and **not** the raw answer.

**Engine (`src/main/engine/graph.test.ts`):**
- An abort that occurs after a HITL resume produces a `cancelled` checkpoint with `resumeInput === undefined`.

**Off-by-default unchanged:** `maxUserRequests = 0` ⇒ the resume path never runs ⇒ byte-for-byte unchanged.
`redactUserAnswer` is only ever invoked on the HITL resume path. Full suite stays green plus the net-new tests;
`tsc` + `build` clean.

---

## 7. Scope / non-goals

- **No SDK-transcript deletion/ephemeralization** (decided: document only — it's needed for session resume and
  is the user's own `~/.claude` data).
- **No #30 UX redesign** (Skip relabel, abort-while-paused) and **no #12 reload-recovery affordance** — those
  stay deferred to the overhaul / their own cycles.
- **No change to question recording** (`userRequests` stores questions only — already correct) or to the
  existing executed-path/error-path scrubs (already correct).

---

## 8. File-by-file

| File | Change |
|---|---|
| `src/shared/ask-user.ts` | + `redactUserAnswer(text, answer)` + `MIN_REDACT_LEN`. |
| `src/shared/ask-user.test.ts` | + `redactUserAnswer` unit tests. |
| `src/main/engine/nodes.ts` | apply `redactUserAnswer` at the resume capture point; import it. |
| `src/main/engine/graph.ts` | scrub `resumeInput` on the abort branch. |
| `src/main/engine/nodes.test.ts` | + echoed-answer-redacted-from-output test. |
| `src/main/engine/graph.test.ts` | + abort-after-resume scrubs `resumeInput` test. |
| `src/renderer/HitlModal.tsx` | truthful answer-handling copy. |
| `ai-manager-hitl-stage3` memory | (post-merge) correct the false "never hits disk" headline. |
