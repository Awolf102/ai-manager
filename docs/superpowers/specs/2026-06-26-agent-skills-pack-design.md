# Agent Skills Pack — Design

**Status:** Approved (brainstorm 2026-06-26). Ready for implementation plan.

**Goal:** Give every AI-Manager agent a curated set of **always-available, model-invoked** skills — four design skills (Emil Kowalski, Taste, Impeccable, UI/UX Pro Max) plus the Playwright browser-automation skill — installed once per machine and loaded into every agent run, **without forcing usage** and **without contaminating agents with personal user config**.

This is feature cluster #1 (add specific skills) + #2 (per-role selection) + #6 (efficient install) from the 2026-06-26 feature list. Builds directly on the shipped **trusted skill catalog** ([[ai-manager-skill-catalog]]).

---

## Context — current state (verified in code 2026-06-26)

- `shared/skill-trust.ts` — `isTrusted()` admits a plugin only if author = "anthropic", repo = `anthropics/*`, or installs ≥ `skillInstallThreshold` (default 100k). `offeredSkills()` ranks/caps the list for the orchestrator; `skillOptionsFor(assigned, discovered)` builds `{plugins:[{type:'local',path,skipMcpDiscovery:true}], skills:[]}` from a per-agent assignment.
- `main/engine/skill-discovery.ts` — `discoverSkills()` reads only `~/.claude/plugins/` (catalog cache + marketplaces + installed) and resolves each trusted plugin's on-disk `skills/` dir.
- `main/engine/agent-runner.ts` — per agent: `settingSources: ['project']` (loads the **target project's** `.claude/`, not `~/.claude`) **plus** `options.plugins`/`options.skills` from `skillOptionsFor(agent.skills, discoveredPlugins())` (line ~104). Discovery is cached ~30s per run.
- `team-spawner.ts` / `role-drafter.ts` — already offer up to 40 discovered skills to the orchestrator, which assigns `skills[]` per agent by role (so **#2 already works for trusted plugins**).
- **Gap:** personal `~/.claude/skills/` is loaded by *neither* path. The five target skills are bare skills (4) and a dual-mode skill/plugin (Playwright) — all **script-driven, no MCP** (verified: `playwright-skill` deps = `playwright` only; runs via `node run.js /tmp/*.js`).

---

## Architecture

A new **skills pack**: one AI-Manager-managed local plugin directory, populated once per machine, that `agent-runner` loads for **every** agent in addition to the orchestrator's per-agent assignments. Because skills are **model-invoked**, listing a skill only makes it *available* — a non-UI agent never triggers a UI skill, a non-QA agent never triggers Playwright. Nothing is forced.

This reuses the **exact proven mechanism** the trusted-plugin pipeline already uses (`options.plugins` + `options.skills` with a local plugin path) — just unconditionally rather than per-assignment.

### Pack layout

```
<skillsPackPath>/                      (default: <userData>/skills-pack)
  .claude-plugin/plugin.json           id: "ai-manager-skills-pack"
  skills/
    emil-kowalski/SKILL.md  ...
    taste/SKILL.md          ...
    impeccable/SKILL.md     ...
    uiux-pro-max/SKILL.md   ...
    playwright-skill/        SKILL.md + run.js + lib/ + node_modules/ + (chromium via setup)
```

Each entry is a bare skill folder; the single `plugin.json` makes the whole pack loadable as one SDK local plugin. Skill ids follow the existing convention `ai-manager-skills-pack:<skill-name>`, where `<skill-name>` is the `name:` from each `SKILL.md` frontmatter (fallback: folder name) — exact ids confirmed after install.

### Components

1. **`shared/skills-pack.ts` (pure, unit-tested)** — new module:
   - `packSkillOptions(packPath, skillNames)` → `SkillSdkOptions | null`: returns `{plugins:[{type:'local',path:packPath,skipMcpDiscovery:true}], skills: skillNames.map(n => 'ai-manager-skills-pack:'+n)}`, or `null` when `skillNames` is empty.
   - `mergeSkillOptions(perAgent, pack)` → merges two `SkillSdkOptions` (dedupe plugin paths and skill ids; either may be `null`). This is the load-bearing pure function — its tests cover: both present, pack-only, per-agent-only, both null, overlap dedupe.

2. **`main/engine/skills-pack.ts` (fs)** — `discoverPackSkills(packPath)`: reads each `<packPath>/skills/*/SKILL.md` and returns the skill `name:` from its frontmatter (fallback: folder name), cached like `discoveredPlugins`. Returns `[]` if the pack dir / `skills/` dir is absent → **no-op path**.

3. **`agent-runner.ts` integration** — after building the per-agent `skillOpts` (existing line ~104), when `getSettings().skillsPackEnabled` and the pack has skills:
   - `const packOpts = packSkillOptions(packPath, await packSkillNames())`
   - `const merged = mergeSkillOptions(skillOpts, packOpts)`
   - assign `options.plugins`/`options.skills` from `merged` (unchanged shape).
   - **Headless guidance:** when the pack contains `playwright-skill`, append one line to the agent's system-prompt `append`: *"When using the playwright-skill, always launch browsers headless (`headless: true`) — you run in a headless environment with no display."* (Overrides the skill's visible-browser default.)

4. **Settings (`shared/types.ts` + `SettingsModal.tsx`)**:
   - `skillsPackEnabled: boolean` (default `true`).
   - `skillsPackPath: string` (default empty → resolves to `<userData>/skills-pack`).
   - When disabled, or the pack is empty/absent → behavior is **byte-for-byte** as today.

### Data flow

```
setup script → populates <skillsPackPath> (skills + playwright browsers)
run start → agent-runner: per-agent skillOptionsFor(...)  ⊕  packSkillOptions(...)  → options.plugins/skills
agent → model sees pack skills as available → invokes only when task-relevant (design → UI work; playwright → QA/verify)
```

---

## Provisioning (#6 — install once)

A documented procedure + helper script `scripts/setup-skills-pack.mjs` that populates `<skillsPackPath>`:

- **Design skills (shell-installable):** run each installer (`npx skills add emilkowalski/skill`, `npx skills add Leonxlnx/taste-skill`, `npx impeccable install`, `uipro init --ai claude`) into a temp/holding location, then copy the resulting skill folder into `skills-pack/skills/`.
- **Playwright:** `git clone --depth 1 https://github.com/lackeyjb/playwright-skill.git`, copy `skills/playwright-skill` into the pack, then `npm run setup` (installs `playwright` + Chromium) in that folder.
- **Manual prerequisite noted:** Impeccable's `/impeccable init` is a **Claude Code slash command** (not pure shell); if its full setup needs that step, it is run once by the user. The script copies whatever skill files the installers produce; the engine feature does not depend on the script being fully automated.

Separating the durable engine feature (pack mechanism) from one-time install chores keeps the feature testable and the install reproducible.

---

## Out of scope (explicitly declined / deferred)

- **General user-facing skill allowlist UI** — declined by user ("no need to change the skill allowlist filter").
- **MCP integration** — not needed; `playwright-skill` is script-driven.
- **Per-role assignment of these five** — they are pack/always-available; the existing per-role pipeline (#2) remains for any *other* real trusted plugins added later. No trust-bypass is required because the pack is loaded directly, not discovered through `isTrusted`.
- **`settingSources: ['user']`** — rejected: would inject `~/.claude/CLAUDE.md`, personal agents, and settings into every spawned agent (contamination).

---

## Testing strategy

- `shared/skills-pack.test.ts` — pure tests for `packSkillOptions` (empty → null; ids built correctly) and `mergeSkillOptions` (all four combinations + overlap dedupe). Mirrors `skill-trust.test.ts`.
- `main/engine/skills-pack.test.ts` — `discoverPackSkills` against a temp dir fixture (skills present; missing `skills/`; missing pack → `[]`).
- `agent-runner` wiring: assert via the existing `Eng` seam that a spawned agent's options include the pack plugin + skill ids when enabled, and are unchanged when `skillsPackEnabled:false` / pack empty (regression: off = byte-for-byte).

---

## Success criteria

1. With the pack populated and `skillsPackEnabled` (default), every agent's run options include the pack plugin + its skill ids, merged (deduped) with any per-agent assignment.
2. A QA/verify agent can invoke the Playwright skill to open the running app headless and report results; a schema/research agent never triggers it.
3. With the pack absent/empty or the setting off → engine output is byte-for-byte identical to today (regression-tested).
4. Setup script reproducibly populates the pack (design skills copied; Playwright browsers installed).

---

## Open items to resolve in the implementation plan

- Exact skill folder names + `name:` frontmatter ids from each installed SKILL.md (read after install).
- Confirm the SDK loads the pack plugin's skills as model-invoked (high confidence — identical shape to the shipped trusted-plugin path).
- Chromium disk footprint / where `npm run setup` places browsers relative to the copied folder.
- Whether the bespoke installers (impeccable, uipro) emit a single self-contained skill folder we can copy cleanly.

[[ai-manager-skill-catalog]] [[ai-manager-architecture]] [[ai-manager-status-roadmap]]
