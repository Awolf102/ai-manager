import { describe, it, expect } from 'vitest'
import { parseAskUser, redactUserAnswer } from './ask-user'

describe('parseAskUser', () => {
  it('parses an ```ask block', () => {
    const text = 'Working...\n```ask\n{ "question": "Which brand color?" }\n```'
    expect(parseAskUser(text)).toEqual({ question: 'Which brand color?' })
  })

  it('returns null when there is no ask block', () => {
    expect(parseAskUser('Just my normal answer, no question.')).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    expect(parseAskUser('```ask\n{ question: nope }\n```')).toBeNull()
  })

  it('returns null when question is empty', () => {
    expect(parseAskUser('```ask\n{"question":""}\n```')).toBeNull()
  })

  it('returns null when question is only whitespace', () => {
    expect(parseAskUser('```ask\n{"question":"   "}\n```')).toBeNull()
  })

  it('does not treat a verdict JSON block as an ask', () => {
    const verdict = '```json\n{"tasks":[{"taskId":"t1","verdict":"pass","feedback":""}]}\n```'
    expect(parseAskUser(verdict)).toBeNull()
  })

  it('takes the last ask block when several are present', () => {
    const text = '```ask\n{"question":"first"}\n```\nthen\n```ask\n{"question":"second"}\n```'
    expect(parseAskUser(text)).toEqual({ question: 'second' })
  })

  it('does not end the block early on a ``` inside the JSON value', () => {
    const text = '```ask\n{ "question": "use ``` fences?" }\n```'
    expect(parseAskUser(text)).toEqual({ question: 'use ``` fences?' })
  })
})

describe('redactUserAnswer', () => {
  it('redacts every verbatim occurrence of a >=6-char answer', () => {
    expect(redactUserAnswer('I used TealSecret123 then TealSecret123 again', 'TealSecret123'))
      .toBe('I used [user answer redacted] then [user answer redacted] again')
  })
  it('trims the answer before matching and gating', () => {
    expect(redactUserAnswer('set to hunter2secret done', '  hunter2secret  '))
      .toBe('set to [user answer redacted] done')
  })
  it('leaves text unchanged when the trimmed answer is shorter than 6 chars', () => {
    // also proves no substring carnage: "no" must not blank out "node"
    expect(redactUserAnswer('the node said no', 'no')).toBe('the node said no')
  })
  it('leaves text unchanged for an empty/whitespace answer', () => {
    expect(redactUserAnswer('anything here', '')).toBe('anything here')
    expect(redactUserAnswer('anything here', '   ')).toBe('anything here')
  })
  it('leaves text unchanged when the answer does not appear', () => {
    expect(redactUserAnswer('no secret here', 'TealSecret123')).toBe('no secret here')
  })
})
