import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from './types'
import { advisorSystemPrompt, parseBrief, applyableSettings, type AdvisorContext } from './advisor'

const ctx: AdvisorContext = {
  projectName: 'Acme',
  settings: DEFAULT_SETTINGS,
  backends: [{ label: 'z.ai (GLM)', models: ['glm-4.6', 'glm-4.5-air'] }],
  digest: 'Top-level entries: src, package.json'
}

describe('advisorSystemPrompt', () => {
  it('grounds in project name, settings, backends, and digest', () => {
    const p = advisorSystemPrompt(ctx)
    expect(p).toContain('Acme')
    expect(p).toContain('z.ai (GLM)')
    expect(p).toContain('glm-4.6')
    expect(p).toContain('Top-level entries')
    expect(p.toLowerCase()).toContain('brief') // instructs the fenced brief block
  })
  it('never leaks a token or base URL even if adjacent data exists', () => {
    // backends only ever carry label+models here; assert the composer has no baseUrl/token wording injected
    const p = advisorSystemPrompt(ctx)
    expect(p).not.toContain('ANTHROPIC_AUTH_TOKEN')
    expect(p).not.toContain('https://')
  })
})

describe('parseBrief', () => {
  it('extracts a fenced brief block', () => {
    const text = 'Sure!\n\n```brief\n{"goal":"build a todo app","stack":["react"]}\n```\nHappy to help.'
    expect(parseBrief(text)).toEqual({ goal: 'build a todo app', stack: ['react'] })
  })
  it('returns null when there is no brief', () => {
    expect(parseBrief('just chatting, no block')).toBeNull()
  })
  it('returns null on malformed JSON', () => {
    expect(parseBrief('```brief\n{not json}\n```')).toBeNull()
  })
  it('ignores a bare unlabeled code fence (requires a brief/json label)', () => {
    expect(parseBrief('here is an example:\n```\n{"goal":"nope"}\n```')).toBeNull()
    expect(parseBrief('```json\n{"goal":"yes"}\n```')).toEqual({ goal: 'yes' })
  })
})

describe('applyableSettings', () => {
  it('keeps only whitelisted cost knobs', () => {
    const brief = { settings: { outputMode: 'terse', cheapModelWorkers: true, lightPrompts: true } }
    expect(applyableSettings(brief)).toEqual({ outputMode: 'terse', cheapModelWorkers: true, lightPrompts: true })
  })
  it('drops autonomy / permission / unknown keys', () => {
    const brief = { settings: { autonomy: 'full', lockBypassPermissions: true, outputMode: 'code-only', bogus: 1 } }
    expect(applyableSettings(brief)).toEqual({ outputMode: 'code-only' })
  })
  it('returns {} when there is no settings object', () => {
    expect(applyableSettings({ goal: 'x' })).toEqual({})
  })
})
