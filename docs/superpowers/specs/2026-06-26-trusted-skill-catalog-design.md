# Trusted Skill Catalog + Auto-Assigned Skills

**Date:** 2026-06-26
**Status:** Approved design, ready for implementation planning
**Roadmap:** Out-of-band user request (skills/plugins). Follows the project-context-files feature.

## Motivation

Today the team's per-agent skills come from a **hardcoded** catalog (`src/shared/skill-catalog.ts`: 4 plugins / 47 skills, all Anthropic) resolved through a **hardcoded** `resolvePluginPath` in `agent-runner.ts` that knows exactly two marketplaces (`knowledge-work-plugins`, `claude-plugins-official`). Two consequences:

1. **Installing more plugins does nothing.** A plugin the user installs via Claude Code is invisible to the app unless it's added to the static catalog and the path resolver — there is no discovery.
2. **Dynamically-created agents get zero skills.** Build-team (`applySpawnedTeam`), Draft-roles, and plain `createAgent` never set `node.skills`; the `SpawnedMember` type and spawn prompt don't even have a skills field. Skills are only ever attached by hand in `AgentConfigPanel`, or carried in via team import. So a freshly-spawned team starts skill-less no matter what's installed.

The user wants to install many plugins so dynamically-spawned agents are more capable — **but only trusted ones** (Anthropic-published, or popular enough to be safe). This feature makes the app (1) auto-discover the skills of *trusted* installed plugins and (2) have the orchestrator equip spawned/drafted agents with the relevant ones.

## Goals

- **Discover** installed plugins' skills automatically from Claude Code's local plugin metadata (no in-app installation).
- **Trust-filter**: surface a plugin's skills only if it is **Anthropic-authored** OR its `unique_installs` is at/above a threshold (default **100,000**, tunable in Settings).
- **Replace** the hardcoded catalog + path resolver with discovery, so any trusted installed plugin is usable with no code edit.
- **Auto-assign** skills to dynamically-created agents: the orchestrator picks per-role skills during Build-team and Draft-roles (mirroring how it assigns `effort`), shown in the editable preview before Apply.
- Never hard-fail: missing/unreadable plugin data degrades gracefully.

## Non-goals (out of scope, YAGNI)

- **In-app installation / a plugin store.** The user installs plugins via Claude Code (`claude plugin marketplace add` + `claude plugin install`); the app only discovers + trust-filters what's present.
- **Online registry calls** for live install counts — the data is already in the local cache.
- **A "verified" badge** — Claude Code's local metadata has no `verified` flag; install count + publisher are the proxies.
- **Re-equipping existing manually-created agents** — auto-assign applies only to the orchestrator-driven Build-team / Draft-roles flows; manual agents keep manual skills.
- **Per-skill manual trust overrides.**

## Decisions locked in brainstorming

- **Discover + trust-filter installed** (NOT in-app install).
- **Trust rule:** Anthropic-authored OR `unique_installs >= skillInstallThreshold` (default 100,000, tunable).
- **Scope:** dynamic trusted catalog AND auto-assign to spawned/drafted agents.
- **Data source:** read Claude Code's local metadata files (Approach A), with a filesystem-scan fallback (Anthropic-only) when the cache is absent.

## Local data on disk (verified 2026-06-26)

Under `~/.claude/plugins/`:

- **`installed_plugins.json`** — `{ version, plugins: { "<plugin>@<marketplace>": [{ scope, installPath, version, installedAt, lastUpdated, gitCommitSha? }] } }`. Authoritative "what's installed" + each install's `installPath` (e.g. `…/cache/<marketplace>/<plugin>/<version>`).
- **`plugin-catalog-cache.json`** — `{ catalog: { generated_at, …, plugins: { "<plugin>@<marketplace>": { plugin, components: { skills: [{ name, chars }], commands, agents, hooks, mcpServers, lspServers }, unique_installs, marketplace_entry: { name, description, author: { name }, category, source: { url, path, ref, sha }, homepage }, version, source } } }, fetchedAt, version }`. **236 plugins**; each carries the skill list (`components.skills[].name`), publisher (`marketplace_entry.author.name`), and `unique_installs`. (Verified: 36 Anthropic-authored, 19 with ≥100k installs, max ~948k.) This is an **internal, undocumented** Claude Code cache — parse tolerantly; treat schema as best-effort.
- **`known_marketplaces.json`** — `{ "<marketplace>": { source: { source: "github", repo: "anthropics/…" }, installLocation, lastUpdated } }`. Gives each marketplace's GitHub repo (provenance) + its on-disk `installLocation` (the cloned marketplace dir).

