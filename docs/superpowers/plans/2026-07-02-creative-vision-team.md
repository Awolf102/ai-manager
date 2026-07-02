# Creative-Vision Team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `visionMode` toggle that biases team-building and reframes worker/QA execution prompts toward creative/design work, a one-click curated "Creative Vision" starter team, and a lightweight creative output preview (inline iframe + image gallery).

**Architecture:** `visionMode` is a `ProjectSettings` boolean threaded as a `vision` flag into the same prompt builders `largeTeamMode` already uses (`spawnTeamPrompt`/`draftRolesPrompt`/`planPrompt`), plus `workerPrompt` + `roleTemplate` — every gated clause is empty/identical when off. A pure `team-vision.ts` module holds the archetype roster (`VISION_TEAM`) and the shared prompt clause (`visionBias()`); the preset builds `VISION_TEAM` through the shipped `briefTeamToSpawnedMembers` → `TeamSpawnModal` → `applySpawnedTeam` path. The preview reuses `manifest-detector`/`launchServer` (iframe) and a new bounded `listOutputImages` scan (gallery, mirroring `contextThumbnail`).

**Tech Stack:** Electron (main/preload/renderer, CJS main), React 19 + TypeScript, zustand, lucide-react, Vitest. Spec: `docs/superpowers/specs/2026-07-02-creative-vision-team-design.md`.

## Global Constraints

- **Byte-for-byte invariant:** `visionMode` OFF ⇒ identical `spawnTeamPrompt`/`draftRolesPrompt`/`planPrompt`/`workerPrompt` (light AND non-light) / `roleTemplate` (all kinds) strings, identical scaffolded role.md, and no run-behavior change. Every `vision` param defaults `false`; every gated clause interpolates to `''` or the current literal so the off-path is character-identical.
- **One source of truth for archetype names:** the creative role names live only in `team-vision.ts` (`VISION_TEAM` + `visionBias()`); prompts and the preset both consume it.
- **Reuse existing patterns:** the preset reuses `briefTeamToSpawnedMembers` (`shared/advisor.ts`) + `TeamSpawnModal`; the gallery mirrors `contextThumbnail`'s data-URL approach (5MB/svg guards); no new engine graph node.
- **Model ids:** Opus 4.8 = `claude-opus-4-8`, Sonnet 4.6 = `claude-sonnet-4-6`.
- **Integration gates:** `npm run typecheck` + `npm run test` before each commit; renderer-touching tasks also `npm run lint`; controller runs `npm run build` at the end. Renderer interactions need the user's on-device smoke (App.tsx isn't rendered in tests) — flagged per task.

---

### Task 1: `visionMode` setting + pure `team-vision.ts` (roster + bias clause)

**Files:**
- Create: `src/shared/team-vision.ts`
- Create: `src/shared/team-vision.test.ts`
- Modify: `src/shared/types.ts` (`ProjectSettings` after `bulkCreateMax`; `DEFAULT_SETTINGS`)
- Modify: `src/renderer/SettingsModal.tsx` (a "Creative Vision" `SettingSection` next to "Large Team")
- Modify: any test fixture that builds a full `ProjectSettings` literal (typecheck will flag them — see Step 4): add `visionMode: false`. Known ones: `src/main/engine/nodes.test.ts` (the `h.settings` fixture), `src/main/engine/team-spawner.test.ts`, `src/main/engine/role-drafter.test.ts`.

**Interfaces:**
- Produces: `visionMode: boolean` setting (default `false`); `VISION_TEAM: AdvisorBriefTeamMember[]` (7 members); `visionBias(): string`.

- [ ] **Step 1: Write the failing test** — create `src/shared/team-vision.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { VISION_TEAM, visionBias } from './team-vision'
import { briefTeamToSpawnedMembers } from './advisor'

describe('team-vision', () => {
  it('visionBias names the creative orientation', () => {
    const b = visionBias()
    expect(b).toMatch(/creative|design/i)
    expect(b.length).toBeGreaterThan(40)
  })
  it('VISION_TEAM is a 7-member creative agency under one Creative Director', () => {
    expect(VISION_TEAM).toHaveLength(7)
    const lead = VISION_TEAM.find((m) => m.kind === 'manager')
    expect(lead?.name).toBe('Creative Director')
    // every worker reports to the Creative Director; the lead reports to orchestrator
    const workers = VISION_TEAM.filter((m) => m.kind === 'worker')
    expect(workers).toHaveLength(6)
    expect(workers.every((w) => w.reportsTo === 'Creative Director')).toBe(true)
    expect(lead?.reportsTo).toBe('orchestrator')
  })
  it('maps cleanly to SpawnedMember[] with reportsTo resolving', () => {
    const members = briefTeamToSpawnedMembers(VISION_TEAM)
    expect(members).toHaveLength(7)
    const lead = members.find((m) => m.name === 'Creative Director')!
    expect(lead.reportsTo).toBe('orchestrator')
    // a worker resolves to the lead's temp id
    const worker = members.find((m) => m.name === 'Copywriter')!
    expect(worker.reportsTo).toBe(lead.id)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/team-vision.test.ts`
