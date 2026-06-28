# Live-Verification Session — Checklist (audit #35)

**Goal:** exercise the orchestration paths that have **never run end-to-end against real Claude**, confirm
the *Expected* behavior, and capture any failures. This **blocks R1/R2** (their bugs live on these paths —
patching them blind is risky). **Uses real tokens + the GUI + you.**

Primary targets (audit Dimension-1 "no" rows): **HITL**, **peer handoff**, **mid-run re-plan**, **escalation**.
Bonus (recent cycles, also never live): **P3 durable resume**, **S5 HITL redaction**, **Full-auto lock**,
**plugin trust**.

---

## 0. Setup (once)

**Throwaway project** — run in your terminal (you can prefix with `!` to run it in this session):

```bash
mkdir -p ~/live-verify && cd ~/live-verify && git init -q && \
printf '# scratch\n\nThrowaway project for verifying AI-Manager orchestration.\n' > README.md && \
mkdir -p src && printf 'export const greet = (n) => `hi ${n}`\n' > src/greet.js && \
git add -A && git commit -qm "init scratch project"
```

**In AI-Manager:**
1. Open project folder → `~/live-verify`. (Confirm the Auth pill is green.)
2. **Settings → enable the gated features** (all default to 0/off):
   - **Autonomy = `auto`** (safe: runs safe commands, guarded). *(For Test 7 only you'll switch to Full.)*
   - **maxUserRequests = 1** (HITL)
   - **maxHandoffs = 1** (handoff)
   - **maxReplans = 1** (re-plan + escalation)
3. **Build a team:** click **Build team** (orchestrator proposes one — accept a small 1-orchestrator + 2-worker
   team), or manually add an orchestrator + 2 workers. Name the two workers something distinct
   (e.g. **Builder** and **Docs**) — Test 2 needs two peers.

> Each test below is its own run. Commit the scratch repo between runs if you want a clean slate
> (`git -C ~/live-verify add -A && git commit -qm wip`).

---

## 1. HITL — a worker pauses to ask you (#5 / S5)  ← most reliable trigger

**Goal (paste into the goal bar):**
> Add a small CLI entry point in `src/cli.js`. **Before writing any code, ask me which package manager
> (npm/pnpm/yarn) and which Node version to target — do not assume.** Then implement it. When I answer,
> include a comment in the file noting the token I give you: `use deploy token ZZ9PLURAL42`.

(The last sentence is to test **S5 redaction** — a ≥6-char "secret" the agent will likely echo.)

**Expected / look for:**
- [ ] Run **pauses**; the **HitlModal** shows the question.
- [ ] **Minimize** → it becomes a badge; restore works.
- [ ] **Submit** an answer → the **same** worker continues *from where it paused* (does not restart the run).
- [ ] **Stop** is disabled while paused.
- [ ] (Re-run, optionally) **Skip** (empty answer) → the worker proceeds best-effort.
- [ ] **S5 redaction:** after completion, open **History → this run →** the worker's output. The token
      `ZZ9PLURAL42` must appear as **`[user answer redacted]`** (or not at all) — **never the raw value**.
      The **question** is recorded; the raw **answer** is not in the app's records.

**Failure signs:** question never surfaces · Submit restarts instead of resuming · the raw secret appears
verbatim in History output.

---

## 2. Peer handoff — a worker consults a peer (Phase 3)

**Setup:** On the canvas, **select the edge between your two workers** (or draw one) → **"Make handoff"**
(it becomes a **dashed** edge). `maxHandoffs ≥ 1`.

**Goal:**
> **Builder:** implement `greet(name)` in `src/greet.js` with input validation (throw on empty/non-string),
> and decide the final exact function signature. **Docs:** write a `## Usage` section in `README.md` for
> `greet`. The **Docs** worker must **hand off to the Builder** to get the exact final signature and
> validation rules **before** writing the docs — do not guess the API.

**Expected / look for:**
- [ ] A **`↪ Handoff`** line appears in the Run view (and in History).
- [ ] The **peer (Builder)** actually runs — its terminal fills with output.
- [ ] The **asker (Docs)** **resumes with the peer's answer** and finishes using it (not a stale/empty answer).
- [ ] Bounded by `maxHandoffs` — a 2nd handoff beyond the cap is refused.

**Known caveat (not a P3 bug):** the audit flagged that the consulted peer's **run-tree pill may show
idle/done** while it actually works (a separate Important finding) — note if you see it, but it's not a
handoff-correctness failure.

**Failure signs:** handoff block parsed but **peer never runs** · asker **resumes a stale session** (gets a
wrong/empty answer).

---

## 3. Mid-run re-plan (Phase 2) + escalation (two-tier review v2)

These are **agent-judgment-driven** — the hardest to force. `maxReplans ≥ 1`. Design the goal to induce them;
if they don't fire, **note "did not trigger"** rather than forcing it. The point: *if* they fire, do they
behave?

**Goal (induces a re-plan and/or a mis-scoped-task escalation):**
> Build a small in-memory task-list module in `src/tasks.js`: add, list, complete, and **persist to disk**.
> Do the whole thing as you see fit. If partway through your plan turns out wrong or a task was too big to
> review cleanly, **re-plan** the remaining work — don't force a bad breakdown.

**Expected / look for:**
- [ ] A **re-plan / escalate line** appears in the Run view (the `replan` event).
- [ ] **Passed tasks are NOT redone** (frozen); only not-passed tasks are re-broken-up.
- [ ] The run still **converges to completion** and is **bounded** by `maxReplans` (no infinite loop).

**Failure signs — these are exactly the R1 bugs to watch (#6/#7/#13):**
- [ ] Passed/frozen tasks get **clobbered or redone**.
- [ ] **Duplicate plan ids** appear.
- [ ] A task is stuck waiting on a **`dependsOn` that no longer exists** (dangling dependency after re-plan).

> If you see any of these, capture the Run view + History — that's the R1 evidence. R1 will fix them; this
> session just confirms whether the machinery runs and **how** it fails so R1 is informed (or re-scoped).

---

## 4. P3 durable resume — crash recovery (NEW, never live)

**Crash path:** start any small run; **while it's running**, **force-quit** the app (Cmd+Q / kill). Re-open
the app and the `~/live-verify` project.
- [ ] On open: a **banner** "N run(s) can be resumed" + a **badge** on the History button.
- [ ] History → a **"Resumable"** section with the crashed run (pill: **Crashed**).
- [ ] **Resume** continues it from the last checkpoint.
- [ ] **Discard** (with confirm) removes it; the banner/badge clear.

**Paused path (the #12 case):** start the **Test-1 HITL** goal again; when it **pauses** (modal), **reload the
renderer** (Cmd+R) or force-quit. Re-open the project.
- [ ] The paused run shows in **Resumable** (pill: **Paused**).
- [ ] **Resume** → the **question modal re-appears** → answer → it continues.

**Also confirm:**
- [ ] A **genuinely in-flight** run is **not** shown as resumable (start a run, open History mid-run — it
      should be in the live view, not the Resumable list).
- [ ] With **no checkpoints**, **no banner/badge** (normal state).

---

## 5. Full-auto lock (S3+S4)

- Settings → **Security**: Autonomy = **Full auto** (acknowledge the danger gate) **and** turn
  **"Never bypass permissions" (lock) ON**.
- Run any small goal.
- [ ] The run behaves like **acceptEdits** (auto-accepts edits) rather than unrestricted bypass — the lock
      clamps it. *(Hard to observe directly; mainly confirm the run still works and isn't visibly unrestricted.)*
- [ ] Turn the lock **OFF** (still Full auto) → bypass is active again (the acknowledged danger mode).

## 6. Plugin trust (S3)

- Settings → **Security**: **"Auto-trust only Anthropic-authored skills" = ON** (default).
- Open an agent's config → the skills it can be assigned.
- [ ] Only **Anthropic-authored** skills are offered (e.g. **frontend-design**); **superpowers / stripe** are
      **not** offered.
- [ ] Toggle the setting **OFF** → broader marketplace skills appear.

---

## Results to capture (hand back to me)

For each of Tests 1–4: **did it fire?** **did it behave per Expected?** **any failure signs?** (note "did not
trigger" where applicable). The headline I need: **do escalation / re-plan / handoff / HITL run correctly
live, or exactly how do they fail** — that determines whether R1/R2 can proceed as planned or need re-scoping.
Tests 4–6 (P3/lock/trust) are bonus confirmations that the recent cycles work in the real app.
