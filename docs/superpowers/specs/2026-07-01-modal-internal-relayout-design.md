# Modal Internal Re-layout — Header / Scroll-body / Pinned-footer

The last deferred surface of the post-overhaul **visual modernization arc** (see the `ai-manager-visual-pass` memory). Surface 3 gave all ~9 modals a shared `<Modal>` primitive (backdrop / Escape / focus / enter-exit motion). This pass does the deferred "full pass" on the modals' **internal content layout** — a consistent, airy header/body/footer structure across every modal, matching the Notion-airy look the Settings modal (Surface 1) established.

## Motivation

`.modal` is a single `overflow-y: auto` box, so in the list-heavy modals (Context, Team preview, Draft roles) the **title scrolls out of view and the Cancel/Apply buttons scroll away** — you must scroll to the bottom to act. There is no shared header/body/footer structure or spacing rhythm: each modal hand-rolls an `<h2>` + ad-hoc body + a `.modal-actions` row, and **none pass `labelledBy`** to `<Modal>`, so the title isn't the accessible name (the primitive supports it; nothing uses it).

## Goals

- **Structural:** every `.modal`-based modal becomes a flex column — a fixed header, a single scrollable body, and a **pinned footer** — so the title and action buttons are always visible.
- **Consistency + airy rhythm:** a shared header/body/footer vocabulary + hairline dividers + Notion-airy spacing matching the Settings modal.
- **Accessibility:** wire each modal's title to `<Modal labelledBy>`.

