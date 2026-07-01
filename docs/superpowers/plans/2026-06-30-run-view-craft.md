# Run View — Craft Pass (Motion + Depth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the run view feel alive as a run happens (narration stream-in, status-pill crossfade + working-breathe, run-complete + result reveals) and bring it onto the warm-dark tokens (warm terminal theme, role-tinted tree + feed names).

**Architecture:** Presentational + small local-state/lookup additions across four files: `RunView.tsx`, `ActivityFeed.tsx`, `TerminalPane.tsx` (xterm theme), and `styles.css` (all motion + tint CSS). No engine/IPC/store/`shared` change. No new pure module — the role lookup is a one-line `.find().kind` mirroring the existing `nameOf` helpers, inlined per component.

**Tech Stack:** React 19, TypeScript, plain CSS (warm-dark tokens in `tokens.css`), `@xterm/xterm`, Vitest (existing suite), electron-vite build.

## Global Constraints

- **Zero engine / IPC / store / `shared` change.** Presentational + local component state only.
- **Terminal palette (verbatim):** background `#141019`, foreground `#EAD7D1`, cursor `#DD99BB`. Applies to BOTH the run terminal and the dock shell terminal and all their CSS background layers.
- **Warm-dark tokens only** for new CSS: `--motion` (180ms), `--ease-out`, `--ease-in-out`, `--orchestrator` (gold), `--manager` (periwinkle), `--worker` (teal), `--accent` (rose, fallback only). No new tokens.
- **Role-tint via the canvas `kind-${kind}` CSS-class pattern** — colors live in CSS, components just add the class.
- **Status-pill semantic hues are NOT recolored** — they only gain a crossfade transition + working-breathe.
- **Manual tab switches stay instant** — only the once-per-run auto-land on Result animates (gated by a `revealResult` flag).
- **Motion is GPU-only** (transform/opacity), calm-conductor (no springs/bounce), and honors `@media (prefers-reduced-motion: reduce)`.
- **Out of scope:** the History view's `.hist-detail pre` (also `#0b0c10`, but a separate surface — leave it); any functional/data change to the run view.
- **Never `git add`** `.agents/`, `.claude/`, or `skills-lock.json`. Add only the files each task names.
- **No new automated tests** (no component-test harness — no testing-library/jsdom; all `*.test.ts` are pure-node logic; no pure logic to extract here). Per-task verification = `npm run typecheck` clean + `npm run test` (full suite stays green, currently 462). Build runs once at the final gate. Visual/motion acceptance = the user's on-device smoke.

---

### Task 1: Warm the terminal theme (all layers)

Retune both xterm terminals and every cool CSS background layer to the warm palette.

**Files:**
- Modify: `src/renderer/run/RunView.tsx` (the `new Terminal({...})` theme, ~line 59)
- Modify: `src/renderer/terminal/TerminalPane.tsx` (the `new Terminal({...})` theme, ~line 25)
- Modify: `src/renderer/styles.css` (`.run-output` ~line 927; `.terminal-dock` background ~line 547; `.term-tab.active` background ~line 574)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing consumed by other tasks (purely visual).

- [ ] **Step 1: Warm the RunView xterm theme.**

In `src/renderer/run/RunView.tsx`, change:
```tsx
      theme: { background: '#0b0c10', foreground: '#e6e8ee' }
```
to:
```tsx
      theme: { background: '#141019', foreground: '#EAD7D1', cursor: '#DD99BB' }
```

- [ ] **Step 2: Warm the dock TerminalPane xterm theme.**

In `src/renderer/terminal/TerminalPane.tsx`, change:
```tsx
      theme: { background: '#0b0c10', foreground: '#e6e8ee', cursor: '#6ea8fe' }
```
to:
```tsx
      theme: { background: '#141019', foreground: '#EAD7D1', cursor: '#DD99BB' }
```

- [ ] **Step 3: Warm the CSS background layers in `styles.css`.**

