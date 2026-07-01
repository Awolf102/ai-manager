# Modal Internal Re-layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every `.modal`-based modal a consistent header / scrollable-body / pinned-footer layout so the title and action buttons stay visible while only the content scrolls, in the Notion-airy style matching the Settings modal — plus wire each title to `aria-labelledby`.

**Architecture:** A CSS restructure of the shared `.modal` box (single scroll box → flex column with header/body/footer regions), then per-modal JSX that wraps existing content in `.modal-header` + `.modal-body` (keeping `.modal-actions` as the pinned footer) and passes `labelledBy`. No new component; no store/IPC/engine/`shared` change; `<Modal>` unchanged.

**Tech Stack:** React 19, TypeScript, plain CSS (warm-dark tokens), Vitest, ESLint react-hooks gate.

## Global Constraints

- **Shared structure:** `.modal` = flex column (`overflow: hidden`, 86vh cap); regions `.modal-header` (fixed) / `.modal-body` (the only scroll region) / `.modal-actions` (pinned footer). The 20px panel padding moves INTO the regions.
- **Every `.modal`-based modal must wrap its content in `.modal-body`** — otherwise content sits outside the scroll region and overflows the fixed-height panel.
- **Notion-airy:** hairline dividers + open rows, **no card borders** (matches Settings).
- **Title fold:** replace `.modal h2` styling with `.modal-title` (keep `font-size: 16px`; margin becomes `0` — header padding provides spacing) so titles don't visually shift.
- **`.modal-wide` must drop its own `overflow: auto` + `max-height`** (they fight the flex column); keep only width/max-width. `.ctx-modal` is width-only (fine).
- **Accessibility:** each modal gets `<h2 id="<x>-title" className="modal-title">` and passes `labelledBy="<x>-title"` to `<Modal>`.
- **Scope:** FAQ, Confirm, HITL, Draft roles, Team preview, Context, Launch-app (RunResult), Add agent. `SettingsModal` is OUT (uses `unstyled`, not `.modal`).
- Warm-dark tokens only; no new tokens; no motion change (Surface-3 enter/exit unchanged); no behavior/data change; keep every handler verbatim.
- Never `git add` `.agents/`, `.claude/`, or `skills-lock.json`.
- **No new automated tests** (presentational; no pure logic; no component-test harness). Per-task verification: `npm run typecheck` + `npm run test` (476 green) + `npm run lint` (0 errors — required renderer gate). Build once at the final gate. Visual acceptance = the user's on-device smoke.
- **Ordering note:** Task 1 lands the CSS first, so un-converted modals look wrong (no padding / mis-scroll) until their conversion task lands. That's expected — the cycle is only coherent once all tasks merge; on-device smoke happens at the end.

---

### Task 1: CSS foundation — flex-column `.modal` + header/body/footer

**Files:**
- Modify: `src/renderer/styles.css` (`.modal` ~718, `.modal h2` ~729, `.modal-actions` ~734, `.modal-wide` ~1251)

**Interfaces:**
- Produces: CSS classes `.modal-header`, `.modal-title`, `.modal-desc`, `.modal-body`; restyled `.modal-actions`; flex-column `.modal`. Consumed by Tasks 2–6.

- [ ] **Step 1: Replace the `.modal` rule.** Change:

```css
.modal {
  width: 380px;
  max-height: 86vh;
  overflow-y: auto;
  background: var(--surface-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  padding: 20px;
  box-shadow: var(--elev-2);
}
```

to:

```css
.modal {
  width: 380px;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--elev-2);
}
```

- [ ] **Step 2: Replace the `.modal h2` rule with `.modal-title` + add the region classes.** Change:

```css
.modal h2 {
  margin: 0 0 16px;
  font-size: 16px;
}
```

to:

```css
.modal-title {
  margin: 0;
  font-size: 16px;
}
.modal-header {
  flex: none;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--hairline);
}
.modal-desc {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: var(--text-sm);
  line-height: var(--lh-normal);
}
.modal-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 16px 20px;
}
```

