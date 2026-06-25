// The skill catalog the app offers per agent. These are real, installed Claude
// Code skill plugins (Anthropic's `data`/`design`/`engineering` from the
// knowledge-work-plugins marketplace, plus `frontend-design` from the official
// one). Each agent picks a subset; agent-runner loads the needed plugins and
// passes the chosen skill ids to the SDK's `skills` filter.
//
// Pure / node-free so both processes can import it (renderer shows the picker;
// main builds the SDK options). Plugin paths are resolved in main, not here.

export interface CatalogSkill {
  /** plugin-qualified id passed to the SDK `skills` option, e.g. 'data:analyze' */
  id: string
  label: string
  description: string
}

export interface CatalogPlugin {
  /** plugin name (matches plugin.json `name`) — also the `skills` prefix */
  id: string
  label: string
  /** publisher, for the UI */
  by: string
  skills: CatalogSkill[]
}

const skill = (plugin: string, name: string, description: string): CatalogSkill => ({
  id: `${plugin}:${name}`,
  label: name,
  description
})

export const SKILL_CATALOG: CatalogPlugin[] = [
  {
    id: 'engineering',
    label: 'Engineering',
    by: 'Anthropic',
    skills: [
      skill('engineering', 'code-review', 'Review code changes for security, performance, and correctness.'),
      skill('engineering', 'debug', 'Structured debugging — reproduce, isolate, diagnose, and fix.'),
      skill('engineering', 'testing-strategy', 'Design test strategies and test plans.'),
      skill('engineering', 'architecture', 'Create or evaluate an architecture decision record (ADR).'),
      skill('engineering', 'system-design', 'Design systems, services, and architectures.'),
      skill('engineering', 'tech-debt', 'Identify, categorize, and prioritize technical debt.'),
      skill('engineering', 'documentation', 'Write and maintain technical documentation.'),
      skill('engineering', 'deploy-checklist', 'Pre-deployment verification checklist.'),
      skill('engineering', 'incident-response', 'Triage, communicate, and write postmortems for incidents.'),
      skill('engineering', 'standup', 'Generate a standup update from recent activity.')
    ]
  },
  {
    id: 'data',
    label: 'Data',
    by: 'Anthropic',
    skills: [
      skill('data', 'analyze', 'Answer data questions — from quick lookups to full analyses.'),
      skill('data', 'write-query', 'Write optimized SQL for your dialect with best practices.'),
      skill('data', 'sql-queries', 'Correct, performant SQL across major warehouse dialects.'),
      skill('data', 'explore-data', "Profile a dataset to understand shape, quality, and patterns."),
      skill('data', 'statistical-analysis', 'Descriptive stats, trend analysis, outlier detection.'),
      skill('data', 'create-viz', 'Create publication-quality visualizations with Python.'),
      skill('data', 'data-visualization', 'Effective data visualizations (matplotlib, seaborn, plotly).'),
      skill('data', 'build-dashboard', 'Build an interactive HTML dashboard with charts and filters.'),
      skill('data', 'validate-data', 'QA an analysis before sharing — methodology, accuracy, bias.'),
      skill('data', 'data-context-extractor', 'Extract schema/context to ground data work.')
    ]
  },
  {
    id: 'design',
    label: 'Design',
    by: 'Anthropic',
    skills: [
      skill('design', 'design-system', 'Audit, document, or extend your design system.'),
      skill('design', 'design-critique', 'Structured feedback on usability, hierarchy, consistency.'),
      skill('design', 'accessibility-review', 'Run a WCAG 2.1 AA accessibility audit.'),
      skill('design', 'ux-copy', 'Write or review UX copy — microcopy, errors, empty states, CTAs.'),
      skill('design', 'design-handoff', 'Generate developer handoff specs from a design.'),
      skill('design', 'user-research', 'Plan, conduct, and synthesize user research.'),
      skill('design', 'research-synthesis', 'Synthesize research into themes, insights, recommendations.')
    ]
  },
  {
    id: 'frontend-design',
    label: 'Frontend Design',
    by: 'Anthropic',
    skills: [
      skill(
        'frontend-design',
        'frontend-design',
        'Distinctive, intentional visual design for new or reshaped UI.'
      )
    ]
  }
]

/** Every skill id in the catalog. */
export function catalogSkillIds(): string[] {
  return SKILL_CATALOG.flatMap((p) => p.skills.map((s) => s.id))
}

export interface SkillSdkOptions {
  plugins: { type: 'local'; path: string; skipMcpDiscovery: true }[]
  skills: string[]
}

/**
 * Build the SDK `plugins` + `skills` options for an agent's assigned skill ids.
 * Loads each distinct plugin once (MCP discovery skipped — we want the skills,
 * not the warehouse connectors) and passes the assigned ids through as the
 * `skills` filter. Returns null when nothing is assigned. `pluginPath` is
 * injected so this stays pure/testable.
 */
export function skillOptionsFor(
  assigned: string[] | undefined,
  pluginPath: (pluginId: string) => string
): SkillSdkOptions | null {
  const valid = (assigned ?? []).filter((s) => s.includes(':'))
  if (valid.length === 0) return null
  const pluginIds = [...new Set(valid.map((s) => s.slice(0, s.indexOf(':'))))]
  return {
    plugins: pluginIds.map((id) => ({ type: 'local', path: pluginPath(id), skipMcpDiscovery: true })),
    skills: valid
  }
}
