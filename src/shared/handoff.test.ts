import { describe, it, expect } from 'vitest'
import { parseHandoff } from './handoff'

const peers = [
  { id: 'w2', name: 'Research' },
  { id: 'c1', name: 'Compliance' }
]

describe('parseHandoff', () => {
  it('parses a ```handoff block and resolves the target by name (case-insensitive)', () => {
    const text = 'Sure.\n```handoff\n{ "to": "research", "ask": "expressive UI ideas" }\n```'
    expect(parseHandoff(text, peers)).toEqual({ peerId: 'w2', ask: 'expressive UI ideas' })
  })

  it('resolves the target by id', () => {
    const text = '```handoff\n{"to":"c1","ask":"is this compliant?"}\n```'
    expect(parseHandoff(text, peers)).toEqual({ peerId: 'c1', ask: 'is this compliant?' })
  })

  it('returns null when there is no handoff block', () => {
    expect(parseHandoff('Just my normal answer, no consult.', peers)).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    expect(parseHandoff('```handoff\n{ to: research, ask }\n```', peers)).toBeNull()
  })

  it('returns null when ask is empty', () => {
    expect(parseHandoff('```handoff\n{"to":"research","ask":""}\n```', peers)).toBeNull()
  })

  it('returns null when the target is not a reachable peer', () => {
    expect(parseHandoff('```handoff\n{"to":"nobody","ask":"x"}\n```', peers)).toBeNull()
  })

  it('does not treat a verdict JSON block as a handoff', () => {
    const verdict = '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```'
    expect(parseHandoff(verdict, peers)).toBeNull()
  })

  it('takes the last handoff block when several are present', () => {
    const text =
      '```handoff\n{"to":"research","ask":"first"}\n```\nthen\n```handoff\n{"to":"compliance","ask":"second"}\n```'
    expect(parseHandoff(text, peers)).toEqual({ peerId: 'c1', ask: 'second' })
  })
})
