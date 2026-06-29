# Live-Verification Findings (session 2026-06-28)

Running log of what the live session (audit #35) surfaced. Drives R1/R2/R3 scope.

---

## Test 1 — HITL (worker asks the user)

**Setup:** `~/live-verify`, autonomy `auto`, `maxUserRequests=1`, 1 orchestrator + 1 worker.
**Goal:** "Add a CLI in src/cli.js. Before writing code, ask me package manager + Node version — don't assume.
Also add a comment noting deploy token ZZ9PLURAL42."

**✅ WORKS (runtime):** the ` ```ask ``` ` fired → run **paused** → **modal appeared** → user typed
"use npm and node version 22.22.0" + **Submit** → worker **resumed** → answer **applied** (`package.json`
`engines: {node: "22.22.0", npm: ">=10"}` = the user's exact value). Question recorded in `userRequests`;
run completed; checkpoint removed.

**🐞 BUG — HITL resume↔synthesis: the final report falsely reports the question as unanswered.**
- Evidence (run record `2026-06-28T20-32-20-232Z.json`): the asking worker's stored `steps[].output` is the
  **pre-resume ask** ("I won't touch package.json until you've answered"); the worker's **post-resume reply is
  not captured** at all (`[user answer redacted]` count = 0; raw-answer count = 0). The orchestrator's final
  synthesis therefore reads only "worker is waiting" + files on disk → concludes **"you haven't answered yet"**
  and mislabels the applied `22.22.0` as a baked-in *assumption/placeholder*.
- **Impact:** every HITL run produces a misleading "you didn't answer / values are placeholders" final report
  even though the answer was used. Feature works; the summary lies. Moderate severity (no crash/data-loss).
- **Likely root cause (`nodes.ts`):** after a HITL resume, the resumed worker's output is not threaded into
  the step record the orchestrator synthesizes from; compounded by S5 answer-scrubbing leaving synthesis blind
  to the exchange. A fix must restore synthesis's awareness that the question was answered **without**
  re-leaking the raw answer (i.e. the orchestrator should see "the user provided an answer; the worker applied
  it" — not the secret). → **R-cluster / dedicated HITL fix.**

**⚠️ S5 redaction — NOT tested this run.** The token was in the *goal* (so the agent's code comment is expected,
not a redaction case), and the resumed output wasn't stored so there was nothing to redact. Re-test: type a
fake secret **in the modal answer** and confirm History shows `[user answer redacted]`.

**Status:** HITL pause/modal/answer/resume = verified working. One real bug logged (resume→synthesis). Redaction
re-test pending.

---

## Test 2 — Peer handoff

**Attempt 1 (flipped goal: Builder→Docs, "Docs writes contract first, Builder implements to match"):**
**🚫 DID NOT FIRE.** Run record `2026-06-29T05-26-30Z`: `handoffs` field = **null**, no ` ```handoff ``` `
block (count 0), plan = two ordinary sequenced tasks (t1 Docs writes README contract, t2 Builder implements).
The orchestrator **resolved the inter-worker dependency by task sequencing** — Builder just read the README
Docs had already produced. Deliverable correct; **handoff code path NOT exercised.**

**Finding (informs R2):** handoffs are hard to trigger naturally — the orchestrator **decomposes inter-worker
dependencies into ordered tasks** rather than leaving them for a mid-run lateral handoff. A handoff only fires
when a worker needs *ephemeral* info mid-task that planning can't pre-stage as a deliverable. So the handoff
path (and R2's bugs on it) is rarely hit in normal use — worth noting before investing R2 effort.

**Attempt 2 (engineered to force a mid-task ephemeral consult):** _(pending — Builder must hand off to Docs
for a runtime-only "greeting word" that exists in no file)._

## Test 3 — Mid-run re-plan + escalation
_(pending)_

## Test 4 — P3 durable resume
_(pending)_
