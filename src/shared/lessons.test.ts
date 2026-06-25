import { describe, it, expect } from 'vitest'
import { parseLessonBullet, formatLessonBullet, portableLessons } from './lessons'

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

describe('portableLessons', () => {
  it('returns only portable lesson texts, marker stripped', () => {
    const mem = '## Lessons\n- [portable] write tests first\n- [project] api key in config\n- untagged legacy\n'
    expect(portableLessons(mem)).toEqual(['write tests first'])
  })

  it('is uncapped (unlike lessonsDigest) and ignores the placeholder', () => {
    const mem = '## Lessons\n- (none yet)\n' + Array.from({ length: 8 }, (_, i) => `- [portable] L${i}`).join('\n')
    expect(portableLessons(mem)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'])
  })

  it('returns [] when there is no Lessons section', () => {
    expect(portableLessons('# Memory\n\n## Task log\n- did stuff')).toEqual([])
  })
})