Change each of these three (locate by content; line numbers approximate):
- `.run-output { position: absolute; inset: 0; padding: 6px 8px; background: #0b0c10; }` → `background: #141019`
- `.terminal-dock { … background: #0b0c10; … }` → `background: #141019`
- `.term-tab.active { background: #0b0c10; color: var(--text); }` → `background: #141019`

Do NOT change `.hist-detail pre { background: #0b0c10; … }` — the History view is out of scope for this cycle.

- [ ] **Step 4: Typecheck.**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Run the full test suite (regression).**

Run: `npm run test`
Expected: all pass (currently 462). No test renders these components; this guards against edit/import breakage.

- [ ] **Step 6: Commit.**

```bash
git add src/renderer/run/RunView.tsx src/renderer/terminal/TerminalPane.tsx src/renderer/styles.css
git commit -m "feat(run-view): warm the terminal theme (near-black de-cooled #141019)"
```

---

### Task 2: Role-tint the tree + feed agent names

Color the run-tree row names and the narration feed agent names by role, following the canvas `kind-${kind}` pattern. Replaces the feed's blanket rose.

**Files:**
- Modify: `src/renderer/run/RunView.tsx` (add `kindOf` helper near `nameOf` ~line 107; row-name span ~line 168)
- Modify: `src/renderer/run/ActivityFeed.tsx` (add `kindOf` helper near `nameOf` ~line 56; agent span ~line 71)
- Modify: `src/renderer/styles.css` (add `.kind-*` tint rules; keep `.activity-agent` rose as fallback)

**Interfaces:**
- Consumes: existing `graph.nodes` (each node has `id`, `name`, `kind: 'orchestrator' | 'manager' | 'worker'`), and the existing `nameOf` helpers in both components.
- Produces: CSS classes `kind-orchestrator` / `kind-manager` / `kind-worker` on `.run-row-name` and `.activity-agent`.

- [ ] **Step 1: Add `kindOf` + tint class in `RunView.tsx`.**

After the existing `nameOf` line:
```tsx
  const nameOf = (id: string): string => graph?.nodes.find((n) => n.id === id)?.name ?? id
```
add:
```tsx
  const kindOf = (id: string): string => graph?.nodes.find((n) => n.id === id)?.kind ?? 'unknown'
```
Then change the tree row-name span:
```tsx
                <span className="run-row-name">{nameOf(id)}</span>
```
to:
```tsx
                <span className={`run-row-name kind-${kindOf(id)}`}>{nameOf(id)}</span>
```

- [ ] **Step 2: Add `kindOf` + tint class in `ActivityFeed.tsx`.**

After the existing `nameOf` line:
```tsx
  const nameOf = (id: string): string => graph?.nodes.find((n) => n.id === id)?.name ?? id
```
add:
```tsx
  const kindOf = (id: string): string => graph?.nodes.find((n) => n.id === id)?.kind ?? 'unknown'
```
Then change the agent span:
```tsx
            <span className="activity-agent">{nameOf(r.agentId)}</span>
```
to:
```tsx
            <span className={`activity-agent kind-${kindOf(r.agentId)}`}>{nameOf(r.agentId)}</span>
```

- [ ] **Step 3: Add the tint rules in `styles.css`.**

Add (near the `.run-row-name` / `.activity-agent` rules, or in a small labeled block). `.activity-agent`'s existing `color: var(--accent)` stays as the `kind-unknown`/fallback; `.run-row-name`'s default `--fg` stays for `kind-unknown`:
```css
/* role-tinted agent names — tree + narration feed (rose stays as the unknown fallback) */
.run-row-name.kind-orchestrator,
.activity-agent.kind-orchestrator { color: var(--orchestrator); }
.run-row-name.kind-manager,
.activity-agent.kind-manager { color: var(--manager); }
.run-row-name.kind-worker,
.activity-agent.kind-worker { color: var(--worker); }
```
(Specificity `0,2,0` beats the base `0,1,0` rules, so known kinds override correctly.)

- [ ] **Step 4: Typecheck.**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Run the full test suite (regression).**