(The title stays an `<h2>`, so any base `h2` weight/color still applies; only margin + size are set here, matching the old `.modal h2`.)

- [ ] **Step 3: Restyle `.modal-actions` as the pinned footer.** Change:

```css
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
```

to:

```css
.modal-actions {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--hairline);
}
```

- [ ] **Step 4: Fix `.modal-wide` (drop overflow/max-height).** Change:

```css
.modal-wide {
  width: 640px;
  max-width: 90vw;
  max-height: 86vh;
  overflow: auto;
}
```

to:

```css
.modal-wide {
  width: 640px;
  max-width: 90vw;
}
```

- [ ] **Step 5: Verify.** `npm run typecheck` clean; `npm run test` green (476); `npm run lint` 0 errors. (Modals will look wrong until Tasks 2–6 — expected.)

- [ ] **Step 6: Commit.**

```bash
git add src/renderer/styles.css
git commit -m "feat(modals): flex-column modal shell (header/scroll-body/pinned-footer)"
```

---

### Task 2: Convert the small modals — FAQ, Confirm, HITL

**Files:**
- Modify: `src/renderer/FaqModal.tsx`, `src/renderer/ConfirmDialog.tsx`, `src/renderer/HitlModal.tsx`

**Interfaces:** Consumes the Task 1 classes + `<Modal labelledBy>` (existing prop).

- [ ] **Step 1: FaqModal.tsx** — set `labelledBy`, wrap header + body:

```tsx
    <Modal onClose={onClose} labelledBy="faq-title">
      {(close) => (
        <>
          <div className="modal-header">
            <h2 id="faq-title" className="modal-title">How to prompt Orkestr</h2>
          </div>
          <div className="modal-body">
            <div className="faq-body">
              <p><b>Give the orchestrator a goal.</b> Describe the outcome you want in plain language in the goal box, then press Run. The orchestrator plans the work and delegates down the chain.</p>
              <p><b>Build a team first if you have none.</b> Use <i>Draft roles</i> to suggest specialists, or <i>Build team</i> to have the orchestrator design and create one for your goal.</p>
              <p><b>Wire the chain.</b> Drag from the bottom of one agent to the top of another so the upper one delegates to the lower one.</p>
              <p><b>Watch and launch.</b> The Run tab streams progress; <i>Launch app</i> starts the app your team built and opens it.</p>
              <p><b>Good goals are specific.</b> State the what and the constraints (stack, scope, must-haves); leave the how to the team.</p>
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn primary" onClick={() => close()}>Got it</button>
          </div>
        </>
      )}
    </Modal>
```

- [ ] **Step 2: ConfirmDialog.tsx** — `labelledBy`, header + body (the `.confirm-body` text is the body):

```tsx
    <Modal onClose={() => resolveConfirm(false)} labelledBy="confirm-title">
      {(close) => (
        <>
          <div className="modal-header">
            <h2 id="confirm-title" className="modal-title">{title}</h2>
          </div>
          <div className="modal-body">
            <p className="confirm-body">{body}</p>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => close()}>Cancel</button>
            <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => close(() => resolveConfirm(true))}>
              {confirmLabel ?? 'Confirm'}
            </button>
          </div>
        </>
      )}
    </Modal>
```

- [ ] **Step 3: HitlModal.tsx** — keep `dismissable={false}`; add `labelledBy`; wrap header + body (question + field). Replace the render-prop body:

```tsx
    <Modal dismissable={false} onClose={() => minimizeInterrupt(true)} labelledBy="hitl-title">
      {(close) => (<>
        <div className="modal-header">
          <h2 id="hitl-title" className="modal-title">{pending.askerName} has a question</h2>
        </div>
        <div className="modal-body">
          <div className="hitl-question">{pending.question}</div>
          <div className="field">
            <textarea autoFocus rows={4} value={text} placeholder="Your answer…" onChange={(e) => setText(e.target.value)} />
            <div className="radio-desc" style={{ marginTop: 4 }}>
              Your answer is sent to the agent and saved in its session transcript (like any prompt). We redact it
              from the run history — but don't paste true secrets (API keys, passwords).
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => close(() => minimizeInterrupt(true))}>Minimize</button>
          <button className="btn" onClick={() => close(() => submit(''))}>Skip</button>
          <button className="btn primary" disabled={!text.trim()} onClick={() => close(() => submit(text.trim()))}>Submit</button>
        </div>
      </>)}
    </Modal>
```

- [ ] **Step 4: Verify.** `npm run typecheck` clean; `npm run test` green; `npm run lint` 0 errors.

- [ ] **Step 5: Commit.**

```bash
git add src/renderer/FaqModal.tsx src/renderer/ConfirmDialog.tsx src/renderer/HitlModal.tsx
git commit -m "feat(modals): header/body/footer + labelledBy for FAQ, Confirm, HITL"
```

---

### Task 3: Convert the list modals — Draft roles + Team preview (+ airy list)

**Files:**
- Modify: `src/renderer/RoleDraftModal.tsx`, `src/renderer/TeamSpawnModal.tsx`, `src/renderer/styles.css` (airy `.draft-list`)

**Interfaces:** Consumes Task 1 classes. Both use `className="modal-wide"`.

- [ ] **Step 1: RoleDraftModal.tsx** — add `labelledBy="roledraft-title"`; wrap the `<h2>` in `.modal-header`; wrap the `.draft-list` in `.modal-body`; keep `.modal-actions`. Result:

```tsx
    <Modal onClose={onClose} className="modal-wide" labelledBy="roledraft-title">{(close) => (<>
        <div className="modal-header">
          <h2 id="roledraft-title" className="modal-title">Draft roles ({edited.length})</h2>
        </div>
        <div className="modal-body">
          <div className="draft-list">
            {/* …existing edited.map(...) unchanged… */}
          </div>
        </div>
        <div className="modal-actions">
          {/* …existing Cancel / Apply buttons unchanged… */}
        </div>
    </>)}</Modal>
```

(Keep the existing `edited.map` list body and the two action buttons verbatim — only the surrounding header/body wrappers + `labelledBy` + title id/class are added.)

- [ ] **Step 2: TeamSpawnModal.tsx** — same treatment; add a `.modal-desc`. Title id `teamspawn-title`:

```tsx
    <Modal onClose={onClose} className="modal-wide" labelledBy="teamspawn-title">{(close) => (<>
        <div className="modal-header">
          <h2 id="teamspawn-title" className="modal-title">Proposed team ({edited.length})</h2>
          <p className="modal-desc">Review and edit names and roles before creating the team.</p>
        </div>
        <div className="modal-body">
          <div className="draft-list">
            {/* …existing edited.map(...) unchanged… */}
          </div>
        </div>
        <div className="modal-actions">
          {/* …existing Cancel / Apply buttons unchanged… */}
        </div>
    </>)}</Modal>
```

- [ ] **Step 3: Airy `.draft-list` items in styles.css.** Locate the existing `.draft-list` rule(s) (read them first). Add hairline separators + breathing room between items without card borders — append:

```css
.draft-list > .field {
  padding-bottom: 14px;
  border-bottom: 1px solid var(--hairline);
}
.draft-list > .field:last-child {
  padding-bottom: 0;
  border-bottom: none;
}
```

(If the existing `.draft-list` already sets item gap/margins that conflict, keep them and only add the separators; verify nothing double-spaces.)

- [ ] **Step 4: Verify.** `npm run typecheck` clean; `npm run test` green; `npm run lint` 0 errors.

- [ ] **Step 5: Commit.**

```bash
git add src/renderer/RoleDraftModal.tsx src/renderer/TeamSpawnModal.tsx src/renderer/styles.css
git commit -m "feat(modals): header/body/footer + airy list for Draft roles, Team preview"
```

