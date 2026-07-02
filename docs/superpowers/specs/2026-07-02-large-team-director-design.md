# Large Team Mode + Director role — Design

- **Date:** 2026-07-02
- **Phase:** 3, Wave D, feature #8 (flagship). #9 (creative-vision team) is a separate follow-on cycle.
- **Status:** design approved (2026-07-02); spec for review.
- **Builds on shipped:** #3 model backends (`aad8be3`), #6 token efficiency (`8c2acc4`), the Advisor / C→D seam (`e85d039`), two-tier review + v2 escalation (`8c9fc3f`/`5f2a58a`), workflow-graph arc (`26467f2`/`7996f31`/`c0d88a7`), model/effort clamp (`297268b`).

## 1. Goal

Let a project run a **large team of agents** with a new **Director** tier between the orchestrator and its managers, so broad goals can be decomposed across program areas instead of micromanaged by a single orchestrator. Concretely:

1. A new `director` **AgentKind** — a strategic router + reviewer tier.
2. **Large Team Mode** — an opt-in that unlocks broad orchestrator planning, director-aware team-building, and higher concurrency, with cost/runtime guard rails.
3. **Bulk-duplicate workers** — create many similar workers fast.
4. **C→D seam** — the Advisor's structured brief actually builds the team (including directors) end-to-end.

Large teams carry cost/runtime blow-up risk, so the design leans on the already-shipped #3 (per-agent backends) and #6 (cheap-model workers, effort thrift) for cost control, plus new guard rails.

## 2. The invariant (non-negotiable)

**`largeTeamMode` OFF *and* no `director` node present ⇒ byte-for-byte identical to today** — engine behavior, prompt strings, parallelism, spawn/draft output, and canvas rendering. Every new field defaults to its inert value. The exhaustive `Record<AgentKind>` maps (`DEFAULT_MODEL_BY_KIND`, `KIND_PLURAL`) make TypeScript force us to visit every kind-sensitive site.

Two independent "off switches" compose:
- The **`director` kind** is always live (a hand-built `orchestrator → director → worker` tree must route/review correctly regardless of the toggle) — but with **no director node present**, every kind-sensitive branch is byte-for-byte.
- **`largeTeamMode`** gates the *automatic* large-team behaviors (broad planning, director spawning/drafting, raised concurrency). Off ⇒ those code paths are the current strings/values verbatim.

## 3. Decisions (resolved forks)

| Fork | Decision |
|---|---|
| Director's job / planning model | **Strategic router + reviewer on the existing single-level plan.** The orchestrator still produces one task list (coarser altitude in large-team mode); the Director routes its slice down and reviews/aggregates up. **No** recursive/hierarchical planning this cycle (noted as a future extension). |
| Large-team gating | **Explicit `largeTeamMode` toggle** (default off = byte-for-byte). |
| Bulk-duplicate UX | **Both** — "Duplicate ×N" on a configured node *and* a count field on fresh Add. |
| Director auto-spawn/draft | **Yes** — teach `spawnTeam` + `draftRoles` about directors, gated to large/broad goals. |
| C→D seam depth | **Full wiring** — the Advisor proposes a director-led team and "Send to team builder" builds it as real nodes+edges (confirm-gated). |
| Cost guard rails | **Raised (settings-adjustable) parallelism + pre-run size/cost heads-up + cheap-model default for bulk/large-team workers.** |
| Guard-rail numbers | **Settings-adjustable**, not hardcoded (per user): `largeTeamParallel` and `bulkCreateMax`. |

## 4. New / changed settings (`ProjectSettings` + `DEFAULT_SETTINGS`, `shared/types.ts`)

All default to the inert/current value; surfaced in a new **"Large Team"** section of `SettingsModal.tsx` (reusing `SettingSection`/`Switch`/gated-control — no new CSS/tokens).

| Field | Type | Default | Effect |
|---|---|---|---|
| `largeTeamMode` | `boolean` | `false` | Master toggle. On ⇒ broad planning + director spawn/draft + raised concurrency + guard-rail UI. Off ⇒ byte-for-byte. |
| `largeTeamParallel` | `number` | `6` | Concurrency cap used **only when `largeTeamMode` is on**. Off keeps `MAX_PARALLEL = 3`. Adjustable. |
| `bulkCreateMax` | `number` | `25` | Per-action ceiling for Duplicate ×N / Add-count (fat-finger guard). Adjustable. |

