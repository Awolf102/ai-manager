# Creative-Vision Team (visionMode + preset + output preview) — Design

- **Date:** 2026-07-02
- **Phase:** 3, Wave D, feature #9 (the second and final Wave-D feature; follows #8 Large Team Mode + Director role, merged `dc65ab0`).
- **Status:** design approved (2026-07-02); spec for review.
- **Builds on shipped:** #8 (`dc65ab0`) — the `largeTeamMode` mode-flag plumbing this mirrors, the `director` kind, and the C→D `briefTeamToSpawnedMembers` → `TeamSpawnModal` build path this preset reuses; #6 token efficiency (the `lightPrompts` worker-prompt variant this must preserve); the context-files image feature; the run-result / `manifest-detector` / `launchServer` machinery.

## 1. Goal

Make the app first-class for **creative/design vision work** (branding, UX, visual design, copy) rather than only software engineering. Three parts:
1. **`visionMode`** — an opt-in project-level switch (default off) that biases team-building AND reframes the worker/QA execution wording toward creative fidelity. Mirrors `largeTeamMode`'s plumbing exactly; off = byte-for-byte.
2. **A one-click "Add Creative Team" preset** — a deterministic curated creative-agency roster, built through the existing `TeamSpawnModal` path.
3. **A lightweight creative output preview** — an inline iframe of a web/static deliverable + an image gallery of produced assets, in the run result.

## 2. The invariant (non-negotiable)

**`visionMode` OFF ⇒ byte-for-byte identical to today** — every prompt string (`spawnTeamPrompt`, `draftRolesPrompt`, `planPrompt`, `workerPrompt`), the per-kind `roleTemplate`, and the run hot path. Every gated clause interpolates to empty/identical when off; every new setting defaults inert. The preset (§5) and preview (§6) are strictly additive UI — unused ⇒ no behavior change.

## 3. Decisions (resolved forks)

| Fork | Decision |
|---|---|
| Delivery | **Both** — a `visionMode` toggle (goal-tailored creative teams) **and** a one-click curated starter team. |
| QA reframe depth | **Reframe the worker/QA execution prompts too** (not only team-building) — `workerPrompt` + worker/manager `roleTemplate` get creative-fidelity wording in visionMode. |
| Output preview | **Add a lightweight preview** — inline iframe comp **and** image gallery (both). |
| Preset shape | **Deterministic curated role-pack** — a pure `team-vision.ts` module (archetype role.md strings), built via the existing `applySpawnedTeam`/`TeamSpawnModal` path; doubles as the archetype source the visionMode prompt bias names. |
| Roster | Richer creative-agency team (7 members; Art Director + Visual Designer split), per §7. |

## 4. `visionMode` setting + team-building bias

### 4.1 Setting (`src/shared/types.ts`)
- `ProjectSettings.visionMode: boolean` + `DEFAULT_SETTINGS.visionMode: false`.
- `SettingsModal.tsx`: a plain `<Switch>` in a new **"Creative Vision"** `SettingSection` placed next to the "Large Team" section (same category), mirroring the Large Team toggle. No numeric knob, no new CSS.

### 4.2 Prompt bias (gated; off = byte-identical)
A `vision = false` param is added to the three prompt builders and threaded from `getSettings().visionMode` at the three engine call sites, exactly as `largeTeam` is:
- **`spawnTeamPrompt`** (`team-spawn.ts:6`) — when `vision`, append a `visionBias()` clause (from `team-vision.ts`, §5.1) after the existing rule bullets: it reframes "specialists" toward a creative team and names the archetypes (creative director, brand strategist, art director, visual designer, UX/product designer, copywriter, content strategist) so the orchestrator proposes design roles, not engineers. Threaded at `team-spawner.ts:31` as the arg after `s.largeTeamMode`.
- **`draftRolesPrompt`** (`role-draft.ts:12`) — same `visionBias()` clause; threaded at `role-drafter.ts:33`.
- **`planPrompt`** (`nodes.ts:1472`) — when `vision`, a gated clause frames tasks as **design deliverables** (brand direction, UX flows, wireframes, visual comps, copy, content structure) rather than code modules. Threaded at `nodes.ts:854` (`planStep`).