Expected: FAIL — `./team-vision` does not exist.

- [ ] **Step 3: Implement** — create `src/shared/team-vision.ts`:

```ts
// Pure creative-team preset + prompt-bias clause. No node/DOM imports.
import type { AdvisorBriefTeamMember } from './advisor'

/** The creative-orientation clause injected into team-building prompts when visionMode is on.
 *  Single source of the archetype names (shared with VISION_TEAM below). */
export function visionBias(): string {
  return `\n- This is a CREATIVE / DESIGN project, not software engineering. Favor design, brand, UX, and copy craft over code. Think in terms of a creative team (creative director, brand strategist, art director, visual designer, UX/product designer, copywriter, content strategist) and design deliverables — brand direction, UX flows, wireframes, visual comps, and copy — rather than code modules.`
}

const role = (title: string, specialty: string, responsibilities: string): string =>
  `# Role: ${title}\n\n## Specialty\n${specialty}\n\n## Responsibilities\n${responsibilities}\n\n## How you work\n- Ground every decision in the creative brief and the audience; make the intent legible.\n- Show your thinking as concrete artifacts (references, options, rationale), not just prose.\n\n## Constraints\n- You operate inside this one project folder.`

/** The curated "Creative Vision" starter team: a Creative Director (manager) + six creative workers. */
export const VISION_TEAM: AdvisorBriefTeamMember[] = [
  {
    name: 'Creative Director',
    kind: 'manager',
    reportsTo: 'orchestrator',
    role: role('Creative Director (Manager)', 'Sets and guards the creative vision for the project.', '- Set the creative direction and the bar for craft.\n- Review the team’s output for vision coherence, brand fit, and typographic and visual quality; give specific, actionable feedback.\n- Integrate the pieces into one coherent deliverable and report up.')
  },
  {
    name: 'Brand Strategist',
    kind: 'worker',
    reportsTo: 'Creative Director',
    role: role('Brand Strategist (Worker)', 'Brand positioning, voice, and messaging strategy.', '- Define positioning, brand personality, and voice.\n- Produce messaging pillars and tone guidance the rest of the team designs against.')
  },
  {
    name: 'Art Director',
    kind: 'worker',
    reportsTo: 'Creative Director',
    role: role('Art Director (Worker)', 'Overall visual concept and art direction.', '- Establish the visual concept, mood, and art direction.\n- Direct color, imagery, and composition language for the visual designer to execute.')
  },
  {
    name: 'Visual Designer',
    kind: 'worker',
    reportsTo: 'Creative Director',
    role: role('Visual Designer (Worker)', 'Layout, color, typography, and visual comps.', '- Execute the art direction as concrete layouts and comps.\n- Own typography, spacing, color application, and visual polish.')
  },
  {
    name: 'UX / Product Designer',
    kind: 'worker',
    reportsTo: 'Creative Director',
    role: role('UX / Product Designer (Worker)', 'User flows, wireframes, and interaction design.', '- Map user flows and information architecture.\n- Produce wireframes and interaction specs that balance usability with the creative vision.')
  },
  {
    name: 'Copywriter',
    kind: 'worker',
    reportsTo: 'Creative Director',
    role: role('Copywriter (Worker)', 'Copy, naming, and microcopy.', '- Write headlines, body copy, naming, and microcopy in the brand voice.\n- Make every word earn its place and read as intended for the audience.')
  },
  {
    name: 'Content Strategist',
    kind: 'worker',
    reportsTo: 'Creative Director',
    role: role('Content Strategist (Worker)', 'Content structure, information architecture, and editorial.', '- Define content structure, hierarchy, and editorial guidelines.\n- Ensure content is coherent, findable, and on-message across the deliverable.')
  }
]
```

Then in `src/shared/types.ts`, add to `ProjectSettings` (after `bulkCreateMax`):
```ts
  /** treat the project as a creative/design project: biases team-building + reframes worker/QA prompts toward creative fidelity (off = byte-for-byte) */
  visionMode: boolean
```
and to `DEFAULT_SETTINGS` (after `bulkCreateMax: 25`):
```ts
  visionMode: false
