import { describe, it, expect } from 'vitest'
import { parseLessonBullet, formatLessonBullet } from './lessons'

describe('parseLessonBullet', () => {
  it('parses a portable marker and trims the text', () => {
    expect(parseLessonBullet('[portable]  write a failing test first')).toEqual({
      scope: 'portable',
      text: 'write a failing test first'
    })
  })

  it('parses a project marker case-insensitively', () => {
    expect(parseLessonBullet('[PROJECT] migrations live in db/migrate')).toEqual({
      scope: 'project',
      text: 'migrations live in db/migrate'
    })
  })

  it('returns scope null for an untagged (legacy) bullet', () => {
    expect(parseLessonBullet('verify renders return 200')).toEqual({
      scope: null,
      text: 'verify renders return 200'
    })
  })
})

describe('formatLessonBullet', () => {
  it('renders the marker and trims the text', () => {
    expect(formatLessonBullet('portable', '  write tests first ')).toBe('[portable] write tests first')
  })

  it('round-trips through parseLessonBullet', () => {
    expect(parseLessonBullet(formatLessonBullet('project', 'api key in config'))).toEqual({
      scope: 'project',
      text: 'api key in config'
    })
  })
})