Run: `npm run test`
Expected: all pass (462).

- [ ] **Step 6: Commit.**

```bash
git add src/renderer/run/RunView.tsx src/renderer/run/ActivityFeed.tsx src/renderer/styles.css
git commit -m "feat(run-view): role-tint the tree + narration agent names (off rose)"
```

---

### Task 3: Motion — the run coming alive

All the run-view motion: narration rows stream in, status pills crossfade + the working pill breathes, the run-complete banner + ✓/✗ reveal, and the once-per-run Result reveal.

**Files:**
- Modify: `src/renderer/run/RunView.tsx` (banner-mark wrapper ~line 118; `revealResult` state + wiring in the finish effect ~line 42 and the runId-clear effect ~line 92; `.reveal` class on the result `<pre>` ~line 206)
- Modify: `src/renderer/styles.css` (feed stream-in, pill crossfade + breathe, banner + mark reveal, result-in keyframe, one reduced-motion block)

**Interfaces:**
- Consumes: existing run state (`run.running`, `run.final`, `run.error`, `run.runId`), the existing `banner`/`hasResult` locals, and the existing `rightTab` state/effects in `RunView.tsx`.
- Produces: CSS classes `.run-banner-mark` and `.run-result.reveal`; no exported symbols.

- [ ] **Step 1: Add the `revealResult` state in `RunView.tsx`.**

After:
```tsx
  const [rightTab, setRightTab] = useState<'narration' | 'terminal' | 'result'>('narration')
```
add:
```tsx
  const [revealResult, setRevealResult] = useState(false)
```

- [ ] **Step 2: Wire the once-per-run reveal into the existing effects.**

Change the finish effect from:
```tsx
  useEffect(() => {
    if (prevRunning.current && !run.running && run.final && !run.error) setRightTab('result')
    prevRunning.current = run.running
  }, [run.running, run.final, run.error])
```
to:
```tsx
  useEffect(() => {
    if (prevRunning.current && !run.running && run.final && !run.error) {
      setRightTab('result')
      setRevealResult(true)
    }
    prevRunning.current = run.running
  }, [run.running, run.final, run.error])
```
Change the runId-clear effect from:
```tsx
  useEffect(() => {
    buffers.current.clear()
    termRef.current?.clear()
  }, [run.runId])
```
to:
```tsx
  useEffect(() => {
    buffers.current.clear()
    termRef.current?.clear()
    setRevealResult(false)
  }, [run.runId])
```

- [ ] **Step 3: Wrap the banner mark and add the reveal class in `RunView.tsx`.**

Change the banner block from:
```tsx
      {banner && (
        <div className={`run-banner ${banner.kind}`}>
          {banner.kind === 'success' ? '✓' : '✗'} {banner.text}
        </div>
      )}
```
to:
```tsx
      {banner && (
        <div className={`run-banner ${banner.kind}`}>
          <span className="run-banner-mark">{banner.kind === 'success' ? '✓' : '✗'}</span> {banner.text}
        </div>
      )}
```
Change the result `<pre>` from:
```tsx
                <pre className="run-result">{run.final}</pre>
```
to:
```tsx
                <pre className={`run-result ${revealResult ? 'reveal' : ''}`}>{run.final}</pre>
```

- [ ] **Step 4: Add the motion CSS in `styles.css`.**