**Skill id** = `<plugin>:<skill-name>` (e.g. `data:airflow`) — matches the existing `engineering:code-review` convention so nothing downstream changes.

## Architecture

Three layers.

### 1. Trusted skill discovery (`src/main/engine/skill-discovery.ts`, new)

Impure (reads `~/.claude/plugins`). Builds the catalog of **available** plugins, applies the trust filter, returns trusted plugins with skills + metadata + a verified on-disk path.

`discoverSkills(threshold: number): Promise<DiscoveredPlugin[]>`:
1. Read `known_marketplaces.json` (marketplace → repo + installLocation), `installed_plugins.json` (installed set + installPaths), `plugin-catalog-cache.json` (rich metadata).
2. Enumerate plugins from the catalog cache (covers every plugin in an added marketplace). For each:
   - **Resolve the on-disk skills dir** and include the plugin only if it exists: prefer `installed_plugins.json` `installPath`; else the marketplace clone (`<marketplace.installLocation>/<marketplace_entry.source.path or plugin subdir>`). Require a `skills/` directory there. (This generalizes today's hardcoded resolver and keeps the current `knowledge-work-plugins` + `frontend-design` plugins working — including the `plugins/` subpath wrinkle — without special-casing.)
   - **Trust:** `trusted = isTrusted({ author, marketplaceRepo, uniqueInstalls }, threshold)` (Section: trust rule).
   - Build `skills` from `components.skills[].name` → `{ id: "<plugin>:<name>", name, description }` (description from `marketplace_entry.description` or per-skill if available).
3. Return only trusted plugins.

**Fallback** (catalog cache missing/unparseable): scan each added marketplace's `installLocation` for `*/skills/*/SKILL.md` (and the `plugins/*/skills/*` shape), derive skills from the dir names + SKILL.md frontmatter, and trust **only `anthropics/*` marketplaces** (no install data available). Conservative by design.

Pure, unit-tested core in **`src/shared/skill-trust.ts`** (node/DOM-free):
- `isTrusted(p: { author?: string; marketplaceRepo?: string; uniqueInstalls?: number }, threshold: number): boolean` — `true` if `author` equals "anthropic" (case-insensitive), OR `marketplaceRepo` starts with `anthropics/`, OR `uniqueInstalls >= threshold`.
- `shapeCatalog(raw: { installed, cache, marketplaces }, threshold): DiscoveredPlugin[]` — the join + skill-id derivation + trust filter, taking already-parsed JSON so it's testable on fixtures (no fs). `skill-discovery.ts` does the fs reads + path-existence checks, then delegates shaping to this.

Types (`src/shared/types.ts`): `DiscoveredSkill { id: string; name: string; description: string }`, `DiscoveredPlugin { id: string; marketplace: string; author: string; uniqueInstalls: number; trusted: true; path: string; skills: DiscoveredSkill[] }`.

### 2. Wire discovery into the SDK + UI (replaces the hardcoded catalog)

- **`agent-runner.ts`**: drop the hardcoded `resolvePluginPath`. A new `skillOptionsFor(agentSkills: string[], discovered: DiscoveredPlugin[])` (relocated from `skill-catalog.ts`, reworked) builds `{ plugins: [{ type: "local", path, skipMcpDiscovery: true }], skills: [...] }` — including only the plugins whose skills the agent actually has, and only skills still present in `discovered` (an assigned skill that's no longer trusted/installed is silently dropped). Discovery runs **once per run** and is cached (it's consulted for every agent step; the ~369 KB cache shouldn't be re-read per call).
- **IPC `skills:list`** → returns the trusted catalog (grouped by plugin, with `author` + `uniqueInstalls`) for the renderer; preload + `RendererApi` method `listSkills()`.
- **`AgentConfigPanel.tsx`**: the skills multi-select becomes dynamic — fetches `skills:list`, lists trusted installed skills grouped by plugin, each with a badge ("✓ Anthropic" or "120k installs"). Replaces the static `SKILL_CATALOG` import.
- **`ProjectSettings.skillInstallThreshold?: number`** (default 100,000) — Settings field controlling the trust floor, on the existing settings plumbing (`DEFAULT_SETTINGS` + `SettingsModal`). Discovery reads it via `getSettings()`.
- **`src/shared/skill-catalog.ts`** is retired; the small set of skill-name knowledge it held is no longer needed (discovery supplies it; the fallback derives names from disk). `scripts/skills-check.mjs` updated to call discovery instead of hardcoded paths.

### 3. Auto-assign skills to dynamically-created agents

The orchestrator is given a **condensed, capped** trusted-skill list (skill id + one-line description; capped — e.g. ≤40 entries, preferring Anthropic + highest-install — to keep the prompt bounded) and asked to assign the most relevant skills per member, exactly as it assigns `effort` today.

- **Build-team:** `SpawnedMember` (`src/shared/team-spawn.ts`) gains `skills?: string[]`. `spawnTeamPrompt` lists the offered trusted skills and asks for per-member `skills` in the JSON. `parseSpawnedTeam` validates each against the offered set (drops unknown ids; caps ≤5/member). `applySpawnedTeam` (`project-store.ts`) sets `node.skills` when present.
- **Draft-roles:** `draftRolesPrompt` offers the same list; `parseDraftedRoles` reads an optional `skills` per role; the apply path persists them via the existing `updateAgent`.
- The `spawnTeam` / `draftRoles` engine entry points (`team-spawner.ts` / `role-drafter.ts`) fetch the trusted catalog (via discovery) and pass it into the prompt builders.
- The editable **TeamSpawnModal** / **RoleDraftModal** previews show the proposed skills per member so the user can adjust before Apply.
- Manually-created agents (`createAgent`) are unchanged.

## Data flow

`~/.claude/plugins/*.json` → `discoverSkills(threshold)` (trust-filtered, cached per run) → (a) `skills:list` IPC → `AgentConfigPanel` + the Build-team/Draft-roles prompt builders; (b) `skillOptionsFor` → SDK `plugins`/`skills` at run time. Build-team / Draft-roles → orchestrator assigns trusted skills per member → `node.skills` persisted in `graph.json` → loaded on the next run.

## Error handling

- `~/.claude/plugins` or any file missing/unreadable → empty (or fallback) catalog; the app runs with no skills (today's behavior when nothing is installed). Discovery **never throws into a run** (double-walled try/catch, like the team-brain auto-sync helpers).
- `plugin-catalog-cache.json` unparseable → filesystem-scan fallback, Anthropic-only trust.
- A plugin whose on-disk `skills/` dir is absent → excluded (not surfaced).
- A skill assigned to an agent that is no longer trusted/installed → dropped at load time in `skillOptionsFor` (the run proceeds).
- `skillInstallThreshold` unset → default 100,000.
- Orchestrator returns unknown/oversized skill lists → parser drops unknown ids and caps per-member count.

## Testing

- **Pure unit (`src/shared/skill-trust.test.ts`)** — the real coverage:
  - `isTrusted`: Anthropic author (any case) → true; `anthropics/*` marketplace → true; `uniqueInstalls >= threshold` → true; non-Anthropic below threshold → false; boundary (`== threshold` → true).
  - `shapeCatalog`: joins installed/cache/marketplaces on fixtures; derives `<plugin>:<name>` skill ids; excludes untrusted plugins; tolerates missing fields.
- **`team-spawn.test.ts`** — `spawnTeamPrompt` includes the offered skills; `parseSpawnedTeam` keeps only valid offered ids, drops unknown, caps ≤5/member, and tolerates members with no `skills`.
- **`role-draft.test.ts`** — `draftRolesPrompt` offers skills; `parseDraftedRoles` reads optional per-role `skills` (drops unknown).
- **`skill-discovery.ts`** (fs reads), **IPC/preload/renderer**, and the `agent-runner` rewire — typecheck + build (house precedent), plus a fixture-directory test for discovery's path resolution + fallback if cheap to set up.

## File-by-file summary

| File | Change |
|------|--------|
| `src/shared/skill-trust.ts` | NEW pure module: `isTrusted`, `shapeCatalog` |
| `src/shared/skill-trust.test.ts` | NEW unit tests |
| `src/shared/types.ts` | `DiscoveredSkill`/`DiscoveredPlugin`; `ProjectSettings.skillInstallThreshold` (+ `DEFAULT_SETTINGS`); `SpawnedMember.skills?`; IPC `skills:list` + `RendererApi.listSkills` |
| `src/main/engine/skill-discovery.ts` | NEW: `discoverSkills(threshold)` — reads the 3 JSON files, resolves on-disk skill dirs, fallback scan; delegates shaping to `skill-trust` |
| `src/main/engine/agent-runner.ts` | Remove hardcoded `resolvePluginPath`; rework `skillOptionsFor` to take discovered plugins; cache discovery per run |
| `src/shared/skill-catalog.ts` | Retired (discovery replaces it) |
| `src/main/engine/team-spawner.ts`, `src/shared/team-spawn.ts` | `SpawnedMember.skills?`; offer catalog in `spawnTeamPrompt`; validate+cap in `parseSpawnedTeam`; spawner passes the catalog |
| `src/main/engine/role-drafter.ts`, `src/shared/role-draft.ts` | offer catalog in `draftRolesPrompt`; parse optional per-role `skills` |
| `src/main/engine/project-store.ts` | `applySpawnedTeam` sets `node.skills`; Draft-roles apply path persists skills |
| `src/main/ipc.ts`, `src/preload/index.ts` | `skills:list` handler + bridge |
| `src/renderer/panels/AgentConfigPanel.tsx` | dynamic skills multi-select from `skills:list` (badges) |
| `src/renderer/SettingsModal.tsx` | `skillInstallThreshold` field |
| `src/renderer/TeamSpawnModal.tsx`, `src/renderer/RoleDraftModal.tsx` | show proposed per-member skills (editable) |
| `scripts/skills-check.mjs` | use discovery |

No changes to the run record/history, the orchestration graph (`nodes.ts`), or team export/import (which already carries `skills`).

## Risks / edge cases

- **`plugin-catalog-cache.json` is internal/undocumented** — its schema could change across Claude Code versions. Mitigated: tolerant parsing + the Anthropic-only filesystem fallback, so the feature degrades rather than breaks.
- **Marketplace-added vs installed** — plugins from an *added* marketplace live in the clone dir; *installed* plugins also have a cache copy. Discovery resolves either and requires a real `skills/` dir, so both work and today's `knowledge-work-plugins` plugins (not in `installed_plugins.json`) keep working.
- **Prompt bloat from a large trusted catalog** — capped + condensed list passed to the orchestrator (id + one-line description). The cap is a tunable constant; `log()` if entries are dropped from the offer.
- **Stale assignments** — a `node.skills` entry can outlive its plugin; dropped silently at load (logged), never errors a run.
- **Threshold churn** — lowering the threshold surfaces more plugins; raising it hides some already-assigned skills (they're dropped at load). Acceptable and reversible.
- **Trust ≠ sandbox** — surfacing a trusted skill still runs that skill's guidance inside the agent; "trusted" here means provenance/popularity, not a security sandbox. Documented; matches Claude Code's own trust model.