Validation: `largeTeamParallel` clamped to `1–24` on write; `bulkCreateMax` clamped to `1–100`.

## 5. The `director` kind — always-on plumbing

With no director node present, all of this is byte-for-byte; a director node opts a subtree into the new behavior.

### 5.1 Type + constants (`shared/types.ts`)
- `AgentKind` → `'orchestrator' | 'director' | 'manager' | 'worker'` (`:7`).
- `AGENT_KINDS` (`:563`) **and the duplicate list in `team-bundle.ts:15`** → include `'director'`, ordered `orchestrator → director → manager → worker`.
- `DEFAULT_MODEL_BY_KIND` (`:565`) → `director: 'claude-opus-4-8'` (strategic reasoning = Opus).
- TS-flagged exhaustive/inline sites: `KIND_PLURAL` (`context-files.ts:41`), the inline `['orchestrator','manager','worker']` in `scopeLabel` (`context-files.ts:51`), the `KINDS` array in `ContextModal.tsx:35`, and the layout literal union in `octopus-layout.ts:3`.

### 5.2 Color + icon (on-brand, per `DESIGN.md` §"Agent role colors")
- New role hue distinct from the gold/periwinkle/silver triad, from emerald-signal, and from danger-coral: **`--director` orchid ≈ `#CB98DB`** + **`--director-tint: rgba(203,152,219,0.14)`** in `tokens.css` (alongside the triad at lines 36–41). Must hit the triad's **≥7:1 on `--surface-2`** and ≥3:1 AA-large — the exact hex is contrast-verified during implementation and consumed only as the `--director` token (never hardcoded).
- Icon: new key **`compass`** → lucide **`Compass`** in `iconComponents.tsx` (`:30`), plus `KIND_FALLBACK.director = 'compass'` in `icons.ts` (`:41`). `iconForName(name, kind?)` is non-exhaustive, so name-based rules still win first.
- **Four `.kind-director` CSS rule-sets** in `styles.css` mirroring the existing three: node background gradient (`~:369`), icon color/tint (`~:396`), kind-label color (`~:412`), run/activity rows (`~:1627`). (Nodes render via the `kind-${agent.kind}` class from `AgentNode.tsx:20`.)

### 5.3 Role template (`project-store.ts` `roleTemplate`, `:74`)
New `if (kind === 'director')` branch (before the worker fall-through): *"a program lead between the orchestrator and the managers. You own a broad program area; decompose the orchestrator's directive across your managers/workers, aggregate and review their results, and report up. You do NOT implement — you direct, review, and integrate."*

### 5.4 N-tier review generalization (`nodes.ts`) — the one real engine touch
Routing itself is already kind-agnostic: `routeTasks`/`childrenOf`/`parentOf`/`reviewerOf` recurse over the free-form edge tree, so a director is simply an intermediate router whose children's reviewer is itself. Two booleans encode a "the middle tier is managers" assumption and must generalize to "an intermediate **review tier** (manager **or** director) exists":
- `hasManagers` (`:1196`) → true when a task's parent kind is `manager` **or** `director`. (Consider renaming to `hasReviewTiers` for clarity; behavior for existing 3-tier teams is unchanged since no director is present.) Gates the tier-2 integration pass.
- `reviewerIdsOf` (`:1205`) → include a parent when `p.kind === 'manager' || p.kind === 'director'`, so directors also reflect on their QA work.

Both are byte-for-byte for any team without a director. Add director fixtures to `nodes.test.ts` and keep the existing 3-tier fixtures as regression guards.

## 6. `largeTeamMode` behaviors (all gated; off = current path verbatim)

A single `largeTeam: boolean` (read from settings) threads into three prompt sites and one cap.