Non-goals: the Settings modal (already redesigned Surface 1 — uses `unstyled`, not `.modal`; untouched); a reusable `<ModalShell>` component (chosen against — CSS convention only); any new motion (Surface 3's enter/exit is unchanged); any behavior/data/IPC change.

## Decisions locked in brainstorming

- **Scope = full consistent re-layout** (over "just fix scrolling" and over "full + reusable shell").
- **Approach = shared CSS layout convention** (`.modal-header`/`.modal-title`/`.modal-desc`/`.modal-body`/`.modal-actions`) applied per-modal — no new component.
- **Notion-airy:** open rows + hairline dividers, **no card borders** (matches the Settings decision).
- Aesthetic reference = the shipped Settings modal.

## Architecture

Purely presentational: a CSS restructure of the shared `.modal` box + per-modal JSX wrapping (header/body around existing content) + a title id + `labelledBy`. No store/IPC/engine/`shared` change; no new component; the `<Modal>` primitive is unchanged (its existing `labelledBy` prop is finally used).

### `styles.css` — the shared layout

Restructure `.modal` from a scrolling box into a flex column, and move the padding into the three regions so header/footer stay put while the body scrolls:

```css
.modal {
  width: 380px;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;            /* was overflow-y: auto */
  background: var(--surface-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--elev-2);
  /* padding removed — now lives in .modal-header / .modal-body / .modal-actions */
}
.modal-header {
  flex: none;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--hairline);
}
.modal-title { margin: 0; /* inherits the former .modal h2 size/weight/color */ }
.modal-desc { margin: 6px 0 0; color: var(--muted); font-size: var(--text-sm); }
.modal-body { flex: 1 1 auto; overflow-y: auto; padding: 16px 20px; }
.modal-actions {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--hairline);
  margin: 0;                   /* was margin-top: 8px */
}
```
- Fold the existing `.modal h2` styling into `.modal-title` (keep the same size/weight/color so titles don't visually shift).
- `.modal-wide` (used by Draft roles / Team preview) keeps only its width override; the flex-column structure is inherited from `.modal`.
- **List rhythm:** `.draft-list` items gain a hairline separator + airier vertical spacing (Notion open-rows, no card borders).

### Per-modal application (JSX)

Every `.modal`-based modal adopts the same shape:

```tsx
<Modal onClose={onClose} labelledBy="faq-title">{(close) => (<>
  <div className="modal-header">
    <h2 id="faq-title" className="modal-title">How to prompt Orkestr</h2>
    {/* optional: <p className="modal-desc">…</p> */}
  </div>
  <div className="modal-body">
    {/* existing content */}
  </div>
  <div className="modal-actions">{/* existing buttons, via close */}</div>
</>)}</Modal>
```

Modals to convert (each: wrap header, wrap body, add title `id`, pass `labelledBy`; keep all existing logic/handlers verbatim):
- `FaqModal.tsx` — `.faq-body` → body; "Got it" footer.
- `ContextModal.tsx` (201 lines, two sections: attached files + referenced folders) — its section content → body; a `.modal-desc` one-liner is worthwhile; footer actions. Preserve the drag-drop / scoping logic untouched.
- `RoleDraftModal.tsx` — `.draft-list` → body; Cancel/Apply footer.
- `TeamSpawnModal.tsx` — `.draft-list` → body; a `.modal-desc` ("Review and edit before creating") is worthwhile; Cancel/Apply footer.
- `run/RunResultModal.tsx` (130 lines, "Launch app") — content → body; footer actions.
- `AddAgentModal` (in `App.tsx`) — the form fields → body; footer actions. (The role-picker radiogroup from the a11y pass stays.)
- `HitlModal.tsx` — question + textarea → body; its 3 actions → footer. (Stays `dismissable={false}`.)
- `ConfirmDialog.tsx` — title + body text → header/body; confirm/dismiss → footer.

`SettingsModal.tsx` is **out of scope** (uses `unstyled`, its own two-pane layout — the `.modal` change does not affect it).

## Data flow

None new. Modals render the same data and call the same handlers; only their DOM structure + classes change. `labelledBy` ties `<Modal aria-labelledby>` to the new title id.

## Error handling / edge cases

- **Short modals** (FAQ, Confirm) — the flex-column structure is fine; the body simply doesn't overflow (no scrollbar appears).
- **Unwrapped content** — the risk: if a modal's content is NOT placed inside `.modal-body`, it sits outside the scroll region and can overflow the fixed-height panel. Every listed modal must wrap its content; the plan converts each explicitly and the on-device smoke checks each opens and scrolls correctly.
- **`.modal-wide`** — still widens; verify the two wide modals (Draft roles, Team preview) scroll their lists with the footer pinned.
- **`dismissable={false}` (HITL)** — unaffected by the layout change; keep it.
- **Focus/motion** — `<Modal>` focuses the panel and animates enter/exit as before; the internal restructure doesn't touch that (the `.modal-panel` carries motion, `.modal` carries the box — both still apply).

## Testing

Presentational (CSS + JSX wrapping + aria) with no pure logic and no component-test harness (consistent with the other arc surfaces) → **no new automated tests**. Verification:
- **Full existing suite green** (476) + `typecheck` + `build`.
- **`npm run lint`** (the ESLint react-hooks gate — now a required renderer-cycle gate) → 0 errors.
- **On-device smoke by the user:** open each modal; confirm the title + action buttons stay pinned while the body scrolls (esp. Context / Team preview / Draft roles with many items); the airy header/spacing matches Settings; short modals look right; VoiceOver announces each modal by its title.

## File-by-file summary

- `src/renderer/styles.css` — restructure `.modal` to flex-column; add `.modal-header`/`.modal-title`/`.modal-desc`/`.modal-body`; restyle `.modal-actions` as a pinned footer; fold `.modal h2` into `.modal-title`; airy `.draft-list` items.
- `src/renderer/FaqModal.tsx`, `ContextModal.tsx`, `RoleDraftModal.tsx`, `TeamSpawnModal.tsx`, `run/RunResultModal.tsx`, `HitlModal.tsx`, `ConfirmDialog.tsx` — adopt header/body/footer + title id + `labelledBy`.
- `src/renderer/App.tsx` — same for the `AddAgentModal` component.

## Risks / edge cases

- **Coordinated `.modal` change:** the CSS restructure affects every `.modal`-based modal at once; each must be converted in the same cycle or it will mis-scroll. Mitigation: one task per modal (or grouped), all verified before merge; on-device smoke per modal.
- **Title visual shift:** fold `.modal h2` styling into `.modal-title` exactly so titles don't change size/weight.
- Scope creep into redesigning modal *content* beyond layout (e.g. reworking the Context modal's features) — explicitly out; this is structure + rhythm + aria only.
