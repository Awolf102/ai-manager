import { describe, it, expect } from 'vitest'
import { parseFollowUps } from './follow-through'

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