- **Broad planning** — `planStep`/`planPrompt` (`nodes.ts`) gets a large-team variant: fewer, coarser **program-level** tasks that map to director-owned areas, rather than fine-grained tasks. The non-large-team prompt string is unchanged.
- **Raised concurrency** — new pure `parallelCap(settings)` = `settings.largeTeamMode ? settings.largeTeamParallel : MAX_PARALLEL`. Thread it into the four `mapCapped` call sites (execute waves `~:469`, domain review `~:544`, repair `~:645`, reflection `~:761`/`:781`). `MAX_PARALLEL = 3` stays the off/default value.
- **Director-aware spawn/draft** — see §7.

## 7. Director-aware team-building (gated to large goals)

### 7.1 Dynamic spawn (`team-spawn.ts` + `team-spawner.ts`)
- `SpawnedMember.kind` (`types.ts:16`) widens to `'director' | 'manager' | 'worker'`.
- `spawnTeamPrompt` gains a `largeTeam` flag (mirroring the existing `assignModels` flag at `team-spawn.ts:11`). When set, the member-shape hint and rules describe the **director tier** and when to use it (a goal spanning multiple broad program areas → an `orchestrator → director → manager/worker` shape); when unset, the prompt string is byte-for-byte today's.
- `parseSpawnedTeam` (`:58`) accepts `'director'` in the kind gate. (Parser accepts director unconditionally — harmless — while the *prompt* only proposes directors in large-team mode, so off = byte-for-byte spawn output.)
- `pickSpawnModel` → `DEFAULT_MODEL_BY_KIND['director']` = Opus, no change needed. `applySpawnedTeam` (`project-store.ts:1084`) already builds arbitrary-depth trees from `reportsTo` — no change.
- `team-spawner.spawnTeam` passes the `largeTeam` flag from settings.

### 7.2 Role drafting (`role-draft.ts` + `role-drafter.ts`)
- `draftRolesPrompt` (`role-draft.ts:12`): the `# Role: <name> (<Worker|Manager>)` shape (`:45`) becomes `(<Worker|Manager|Director>)` **only when `largeTeam` is passed**; `parseDraftedRoles` (`:66`) accepts `Director`. Off = byte-for-byte.

## 8. Bulk-duplicate workers (both paths)

### 8.1 Duplicate ×N (from a selected node)
- Affordance in `AgentConfigPanel.tsx`: a "Duplicate…" control → count input → confirm.
- New main-process `duplicateAgent(sourceId, count, opts)` in `project-store.ts`, modeled on `applySpawnedTeam`'s atomic batch-create: for each of N clones, mint a unique slug/name (`<name> 2`, `3`, …), **copy the source's `role.md` content** (not the template), and copy `kind`, `model`, `backendId`, `skills`, `permissionMode`; replicate the **same parent edge** (`parentOf(sourceId)`). Position via `nextPosition`. One graph write.
- New IPC `agent:duplicate` + preload + `RendererApi`, mirroring the `createAgent` seam.
- Count capped at `settings.bulkCreateMax`.

### 8.2 Count field on Add (`AddAgentModal`, `App.tsx:503`)
- Add a `count` number input (default 1, capped at `bulkCreateMax`). Creates N fresh-from-template agents (loop `createAgent`, or a small batch helper) of the chosen kind.

### 8.3 Cheap-model default (cost control)
- When `largeTeamMode` is on, **both** modals pre-select `settings.cheapModelTier` as the model (user-overridable). Outside large-team mode: Duplicate clones the source model faithfully; Add uses `DEFAULT_MODEL_BY_KIND[kind]`. This honors "bulk/large-team workers default toward the shipped #6 cheap tier."

## 9. C→D seam — the Advisor builds the team

### 9.1 Type (`shared/advisor.ts`)
- `AdvisorBriefTeamMember` (`:4`) → `kind: 'director' | 'manager' | 'worker'` **and** a new optional `reportsTo?: string` (a member `name`, or `"orchestrator"`) so the Advisor can express real hierarchy.