---

### Task 4: Convert ContextModal

**Files:**
- Modify: `src/renderer/ContextModal.tsx`

**Interfaces:** Consumes Task 1 classes. Uses `className="ctx-modal"` (width-only — keep).

- [ ] **Step 1: Restructure.** Add `labelledBy="context-title"`. Move the `<h2>` + the `.ctx-hint` paragraph into a `.modal-header` (the hint reads as the description). Wrap BOTH `.ctx-section-head`/`.ctx-list` blocks (the whole middle) in a single `.modal-body`. Keep the final `.modal-actions` as the footer. Concretely, the return becomes:

```tsx
    <Modal onClose={onClose} className="ctx-modal" labelledBy="context-title">{(close) => (<>
        <div className="modal-header">
          <h2 id="context-title" className="modal-title">Project context</h2>
          <p className="ctx-hint">
            Reference material for this project. Every item goes to all agents by default — use "Applies to"
            to narrow it to specific agents.
          </p>
        </div>
        <div className="modal-body">
          {/* …existing: the two `<div className="ctx-section-head">…</div>` + `<div className="ctx-list">…</div>`
              blocks (Attached files, Referenced folders), unchanged… */}
        </div>
        <div className="modal-actions">
          <span className="spacer" />
          <button className="btn primary" onClick={() => close()}>Close</button>
        </div>
    </>)}</Modal>
```

Keep ALL existing logic (Thumb, ScopeControl, addFiles/addFolder/setScope, the `.map` bodies, the drag-drop notes) verbatim — only the header/body wrappers + title id/class + `labelledBy` change.

- [ ] **Step 2: Verify.** `npm run typecheck` clean; `npm run test` green; `npm run lint` 0 errors.

- [ ] **Step 3: Commit.**

```bash
git add src/renderer/ContextModal.tsx
git commit -m "feat(modals): header/body/footer + labelledBy for Context"
```

---

### Task 5: Convert RunResultModal (Launch app)

**Files:**
- Modify: `src/renderer/run/RunResultModal.tsx`

**Interfaces:** Consumes Task 1 classes. Uses `className="modal-wide"`.

- [ ] **Step 1: Restructure.** Add `labelledBy="runresult-title"`. Wrap the `<h2>Launch app</h2>` in `.modal-header`; wrap the whole middle (the `launchable ? (...) : (...)` block including the `.server-log` `<pre>`) in `.modal-body`; keep `.modal-actions` as the footer:

```tsx
    <Modal onClose={onClose} className="modal-wide" labelledBy="runresult-title">{(close) => (<>
        <div className="modal-header">
          <h2 id="runresult-title" className="modal-title">Launch app</h2>
        </div>
        <div className="modal-body">
          {launchable ? (
            <>
              {/* …existing form / rr-row / rr-notes / rr-status / server-log, unchanged… */}
            </>
          ) : (
            <p className="rr-notes">{/* …existing non-launchable message… */}</p>
          )}
        </div>
        <div className="modal-actions">
          {/* …existing Close / Stop / Launch&open / Open-folder buttons, unchanged… */}
        </div>
    </>)}</Modal>
```

Keep all state/effects/handlers (launch/stop, the server-log ref, etc.) verbatim.

- [ ] **Step 2: Verify.** `npm run typecheck` clean; `npm run test` green; `npm run lint` 0 errors.

- [ ] **Step 3: Commit.**

```bash
git add src/renderer/run/RunResultModal.tsx
git commit -m "feat(modals): header/body/footer + labelledBy for Launch app"
```

---

### Task 6: Convert AddAgentModal (in App.tsx)

**Files:**
- Modify: `src/renderer/App.tsx` (the `AddAgentModal` component, ~line 494)

**Interfaces:** Consumes Task 1 classes. Plain `.modal` (default width).

