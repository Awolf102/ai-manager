# Top Bar / App-Shell Frame Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the persistent top bar from a flat ~9-button row into an identity cluster + hairline-separated action groups, swap the text brand for `BrandMark`, make the bar reflect open surfaces, and add one restrained origin-aware dropdown animation.

**Architecture:** Purely presentational + trivial state wiring. Three files: `App.tsx` (`.topbar` markup + open-state classNames), `TeamMenu.tsx` (trigger active-state), `styles.css` (group/divider/brand/dropdown-motion). `BrandMark.tsx` reused unchanged. No store/IPC/engine/behavior change.

**Tech Stack:** React 19, TypeScript, plain CSS (warm-dark token system in `tokens.css`), lucide-react icons, Vitest (existing suite), electron-vite build.

## Global Constraints

- **Zero behavior / IPC / engine / store change.** Every click handler stays byte-for-byte; this is markup regroup + className toggles + CSS only.
- **Warm-dark tokens only.** Use existing tokens: `--fg`/`--text`, `--fg-muted`/`--muted`, `--hairline`, `--hairline-strong`, `--signal`, `--surface-hover`, `--surface-2`, `--text-sm` (12px), `--text-md` (15px), `--motion` (180ms), `--motion-fast` (120ms), `--ease-out`. No new tokens.
- **No emoji-as-UI.** Icons are lucide (already imported in `App.tsx`: `CircleHelp`, `FolderOpen`, `Clock`, `Terminal`, `Users`, `Paperclip`, `SettingsIcon` alias for Settings, `Plus`; `BrandMark` also already imported).
- **No top-bar entrance/decorative motion** (Emil high-frequency rule). The only animation added is the Team ▾ dropdown open.
- **`@starting-style` house convention = standalone form** (matches `Modal.tsx` CSS): `@starting-style { .selector { … } }`, not nested.
- **Reduced motion:** honor `@media (prefers-reduced-motion: reduce)`.
- **Never `git add`** `.agents/`, `.claude/`, or `skills-lock.json` (pre-existing untracked, not ours). Add only the specific files each task names.
- **No new automated tests** (no component-test harness — no testing-library/jsdom; all `*.test.ts` are pure-node logic). Per-task verification = `npm run typecheck` clean + `npm run test` (full suite stays green, currently 462). Build runs once at the final gate. Visual/motion acceptance = the user's on-device smoke.

---

### Task 1: Restructure the top bar (markup + open-state + CSS)

Regroup the `.topbar` into a left identity cluster and right action groups, swap the text brand for `BrandMark` + wordmark, move `Switch project` into the left cluster and `FAQ` into the config group, and reflect open surfaces (Settings/Context/FAQ) via the existing `.btn.active`.

**Files:**
- Modify: `src/renderer/App.tsx` (the `<div className="topbar">…</div>` block, currently lines ~155–175)
- Modify: `src/renderer/styles.css` (replace the `.topbar .brand` rule ~lines 43–47; augment `.topbar .project` ~lines 49–51; add group/sep/brand/authpill rules)

