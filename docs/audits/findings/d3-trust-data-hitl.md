# Audit D3 — Security: trust boundaries, plugins, team-data import, context-file copy, HITL secret handling

Scope: a read-only security review of the trust boundaries around (1) Claude Code plugin/skill auto-discovery and loading (`shared/skill-trust.ts`, `main/engine/skill-discovery.ts`, `main/engine/agent-runner.ts`), (2) portable team bundle / team-brain import from arbitrary files (`shared/team-bundle.ts`, `shared/team-brain.ts`, `main/engine/project-store.ts`, `main/ipc.ts`), (3) project context-file copy (`shared/context-files.ts`, `shared/slug.ts`, `project-store.ts`), and (4) the explicit ask — confirming HITL answers are actually scrubbed from every persisted artifact (`shared/ask-user.ts`, `main/engine/nodes.ts`, `graph.ts`, `run-store.ts`, `project-store.ts`, `HistoryView.tsx`, `agent-runner.ts`). Findings are ordered Critical → Important → Minor. The headline results: the plugin trust rule trusts the *entire* Anthropic-hosted marketplace (240 third-party plugins) regardless of author/installs, and loading such a plugin loads its **hooks** (code), not just SKILL.md guidance; and the HITL answer, while correctly scrubbed from the app's own checkpoint fields, still reaches disk via the SDK session transcript and (if the agent echoes it) via the persisted run output — so the memory's claim "the answer never hits disk" is not strictly true.

---

### [Critical] Plugin trust rule trusts every third-party plugin in an Anthropic-hosted marketplace, and "loading a skill" loads the plugin's hooks (code), not just guidance