- [ ] **Step 1: Restructure.** Add `labelledBy="addagent-title"`. Wrap the `<h2>Add agent</h2>` in `.modal-header`; wrap the two `.field` blocks (Name + the Role radiogroup) in `.modal-body`; keep `.modal-actions`:

```tsx
    <Modal onClose={onClose} labelledBy="addagent-title">{(close) => (<>
        <div className="modal-header">
          <h2 id="addagent-title" className="modal-title">Add agent</h2>
        </div>
        <div className="modal-body">
          {/* …existing <div className="field">Name…</div> and
              <div className="field">Role in the chain … radiogroup</div>, unchanged (incl. kindRefs/rovingIndex)… */}
        </div>
        <div className="modal-actions">
          {/* …existing Cancel / Create buttons, unchanged… */}
        </div>
    </>)}</Modal>
```

Keep the `name`/`kind`/`kindRefs` hooks and the radiogroup logic verbatim.

- [ ] **Step 2: Verify.** `npm run typecheck` clean; `npm run test` green; `npm run lint` 0 errors.

- [ ] **Step 3: Commit.**

```bash
git add src/renderer/App.tsx
git commit -m "feat(modals): header/body/footer + labelledBy for Add agent"
```

---

### Task 7: Integration gate + on-device smoke handoff

**Files:** none modified.

- [ ] **Step 1:** `npm run typecheck` — clean.
- [ ] **Step 2:** `npm run test` — 476 pass (re-run once if only `run-store.test.ts` flakes).
- [ ] **Step 3:** `npm run lint` — 0 errors (1 known pre-existing `exhaustive-deps` warning is fine).
- [ ] **Step 4:** `npm run build` — completes.
- [ ] **Step 5: Record the on-device smoke checklist** (user runs it):
  - Open each modal: FAQ, Add agent, Context, Draft roles, Team preview, Launch app, and (trigger) Confirm + HITL.
  - Title + action buttons stay **pinned** while the body scrolls — verify with a long list (Context with several items / Team preview / Draft roles).
  - Airy header + spacing matches the Settings modal; short modals (FAQ, Confirm) look right (no odd empty space).
  - Enter/exit motion still animates; Escape/click-outside still close (except HITL); Confirm returns true/false correctly.
  - VoiceOver announces each modal by its title (labelledBy wired).
- [ ] **Step 6:** No commit. Report for the Opus whole-branch review + merge decision.

---

## Self-Review

**Spec coverage:**
- Flex-column `.modal` + header/body/pinned-footer → Task 1. ✓
- `.modal-wide` overflow fix + `.modal h2`→`.modal-title` fold → Task 1. ✓
- Airy list rhythm → Task 3. ✓
- Per-modal conversion (all 8) → Tasks 2 (FAQ/Confirm/HITL) + 3 (Draft/Team) + 4 (Context) + 5 (RunResult) + 6 (AddAgent). ✓
- `labelledBy` wired on every modal → each conversion task. ✓
- Settings excluded → not in any task (noted in constraints). ✓
- No motion/behavior/data change; handlers verbatim → constraints + per-task notes. ✓
- Verification (typecheck+test+lint+build+on-device) → each task + Task 7. ✓

**Placeholder scan:** Full code for the small modals (Task 2) + CSS (Task 1); the larger modals (Tasks 3–6) use explicit wrap recipes with the exact `<Modal>`/title/actions anchors and "unchanged" markers for the verbatim bodies — this is a mechanical structural wrap, not omitted content. No TBD/TODO.

**Type consistency:** Class names consistent across tasks (`.modal-header`/`.modal-title`/`.modal-desc`/`.modal-body`/`.modal-actions`); title id ↔ `labelledBy` pairs match per modal (`faq-title`, `confirm-title`, `hitl-title`, `roledraft-title`, `teamspawn-title`, `context-title`, `runresult-title`, `addagent-title`). No new symbols/props (uses `<Modal>`'s existing `labelledBy`).