**Interfaces:**
- Consumes: `BrandMark` (already imported in `App.tsx`; props `{ size: number }`). Existing in-scope values: `graph.project.name`, `graph.linkedTeam`, `graph.context`, `graph.contextFolders`, `resumable`, `auth`, `authChecking`, and local booleans `showContext`, `showSettings`, `showFaq`, `showDock`; handlers `setShowContext`, `setShowSettings`, `setShowFaq`, `toggleDock`, `openHistory`, `recheckAuth`, `setGraph`, `refreshResumable`, `pickProjectFolder`, `setShowAdd`.
- Produces: new CSS classes `.topbar-brand`, `.topbar-wordmark`, `.topbar-group`, `.topbar-sep` (Task 2 reuses none of these; they're self-contained to this surface).

- [ ] **Step 1: Replace the `.topbar` JSX block in `App.tsx`.**

Replace the entire current `<div className="topbar"> … </div>` block with:

```tsx
      <div className="topbar">
        <div className="topbar-brand">
          <BrandMark size={20} />
          <span className="topbar-wordmark">Orkestr</span>
        </div>
        <span className="topbar-sep" aria-hidden="true" />
        <span className="project">{graph.project.name}</span>
        <button className="btn" title="Switch to another project" onClick={async () => { const g = await window.api.pickProjectFolder(); if (g) { setGraph(g); void refreshResumable(true) } }}><FolderOpen size={14} /> Switch project</button>

        <span className="spacer" />

        <div className="topbar-group">
          <AuthPill checking={authChecking} status={auth} onClick={() => void recheckAuth()} />
        </div>
        <span className="topbar-sep" aria-hidden="true" />
        <div className="topbar-group">
          <button className="btn" title="Run history" onClick={() => openHistory()}><Clock size={14} /> History{resumable.length > 0 && <span className="resume-badge">{resumable.length}</span>}</button>
          <button className={`btn ctx-btn ${showContext ? 'active' : ''}`} title="Project context — files & folders for the team" onClick={() => setShowContext(true)}><Paperclip size={14} /> Context{((graph.context?.length ?? 0) + (graph.contextFolders?.length ?? 0)) > 0 && <span className="ctx-badge">{(graph.context?.length ?? 0) + (graph.contextFolders?.length ?? 0)}</span>}</button>
          <button
            className={`btn ${showDock ? 'active' : ''}`}
            title={showDock ? 'Hide the bottom panel' : 'Show the bottom panel'}
            onClick={() => toggleDock()}
          >
            <Terminal size={14} /> Terminal
          </button>
        </div>
        <span className="topbar-sep" aria-hidden="true" />
        <div className="topbar-group">
          <TeamMenu />
          {graph.linkedTeam && (<span className="team-link" title={`Linked team brain: ${graph.linkedTeam.path}`}><Users size={12} /> {graph.linkedTeam.path.split(/[\\/]/).pop()}</span>)}
          <button className={`btn ${showSettings ? 'active' : ''}`} title="Settings" onClick={() => setShowSettings(true)}><SettingsIcon size={14} /> Settings</button>
          <button className={`btn faq-btn ${showFaq ? 'active' : ''}`} title="How to prompt" onClick={() => setShowFaq(true)}><CircleHelp size={15} /></button>
        </div>
        <span className="topbar-sep" aria-hidden="true" />
        <button className="btn primary" onClick={() => setShowAdd(true)}><Plus size={14} /> Add agent</button>
      </div>
```

Notes for the implementer:
- This removes the old leading `.faq-btn` and the old `<span className="brand">Orkestr</span>`; the brand text now lives in `.topbar-wordmark`.
- `Switch project` moved to the left cluster; `FAQ` moved to the config group (last). No handler changes.
- Open-state reflection added: Context/Settings/FAQ get `${flag ? 'active' : ''}`; Terminal already had `showDock`.
- Do NOT add `active` to the Team ▾ trigger here — that lives inside `TeamMenu` and is Task 2.

- [ ] **Step 2: Update the top-bar CSS in `styles.css`.**

Delete the existing `.topbar .brand { … }` rule (lines ~43–47) — the `brand` class no longer exists. Replace the existing `.topbar .project { color: var(--muted); }` rule with the truncating version, and add the new cluster/group rules. Net CSS to have present:

```css
/* ---- identity cluster ---- */
.topbar-brand {
  display: flex;
  align-items: center;
  gap: 8px;
}
.topbar-wordmark {
  font-weight: 650;
  letter-spacing: 0.2px;
  font-size: var(--text-md);
  color: var(--text);
}
.topbar .project {
  color: var(--muted);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- action groups + hairline separators ---- */
.topbar-group {
  display: flex;
  align-items: center;
  gap: 8px;
}
.topbar-sep {
  width: 1px;
  height: 18px;
  background: var(--hairline-strong);
  flex: none;
}

/* auth pill crossfades on state change (rare) instead of snapping */
.auth-pill {
  transition: color var(--motion) var(--ease-out), border-color var(--motion) var(--ease-out);
}
```

Notes:
- Leave `.topbar { … -webkit-app-region: drag }` and `.topbar button, .toolbtn { -webkit-app-region: no-drag }` untouched — the descendant selector `.topbar button` still matches buttons nested in `.topbar-group`, and `.auth-pill` keeps its own `no-drag`. The `.topbar-brand`/`.topbar-group`/`.topbar-sep` wrappers intentionally stay in the drag region (their gaps drag the window).
- The old `.brand { padding-left: 64px }` indent is intentionally NOT carried over: the window uses a standard native titlebar (`src/main/index.ts` sets no `titleBarStyle`/`frame:false`), so there are no overlapping traffic lights — the 64px was vestigial. The identity cluster now sits at the `.topbar`'s own `padding: 0 14px`.

- [ ] **Step 3: Typecheck.**

Run: `npm run typecheck`
Expected: clean (no errors). If `AuthPill` / any moved identifier is reported unused or undefined, re-check the block was pasted intact.

- [ ] **Step 4: Run the full test suite (regression).**

Run: `npm run test`
Expected: all tests pass (currently 462). No test renders `App.tsx`, so this guards against accidental import/syntax breakage.

- [ ] **Step 5: Commit.**

```bash
git add src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(topbar): regroup into identity + action clusters, BrandMark, open-state reflection"
```

---

### Task 2: Team ▾ — active trigger + origin-aware dropdown motion

Make the Team ▾ trigger reflect its open state, and give the dropdown a single restrained origin-aware enter animation (the one animation this surface earns).

**Files:**
- Modify: `src/renderer/TeamMenu.tsx` (the trigger `<button>` className, ~line 42)
- Modify: `src/renderer/styles.css` (augment `.topmenu-list`, ~lines 1615–1618)

**Interfaces:**
- Consumes: `TeamMenu`'s existing internal `open` state (`useState`) and `.btn.active` style (from `styles.css`, already defined). `.topmenu-list` is `position: absolute; top: 100%; right: 0` → right-aligned under the trigger, so the scale origin is `top right`.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Reflect `open` on the trigger button in `TeamMenu.tsx`.**

Change the trigger button line from:

```tsx
      <button className="btn" onClick={() => setOpen((v) => !v)}>Team <ChevronDown size={12} /></button>
```

to:

```tsx
      <button className={`btn ${open ? 'active' : ''}`} onClick={() => setOpen((v) => !v)}>Team <ChevronDown size={12} /></button>
```

No other TeamMenu change is needed: the dropdown is already `{open && <div className="topmenu-list">…}`, so it mounts fresh on each open and `@starting-style` (Step 2) fires the enter animation. Close stays instant (unmount) — the documented action/dismiss asymmetry.

- [ ] **Step 2: Add the dropdown enter motion in `styles.css`.**

Immediately after the existing `.topmenu-list button:hover { … }` rule (~line 1618), add:

```css
/* ---- Team ▾ dropdown: origin-aware enter (the one earned animation) ---- */
.topmenu-list {
  transform-origin: top right;
  transition: opacity var(--motion) var(--ease-out), transform var(--motion) var(--ease-out);
}
@starting-style {
  .topmenu-list { opacity: 0; transform: scale(0.97); }
}
@media (prefers-reduced-motion: reduce) {
  /* opacity-only: transform snaps, no sustained movement */
  .topmenu-list { transition-property: opacity; transform: none; }
}
```

Note: this augments (does not replace) the existing single-line `.topmenu-list` layout rule — the cascade merges them.

- [ ] **Step 3: Typecheck.**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Run the full test suite (regression).**

Run: `npm run test`
Expected: all pass (462). No test renders `TeamMenu`.

- [ ] **Step 5: Commit.**

```bash
git add src/renderer/TeamMenu.tsx src/renderer/styles.css
git commit -m "feat(topbar): Team menu reflects open state + origin-aware dropdown enter"
```

---

### Task 3: Integration gate + on-device smoke handoff

Run the full build once (expensive; deferred to the end per house process — the long `electron-vite build` can drop subagent connections, so the controller runs it) and prepare the on-device smoke checklist.

**Files:** none modified.

- [ ] **Step 1: Full typecheck.**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 2: Full test suite.**

Run: `npm run test`
Expected: all pass (462).

- [ ] **Step 3: Production build.**

Run: `npm run build`
Expected: completes without errors (bundles main/preload/renderer).

- [ ] **Step 4: Record the on-device smoke checklist** (the user runs this — agents can't launch the Electron GUI). Verify:
  - Identity cluster: `BrandMark` + "Orkestr" wordmark render, aligned, left-edge spacing looks right (no vestigial over-indent).
  - Grouping reads clearly: identity │ project + Switch │ … │ Auth ┆ History/Context/Terminal ┆ Team/Settings/? ┆ Add agent. Hairline separators visible but subtle.
  - Open-state reflection: opening Settings / Context / FAQ / Team ▾ / toggling Terminal each highlights its button (`.active`); closing clears it.
  - Team ▾ dropdown scales in from its top-right corner, ~180ms, no bounce; closes instantly.
  - Hover/press feedback crisp on labeled AND icon (`?`) buttons; focus-visible ring on keyboard focus.
  - Long project name truncates with ellipsis and doesn't push the right groups off-screen.
  - `prefers-reduced-motion`: dropdown fades without scaling; no press-scale.
  - Window drag still works by dragging the bar's empty regions.

- [ ] **Step 5:** No commit (verification only). Report results for the Opus whole-branch review + merge decision.

---

## Self-Review

**Spec coverage:**
- Structure / grouping → Task 1 (markup) + Task 1 CSS. ✓
- BrandMark swap → Task 1. ✓
- Move Switch project (left) + FAQ (config group) → Task 1. ✓
- Open-state reflection (Settings/Context/FAQ) → Task 1; (Team ▾) → Task 2; (Terminal already) → preserved in Task 1. ✓
- Feedback states uniform (hover/press/focus) → existing `.btn` styles preserved across regroup; verified in Task 3 smoke. ✓
- One origin-aware dropdown animation → Task 2. ✓
- No bar entrance motion → enforced by omission + Global Constraints. ✓
- AuthPill color transition → Task 1 CSS. ✓
- Project-name truncation → Task 1 CSS. ✓
- Testing (regression + typecheck + build + on-device smoke) → each task + Task 3. ✓
- No behavior/IPC/engine change → Global Constraints; handlers copied verbatim. ✓

**Placeholder scan:** No TBD/TODO; every code step shows exact code and exact commands. ✓

**Type consistency:** Class names consistent across tasks (`.topbar-brand`, `.topbar-wordmark`, `.topbar-group`, `.topbar-sep`, `.btn.active`, `.topmenu-list`). `SettingsIcon` is the existing import alias used in `App.tsx`. No undefined identifiers introduced. ✓