Add a labeled block (near the run-view CSS section). Note the `.run-pill` transition augments the existing `.run-pill` rule (cascade merges — do not rewrite the existing rule):
```css
/* ---- run view: motion (the run coming alive) ---- */
.activity-row {
  transition: opacity var(--motion) var(--ease-out), transform var(--motion) var(--ease-out);
}
@starting-style {
  .activity-row { opacity: 0; transform: translateY(4px); }
}

.run-pill {
  transition: background-color var(--motion) var(--ease-out), color var(--motion) var(--ease-out), border-color var(--motion) var(--ease-out);
}
.run-pill.st-working { animation: pill-breathe 1.6s var(--ease-in-out) infinite; }
@keyframes pill-breathe { 50% { opacity: 0.72; } }

.run-banner {
  transition: opacity 220ms var(--ease-out), transform 220ms var(--ease-out);
}
@starting-style {
  .run-banner { opacity: 0; transform: translateY(-6px); }
}
.run-banner-mark {
  display: inline-block;
  transition: transform 220ms var(--ease-out);
}
@starting-style {
  .run-banner-mark { transform: scale(0.9); }
}

.run-result.reveal { animation: result-in 180ms var(--ease-out); }
@keyframes result-in { from { opacity: 0; } to { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .activity-row,
  .run-banner { transition-property: opacity; transform: none; }
  .run-banner-mark { transition: none; transform: none; }
  .run-pill.st-working { animation: none; }
  .run-result.reveal { animation: none; }
}
```

- [ ] **Step 5: Typecheck.**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Run the full test suite (regression).**

Run: `npm run test`
Expected: all pass (462).

- [ ] **Step 7: Commit.**

```bash
git add src/renderer/run/RunView.tsx src/renderer/styles.css
git commit -m "feat(run-view): motion — feed stream-in, pill crossfade/breathe, banner + result reveal"
```

---

### Task 4: Integration gate + on-device smoke handoff

Run the full build once (deferred to the end per house process — the long `electron-vite build` can drop subagent connections, so the controller runs it) and record the on-device smoke checklist.

**Files:** none modified.

- [ ] **Step 1: Full typecheck.**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 2: Full test suite.**

Run: `npm run test`
Expected: all pass (462).

- [ ] **Step 3: Production build.**

Run: `npm run build`
Expected: completes without errors (main/preload/renderer).

- [ ] **Step 4: Record the on-device smoke checklist** (the user runs this — agents can't launch the Electron GUI). Verify during a live run:
  - Narration rows stream in (fade + slight rise) as agents work; feed stays pinned to newest.
  - Status pills crossfade on change; the **working** pill breathes gently (not alarming).
  - On run completion: the banner + ✓/✗ mark reveal; the Result tab fades in once (auto-land).
  - Manual switching between Narration / Terminal / Result is **instant** (no fade).
  - Both terminals (run view + dock shell) are warm (`#141019`), cream text, rose cursor — no cool tint; the active dock tab matches.
  - Tree + feed agent names are role-tinted (orchestrator gold / manager periwinkle / worker teal); no name is rose anymore.
  - `prefers-reduced-motion`: movement gone, opacity/color still fine; run fully legible.

- [ ] **Step 5:** No commit (verification only). Report results for the Opus whole-branch review + merge decision.

---

## Self-Review

**Spec coverage:**
- Warm terminal theme (both terminals + all cool CSS layers) → Task 1. ✓
- Role-tint tree + feed (off rose) → Task 2. ✓
- Narration stream-in → Task 3 (Step 4 `.activity-row`). ✓
- Status-pill crossfade + working-breathe → Task 3 (Step 4). ✓
- Run-complete banner + mark reveal → Task 3 (Steps 3–4). ✓
- Once-per-run Result reveal (manual switches instant) → Task 3 (Steps 1–4, `revealResult` flag). ✓
- Status pills keep semantic hues (not recolored) → honored (only transition/breathe added). ✓
- Reduced motion → Task 3 (Step 4 block). ✓
- History `.hist-detail pre` out of scope → Task 1 Step 3 explicit. ✓
- No engine/IPC/store change → Global Constraints; only component-local edits. ✓
- Testing (regression + typecheck + build + on-device smoke) → each task + Task 4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows exact before/after code and exact commands. ✓

**Type consistency:** `kindOf(id): string` defined identically in both components; `revealResult`/`setRevealResult` consistent; class names consistent (`kind-*`, `.run-banner-mark`, `.run-result.reveal`, `pill-breathe`, `result-in`). Terminal hex identical everywhere (`#141019` / `#EAD7D1` / `#DD99BB`). ✓
