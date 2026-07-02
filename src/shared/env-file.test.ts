import { describe, it, expect } from 'vitest'
import { parseEnvEntries, applyEnvEdits, labelFor } from './env-file'

describe('parseEnvEntries', () => {
  it('parses KEY=value, export, quoted, and empty; ignores comments/blanks', () => {
    const text = '# a comment\nPORT=3000\nexport NODE_ENV=production\nQUOTED="hello world"\nSINGLE=\'x y\'\nEMPTY=\n\n'
    expect(parseEnvEntries(text)).toEqual([
      { key: 'PORT', value: '3000' },
      { key: 'NODE_ENV', value: 'production' },
      { key: 'QUOTED', value: 'hello world' },
      { key: 'SINGLE', value: 'x y' },
      { key: 'EMPTY', value: '' }
    ])
  })
  it('dedups keeping the last value, first position', () => {
    expect(parseEnvEntries('A=1\nB=2\nA=9')).toEqual([{ key: 'A', value: '9' }, { key: 'B', value: '2' }])
  })
})

describe('applyEnvEdits', () => {
  it('edits a value in place and preserves comments + position', () => {
    const existing = '# db\nDATABASE_URL=old\nPORT=3000'
    const out = applyEnvEdits(existing, [{ key: 'DATABASE_URL', value: 'new' }, { key: 'PORT', value: '3000' }])
    expect(out).toBe('# db\nDATABASE_URL=new\nPORT=3000\n')
  })
  it('drops a deleted key but keeps comments', () => {
    const out = applyEnvEdits('# keep\nA=1\nB=2', [{ key: 'A', value: '1' }])
    expect(out).toBe('# keep\nA=1\n')
  })
  it('appends new keys at the end', () => {
    const out = applyEnvEdits('A=1', [{ key: 'A', value: '1' }, { key: 'NEW', value: '2' }])
    expect(out).toBe('A=1\nNEW=2\n')
  })
  it('writes a fresh file with no leading blank line', () => {
    expect(applyEnvEdits('', [{ key: 'A', value: '1' }])).toBe('A=1\n')
  })
  it('quotes values that need it', () => {
    expect(applyEnvEdits('', [{ key: 'A', value: 'has space' }])).toBe('A="has space"\n')
    expect(applyEnvEdits('', [{ key: 'A', value: 'a"b' }])).toBe('A="a\\"b"\n')
  })
})

describe('labelFor', () => {
  it('uses the curated map', () => {
    expect(labelFor('ANTHROPIC_API_KEY')).toBe('Anthropic API key')
    expect(labelFor('DATABASE_URL')).toBe('Database URL')
  })
  it('humanizes unknown keys with acronym casing', () => {
    expect(labelFor('MY_TOKEN')).toBe('My token')
    expect(labelFor('CUSTOM_API_URL')).toBe('Custom API URL')
  })
})
