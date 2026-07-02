// Pure helpers + types for the Advisor assistant (no node/DOM imports).
import type { ProjectSettings } from './types'

export interface AdvisorBriefTeamMember {
  name: string
  kind: 'manager' | 'worker'
  role: string
}

export interface AdvisorBrief {
  goal?: string
  summary?: string
  stack?: string[]
  settings?: Record<string, unknown>
  backendPresetId?: string
  team?: AdvisorBriefTeamMember[]
}

export interface AdvisorContext {
  projectName: string
  settings: ProjectSettings
  backends: { label: string; models: string[] }[]
  digest?: string
}

/** The ONLY settings keys the Advisor may apply — cost/efficiency knobs. No autonomy/permissions. */
export const ADVISOR_SETTINGS_WHITELIST: (keyof ProjectSettings)[] = [
  'outputMode',
  'effortThrift',
  'effortThriftCeiling',
  'cheapModelWorkers',
  'cheapModelTier',
  'lightPrompts',
  'adaptiveEffort',
  'autoAssignModels'
]

/** The Advisor's grounded system-prompt append. Pure; injects only non-secret project data. */
export function advisorSystemPrompt(ctx: AdvisorContext): string {
  const knobs = [
    `outputMode=${ctx.settings.outputMode}`,
    `effortThrift=${ctx.settings.effortThrift} (ceiling ${ctx.settings.effortThriftCeiling})`,
    `cheapModelWorkers=${ctx.settings.cheapModelWorkers} (${ctx.settings.cheapModelTier})`,
    `lightPrompts=${ctx.settings.lightPrompts}`,
    `adaptiveEffort=${ctx.settings.adaptiveEffort}`,
    `autoAssignModels=${ctx.settings.autoAssignModels}`
  ].join(', ')
  const backends = ctx.backends.length
    ? ctx.backends.map((b) => `- ${b.label}: ${b.models.join(', ') || '(no models)'}`).join('\n')
    : '(none configured)'
  return [
    '# Role: Project Advisor',
    `You are the Advisor for the "${ctx.projectName}" project in the AI Manager app. You help the user (who may be non-technical) plan what to build, pick AI services and models, choose a tech stack that fits their budget and expected user base, and write cost-efficient prompts. Be concise, practical, and explain trade-offs plainly.`,
    '',
    'You are READ-ONLY: you can read the project to ground your advice, but you cannot change settings, files, or run anything. The user confirms every action.',
    '',
    '## When you have a concrete recommendation the user could act on',
    'Include ONE fenced code block labelled `brief` containing JSON with any of these optional fields: `goal` (string, a build goal), `summary` (string), `stack` (string[]), `settings` (object of cost/efficiency knobs only), `backendPresetId` (string), `team` ({name,kind,role}[]). Keep your normal prose OUTSIDE the block. The app renders the brief as buttons the user confirms — never assume it was applied. Never put secrets (API keys, tokens) anywhere.',
    '',
    '## Current project settings (cost/efficiency knobs)',
    knobs,
    '',
    '## Configured model backends (labels + model ids only)',
    backends,
    ...(ctx.digest ? ['', '## Selected folder (for grounding)', ctx.digest] : [])
  ].join('\n')
}

/** Extract a fenced ```brief (or ```json) JSON object from the text, or null. */
export function parseBrief(text: string): AdvisorBrief | null {
  const fences = [...text.matchAll(/\x60{3}(?:brief|json)?\s*([\s\S]*?)\x60{3}/gi)]
  const candidates = fences.map((m) => m[1])
  for (const c of candidates.reverse()) {
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      const obj = JSON.parse(c.slice(start, end + 1))
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as AdvisorBrief
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** Filter a brief's settings to the whitelist — a hallucinated key can never change security posture. */
export function applyableSettings(brief: AdvisorBrief): Partial<ProjectSettings> {
  const src = (brief.settings ?? {}) as Record<string, unknown>
  const out: Partial<ProjectSettings> = {}
  for (const key of ADVISOR_SETTINGS_WHITELIST) {
    if (key in src && src[key] !== undefined) {
      ;(out as Record<string, unknown>)[key] = src[key]
    }
  }
  return out
}