```

In `src/renderer/SettingsModal.tsx`, add a new `SettingSection` immediately after the closing `</SettingSection>` of the "Large Team" section (mirror its `<Switch>` pattern):
```tsx
              <SettingSection title="Creative Vision">
                <SettingRow
                  label="Vision mode"
                  desc="Treat this as a creative/design project: Build-team and Draft-roles propose design roles, planning frames work as design deliverables, and workers evaluate craft and brand fidelity instead of HTTP-200s. Off = unchanged."
                  control={
                    <Switch
                      checked={s.visionMode}
                      label="Vision mode"
                      onChange={(v) => void update({ visionMode: v })}
                    />
                  }
                />
              </SettingSection>
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `npx vitest run src/shared/team-vision.test.ts && npm run typecheck && npm run lint`
Expected: initially typecheck FAILS on any `ProjectSettings` object literal now missing `visionMode` — these are test fixtures (at least `nodes.test.ts` `h.settings`, `team-spawner.test.ts`, `role-drafter.test.ts`). Add `visionMode: false` to each, then re-run until typecheck is clean and the vitest + lint pass. (Fixtures that spread `DEFAULT_SETTINGS` need no change.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/team-vision.ts src/shared/team-vision.test.ts src/shared/types.ts src/renderer/SettingsModal.tsx
git commit -m "feat(vision): visionMode setting + pure team-vision module (VISION_TEAM + visionBias)"
```

> **On-device smoke (defer):** Settings → Creative Vision → the Vision mode toggle persists.

---

### Task 2: Team-building prompt bias (spawn / draft / plan)

Threads a `vision` flag into the three builders, mirroring `largeTeam`. Off = byte-for-byte.

**Files:**
- Modify: `src/shared/team-spawn.ts` (`spawnTeamPrompt` `:6`)
- Modify: `src/shared/role-draft.ts` (`draftRolesPrompt` `:12`)
- Modify: `src/main/engine/nodes.ts` (`planPrompt` `:1472`, `planStep` `:854`)
- Modify: `src/main/engine/team-spawner.ts` (`:31`), `src/main/engine/role-drafter.ts` (`:33`)
- Test: `src/shared/team-spawn.test.ts`, `src/shared/role-draft.test.ts`, `src/main/engine/nodes.test.ts`

**Interfaces:**
- Consumes: `visionBias()` (Task 1).
- Produces: `spawnTeamPrompt(goal, name, existing, offered?, assignModels?, largeTeam?, vision?)`; `draftRolesPrompt(goal, roster, edges, offered?, largeTeam?, vision?)`; `planPrompt(goal, largeTeam?, vision?)`.

- [ ] **Step 1: Write the failing tests** — add to `src/shared/team-spawn.test.ts`:

```ts
import { visionBias } from './team-vision'
describe('vision-aware spawn', () => {
  it('is byte-for-byte when vision off', () => {
    expect(spawnTeamPrompt('g', 'O', [])).toBe(spawnTeamPrompt('g', 'O', [], [], false, false, false))
    expect(spawnTeamPrompt('g', 'O', [])).not.toMatch(/CREATIVE \/ DESIGN/)
  })
  it('injects the vision bias when on', () => {
    const p = spawnTeamPrompt('g', 'O', [], [], false, false, true)
    expect(p).toContain(visionBias().trim())
  })
})
```
add to `src/shared/role-draft.test.ts`:
```ts
import { visionBias } from './team-vision'
describe('vision-aware draft', () => {
  it('is byte-for-byte when vision off', () => {
    const roster = [{ id: 'a', name: 'A', kind: 'worker' as const, role: 'r' }]
    expect(draftRolesPrompt('g', roster, [])).toBe(draftRolesPrompt('g', roster, [], [], false, false))
    expect(draftRolesPrompt('g', roster, [])).not.toMatch(/CREATIVE \/ DESIGN/)
  })
  it('injects the vision bias when on', () => {
    const roster = [{ id: 'a', name: 'A', kind: 'worker' as const, role: 'r' }]
    expect(draftRolesPrompt('g', roster, [], [], false, true)).toContain(visionBias().trim())
  })
})
```
add to `src/main/engine/nodes.test.ts` (extend the existing `planPrompt` describe):
```ts
  it('planPrompt is byte-for-byte when vision off, and frames deliverables when on', () => {
    expect(planPrompt('build X')).toBe(planPrompt('build X', false, false))
    expect(planPrompt('build X')).not.toMatch(/CREATIVE \/ DESIGN/)
    expect(planPrompt('build X', false, true)).toMatch(/design deliverables/i)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/team-spawn.test.ts src/shared/role-draft.test.ts src/main/engine/nodes.test.ts -t vision`
Expected: FAIL — the builders don't accept a `vision` arg / never inject the clause.

- [ ] **Step 3: Implement**

In `src/shared/team-spawn.ts`: add `import { visionBias } from './team-vision'` at the top; extend the signature and inject:
```ts
export function spawnTeamPrompt(
  goal: string,
  orchestratorName: string,
  existing: { name: string; kind: AgentKind; role: string }[],
  offered: { id: string; description: string }[] = [],
  assignModels = false,
  largeTeam = false,
  vision = false
): string {
```
Add `const visionRule = vision ? visionBias() : ''` near the other locals, and append `${visionRule}` immediately after `${directorRule}` on the "Create a domain manager…" rule line:
```ts
- Create a domain manager when a distinct area of work (a cluster of several related roles or subsystems) would benefit from dedicated review, testing, and accumulated QA expertise — not only when there are many workers. A manager owns reviewing and testing its area, so group several related roles under one QA-capable manager. A manager with a single worker is pure overhead — keep that flat (the worker reports directly to you).${directorRule}${visionRule}
```

In `src/shared/role-draft.ts`: add `import { visionBias } from './team-vision'`; extend the signature and inject:
```ts
export function draftRolesPrompt(
  goal: string,
  roster: DraftRosterAgent[],
  edges: { source: string; target: string }[],
  offered: { id: string; description: string }[] = [],
  largeTeam = false,
  vision = false
): string {
```
Add `const visionNote = vision ? visionBias() : ''` and append `${visionNote}` after `${topology}${skillsBlock}`:
```ts
REPORTING STRUCTURE (source delegates work down to target):
${topology}${skillsBlock}${visionNote}
```

In `src/main/engine/nodes.ts`, extend `planPrompt` (`:1472`):
```ts
export function planPrompt(goal: string, largeTeam = false, vision = false): string {
  const scale = largeTeam
    ? `\n\nThis is a LARGE team. Plan at a BROAD, PROGRAM level: produce a small number (~3–8) of high-level workstreams, each of which a director or manager can own and break down further with their own team. Prefer few broad tasks over many fine-grained ones.`
    : ''
  const visionScale = vision
    ? `\n\nThis is a CREATIVE / DESIGN project — plan design deliverables (brand direction, UX flows, wireframes, visual comps, copy, and content structure), not code modules.`
    : ''
  return `You are planning work to achieve the user's goal for this project. You may READ files to inform the plan, but do NOT make any changes.

GOAL:
${goal}${scale}${visionScale}

Produce a concise, ordered list of concrete tasks that together fully achieve the goal. Each task should be self-contained and suitable to hand to a single specialist. Prefer the smallest set of tasks that covers the goal.

A task may optionally declare "dependsOn": an array of the ids of tasks that MUST be finished before it can start (e.g. a frontend task that needs the backend API to exist first). Add a dependency ONLY when a task genuinely cannot begin until another is done — most tasks have none, so use [] or omit it. Never create a cycle.

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "tasks": [ { "id": "t1", "title": "short title", "description": "what to do, in enough detail for a specialist", "dependsOn": [] } ] }
\`\`\``
}
```
and update `planStep` (`:854`):
```ts
    planPrompt(goal, getSettings().largeTeamMode, getSettings().visionMode),
```

In `src/main/engine/team-spawner.ts` (`:31`) — add `s.visionMode` as the 7th arg:
```ts
  const base = spawnTeamPrompt(opts.goal, getAgent(opts.orchestratorId).name, agents, offered, s.autoAssignModels, s.largeTeamMode, s.visionMode)
```
In `src/main/engine/role-drafter.ts` (`:33`):
```ts
  const base = draftRolesPrompt(opts.goal, agents, edges, offered, s.largeTeamMode, s.visionMode)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/team-spawn.test.ts src/shared/role-draft.test.ts src/main/engine/nodes.test.ts src/main/engine/team-spawner.test.ts src/main/engine/role-drafter.test.ts && npm run typecheck`
Expected: PASS. (The settings-literal fixtures were given `visionMode: false` in Task 1, so `getSettings().visionMode` resolves to `false` and every off-path assertion holds.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/team-spawn.ts src/shared/team-spawn.test.ts src/shared/role-draft.ts src/shared/role-draft.test.ts src/main/engine/nodes.ts src/main/engine/nodes.test.ts src/main/engine/team-spawner.ts src/main/engine/role-drafter.ts
git commit -m "feat(vision): vision-aware Build-team + Draft-roles + planning (gated; off = byte-for-byte)"
```

---

### Task 3: Worker/QA execution reframe (`workerPrompt` + `roleTemplate`)

The highest-scrutiny piece: swaps software-QA wording for creative fidelity in visionMode. Off = byte-for-byte, including the `lightPrompts` variant.

**Files:**
- Modify: `src/main/engine/nodes.ts` (`workerPrompt` `:1538`, its call site `:384`)
- Modify: `src/main/engine/project-store.ts` (`roleTemplate` `:75`, `createAgent` `:284`)
- Test: `src/main/engine/nodes.test.ts`, `src/main/engine/project-store.test.ts`

**Interfaces:**
- Produces: `workerPrompt(goal, tasks, light?, vision?)`; `roleTemplate(name, kind, vision?)`.

- [ ] **Step 1: Write the failing tests** — add to `src/main/engine/nodes.test.ts` (import `workerPrompt` if not already imported):

```ts
describe('workerPrompt vision reframe', () => {
  it('non-light is byte-for-byte off, creative on', () => {
    expect(workerPrompt('g', [])).toBe(workerPrompt('g', [], false, false))
    expect(workerPrompt('g', [])).toContain('404s assets') // current software-QA wording preserved
    const v = workerPrompt('g', [], false, true)
    expect(v).not.toContain('404s assets')
    expect(v).toContain('visual hierarchy')
  })
  it('light is byte-for-byte off, creative on', () => {
    expect(workerPrompt('g', [], true)).toBe(workerPrompt('g', [], true, false))
    expect(workerPrompt('g', [], true)).toContain('return 200')
    expect(workerPrompt('g', [], true, true)).toContain('visual hierarchy')
  })
})
```
add to `src/main/engine/project-store.test.ts` (the existing `roleTemplate` describe):
```ts
  it('worker template is byte-for-byte off, creative on', () => {
    expect(roleTemplate('X', 'worker')).toBe(roleTemplate('X', 'worker', false))
    expect(roleTemplate('X', 'worker')).toContain('return 200')
    const v = roleTemplate('X', 'worker', true)
    expect(v).not.toContain('return 200')
    expect(v).toContain('creative intent')
  })
  it('manager template is byte-for-byte off, creative on', () => {
    expect(roleTemplate('X', 'manager')).toBe(roleTemplate('X', 'manager', false))
    expect(roleTemplate('X', 'manager', true)).toContain('creative review')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/engine/nodes.test.ts src/main/engine/project-store.test.ts -t vision`
Expected: FAIL — the functions don't accept a `vision` arg.

- [ ] **Step 3: Implement**

Replace `workerPrompt` in `src/main/engine/nodes.ts` (`:1538-1559`) with (the `vision=false` branches are byte-for-byte the current strings):
```ts
export function workerPrompt(goal: string, tasks: RunTask[], light = false, vision = false): string {
  const list = tasks.map((t, i) => `${i + 1}. ${t.title}\n   ${t.description}`).join('\n\n')
  if (light) {
    const qa = vision
      ? 'If your work is a design, brand, or copy deliverable, evaluate it against the creative intent — check visual hierarchy, brand and tonal consistency, and typographic craft — before reporting success.'
      : 'If your work serves web pages, actually run it and confirm the entry page AND every asset it references return 200 before reporting success.'
    return `Team goal: ${goal}

Complete the following task(s) in this project folder, making the necessary changes. Apply any relevant lessons from your memory.

${list}

${qa} When finished, briefly report what you changed and flag anything you could not complete.`
  }
  const qa = vision
    ? 'If your work is a design, brand, or copy deliverable, do not rely on "it looks right" — evaluate it against the creative intent: check visual hierarchy, brand and tonal consistency, typographic craft, and that it reads as intended for its audience. Don\'t report success until the deliverable holds together.'
    : 'If your work is a web app or anything that serves pages, do not rely on unit tests or "the code looks right" — actually run it and load the entry page: confirm it returns 200 AND every asset it references (CSS, JS, images) also returns 200. A static-path or route mismatch that 404s assets makes the page render as unstyled, broken HTML even when your code is correct. Don\'t report success until the page renders fully.'
  return `You are working as part of a team to achieve this overall goal:
${goal}

You have been assigned the following task(s). Complete them in this project folder, making the necessary changes. Apply any relevant lessons from your memory.

${list}

${qa}

When finished, briefly report what you changed and flag anything you could not complete.`
}
```
Update the call site (`:384`) to pass `es.visionMode`:
```ts
        prompt: workerPrompt(state.goal, group.map((t) => t.task), es.lightPrompts, es.visionMode) + (asksAvailable() ? askUserSection() : '') + (es.followThrough === 'headless' ? followThroughSection() : '') + (es.followThrough === 'ask' ? followThroughAskSection() : ''),
```

In `src/main/engine/project-store.ts`, change `roleTemplate` to take `vision`, and swap the worker + manager phrases (all `vision=false` branches are the current exact text). Signature:
```ts
export function roleTemplate(name: string, kind: AgentKind, vision = false): string {
```
Manager branch — replace line `:108` and the file-hand-off line `:113`:
```ts
- ${vision
  ? '**Review your team’s output for craft and vision fidelity** — visual hierarchy, brand consistency, typographic quality, and tone. You own creative review, so your workers can focus on creating.'
  : '**Review and test your team’s output in your domain against the goal.** Don’t trust a worker’s report — run the app/tests and verify it actually works. You own testing, so your workers can focus on building.'}
```
```ts
- ${vision ? 'Match tasks to roles literally — don’t hand a copywriting task to a visual designer.' : 'Match tasks to roles literally — don’t hand a database task to a UI specialist.'}
```
Worker branch — replace the "specialist worker" line `:146` and the "verify it renders" bullet `:161`:
```ts
You are a **specialist worker** — ${vision ? 'you produce the actual creative work (design, brand, and copy deliverables).' : 'you do the actual implementation.'}
```
```ts
- ${vision
  ? 'Evaluate your work against the creative intent — visual hierarchy, brand and tonal consistency, and typographic craft — not just whether it technically works.'
  : 'If you build anything that serves a web page, **verify it actually renders** — run it and confirm the entry page and every asset it references (CSS/JS/images) return 200, not just that unit tests pass. A static-path mismatch that 404s assets renders the page unstyled even when the code is correct.'}
```
(Leave the orchestrator and director branches, the Specialty comment, and all other lines unchanged.)

Update `createAgent` (`:284`) to thread the setting:
```ts
  if (!existsSync(rolePath)) await fs.writeFile(rolePath, roleTemplate(input.name, input.kind, getSettings().visionMode), 'utf8')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/engine/nodes.test.ts src/main/engine/project-store.test.ts && npm run typecheck`
Expected: PASS — vision tests green; existing #8 roleTemplate (director/worker) tests still pass (default `vision=false` ⇒ byte-for-byte).

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/nodes.ts src/main/engine/nodes.test.ts src/main/engine/project-store.ts src/main/engine/project-store.test.ts
git commit -m "feat(vision): reframe worker execution + worker/manager role templates for creative fidelity (gated)"
```

---

### Task 4: One-click "Add Creative Team" preset (TeamMenu)

Reuses the shipped `briefTeamToSpawnedMembers` → `TeamSpawnModal` → `applySpawnedTeam` path. Renderer-only — gated by typecheck/lint/smoke.

**Files:**
- Modify: `src/renderer/TeamMenu.tsx`

**Interfaces:**
- Consumes: `VISION_TEAM` (Task 1), `briefTeamToSpawnedMembers` (`shared/advisor.ts`), `TeamSpawnModal` (props `members`, `orchestratorId`, `onClose`), store `graph`/`notify`.

- [ ] **Step 1: Implement** — in `src/renderer/TeamMenu.tsx`:

Add imports:
```ts
import { ChevronDown, CloudDownload, CloudUpload, Download, Palette, Upload } from 'lucide-react'
import TeamSpawnModal from './TeamSpawnModal'
import { briefTeamToSpawnedMembers } from '../shared/advisor'
import { VISION_TEAM } from '../shared/team-vision'
import type { SpawnedMember } from '../shared/types'
```
Add store + state near the existing hooks:
```ts
  const graph = useStore((s) => s.graph)
  const [spawn, setSpawn] = useState<{ members: SpawnedMember[]; orchestratorId: string } | null>(null)
```
Add the handler alongside `exportTeam`/`importTeam`:
```ts
  const addCreativeTeam = (): void => {
    setOpen(false)
    const orch = graph?.nodes.find((n) => n.kind === 'orchestrator')
    if (!orch) {
      notify({ kind: 'error', message: 'Add an Orchestrator first — then you can add a creative team under it.' })
      return
    }
    setSpawn({ members: briefTeamToSpawnedMembers(VISION_TEAM), orchestratorId: orch.id })
  }
```
Add a menu item to the `items` array (after Import team…):
```ts
    { label: 'Add Creative Team', icon: <Palette size={14} />, run: async () => addCreativeTeam() },
```
Render the modal — change the outer `return (<div className="topmenu" …>` to a fragment wrapping both the menu and the modal, and add before the final close:
```tsx
      {spawn && <TeamSpawnModal members={spawn.members} orchestratorId={spawn.orchestratorId} onClose={() => setSpawn(null)} />}
```
(Wrap the existing `<div className="topmenu">…</div>` and the `{spawn && …}` in a `<>…</>` fragment so both render.)

- [ ] **Step 2: Verify build gates**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/TeamMenu.tsx
git commit -m "feat(vision): one-click Add Creative Team preset (via briefTeamToSpawnedMembers + TeamSpawnModal)"
```

> **On-device smoke (defer):** Team menu → Add Creative Team → TeamSpawnModal shows the 7-member roster indented under the orchestrator; Apply creates them with palette/pencil icons.

---

### Task 5: `listOutputImages` core (pure predicate + main + IPC seam)

**Files:**
- Create: `src/shared/output-images.ts`
- Create: `src/shared/output-images.test.ts`
- Modify: `src/main/engine/project-store.ts` (new `listOutputImages`)
- Modify: `src/shared/types.ts` (`IPC.outputImages`; `RendererApi.listOutputImages`; the `OutputImage` type)
- Modify: `src/main/ipc.ts` (handler), `src/preload/index.ts` (entry)

**Interfaces:**
- Produces: pure `includeOutputImage(relPath, depth): boolean`, `OUTPUT_IMAGE_MAX = 60`, `OUTPUT_IMAGE_MAX_DEPTH = 4`, `OUTPUT_IMAGE_MAX_BYTES = 2_000_000`; `OutputImage = { path: string; dataUrl: string | null }`; `RendererApi.listOutputImages(): Promise<OutputImage[]>`.

- [ ] **Step 1: Write the failing test** — create `src/shared/output-images.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { includeOutputImage, OUTPUT_IMAGE_MAX_DEPTH } from './output-images'

describe('includeOutputImage', () => {
  it('includes raster images within the depth bound', () => {
    expect(includeOutputImage('designs/hero.png', 1)).toBe(true)
    expect(includeOutputImage('logo.jpg', 0)).toBe(true)
  })
  it('excludes non-images and svg', () => {
    expect(includeOutputImage('notes.md', 0)).toBe(false)
    expect(includeOutputImage('icon.svg', 0)).toBe(false) // svg never inlined (security, mirrors contextThumbnail)
  })
  it('excludes build/vcs/app dirs and beyond the depth bound', () => {
    expect(includeOutputImage('node_modules/x/a.png', 1)).toBe(false)
    expect(includeOutputImage('.git/a.png', 1)).toBe(false)
    expect(includeOutputImage('.ai-manager/context/a.png', 1)).toBe(false)
    expect(includeOutputImage('dist/a.png', 1)).toBe(false)
    expect(includeOutputImage('out/a.png', 1)).toBe(false)
    expect(includeOutputImage('a/b/c/d/e/deep.png', OUTPUT_IMAGE_MAX_DEPTH + 1)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/output-images.test.ts`
Expected: FAIL — `./output-images` does not exist.

- [ ] **Step 3: Implement** — create `src/shared/output-images.ts`:

```ts
// Pure filtering for the run-output image gallery. No node/DOM imports.
import { isImageName } from './context-files'

export const OUTPUT_IMAGE_MAX = 60
export const OUTPUT_IMAGE_MAX_DEPTH = 4
export const OUTPUT_IMAGE_MAX_BYTES = 2_000_000

export interface OutputImage {
  path: string // project-relative path
  dataUrl: string | null // inlined image, or null if too large to inline
}

const EXCLUDED = new Set(['node_modules', '.git', '.ai-manager', 'dist', 'out'])

/** Whether a project-relative image path should appear in the gallery. `depth` = number of
 *  path segments before the file (0 = project root). SVG is excluded (never inlined as <img src>). */
export function includeOutputImage(relPath: string, depth: number): boolean {
  if (depth > OUTPUT_IMAGE_MAX_DEPTH) return false
  const segs = relPath.split('/')
  if (segs.some((s) => EXCLUDED.has(s))) return false
  const name = segs[segs.length - 1]
  if (!isImageName(name)) return false
  return !name.toLowerCase().endsWith('.svg')
}
```

In `src/shared/types.ts`: export the type (re-export from the module for the RendererApi surface), add the IPC channel + the RendererApi method. Add near the other `IPC` entries:
```ts
  outputImages: 'run:output-images',
```
and to `RendererApi` (with an import `import type { OutputImage } from './output-images'` at the top, and `export type { OutputImage } from './output-images'`):
```ts
  listOutputImages: () => Promise<OutputImage[]>
```

In `src/main/engine/project-store.ts`, add (uses `requireCurrent().path`, `fs`, `join`, and the pure predicate):
```ts
import { includeOutputImage, OUTPUT_IMAGE_MAX, OUTPUT_IMAGE_MAX_BYTES, type OutputImage } from '../../shared/output-images'
```
```ts
/** Bounded scan of the project for produced images, for the run-output gallery. Skips build/vcs/app
 *  dirs and svg; inlines each ≤ OUTPUT_IMAGE_MAX_BYTES as a data URL (mirrors contextThumbnail). */
export async function listOutputImages(): Promise<OutputImage[]> {
  const { path } = requireCurrent()
  const out: OutputImage[] = []
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (out.length >= OUTPUT_IMAGE_MAX) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= OUTPUT_IMAGE_MAX) return
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        // prune excluded dirs cheaply via the predicate on a sentinel child
        if (includeOutputImage(`${relPath}/_.png`, depth + 1)) await walk(join(dir, e.name), relPath, depth + 1)
        continue
      }
      if (!includeOutputImage(relPath, depth)) continue
      let dataUrl: string | null = null
      try {
        const stat = await fs.stat(join(dir, e.name))
        if (stat.size <= OUTPUT_IMAGE_MAX_BYTES) {
          const buf = await fs.readFile(join(dir, e.name))
          const ext = e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase()
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
          dataUrl = `data:${mime};base64,${buf.toString('base64')}`
        }
      } catch {
        dataUrl = null
      }
      out.push({ path: relPath, dataUrl })
    }
  }
  await walk(path, '', 0)
  return out
}
```
In `src/main/ipc.ts` (near the other `store.*` handlers):
```ts
  ipcMain.handle(IPC.outputImages, () => store.listOutputImages())
```
In `src/preload/index.ts`:
```ts
  listOutputImages: () => ipcRenderer.invoke(IPC.outputImages),
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/shared/output-images.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/output-images.ts src/shared/output-images.test.ts src/shared/types.ts src/main/engine/project-store.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat(vision): listOutputImages core (bounded scan + data URLs) + IPC/preload/RendererApi"
```

---

### Task 6: Creative output preview (RunResultModal iframe + image gallery)

**Files:**
- Modify: `src/renderer/run/RunResultModal.tsx`
- Modify: `src/renderer/styles.css` (minimal `.rr-preview` + gallery styles)

**Interfaces:**
- Consumes: `window.api.listOutputImages()` → `OutputImage[]` (Task 5); the existing `url` state (served deliverable) + `launchServer`.

- [ ] **Step 1: Implement** — in `src/renderer/run/RunResultModal.tsx`:

Add the gallery state + load-on-mount, and import the type:
```ts
import type { RunManifest, ServerStatus, OutputImage } from '../../shared/types'
```
```ts
  const [images, setImages] = useState<OutputImage[]>([])
  useEffect(() => {
    let alive = true
    void window.api.listOutputImages().then((imgs) => { if (alive) setImages(imgs) })
    return () => { alive = false }
  }, [])
```
Inside the launchable branch, after the `<pre className="server-log">…</pre>`, add the inline iframe when a URL is live:
```tsx
              {url && <iframe className="rr-preview" src={url} title="Deliverable preview" />}
```
After the whole `{launchable ? (…) : (…)}` block (still inside `.modal-body`), add the gallery (shows regardless of launchability):
```tsx
          {images.length > 0 && (
            <div className="field">
              <label>Produced images ({images.length})</label>
              <div className="output-gallery">
                {images.map((img) =>
                  img.dataUrl ? (
                    <img key={img.path} className="output-thumb" src={img.dataUrl} alt={img.path} title={img.path} />
                  ) : (
                    <span key={img.path} className="output-thumb output-thumb-icon" title={img.path}>{img.path.split('/').pop()}</span>
                  )
                )}
              </div>
            </div>
          )}
```

In `src/renderer/styles.css`, add (consume tokens; no hardcoded palette):
```css
.rr-preview {
  width: 100%;
  height: 420px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface-0);
  margin-top: var(--space-3);
}
.output-gallery {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.output-thumb {
  width: 96px;
  height: 96px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline);
  background: var(--surface-1);
}
.output-thumb-icon {
  display: grid;
  place-items: center;
  padding: var(--space-2);
  font-size: var(--text-xs);
  color: var(--fg-muted);
  text-align: center;
  overflow: hidden;
}
```

- [ ] **Step 2: Verify build gates**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/run/RunResultModal.tsx src/renderer/styles.css
git commit -m "feat(vision): creative output preview — inline iframe comp + produced-image gallery"
```

> **On-device smoke (defer):** run a creative goal that emits an HTML comp and/or images → Launch app → inline iframe renders the comp; the "Produced images" gallery shows thumbnails (icon chip for any >2MB). **CSP watch-out:** if the app's Content-Security-Policy `frame-src`/`default-src` blocks framing `http://localhost:*`, the iframe stays blank — the smoke must confirm it renders; if blocked, the fix is to widen `frame-src` to allow localhost (or fall back to the existing open-in-browser button, which still works). The image gallery uses `data:` URLs and is unaffected.

---

## Final verification (controller, after all tasks)

- [ ] `npm run typecheck` — clean
- [ ] `npm run test` — all green (new tests across team-vision / output-images / team-spawn / role-draft / nodes / project-store)
- [ ] `npm run lint` — 0 errors
- [ ] `npm run build` — succeeds
- [ ] **Byte-for-byte checklist** (spec §12): with `visionMode` off — `spawnTeamPrompt`/`draftRolesPrompt`/`planPrompt`/`workerPrompt`(light+non-light)/`roleTemplate`(all kinds) string-equality tests green; `createAgent` scaffolds identical role.md; preset/preview unused ⇒ no change; no new run-graph node.
- [ ] **On-device smoke** (required for renderer): Vision mode toggle; Add Creative Team → TeamSpawnModal roster; RunResult iframe + image gallery.

## Notes on decomposition / DRY / YAGNI

- The archetype names live only in `team-vision.ts` (`visionBias()` + `VISION_TEAM`) — consumed by the prompt bias (Task 2) and the preset (Task 4).
- Pure logic (`visionBias`, `VISION_TEAM` mapping, `includeOutputImage`) is extracted to `shared/` and unit-tested; the fs walk + renderer are thin wrappers.
- The preset adds **zero** new engine/IPC (rides the shipped C→D path); only the gallery adds one IPC.
- Deferred (spec §11): run-tracked output manifests; a `.aimteam.json` bundle; Advisor-generated presets; design-tool integrations; renaming "Launch app".
