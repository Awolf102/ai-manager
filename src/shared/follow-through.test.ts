import { describe, it, expect } from 'vitest'
import { parseFollowUps, parseFollowUpAsk } from './follow-through'

const block = (s: string, d: string) =>
  '```followup\n{ "summary": ' + JSON.stringify(s) + ', "decision": ' + JSON.stringify(d) + ' }\n```'

describe('parseFollowUps', () => {
  it('returns [] when no followup block', () => {
    expect(parseFollowUps('just some worker output')).toEqual([])
  })
  it('parses a single block', () => {
    expect(parseFollowUps('did work\n' + block('chat icon unspecified', 'built a chat panel'))).toEqual([
      { summary: 'chat icon unspecified', decision: 'built a chat panel' }
    ])
  })
  it('parses multiple blocks in order', () => {
    const text = block('a', 'A') + '\nprose\n' + block('b', 'B')
    expect(parseFollowUps(text)).toEqual([
      { summary: 'a', decision: 'A' },
      { summary: 'b', decision: 'B' }
    ])
  })
  it('drops blocks missing summary or decision, or empty', () => {
    const bad = '```followup\n{ "summary": "x" }\n```'
    const empty = '```followup\n{ "summary": "", "decision": "y" }\n```'
    expect(parseFollowUps(bad + '\n' + empty + '\n' + block('ok', 'done'))).toEqual([
      { summary: 'ok', decision: 'done' }
    ])
  })
})

const askBlock = (s: string, q: string, opts?: string[]) =>
  '```followup\n' + JSON.stringify(opts ? { summary: s, question: q, options: opts } : { summary: s, question: q }) + '\n```'

describe('parseFollowUpAsk', () => {
  it('returns null when no block', () => {
    expect(parseFollowUpAsk('nope')).toBeNull()
  })
  it('parses summary + question with options', () => {
    expect(parseFollowUpAsk('x\n' + askBlock('chat icon', 'what should it do?', ['a', 'b']))).toEqual({
      summary: 'chat icon', question: 'what should it do?', options: ['a', 'b']
    })
  })
  it('options default to [] and are capped to 4, empties dropped', () => {
    expect(parseFollowUpAsk(askBlock('s', 'q'))).toEqual({ summary: 's', question: 'q', options: [] })
    expect(parseFollowUpAsk(askBlock('s', 'q', ['a', '', 'b', 'c', 'd', 'e'])).options).toEqual(['a', 'b', 'c', 'd'])
  })
  it('returns null if summary or question is empty/missing', () => {
    expect(parseFollowUpAsk(askBlock('', 'q'))).toBeNull()
    expect(parseFollowUpAsk('```followup\n{ "summary": "s" }\n```')).toBeNull()
  })
  it('prefers the last block', () => {
    expect(parseFollowUpAsk(askBlock('s1', 'q1') + '\n' + askBlock('s2', 'q2'))?.question).toBe('q2')
  })
})
