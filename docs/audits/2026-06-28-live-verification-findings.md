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

**Attempt 2 (engineered: Builder needs a runtime-only "greeting word" only Docs knows, in no file):**
**✅ HANDOFF FIRED & WORKED + 🐞 NOT PERSISTED.** Run `2026-06-29T05-32Z`.
- **Runtime (verified, incl. screenshot):** Builder read the files, hit the wall, emitted a real
  ` ```handoff {to:"Docs", ask:"what greeting word should greet() use?"} ` block → UI showed
  **`↪ Handoff: Builder → Docs`** → **Docs ran as the consulted peer** (terminal filled; answered **"Hello"**)
  → **Builder resumed with the answer** and used it (verified code matched; **no stale session**). The audit's
  Dimension-1 "Expected" for handoff (↪ line · peer runs · asker continues) is **met live** — the
  "handoff never run against real Claude" gap is **cleared.**
- **🐞 PERSISTENCE BUG (R2 confirmed, #23/#27/#25):** the run record has **no `handoffs` field at all**
  (`'handoffs' in record → False`). A handoff that visibly fired left **zero durable trace** in History
  (no asker/peer/ask record). `state.handoffs` was never set / not persisted. This is exactly R2's "handoff
  persistence & observability" — now with a live repro.
- **Related observation:** the orchestrator *also* planned `t1: "Get greeting word from Docs"`, so the lateral
  handoff overlapped a planned task — redundancy between planner-resolution and handoff. Note for R2 scoping.

**Status:** handoff path **verified working live** (clears the audit's never-run concern); **R2 persistence/
observability gap confirmed** (handoffs not recorded). Also: forcing a handoff required an *engineered*
ephemeral-consult goal — natural goals get sequenced (Attempt 1), so the path is rarely hit in normal use.

## Test 3 — Mid-run re-plan + escalation

**🚫 DID NOT FIRE** (engineered "re-plan if step-1 discovery doesn't match" goal). Run `2026-06-29T05-…Z`:
`replans` key **absent**, plan = 3 tasks, **all passed review on attempt 1** (t1/t2/t3 → pass), no drift, no
review failure → no proactive re-plan, no escalation. The orchestrator planned correctly upfront and the
discovery matched its assumptions. (3rd "adaptive path rarely fires naturally" data point, after Test 2 att.1.)

**Implication for R1 — un-blocks it rather than stalling:** the re-plan/escalation paths won't trigger on
demand, BUT R1's bugs (#6/#7/#13 in `mergeReplan`/`replan.ts` — clobbered frozen tasks, duplicate plan ids,
dangling `dependsOn`) are **deterministic, unit-testable code defects** that do NOT require a live repro: feed
`mergeReplan` a replan decision and assert it preserves passed tasks / dedupes ids / repoints-or-drops orphan
deps. So **R1 can proceed via code-level fixes + unit tests.** The "live-verify before R1" caveat is satisfied
(we tried; it doesn't fire naturally) — escalation/replan integrity is now an R1 code cycle, not a live gate.

## Test 4 — P3 durable resume
_(pending)_
