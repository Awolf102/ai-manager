# Dimension 2 — Code correctness (shared pure logic)

Static correctness review of every module under `src/shared/`. I read each file in full,
cross-checked the engine/renderer call sites that consume these pure functions, and reproduced
each suspected bug with a standalone Node script using the exact code (clamp rounding, fence regexes,
`mergeReplan` id collision, `deriveOrderDeps` self-dep, `validateTeamBundle` gaps, etc.). Findings are
ordered Critical → Important → Minor. Every finding cites real file:line and a concrete bad input.

---

### [Critical] `mergeReplan` overwrites a frozen task's state (data loss) and produces a duplicate plan id when a revised task reuses an existing id

**Location** `src/shared/replan.ts:53-66` (the `next[rt.id] = …` loop and `frozenInOrder`/`newTasks` concat).

**What's wrong** `mergeReplan` freezes every task NOT in `replace`, then writes the decision's revised
tasks into `next` keyed by `rt.id`. There is no guard that a revised `rt.id` is distinct from a frozen
id. If the orchestrator's re-plan JSON emits a task whose `id` collides with a frozen (already-passed)
task, `next[rt.id] = { …status:'pending', attempts:0, output:'' }` silently clobbers the frozen
`TaskState` — losing its `ownerId`, `passed` status, `output`, and verdict. Reproduced: a frozen
`t1` (status `passed`, `output:"important result"`) became `{status:'pending', output:''}` after a
decision reused id `t1`. Worse, `plan` is rebuilt as `[...frozenInOrder, ...newTasks]` where
`frozenInOrder` still contains `t1` (it's in `frozen`) AND `newTasks` contains `t1` — so the rebuilt
plan lists `t1` **twice** (verified: `plan.filter(p=>p.id==='t1').length === 2`). The duplicate id then
corrupts every downstream lookup keyed by id (dep resolution, run-view rows, synthesis).

**Why it matters** The replan decision comes from a model (`applyReplanDecision` at nodes.ts:553-568
feeds untrusted orchestrator output straight into `mergeReplan`). A model re-using a short id like `t1`
or `task-1` is entirely plausible. The result is silent loss of completed work plus a duplicated plan
entry — exactly the "run-corrupting / silent wrong behavior" class. Gated by `maxReplans>0`, but that is
the whole point of the escalation/replan feature.

**Suggested fix** Reject or remap any `rt.id` that already exists in `frozen` (e.g. namespace revised
ids, or skip-with-warning on collision), and de-dup the rebuilt `plan` by id.

---

### [Important] `clampEffort` silently disables itself for any model id not exactly one of the three hardcoded keys

**Location** `src/shared/model-caps.ts:7-32` (the `MODEL_EFFORT_CAPS` literal + `if (caps === undefined) return effort`).

**What's wrong** Caps are looked up by exact-string key. `clampEffort` returns the requested effort
**unchanged** for any model whose id is not literally `claude-opus-4-8` / `claude-sonnet-4-6` /
`claude-haiku-4-5` (the `caps === undefined` branch is documented as "unknown model -> requested
unchanged"). Verified: `claude-sonnet-4-6[1m]`, `us.anthropic.claude-sonnet-4-6-v1:0`, and a future
`claude-sonnet-4-5`/`-4-7` all fall through to passthrough — the XHIGH-on-Sonnet clamp that this whole
feature exists to enforce is silently off. The running model id seen elsewhere in this environment is
`claude-opus-4-8[1m]` (a `[1m]` suffix), which would NOT match the key.

**Why it matters** This is the exact mismatch the feature shipped to fix (per MEMORY: "Fixes the
XHIGH-on-Sonnet badge mismatch"). Today the renderer dropdown is bound to `MODELS` so the stored id
matches by luck, but any region-prefixed id, a `[1m]` variant, a model bump, or an imported team bundle
carrying an older/aliased `model` string re-introduces the bug with no error — a worker on a Sonnet
variant would be sent `effort: 'xhigh'` again.

**Suggested fix** Match on a normalized model family (strip region prefixes / bracket suffixes, or map a
small set of known aliases) before the caps lookup, and prefer a conservative default cap for genuinely
unknown ids rather than full passthrough.

---

### [Important] `deriveOrderDeps` emits a self-dependency when one worker is shared across two ordered top-level teams

**Location** `src/shared/workflow-order.ts:50-61` (`teamTasks` built from `subtreeOf`, then `out[id] = earlier`).

**What's wrong** Teams are top-level orchestrator edges; `teamTasks[k]` is every task whose owner is in
team k's subtree. The reporting graph is treated as a tree but is actually a DAG — a worker can report
to two managers, and both managers can be ordered top-level teams. When a task's owner sits in BOTH an
earlier ordered team and the current team, `out[id] = [...earlier]` includes that same task's id.
Reproduced with `orch→A(order1)`, `orch→B(order2)`, `A→W`, `B→W`, task `t1` owned by `W`:
`deriveOrderDeps` returns `{ t1: ["t1"] }` — `t1` depends on itself.

**Why it matters** A self-dependency makes `depsSatisfied(t1)` permanently false. The wave loop's cycle
guard (`nodes.ts:349-353`, "if nothing is ready, run the rest anyway") masks the hang, but the task then
runs out of its intended order — silently defeating the Phase-1 ordering the user clicked. It also feeds
into `dependsOn` written onto the task (nodes.ts:158-162). A shared worker across ordered teams is a
realistic canvas topology.

**Suggested fix** Filter `id` out of its own dependency list (`earlier.filter(e => e !== id)`), and
generally drop any dep that points to a task in the same team k.

---

### [Important] `validateTeamBundle` accepts members missing `position`/`model`/`role`/`permissionMode`, then `planTeamImport`/`buildTeamBundle` crash dereferencing them

**Location** `src/shared/team-bundle.ts:84-100` (validation only checks `memberId`/`name`/`kind` are
strings) vs `src/shared/team-bundle.ts:124-141` (`planTeamImport` reads `m.position.x`, `m.model`,
`m.permissionMode`, `m.role`, `m.lessons` unconditionally).

**What's wrong** `validateTeamBundle` returns `{ ok: true }` for a member object that has only
`memberId`/`name`/`kind`. `planTeamImport` then does `m.position.x + POSITION_OFFSET`. Reproduced: a
bundle `{kind, version:1, members:[{memberId:'m1', name:'A', kind:'worker'}], edges:[]}` passes
validation, then `m.position.x` throws `Cannot read properties of undefined (reading 'x')`. `m.lessons`
(read by `buildSeededMemory`) and `m.model` are likewise unvalidated.

**Why it matters** Team bundles are explicitly untrusted JSON read from disk ("Validate untrusted JSON
read from disk", line 83). A hand-edited or older-format bundle that omits `position`/`lessons` passes the
validator and then throws an uncaught `TypeError` during import — a validator that doesn't actually
protect its consumer. (See also the d3 injection audit for the trust angle.)

**Suggested fix** Validate that each member has `position:{x:number,y:number}`, `model:string`,
`permissionMode:string`, `role:string`, and `lessons:string[]` (or default-fill them in `planTeamImport`),
so a malformed-but-plausible bundle is rejected cleanly instead of crashing.

---

### [Important] `ask`/`handoff` fence regexes over-match labels like ` ```asking ` / ` ```handofffoo `

**Location** `src/shared/ask-user.ts:24` (`/```ask[^\n]*\r?\n.../`) and `src/shared/handoff.ts:36`
(`/```handoff[^\n]*\r?\n.../`).

**What's wrong** The fence-language matcher is `` ```ask `` / `` ```handoff `` followed by `[^\n]*` — it
does not require a word boundary, so any fence whose info-string merely *starts* with `ask`/`handoff`
matches. Reproduced: `` ```asking `` and `` ```askew `` both match the ask regex; `` ```handofffoo ``
matches the handoff regex. A worker writing a fenced block labeled ` ```asking-for-help` or a JS sample
in a ` ```handofffunction` block (or a doc that uses these as code-fence languages) is parsed as a real
ask/handoff request.

**Why it matters** A spurious match drives real control flow: `parseAskUser` returning non-null pauses
the whole run for human input (HITL, gated by `maxUserRequests>0`), and `parseHandoff` dispatches a peer
agent run (gated by `maxHandoffs>0`). A false positive from incidental prose/code is a wrong, costly
side effect — and a false *negative* is impossible to distinguish here, so the worker's intent is
silently mis-read.

**Suggested fix** Anchor the language token: `` /```ask(?:[ \t]*\r?\n|[ \t][^\n]*\r?\n)/ `` (require the
token to be followed by whitespace/newline, not more word characters), same for `handoff`.

---

### [Minor] `mergeBrainPush` unions lessons with no cap, so the team brain grows unbounded

**Location** `src/shared/team-brain.ts:14-24` (`unionLessons`) called from `mergeBrainPush:34`.

**What's wrong** `mergeLessons` (the pull side into an agent's memory.md) caps at 40
(`team-brain.ts:95`), but `unionLessons` used by the push side has no cap. Each push appends every new
distinct project lesson to the brain member's array forever. Reproduced: 100 distinct lessons → brain
array length 100. Over many runs a brain member's `lessons` grows without bound, and that whole array is
later handed to `mergeLessons` / `lessonsDigest` on every pull.

**Why it matters** Not a crash, but the team brain is the durable accumulator ("living team"); unbounded
growth bloats the on-disk bundle and the routing prompt over a project's lifetime. The 40-cap on the
read side is silently undermined.

**Suggested fix** Cap `unionLessons` (or the brain member's `lessons` after merge) to a sane maximum
(e.g. the same 40, newest-first) in `mergeBrainPush`.

---

### [Minor] RunView "capped from X" tooltip can show a *lower* effort than the displayed effort

**Location** `src/shared/effort.ts:12-30` (`effortOfWorker` returns max post-clamp `effort`,
`cappedFrom` returns max pre-clamp `assignedEffort`), consumed at `src/renderer/run/RunView.tsx:152-154`.

**What's wrong** A worker's badge shows `eff` = highest `effort` across its tasks and `capped` = highest
`assignedEffort` across its tasks — but these can come from **different** tasks. Reproduced on a Sonnet
worker: task A requested `max` → `effort:'max'`, no cap (no `assignedEffort`); task B requested `xhigh` →
clamped to `effort:'max'`, `assignedEffort:'xhigh'`. `effortOfWorker` = `max`, `cappedFrom` = `xhigh`, so
the tooltip reads "effort max (capped from xhigh)" — nonsensically claiming the effort was reduced from a
*lower* level (`xhigh` < `max`).

**Why it matters** Pure cosmetic/trust nit, but it surfaces in the UI as misleading provenance for the
effort the worker ran at — the exact thing the cap-badge feature exists to communicate.

**Suggested fix** Only show "capped from X" when `cappedFrom > effortOfWorker`, or compute the badge per
the single highest-effort task rather than mixing two independent maxima.

---

### [Minor] `narrate` `basename` returns the whole path for a directory-style path ending in a separator

**Location** `src/shared/narrate.ts:58-62` (`basename`: `parts[parts.length-1] || p`).

**What's wrong** For a path ending in `/` (or `\`), the last split segment is empty, so `|| p` returns
the **entire** path. Reproduced: `basename("/a/b/c/")` → `"/a/b/c/"`. A `Read`/`Write` on a
directory-like target would narrate "Reading /very/long/abs/path/" instead of a clean tail.

**Why it matters** Narration is plain-English/cosmetic, so impact is small, but it leaks a long absolute
path into the activity feed instead of a name. The `host()` fallback (line 65-68) has a similar shape:
a scheme-less URL like `example.com/page` returns the whole string, and `https://user:pass@host/` keeps
the userinfo — minor display leakage.

**Suggested fix** Drop trailing separators before taking the last segment
(`p.replace(/[\\/]+$/,'').split(/[\\/]/).pop()`), and strip any `userinfo@` from `host()`.

---

### [Minor] `effortByTask` relies on object insertion order to make "deepest router wins", not on depth

**Location** `src/shared/effort.ts:37-45`, consumed by `src/renderer/run/HistoryView.tsx:77` over
`record.steps` (which is `Object.values(RunState.steps)`, see `run-state.ts:23`).

**What's wrong** The doc claims "a deeper router's assignment overwrites a shallower one — the effort the
task ran at wins." The implementation is purely last-write-wins over `steps` array order, with no notion
of depth. Reproduced: with steps `[{t1:max}, {t1:low}]`, result is `{t1:'low'}` regardless of which
router is deeper. Correctness depends on `RunState.steps` being inserted parent-before-child (it is today,
because routing inserts top-down), so it happens to work — but it's an implicit, fragile coupling.

**Why it matters** If step insertion order ever changes (e.g. a future parallel-routing change, or a
re-insert under an existing key during repair), History would show the wrong per-task effort with no
error. Low likelihood today, hence Minor.

**Suggested fix** Carry the routing depth on the step/assignment and pick max-depth explicitly, or
document the insertion-order invariant at the function so a refactor doesn't break it silently.

---

### [Minor] `uniqueContextName` produces an awkward (but safe) name for dotfiles and multi-dot names

**Location** `src/shared/context-files.ts:16-25` (split on `lastIndexOf('.')`).

**What's wrong** For a leading-dot name the stem becomes empty: `uniqueContextName(['.env'], '.env')` →
`"-2.env"`. For multi-dot names only the last dot is the boundary: `'a.tar.gz'` → `'a.tar-2.gz'`. Both
are filesystem-safe and collision-free, just ugly. (Not a data-loss path — the original is preserved when
not taken.)

**Why it matters** Purely cosmetic for context-file storage names; included for completeness since the
assignment asks for collision/edge-case coverage here.

**Suggested fix** For a leading-dot name, treat the whole thing as the stem (no extension split);
optional, low priority.

## Verification

Adversarial re-check. Each finding's cited code was re-opened and the consuming call sites
in `src/main/engine/nodes.ts` / `src/renderer/run/RunView.tsx` / `project-store.ts` traced.

- **d2-shared-modules-1 — CONFIRMED (Critical).** `mergeReplan` (replan.ts:53-66): line 53 builds
  `next` from `frozen`, then line 55 `next[rt.id] = {fresh pending}` unconditionally overwrites a
  frozen TaskState when a decision id collides with a non-replaced id; line 64 `frozenInOrder` still
  includes that id AND line 65 `newTasks` re-adds it → the id appears twice in the rebuilt plan and
  the frozen ownerId/status/output are lost. Reachability is real: the replan path
  (nodes.ts:585,593 with idPrefix `t`) shows the LLM the executed tasks and lets it emit revised
  tasks with ids like `t1`/`t2` that collide with frozen executed tasks; `mergeReplan` does no
  namespacing or de-collision. Run-state corruption → Critical stands.

- **d2-shared-modules-2 — ADJUSTED to Minor.** model-caps.ts:25 (`if (caps === undefined) return effort`)
  is exactly as described. But `clampEffort` is only ever called via `effortForModel` (nodes.ts:1135)
  with `model = getAgent(childId).model` (nodes.ts:743), and the node `model` field is constrained to
  the 3 fixed dropdown ids (types.ts:425-427 MODEL_OPTIONS). A region-prefixed / `[1m]`-suffixed /
  future id is not reachable through the app's own model selection today, so this does not bite under
  realistic current use — it is forward-looking robustness, not an active Important bug. Downgraded.

- **d2-shared-modules-3 — CONFIRMED (Important).** `deriveOrderDeps` (workflow-order.ts:50-61): when a
  worker's owner node is in two ordered top-level subtrees, its task id appears in two `teamTasks`
  buckets, so for the later team `earlier` (line 57) contains that id and line 59 sets
  `out[id] = [...earlier]` including itself → self-dependency. Critically, the self-dep filter
  `x !== id` (nodes.ts:701) is ONLY in the LLM plan-parsing path; the `deriveOrderDeps` output is
  merged into `t.dependsOn` at nodes.ts:158-161 with NO such filter, so the self-dep survives into
  `depsSatisfied` (nodes.ts:1078-1079, never true) and is masked only by the wave-loop cycle guard
  (nodes.ts:349-350), silently defeating Phase-1 ordering. Requires a non-tree (DAG) report graph,
  which the canvas permits. Silently-wrong ordering → Important stands.

- **d2-shared-modules-4 — CONFIRMED (Important).** `validateTeamBundle` (team-bundle.ts:92-97) only
  checks memberId/name/kind are strings; `planTeamImport` reads `m.position.x` (line 135),
  `m.model`/`m.permissionMode`/`m.role`, and `buildSeededMemory(m.name, m.lessons)` (line 137, which
  does `lessons.length`) unconditionally. A validated-but-incomplete bundle (missing position or
  lessons) throws TypeError. The path is reachable with untrusted JSON: ipc.ts:126/168 →
  `importTeam` (project-store.ts:708-710) → `planTeamImport`. Confirmed.

- **d2-shared-modules-5 — ADJUSTED to Minor.** ask-user.ts:24 `/```ask[^\n]*\r?\n.../` and
  handoff.ts:36 `/```handoff[^\n]*.../` both lack a word boundary after the label, so ` ```asking `
  / ` ```handofffoo ` match — the `[^\n]*` (meant for an info-string) over-matches. Real, but
  triggering a false ask/handoff also requires the fence body to be valid JSON carrying the required
  field (`question`, or `to`/`ask`); an agent would not emit that incidentally under a typo'd label,
  so realistic impact is low. Downgraded from Important to Minor.

- **d2-shared-modules-6 — CONFIRMED (Minor).** team-brain.ts:14-24 `unionLessons` (push side) has no
  cap; the pull-side `mergeLessons` caps at 40 (team-brain.ts:95). Brain member lessons grow unbounded
  across syncs. Confirmed Minor.

- **d2-shared-modules-7 — CONFIRMED (Minor).** effort.ts:12-30: `effortOfWorker` returns max post-clamp
  `a.effort`; `cappedFrom` returns max `a.assignedEffort` (pre-clamp); they scan the worker's
  assignments independently, so the two maxima can come from different tasks. RunView.tsx:153 renders
  `effort ${eff} (capped from ${capped})`, which can read e.g. "max (capped from xhigh)" — a cap from
  a lower level than displayed. Confirmed Minor.

- **d2-shared-modules-8 — CONFIRMED (Minor).** narrate.ts:58-62 `basename`: for `/a/b/c/`,
  `split(/[\\/]/)` ends in `''`, so `parts[last] || p` returns the whole path. `host` (lines 64-68):
  regex captures `[^/]+` so `user:pass@host` keeps userinfo, and a scheme-less URL falls back to the
  whole input. Cosmetic activity-feed leakage. Confirmed Minor.

- **d2-shared-modules-9 — CONFIRMED (Minor).** effort.ts:37-45 `effortByTask` is last-write-wins over
  `Object.values(steps)` order; correctness depends on the documented (lines 35-36) parent-before-child
  insertion invariant, which a routing refactor could break silently. Real fragility, Minor.

- **d2-shared-modules-10 — CONFIRMED (Minor).** context-files.ts:16-25: `.env` → stem `''`/ext `.env`
  → `-2.env`; `a.tar.gz` → stem `a.tar`/ext `.gz` → `a.tar-2.gz`. Safe and collision-free, just ugly.
  Confirmed Minor.
