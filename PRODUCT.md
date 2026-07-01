# Product

## Register

product

## Users

People orchestrating a team of cooperating Claude Code agents on a local codebase — from developers who live in the terminal to increasingly non-technical users who want to describe a goal and watch a team build it. Context: a focused desktop app (Electron) they keep open alongside their work, running real multi-agent builds against a real project on disk. The primary job on any screen is *set up a team, give it a goal, and watch/steer the run.*

## Product Purpose

Orkestr is a desktop app to **design, run, and watch a team of AI agents build software** on a local project. Users compose an org-chart of agents (orchestrator → managers → workers) on a free-form canvas, give the orchestrator a goal, and the app plans, delegates, executes, reviews, and reports — streaming plain-English narration and live terminals. Success = the user trusts the team to do real work and can follow/steer it without reading raw logs.

## Brand Personality

**Premium & crafted.** Refined, polished, confident — the feel of high-end professional software (Linear/Things dialed up, with Apple/visionOS depth). Fancy achieved through *craft and correct invisible detail*, not flash. Voice stays composed and precise. Emotional goals: **confidence, focus, a sense of quality and control** — the user should feel they're driving a serious, well-made instrument. (This evolves and replaces the earlier "calm conductor / maximum restraint" identity — the direction is now richer and glossier, but still disciplined.)

## Anti-references

- **Garish / over-the-top gloss** — no neon overload, no gloss so heavy it reads tacky. Fancy, never gaudy.
- **Generic SaaS / templated dashboards** — must keep a distinct, unmistakable identity; never look like a Bootstrap/AI-default admin panel.
- **Heavy skeuomorphism** — no buttons pretending to be physical 3D plastic/metal; gloss and glass are accents and materials, not literal realism.

## Design Principles

- **Premium through craft, not flash.** Depth, gloss, and glass must each earn their place; the "fancy" feeling is the sum of many correct, mostly-invisible details, not one loud effect.
- **Disciplined richness.** Bold direction, restrained execution — a black/green/white palette and glossy materials applied with intent, so it reads expensive rather than busy.
- **Depth communicates, not just decorates.** Layering, elevation, and sheen should signal hierarchy and state (what's active, elevated, interactive) — never gloss for its own sake.
- **Clarity is non-negotiable.** It remains a serious orchestration tool; the fancier look must never cost legibility, contrast, or usability. Keep the full-APG accessibility work intact.
- **Distinct identity.** The look should be recognizably Orkestr — a deliberate point of view — not a category-reflex dark theme.

## Accessibility & Inclusion

WCAG-conscious; a full ARIA Authoring Practices pass shipped (keyboard operation for tabs/menus/dividers/radiogroups, roles/states, focus management, canvas + node labels). Maintain **AA contrast** — especially critical with the new black + royal-green + white palette (royal green must stay legible as an accent/text on black; verify ≥4.5:1 for body, ≥3:1 for large/UI). `prefers-reduced-motion` is honored throughout and must remain so as glossy motion is added.