**Location** `src/shared/skill-trust.ts:7-14` (`isTrusted`) and `:41-52` (`shapeCatalog` sets `marketplaceRepo` to the *marketplace's* repo for every plugin); `src/main/engine/skill-discovery.ts:61-72`; loaded in `src/main/engine/agent-runner.ts:125-130` via `skillOptionsFor` with `{ type:'local', path, skipMcpDiscovery:true }`.

**What's wrong** The trust check is `author === 'anthropic' OR marketplaceRepo startsWith 'anthropics/' OR uniqueInstalls >= threshold`. In `shapeCatalog`, `marketplaceRepo` is read from `known_marketplaces.json[marketplace].source.repo` — i.e. it is the *marketplace's* repo, identical for every plugin in that marketplace. On a normal install `claude-plugins-official` has `source.repo = "anthropics/claude-plugins-official"`, so the `startsWith('anthropics/')` branch returns `true` for **all 240 third-party plugins** in that marketplace (verified on-device: e.g. `42crunch-api-security-testing` author `42Crunch`, `adobe-for-creativity` author `Adobe`). The 100k-install threshold and the per-plugin author check are therefore dead for the whole official marketplace — a low-install or freshly-typosquatted plugin published into (or impersonating) that marketplace is "trusted." Worse, what gets loaded is the **entire plugin directory**, not just its SKILL.md: the SDK's own `SdkPluginConfig.skipMcpDiscovery` docstring states it "loads skills/**hooks**/agents/commands from this plugin but does NOT read its .mcp.json" (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3838-3840`; plugins "provide custom commands, agents, skills, and **hooks**" at `:1671-1672`). Hooks run shell commands at tool-lifecycle events, so loading a "trusted" plugin is equivalent to running its code — and with Full autonomy that code runs with `bypassPermissions` (see the blast-radius finding). `skipMcpDiscovery:true` only blocks MCP servers, not hooks.

**Why it matters** A malicious/typosquatted plugin that lands in (or is mislabeled into) the Anthropic-hosted marketplace satisfies the trust check by marketplace membership alone, gets `offeredSkills(...)` to the orchestrator (`skill-trust.ts:78-87`), can be auto-assigned to a worker during Build-team/Draft-roles, and then has its hooks loaded and executed on the user's machine. This is a code-execution trust-boundary failure that the install-threshold was supposed to prevent.

**Suggested fix** Trust per-plugin, not per-marketplace: require the per-plugin `marketplace_entry.author.name === 'anthropic'` (or a verified publisher allow-list) for the "Anthropic" branch, and do not treat marketplace `source.repo` as evidence of any individual plugin's authorship. Consider gating hook loading explicitly (the SDK exposes only `skipMcpDiscovery`, so a tighter integration or a documented "skills load plugin hooks too" warning is warranted), and make skill discovery/auto-assignment opt-in.

---

### [Critical] HITL answer reaches disk despite app-level scrubbing — via the SDK session transcript and the agent's persisted output (memory's "answer never hits disk" is overstated)

**Location** answer injected into the resumed agent prompt at `src/main/engine/nodes.ts:248` (`answerResumePrompt(answer)`); the resumed agent's output stored at `nodes.ts:260` (`t.output = out`) and `:262` (`steps[ask.ownerId].output = out`), persisted to the in-flight checkpoint at `:274` and to the History record via `toRunRecord` → `steps: Object.values(s.steps)` (`src/shared/run-state.ts:23`) → `saveRun` (`src/main/engine/project-store.ts:451-457`). SDK transcript persistence confirmed at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:479` ("removes `{sessionId}.jsonl`") and on-device (`~/.claude/projects/.../*.jsonl` store user prompts verbatim).

**What's wrong** The app *does* correctly scrub its own two answer-bearing fields: `executeNode` returns `scrub = { resumeInput: undefined, pendingAsk: undefined }` on every path (`nodes.ts:235`, applied at `:274`, `:330`, `:346`, `:379`), `graph.ts` clears `resumeInput` on the error path (`graph.ts:69`), and `userRequests` is `{askerId, question}` only — never the answer — in both the type (`src/shared/types.ts:409`) and the views (`HistoryView.tsx:158`, `RunView.tsx:129`). But two paths still put the answer on disk: (a) the answer is sent verbatim inside `answerResumePrompt(answer)` to the worker's Claude session, and the Agent SDK writes every user prompt to its on-disk session transcript (`~/.claude/projects/<proj>/<sessionId>.jsonl`) — outside `.ai-manager/` and outside any app scrubbing; and (b) if the agent echoes the answer in its reply (e.g. "I configured it with the token you gave me…"), that reply is `out`, which is written to the checkpoint and to the permanent History `RunRecord.steps[].output`.

**Why it matters** The project memory states the HITL answer "must never hit disk" and that it "is scrubbed from every persisted checkpoint + History." That is true for the app's own state fields but false overall: a sensitive answer can persist in the SDK transcript unconditionally and in the History output if the agent reflects it. The modal does warn "don't paste secrets" (`HitlModal.tsx`), which is the real (and reasonable) mitigation — but the audit's explicit requirement was to confirm the answer never hits disk, and it can.

**Suggested fix** Treat the warning as the contract and update the memory claim to match (scrubbing covers app state only, not the SDK transcript or agent-echoed output). If stronger guarantees are wanted, redact the resumed output against the answer string before persisting `t.output`/`steps[].output`, and document that the SDK session transcript will contain the answer (or run HITL turns in a non-persisted/ephemeral session).

---

### [Important] Imported team bundle is under-validated: untrusted `permissionMode`, `model`, `role`, and `lessons` are written straight to agent files

**Location** schema check `src/shared/team-bundle.ts:84-100` (`validateTeamBundle` only verifies `kind`/`version`/`members` array and that each member's `memberId`/`name`/`kind` are strings); import writes at `src/main/engine/project-store.ts:719-731` (`permissionMode: m.permissionMode`, `model: m.model`, `role.md = m.role`) and `team-bundle.ts:124-141` (`planTeamImport` passes `permissionMode`/`model`/`role` through unvalidated; `memory` seeded from `m.lessons` via `buildSeededMemory`, `team-bundle.ts:36-50`).

**What's wrong** `validateTeamBundle` does not validate `permissionMode`, `model`, `role`, `skills`, or `lessons`. An imported `.aimteam.json` can therefore set a member's `permissionMode` to `'bypassPermissions'` (the field is never re-checked on import) and inject arbitrary `role.md` / lesson text. At orchestration time the per-agent mode is overridden by `state.actingMode` (`nodes.ts:294`), but the manual **Run** button does not pass a permissionMode, so `runHeadless` falls back to `agent.permissionMode` (`agent-runner.ts:187-194`, `:111`) — meaning a manually-run imported agent runs with whatever bypass mode the bundle chose. The injected `role`/`lessons` text is concatenated verbatim into the agent's system prompt (`agent-runner.ts:17-26` `composeAppend`) and is treated as "authoritative" instructions the agent will act on with filesystem access — a classic prompt-injection delivery vector via a shareable file.

**Why it matters** "Import a team a colleague shared" is a normal, encouraged workflow (export/import + brain sync). A hostile or tampered bundle can silently escalate an agent's permission mode and plant instructions the agent will execute, without any user-visible diff of the role/memory content before it is written.

**Suggested fix** In `validateTeamBundle`, whitelist `permissionMode` to the known enum and reject/normalize unknown `model` ids; on import, ignore the bundle's `permissionMode` and default to the project's safe mode (e.g. `acceptEdits`). Show the imported role/memory text for review before writing, and treat all bundle-provided prose as untrusted in prompts.

---

### [Important] Full autonomy gives every agent `bypassPermissions` with no project sandbox (cwd is not a boundary)

**Location** `src/main/engine/nodes.ts:62-64` (`actingModeFor`: `full → 'bypassPermissions'`, `cautious → 'acceptEdits'`); applied as the worker run mode at `nodes.ts:251`, `:294`, `:526`, `:855`; the only path scoping in the runner is `cwd: projectPath` (`src/main/engine/agent-runner.ts:108`) — no `additionalDirectories`/sandbox is set.

**What's wrong** With Full autonomy the SDK runs in `bypassPermissions`, and the runner sets only `cwd`. `cwd` is the working directory, not a filesystem jail — the agent's Bash/Read/Write/Edit tools can reach any path the user account can, including `~/.ssh`, `~/.claude` (other projects' session transcripts and the very plugin metadata that drives the trust check above), and arbitrary system files. There is no `additionalDirectories` allow-list and no OS sandbox.

**Why it matters** A single prompt-injected task (or a malicious imported role, or a hostile plugin hook) running under Full autonomy has full read/write of the user's home directory — exfiltration, credential theft, or tampering with other projects are all in reach. This also amplifies the two Critical findings (plugin hooks and injected roles both execute in this blast radius).

**Suggested fix** Pass an `additionalDirectories` allow-list limited to the project (and any explicitly-approved dirs) and avoid `bypassPermissions` as a one-click setting, or at minimum surface a prominent, per-run warning that Full autonomy is unsandboxed full-FS access. Note also `allowDangerouslySkipPermissions` is not set alongside `bypassPermissions` (`agent-runner.ts:107-119`), which the SDK documents as required (`sdk.d.ts:1662-1665`) — worth confirming bypass actually engages as intended.

---

### [Important] `marketplaceRepo` trust match has no host/format check and the install threshold is taken from a locally-forgeable cache

**Location** `src/shared/skill-trust.ts:12` (`(p.marketplaceRepo ?? '').toLowerCase().startsWith('anthropics/')`) and `:13` (`(p.uniqueInstalls ?? 0) >= threshold`); the values originate from local files read in `src/main/engine/skill-discovery.ts:43-47` (`known_marketplaces.json`, `plugin-catalog-cache.json`).

**What's wrong** Two forgeability gaps independent of the per-marketplace bug above. (1) The repo check is a bare lowercase `startsWith('anthropics/')` on a free-form string with no host/owner verification — a marketplace whose `source.repo` is set to `anthropics/anything` (on *any* host, or a look-alike registered locally) passes; there is no check that the source is actually `github.com/anthropics`. (2) `uniqueInstalls` is read from `plugin-catalog-cache.json` on the local disk — a cache, not an attested value. Anything that can write that file (a malicious installer, a tampered marketplace sync, another full-autonomy agent run with home-dir write access) can set `unique_installs` above the threshold or set `marketplace_entry.author.name` to `"Anthropic"` and become "trusted." Nothing here is cryptographically checkable from local metadata.

**Why it matters** Even after fixing the per-marketplace rule, trust still rests entirely on unsigned local JSON that is writable by the same agents this app runs. The threshold gives a false sense of a popularity gate that an attacker (or a prior compromised run) can trivially satisfy locally.

**Suggested fix** Verify the marketplace source is genuinely an `anthropics`-owned GitHub repo (exact owner + known host), not a substring; do not derive trust from a writable local install-count cache (or, if kept, treat it as a hint and require an additional verified signal). Document that trust is best-effort and bounded by local-FS integrity.

---

### [Minor] Context-file copy follows symlinks and has no size cap; sensitive-file content can be ingested and broadcast to every agent

**Location** `src/main/engine/project-store.ts:325-342` (`addContextFiles`: `fs.stat(src)` follows symlinks, `fs.copyFile(src, …)` copies dereferenced content, no size check); injected to every agent via `buildContextBlock` (`src/shared/context-files.ts:28-40`) in `agent-runner.ts:110`.

**What's wrong** `addContextFiles` accepts paths (from a file dialog or drag-drop `webUtils.getPathForFile`, so user-chosen — limiting attacker control) and copies them with no maximum size and while dereferencing symlinks. A dragged symlink that points at, say, `~/.ssh/id_rsa` or a multi-GB file is copied wholesale into `.ai-manager/context/` and then listed/contents-referenced for every agent. The thumbnail path caps at 5 MB (`project-store.ts:369`) but the *copy* itself is uncapped. Destination filenames are safe (always `basename`-derived and collision-uniquified via `uniqueContextName`, `context-files.ts:16-25`), so there is no path-traversal on write.

**Why it matters** Low exploitability because the source is user-selected, but it is an easy footgun: a stray symlink balloons the project dir or silently feeds a private key into every agent's prompt (and Full-autonomy agents can then exfiltrate it). Worth a size cap and a symlink guard.

**Suggested fix** Add a per-file size cap and `fs.lstat`-then-reject (or refuse to dereference) symlinks in `addContextFiles`; surface skipped-for-size/symlink reasons in the returned `skipped` list.

---

### [Minor] Team-brain sync reads/writes arbitrary user-chosen paths with no extension/location guard

**Location** `src/main/ipc.ts:133-172` (`syncTeam`/`refreshTeam` use dialog-chosen paths) and `src/main/engine/project-store.ts:598-662` (`syncToTeam` writes JSON to `brainPath`; `refreshFromTeam`/`readTeamBrain` read it). The chosen path is then persisted as `graph.linkedTeam.path` (`project-store.ts:626`, `:649`) and re-used by best-effort auto-sync (`autoPushToTeam`/`autoPullFromTeam`, `:666-688`).

**What's wrong** The brain path comes from a save/open dialog (so the initial choice is the user's), but it is stored and then auto-written to on every run when `autoSyncTeam` is on, with no validation that it is still a `.json` team file, still exists, or still resides where the user expects. `syncToTeam` will create/overwrite whatever path was linked. There is no guard against the linked path having been redirected (e.g. a moved/symlinked file) between runs.

**Why it matters** Low severity (user picks the original path; auto-sync is off by default), but a persisted-then-auto-overwritten arbitrary path is a footgun: a relocated or symlinked brain file could cause silent overwrite of an unintended file on each finished run.

**Suggested fix** Re-validate the linked path on each auto-sync (exists, is a regular file, `.json`, parses as a valid bundle) and skip + surface a notice if it fails, rather than blindly writing.

---

### [Minor] `slugify`/`uniqueSlug` correctly block traversal, but imported `memberId` is used unsanitized as an edge/dedup key

**Location** `src/shared/slug.ts:4-19` (safe: strips to `[a-z0-9-]`, used for all on-disk agent dir names in `project-store.ts:715`, `:772`); imported `memberId` used as a map/edge key at `project-store.ts:710-737` and `team-brain.ts:31-48`.

**What's wrong** The filesystem-facing identifier (slug) is properly sanitized, so there is no path traversal via member/agent names on import or spawn — good. The residual nit is that the bundle's `memberId` (arbitrary string, only type-checked) flows into `idByMember`/edge construction and into `mergeBrainPush` dedup. A crafted bundle with duplicate or colliding `memberId`s can mis-wire imported edges or cause brain-merge members to collapse/overwrite each other (`mergeBrainPush` keys members by `memberId` at `team-brain.ts:31`). This is data-integrity weirdness, not code execution or traversal.

**Why it matters** Minor: at worst an imported team has wrong reporting edges or a merged brain drops a member. No security boundary is crossed, but it is unvalidated untrusted input shaping graph structure.

**Suggested fix** Validate `memberId` uniqueness within an imported bundle (reject or de-duplicate on import) and treat unknown edge endpoints as already handled (they are filtered in `setEdges`, but importTeam pushes edges directly at `project-store.ts:733-737`).

---

## Verification

Adversarial re-check of each finding against the cited code (read-only). Verdicts:

- **d3-trust-data-hitl-1 — confirmed.** `skill-trust.ts:12` `(p.marketplaceRepo ?? '').toLowerCase().startsWith('anthropics/')` returns trusted, and `marketplaceRepo` is sourced from the *marketplace's* repo string (`skill-trust.ts:41` `markets[marketplace]?.source?.repo`), not the individual plugin author — so every plugin in an `anthropics/*`-repo marketplace is trusted regardless of `author`/`uniqueInstalls`. `agent-runner.ts:125-130` then feeds the trusted plugin path into `options.plugins`, which the SDK loads as a full local plugin (only `skipMcpDiscovery:true` at `skill-trust.ts:17` suppresses MCP, not hooks/commands). Real Critical trust-boundary gap.

- **d3-trust-data-hitl-2 — confirmed.** `nodes.ts:248` sends `answerResumePrompt(answer)` which embeds the raw answer verbatim (`nodes.ts:962-964`), and the SDK persists the resumed session to an on-disk `{sessionId}.jsonl` transcript (sdk.d.ts deleteSession doc confirms the local `{sessionId}.jsonl` file). Additionally `nodes.ts:260,262` write the agent's `out` into `t.output` / `steps[].output`, which `run-state.ts:23` projects into `RunRecord.steps` — so an echoed answer reaches History. The app's own scrub (`nodes.ts:235` resumeInput/pendingAsk; userRequests stores only the question) is real but does not cover these two disk paths. Memory's "answer never hits disk" claim is false. Critical confirmed.

- **d3-trust-data-hitl-3 — confirmed.** `validateTeamBundle` (`team-bundle.ts:84-100`) checks only `kind`/`version`/members-array and per-member `memberId`/`name`/`kind` strings; it never validates `permissionMode`, `model`, `role`, or `lessons`. `planTeamImport` (`team-bundle.ts:124-141`) copies `m.permissionMode`/`m.role` straight through, `importTeam` (`project-store.ts:717,726`) writes role.md and sets `node.permissionMode` verbatim, and `agent-runner.ts:111` uses `agent.permissionMode` as the SDK permission mode for the manual Run button. So an imported bundle can set `bypassPermissions` and inject authoritative role prose. Important confirmed.

- **d3-trust-data-hitl-4 — confirmed.** `actingModeFor` (`nodes.ts:62-64`) maps `full→bypassPermissions`; `agent-runner.ts:107-114` sets `options` with only `cwd: projectPath` and no `additionalDirectories`/`sandbox`, so cwd is not an enforced boundary. Verified `additionalDirectories`/`sandbox` exist in the SDK (sdk.d.ts:1245,1770) but are never set in src. `allowDangerouslySkipPermissions` is documented as required for bypass (sdk.d.ts:1648,1664) and is not set in agent-runner. (Note: the `sandbox:false` at index.ts:19 is the Electron BrowserWindow webPreferences, unrelated to the agent SDK.) Important confirmed.

- **d3-trust-data-hitl-5 — confirmed.** `skill-trust.ts:12` is a bare `startsWith('anthropics/')` on a free-form repo string with no host/owner verification (a repo like `anthropics/x` from any host string would match). `skill-discovery.ts:43-47` reads both `known_marketplaces.json` and `plugin-catalog-cache.json` from the local writable `~/.claude/plugins` dir; `uniqueInstalls` flows from that cache (`skill-trust.ts:44`). Both inputs are locally forgeable. Important confirmed.

- **d3-trust-data-hitl-6 — confirmed.** `project-store.ts:327` uses `fs.stat(src)` (follows symlinks) and `:330` `fs.copyFile` with no size cap; destination name is `basename`-derived + uniquified (`context-files.ts:16-25`) so no write traversal. A dragged symlink-to-secret or huge file is copied into `.ai-manager/context/` and listed to every agent via `buildContextBlock` (`context-files.ts:28-40`). Minor confirmed.

- **d3-trust-data-hitl-7 — confirmed.** `ipc.ts:133-148` persists the dialog-chosen path into `linkedTeam`; `autoPushToTeam` (`project-store.ts:680-688`) calls `syncToTeam(link.path,...)` which unconditionally `fs.writeFile(brainPath, ...)` (`project-store.ts:625`) on every finished run when `autoSyncTeam` is on, with no re-check that the path still exists / is a regular .json / wasn't relocated or symlinked. Silent-overwrite footgun. Minor confirmed.

- **d3-trust-data-hitl-8 — confirmed.** On-disk agent dir names are safely slugified (`slug.ts:4-12`, no traversal). But the bundle's `memberId` is used unvalidated for uniqueness: `importTeam` builds `idByMember` (`project-store.ts:711`) and remaps edges by it (`:733-736`), and `mergeBrainPush` dedups members by `memberId` (`team-brain.ts:31-39`) — so colliding/duplicate memberIds can mis-wire edges or collapse merged brain members. Data-integrity nit, no boundary crossed. Minor confirmed.