### 9.2 Consumption (`AdvisorModal.tsx` `sendToBuilder`, `:64`)
- When `brief.team?.length`: a new pure `briefTeamToSpawnedMembers(team)` (in `shared/advisor.ts`, unit-tested) maps members to `SpawnedMember[]` — assigning temp ids, resolving each `reportsTo` name to the corresponding temp id (or `"orchestrator"`), defaulting missing `reportsTo` to `"orchestrator"`. Then **open the existing `TeamSpawnModal` preview** pre-loaded with those members (as if `spawnTeam` returned them) → on confirm, `applySpawnedTeam(members)` + `seedGoal(brief.goal)`.
- When there is no team: behavior is unchanged (`seedGoal(brief.goal)` only).
- **Confirm-gated**, consistent with the Advisor's existing confirm-then-apply hand-off posture; strictly additive (imports nothing new from the orchestrator/engine).

### 9.3 Advisor grounding (`advisorSystemPrompt`, `shared/advisor.ts`)
- Teach the Advisor that a **director** tier exists and that it may propose an `orchestrator → director → manager → worker` team (with `reportsTo`) for broad goals. Ground with `largeTeamMode` as context (advisory only — the build is confirm-gated regardless). No token/baseUrl leakage change (the existing #3 grounding invariants are untouched).

## 10. Guard rails (cost / runtime)

- **Raised, adjustable parallelism** (§6) so large teams finish faster; the user controls the number.
- **Pre-run heads-up** — a small, **display-only** summary near GoalBar's Start (shown when `largeTeamMode` is on, or when the team has **≥ 8 agents**): *"N agents (x directors · y managers · z workers) · concurrency N · large teams cost more and run longer — cheap-model workers (#6) recommended."* Pure derivation from the current graph; no engine behavior.
- **Cheap-model default** for bulk/large-team workers (§8.3).
- **"Unlimited" agents** — no hard cap on live node count (that is the feature). Raise the **import-only** `MAX_MEMBERS = 200` (`team-bundle.ts:11`) to `1000`; the per-action Duplicate/Add cap (`bulkCreateMax`, default 25) is the only creation guard.

## 11. Testing

- **Pure/unit:** the widened kind lists & records; generalized `hasManagers`/`reviewerIdsOf` (existing 3-tier fixtures byte-for-byte + new director fixtures); `parseSpawnedTeam`/`parseDraftedRoles` accept `director`; `parallelCap(settings)`; duplicate slug/name generation; `briefTeamToSpawnedMembers` mapping (incl. name→id resolution and the default-to-orchestrator case).
- **Engine (`nodes.test.ts`, deterministic canned agents):** an `orchestrator → director → manager → worker` run routes, reviews (director reviews its subtree; orchestrator runs the integration pass), repairs, and reflects correctly; and `largeTeamMode`-off / no-director runs are byte-for-byte against current snapshots.
- **Renderer:** `npm run lint` (Rules-of-Hooks gate) + **on-device smoke** (App.tsx is not rendered in tests): director node color/icon/label; Add-count; Duplicate ×N (role/model/skills/parent copied, unique names); the `largeTeamMode` toggle + the two number settings; the Advisor "Send to team builder" confirm→build path; the pre-run heads-up.
- Integration gates: `npm run typecheck`, `npm run test`, `npm run build`, `npm run lint`.

## 12. Deferred / non-goals (YAGNI)

- **Hierarchical/recursive planning** (directors re-decomposing their program into fresh sub-tasks) — single-level chosen; clean future extension.
- **Canvas auto-layout for very wide worker rows** — `octopus-layout.ts` has no per-row width cap, so many duplicated workers form one wide row. React Flow pans/zooms so it stays usable, not broken; layout polish is deferred (functionality-over-polish).
- **Codex / non-Anthropic native harnesses** — orthogonal (backlog #15).

## 13. Byte-for-byte checklist (verify before merge)

1. `largeTeamMode` off + no director ⇒ `spawnTeamPrompt`, `draftRolesPrompt`, `planPrompt` strings identical; `parallelCap` returns 3; spawn/draft output unchanged.
2. No director node ⇒ `hasManagers`/`reviewerIdsOf`/routing/review identical (3-tier + flat fixtures green).
3. Duplicate/Add unused ⇒ no graph change; new settings absent ⇒ defaults applied, no behavior change.
4. Advisor with no `brief.team` ⇒ `seedGoal`-only, unchanged.
5. No token/baseUrl leak introduced by the Advisor grounding change.
