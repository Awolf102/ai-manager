# Run View — Craft Pass (Motion + Depth)

Part of the post-overhaul **visual modernization arc** (see the `ai-manager-visual-pass` memory). The run view is the last untaken **hero** surface — the app's most dynamic moment. This pass makes a run *feel alive* as it happens and brings the surface onto the warm-dark tokens (parallel to the Canvas craft pass, which did both motion + depth).

## Motivation

The run view (`RunView.tsx` + `ActivityFeed.tsx`) updates entirely **instantly**: narration rows pop in with no motion, status pills swap abruptly, the run-complete banner just appears. It also carries two pre-rebrand holdovers: the xterm terminal uses a **cool** theme (`#0b0c10` bg, `#e6e8ee` fg, blue `#6ea8fe` cursor), and the narration feed paints **every** agent name in rose `--accent` (but per the locked brand, rose is the *signal* color, never a role color).

Unlike the top bar (persistent, high-frequency → restraint), a run is an **occasional, actively-watched event** → per Emil's frequency framework it *earns* motion. Voice stays calm-conductor: crisp, no springs/bounce; GPU-only (transform/opacity); full `prefers-reduced-motion`.

## Goals

- **Motion:** narration rows stream in; status pills crossfade + the working state breathes; a satisfying run-complete banner reveal; a once-per-run Result reveal.
- **Depth:** warm the xterm theme (run terminal *and* dock shell terminal) to the tokens; role-tint the tree + feed agent names (off rose); keep semantic status-pill hues.

Non-goals: functional/data changes to the run view (no progress bars, no tree restructure); animating high-frequency manual tab switches; re-tuning the semantic status-pill colors (that was the narrower "depth-only" scope, not this one); any engine/IPC/store change.

## Decisions locked in brainstorming

- **Scope = "the living run" (motion + depth)** — full hero treatment.
- **Terminal palette = "near-black, de-cooled":** background `#141019`, foreground `#EAD7D1` (`--fg`), cursor `#DD99BB` (`--accent`). Applies to BOTH the run terminal and the dock shell terminal.
- **Role-tint via the canvas's `kind-${kind}` CSS-class pattern** (`.kind-orchestrator{color:var(--orchestrator)}` gold / `.kind-manager` periwinkle / `.kind-worker` teal).
- **Status pills keep their semantic hues** — only gain the crossfade transition + working-breathe.
- **Manual tab switches (Narration/Terminal/Result) stay instant.** Only the once-per-run auto-land on Result animates.

## Architecture

Presentational + small local-state/lookup additions. Four files: `RunView.tsx`, `ActivityFeed.tsx`, `TerminalPane.tsx` (xterm theme), `styles.css` (all the motion + tint CSS). No engine/IPC/store/`shared` change. No new pure module (the role lookup is a one-line `.find().kind` mirroring the existing `nameOf` helpers — inlined per component, not extracted).

### `src/renderer/run/ActivityFeed.tsx` — role-tinted feed + stream-in

- Add a `kindOf(id)` helper mirroring the existing `nameOf` (`graph?.nodes.find(n => n.id === id)?.kind`).
- The agent-name span becomes `<span className={\`activity-agent kind-${kindOf(r.agentId) ?? 'unknown'}\`}>`. CSS colors it by role; the blanket `color: var(--accent)` on `.activity-agent` becomes a fallback for `kind-unknown`.
- **No motion TSX change** — the row enter animation is pure CSS (`@starting-style` on `.activity-row`, which mounts per new row).

### `src/renderer/run/RunView.tsx` — warm terminal, role-tinted tree, banner + result reveal

- **xterm theme** (the `new Terminal({...})` call): `theme: { background: '#141019', foreground: '#EAD7D1', cursor: '#DD99BB' }` (replacing `#0b0c10`/`#e6e8ee`/… — note the current RunView theme has no `cursor` key set to blue, but set all three for parity with TerminalPane).
- **Tree role-tint:** add a `kindOf(id)` helper; the row-name span becomes `<span className={\`run-row-name kind-${kindOf(id) ?? 'unknown'}\`}>`.
- **Banner mark:** wrap the ✓/✗ glyph in `<span className="run-banner-mark">` so CSS can scale just the mark on reveal. (`.run-banner` itself already renders conditionally `{banner && …}`, so `@starting-style` fires on mount = run-complete.)
- **Result reveal (once per run):** add local `const [revealResult, setRevealResult] = useState(false)`. In the EXISTING effect that auto-selects the Result tab on successful finish (`if (prevRunning.current && !run.running && run.final && !run.error) { setRightTab('result'); setRevealResult(true) }`), also flip the flag. Reset it on new run: in the existing `useEffect(() => {…}, [run.runId])` clearing block, `setRevealResult(false)`. Render `<pre className={\`run-result ${revealResult ? 'reveal' : ''}\`}>`. The `.reveal` keyframe plays once; manual switches to Result don't add the class → stay instant. (The class lingering after the one-shot animation is harmless — the keyframe doesn't loop.)

### `src/renderer/terminal/TerminalPane.tsx` — warm dock terminal

- xterm theme → `{ background: '#141019', foreground: '#EAD7D1', cursor: '#DD99BB' }` (was `#0b0c10`/`#e6e8ee`/`#6ea8fe`).
- If the terminal host element has an explicit cool background in CSS, align it to `#141019` so there's no flash around the xterm canvas (verify; change only if present).

