# AI-Manager — Remediation Cycle Backlog (triage of the 2026-06-27 audit)

Derived from `docs/audits/2026-06-27-tool-audit.md`. Each **cycle** below is one
brainstorm→spec→plan→TDD unit (the project's standard workflow). Findings are grouped by cohesion
(same file/subsystem) so a cycle is a single coherent change. `#N` references the audit's prioritized
remediation table rows.

**Triage principles:** (1) security + irreversible data-loss first; (2) UX-only Importants fold into the
Phase-2 "Orkestr" overhaul (it rebuilds those surfaces anyway); (3) the replan/escalate/handoff Criticals
sit on code paths that have **never run live against real Claude** — live-verify those paths before/while
fixing them.

---

## Fix-now cycles (must-fix-before-overhaul)

| Cycle | Title | Rolls in (audit #) | Primary files | Depends on | Live-verify first? |
|---|---|---|---|---|---|
| **S2** | Run-result launch hardening | #1 | `server-manager.ts`, `run-manifest.ts`, `manifest-detector.ts`, `RunResultModal.tsx` | — | no |
| **U1** | Destructive-action guardrails | #8, #31 | `AgentConfigPanel.tsx`, `OrgChart.tsx`, `project-store.ts` (deleteAgent), `TeamSpawnModal.tsx`, `RoleDraftModal.tsx` | — | no |
| **P1** | Crash-safe persistence (atomic writes) | #4, + run-store `.tmp` leak (Minor) | `project-store.ts` (saveGraph/openProject), `run-store.ts` | — | no |
| **P2** | Race-safe mutations (serialize graph + memory, thread sessionId) | #5, #14, #16 | `project-store.ts` (updateAgent/applyReflection), `agent-runner.ts`, `nodes.ts` | **P1** (same files) | no |
| **S1** | Autonomy blast-radius hardening | #3, #9, #20 | `agent-runner.ts` (additionalDirectories), `nodes.ts` (mode mapping), `SettingsModal.tsx`, `context-files.ts` (framing) | — | no |
| **S3** | Plugin/skill trust hardening | #2, #19 | `skill-trust.ts`, `skill-discovery.ts`, `agent-runner.ts` | — | no |
| **S4** | Team-bundle import validation | #17, #18, + context-file symlink/size (Minor) | `team-bundle.ts`, `project-store.ts` (importTeam/applySpawnedTeam), `agent-runner.ts` (runHeadless fallback) | — | no |
| **S5** | HITL secret handling truth-up | #10, + abort-path scrub gap (Minor) | `nodes.ts`, `run-state.ts`, `graph.ts`, `HitlModal.tsx` | — | no |
| **P3** | Durable resume actually works | #11, #12 | `run-store.ts` (wire `listResumable`), `orchestrator.ts`, `ipc.ts`, `store.ts`, renderer affordance | — | partial (HITL pause) |
| **R1** | Replan/escalate state integrity | #6, #7, #13 | `replan.ts` (mergeReplan), `nodes.ts` (escalate/review routing) | live-verify | **YES** (maxReplans>0 never run) |
| **R2** | Handoff persistence & observability | #23, #27, #25 | `nodes.ts` (runWithHandoffs), `run-state.ts` | live-verify | **YES** (maxHandoffs>0 never run) |
| **R3** | Scheduling edge cases | #22, #26, #15 | `nodes.ts` (multi-asker), `workflow-order.ts` (self-dep), `project-store.ts` (staged team writes) | — | partial |

### Recommended order
`S2 → U1 → P1 → P2 → S1 → S3 → S4 → S5 → P3 → [live-verify session] → R1 → R2 → R3`

**Why this order:** S2 is a tiny, self-contained fix that closes a command-execution hole — best first win.
U1 is cheap and stops one keystroke from irreversibly deleting accreted agent memory (high user value, no
engine risk). P1 makes persistence crash-safe (the foundation); P2 makes it race-safe and **must follow P1**
(same files). The remaining security cycles (S1/S3/S4/S5) are independent and can be reordered. P3 restores
crash/HITL-pause recovery. The R-cycles come last and **after a live-verification session**, because their
bugs are only reachable on paths that have never executed live — running them once may reveal more (or change
the right fix) before we touch the code.

---

## Deferred to the Phase-2 "Orkestr" overhaul (UX Importants)

These are real, but they are UI-surface rework the overhaul will redo wholesale — fold them into the overhaul
requirements rather than spending point-fix cycles now (per the *functionality-over-polish* preference). They
should be captured as overhaul acceptance criteria:

- #21 per-agent permission dropdown is a silent no-op during runs → collapse to one permission concept.
- #28 GoalBar "Run" silent-fail + inconsistent error surfacing → one non-blocking toast/notification center.
- #29 no success state / final report hidden in live run → "Run complete" banner + render `run.final`.
- #30 (UX half) HITL Skip mislabeled / no abort while paused / guarantee text → modal redesign.
- #32 flagship features default-off with active-sounding copy → real on/off toggles, enable-on-gesture.
- #33 duplicate "Run" buttons / terminal hides live run / undiscoverable canvas edge semantics / ambiguous top-bar icons → IA + canvas legend + coach-marks.
- #34 cost copy + flat ungrouped Settings with danger control last → grouped Settings (Safety/Cost/Review/Team) + cost hints.
- Most Dimension-4 Minors (legend, success confirmations, disabled-button reasons, restore-defaults, dirty-state guards).

> Note: #9 (Full-auto danger styling) and #8/#31 (destructive confirms) are UX but classified **fix-now**
> because they are security/data-loss, not polish — they're in S1 and U1 above, not deferred.

---

## Not a code cycle

- **#35 Live-verification session** — run the four never-run-together "no" rows (escalation, mid-run re-plan,
  peer handoff, HITL) once each against real Claude in a throwaway git project, confirming the Expected column
  of the audit's Dimension-1 checklist. Needs real tokens + the GUI + the user. **Should precede R1/R2.**
- The remaining ~30 Minors fold opportunistically into the nearest cycle above, or batch into one optional
  "papercuts" sweep after the must-fix tiers.

---

## Status

- **2026-06-27** — Triage approved. UX-only Importants (#21, #28, #29, #32–34) **deferred to the Phase-2
  Orkestr overhaul** (recorded as overhaul acceptance criteria in the overhaul-plan memory).
- **2026-06-27** — **Cycle S2 (Run-result launch hardening) STARTED** — brainstorm in progress.

Update this file's "Status" + check off cycles as they merge.