Construction mirrors §2 of the #8 plan: the vision clause is `''` when off, inserted so the off-path string is character-identical.

## 5. QA / worker execution reframe (gated; the highest-scrutiny piece)

When `visionMode` is on, the software-QA wording is swapped for creative fidelity. All variants default to the current strings when off (string-equality tested).

- **`workerPrompt`** (`nodes.ts`, ~`:1538-1558`, BOTH the non-light and `lightPrompts` variants): add a `vision` param. The *"if you build anything that serves a web page, verify it actually renders — every asset returns 200 / run it"* clause becomes, in visionMode: *"verify the deliverable communicates the intended vision — check visual hierarchy, brand and tonal consistency, typographic craft, and that it reads as intended for its audience."* The non-vision branch is byte-for-byte (incl. the existing light/non-light split from #6). `workerPrompt` is called on the run hot path; the `vision` value comes from `getSettings().visionMode` at its call site(s).
- **`roleTemplate`** worker & manager branches (`project-store.ts:75`): add a `vision` param (default false). Worker: *"do the actual implementation … verify it renders"* → a creative variant (*"produce the design/brand/copy deliverable … evaluate it for craft and vision fidelity"*). Manager: *"run the app/tests … don't hand a database task to a UI specialist"* → creative review framing. `createAgent` (`project-store.ts:242`) passes `getSettings().visionMode` into `roleTemplate`. Off = byte-for-byte; the orchestrator/director branches are untouched.

*Rationale:* `visionMode` means "this whole project is creative," so scaffolding for a manually-added agent leaning creative is correct; and the run-hot-path `workerPrompt` reframe is what actually stops a design worker from chasing HTTP-200s.

## 6. Pure `team-vision.ts` module (single source of the roster)

New pure `src/shared/team-vision.ts` (no node/DOM imports; mirrors `team-scale.ts`), exporting:
- **`VISION_TEAM: AdvisorBriefTeamMember[]`** — the archetype roster (§7) as `{name, kind, role, reportsTo}` records with complete role.md text. Reusing the `AdvisorBriefTeamMember` shape lets the preset build via the existing `briefTeamToSpawnedMembers` (from `advisor.ts`, shipped in #8) with its name→id `reportsTo` resolution.
- **`visionBias(): string`** — the creative-orientation prompt clause used by `spawnTeamPrompt`/`draftRolesPrompt` (§4.2), naming the same archetypes. One source of truth for the role names.

## 7. The creative-agency roster (`VISION_TEAM`)

| Member | Kind | Reports to | Focus |
|---|---|---|---|
| Creative Director | `manager` | orchestrator | Sets creative direction; reviews the team's output for vision coherence, craft, and brand fit |
| Brand Strategist | `worker` | Creative Director | Positioning, brand voice, messaging strategy |
| Art Director | `worker` | Creative Director | Overall visual concept and art direction |
| Visual Designer | `worker` | Creative Director | Layout, color, typography, and visual comps (executes the art direction) |
| UX / Product Designer | `worker` | Creative Director | User flows, wireframes, interaction design |
| Copywriter | `worker` | Creative Director | Copy, naming, microcopy |
| Content Strategist | `worker` | Creative Director | Content structure, information architecture, editorial |

Icons resolve for free via the existing `icons.ts` RULES (`creativ`/`brand`/`art`/`design`/`ux`→`palette`, `copy`/`content`→`pencil`). Models = `DEFAULT_MODEL_BY_KIND` (Creative Director → Opus, workers → Sonnet). Each role.md follows the standard shape (`# Role`, `## Specialty`, `## Responsibilities`, `## How you work`, `## Constraints`) with durable creative-specialty text.

## 8. One-click "Add Creative Team" preset

- A **"Add Creative Team"** entry in `TeamMenu.tsx` (alongside Export/Import team).
- On click: resolve the orchestrator from the graph (error toast if none), then `briefTeamToSpawnedMembers(VISION_TEAM)` → set a local `spawn` state that renders the existing **`TeamSpawnModal`** (pre-loaded, so the user reviews/edits before creating) → the modal's Apply calls the existing `applySpawnedTeam`. Mirrors `AdvisorModal.sendToBuilder` exactly.
- **Zero new engine/IPC plumbing** — deterministic, repeatable, no LLM, no bundle file.

## 9. Creative output preview (lightweight, reuses existing detection)

Surfaced in `RunResultModal.tsx` (the deliverable/preview surface, reached from the GoalBar "Launch app" affordance):
- **Inline iframe comp** — when the detected manifest is `web`/`static`, after `launchServer` returns the URL, embed it in an `<iframe>` inline (in addition to the existing open-in-browser button). No new detection; reuses `manifest-detector` + `launchServer`.
- **Image gallery** — a new bounded main-process helper `listOutputImages(projectPath)` returns image files under the project (image extensions from `context-files.isImageName`; **excludes** `node_modules`, `.git`, `.ai-manager`, `dist`, `out`; **capped at 60 results**, **max directory depth 4**). Exposed via one IPC channel `IPC.outputImages = 'run:output-images'` + preload + `RendererApi.listOutputImages(): Promise<string[]>` (returns absolute paths; the renderer loads each as a blob/file URL like `ContextModal` does). Rendered as a thumbnail grid reusing the `.ctx-thumb` styling from `ContextModal`. The gallery shows regardless of launchability, so a pure-image creative deliverable still previews.
- On-brand: reuses existing modal surfaces/tokens; no new tokens. Renderer-only ⇒ on-device smoke required.

## 10. Testing

- **Pure/unit:** `visionBias()` non-empty + names the archetypes; `spawnTeamPrompt`/`draftRolesPrompt`/`planPrompt`/`workerPrompt`/`roleTemplate` **string-equal when vision off** (the byte-for-byte guard) and contain creative wording when on (incl. `workerPrompt` light AND non-light variants); `VISION_TEAM` → `briefTeamToSpawnedMembers` yields 7 valid members with `reportsTo` resolving (Creative Director → orchestrator, workers → Creative Director); `listOutputImages` filters by extension, excludes the named dirs, respects the cap and depth bound.
- **Engine:** (mostly covered by the pure prompt tests) — a `visionMode`-off run is byte-for-byte; no new run-graph nodes.
- **Renderer:** `npm run lint` (Rules-of-Hooks) + **on-device smoke** (App.tsx not rendered in tests): the Creative Vision toggle; "Add Creative Team" → `TeamSpawnModal` shows the 7-member roster indented under the orchestrator, Apply creates it with `palette`/`pencil` icons; the iframe + image-gallery preview in the run result.
- Integration gates: `npm run typecheck`, `npm run test`, `npm run build`, `npm run lint`.

## 11. Deferred / non-goals (YAGNI)

- **Run-tracked output manifests** — the gallery is a bounded directory scan, not a produced-file ledger.
- **A curated `.aimteam.json` bundle** (the pure module supersedes it) and **Advisor-generated presets** (the Advisor can already propose creative teams ad-hoc via the C→D seam).
- **Design-tool integrations** (Figma/Sketch import-export).
- **Renaming "Launch app" → "Preview"** in visionMode (cosmetic; the existing button reaches the preview).

## 12. Byte-for-byte checklist (verify before merge)

1. `visionMode` off ⇒ `spawnTeamPrompt`/`draftRolesPrompt`/`planPrompt`/`workerPrompt` (light + non-light) / `roleTemplate` (all kinds) strings identical to pre-change (string-equality tests green).
2. `createAgent` with `visionMode` off ⇒ identical scaffolded role.md.
3. Preset unused / preview unused ⇒ no graph or behavior change; new setting absent ⇒ default applied.
4. No new run-graph node; a `visionMode`-off run is unchanged end-to-end.