### `src/renderer/styles.css` — motion + tint

- **Feed stream-in:** `.activity-row { transition: opacity var(--motion) var(--ease-out), transform var(--motion) var(--ease-out) }` + standalone `@starting-style { .activity-row { opacity: 0; transform: translateY(4px) } }`.
- **Status pill crossfade:** add `transition: background-color var(--motion) var(--ease-out), color var(--motion) var(--ease-out), border-color var(--motion) var(--ease-out)` to `.run-pill`.
- **Working breathe:** `.run-pill.st-working { animation: pill-breathe 1.6s var(--ease-in-out) infinite }` with a gentle `@keyframes pill-breathe` (e.g. `50% { opacity: 0.72 }` — subtle, no size/position change).
- **Banner reveal:** `.run-banner { transition: opacity 220ms var(--ease-out), transform 220ms var(--ease-out) }` + `@starting-style { .run-banner { opacity: 0; transform: translateY(-6px) } }`; `.run-banner-mark { display: inline-block; transition: transform 220ms var(--ease-out) }` + `@starting-style { .run-banner-mark { transform: scale(0.9) } }`.
- **Result reveal:** `.run-result.reveal { animation: result-in 180ms var(--ease-out) }` with `@keyframes result-in { from { opacity: 0 } to { opacity: 1 } }` (opacity only — the pre can be long; no transform).
- **Terminal bg:** `.run-output { … background: #141019 }` (was `#0b0c10`).
- **Role tint:** `.run-row-name.kind-orchestrator, .activity-agent.kind-orchestrator { color: var(--orchestrator) }` (and `.kind-manager` → `var(--manager)`, `.kind-worker` → `var(--worker)`). Keep `.activity-agent`'s existing rose as the `kind-unknown`/fallback.
- **Reduced motion:** one `@media (prefers-reduced-motion: reduce)` block neutralizing movement — `.activity-row, .run-banner, .run-banner-mark { transform: none }`; `.run-pill.st-working { animation: none }`; `.run-result.reveal { animation: none }`. Opacity/color transitions may remain (Emil/WCAG scope reduced-motion to movement, not crossfades).

## Data flow

No new data. Motion is driven by existing state transitions (new stream events → new feed rows; `run.nodeStatus` → pill classes; `run.running`/`run.final`/`run.error` → banner + result reveal). `kindOf` reads the existing `graph.nodes`.

## Error handling / edge cases

- **Feed rows arriving while Narration is hidden** (user on Terminal/Result tab): rows mount inside a `display:none` slot → `@starting-style` won't animate them, and on tab-return they simply appear (no animation burst). Correct — we only animate rows arriving while the feed is visible.
- **`kindOf` returns undefined** (agent id not in graph): fall back to `kind-unknown` → the existing color (rose for feed, `--fg` for tree). No crash.
- **Reduced motion:** all movement removed; the run stays fully legible.
- **Long `run.final`:** Result reveal is opacity-only (no transform) so a tall report doesn't jump.
- **Banner re-render:** the banner is keyed by run state, not remounted on unrelated re-renders, so the reveal fires on run-complete, not on every render (verify `@starting-style` only triggers on actual mount — it does).

## Testing

No pure logic to extract (role lookup is a trivial `.find().kind` mirroring existing `nameOf`; `run-status.ts`'s `runBanner` is already TDD'd and unchanged). The repo has **no component-test harness** (no testing-library/jsdom; all `*.test.ts` are pure-node logic). Consistent with the Canvas/Modal/Welcome/Top-bar surfaces, there are **no new automated tests**. Verification:
- **Full existing suite green** (462) — guards the `RunView.tsx`/`ActivityFeed.tsx`/`TerminalPane.tsx` edits against import/logic regression.
- **`typecheck` + `build` clean.**
- **On-device eyes-on smoke by the user** (agents can't run the Electron GUI): narration rows streaming in during a live run; status pills crossfading + the working pill breathing; the run-complete banner + ✓/✗ reveal; the once-per-run Result fade (and that manual tab switches stay instant); the warm terminal in both the run view and the dock shell; role-tinted tree + feed names; reduced-motion behavior. This is the real acceptance gate for the motion/look parts.

## File-by-file summary

- `src/renderer/run/ActivityFeed.tsx` — `kindOf` helper; role-tint class on the agent-name span.
- `src/renderer/run/RunView.tsx` — warm xterm theme; `kindOf` + tree row-name tint class; `run-banner-mark` wrapper; `revealResult` state wired into the existing finish + new-run effects; `.reveal` class on the result `<pre>`.
- `src/renderer/terminal/TerminalPane.tsx` — warm xterm theme (+ align host bg if cool).
- `src/renderer/styles.css` — feed stream-in, pill crossfade + working-breathe, banner + mark reveal, result-in keyframe, warm `.run-output` bg, role-tint classes, one reduced-motion block.

## Risks / edge cases

- **`@starting-style` under `display:none` slots** — analyzed above; the behavior (only-animate-when-visible) is desirable, not a bug.
- **Two files share the terminal theme** — both `RunView.tsx` and `TerminalPane.tsx` must be updated to the same hex (there's no shared theme constant today; keeping two literals is acceptable for this small change, but the implementer should use identical values).
- **Working-breathe subtlety** — must be gentle (opacity only, no size/glow that reads as alarming); calm-conductor. Tunable in the on-device smoke.
- Scope creep toward functional run-view changes — explicitly out of scope.
