import { describe, it, expect } from 'vitest'
import { parseBranchList } from './git-parse'

describe('parseBranchList', () => {
  it('parses the --format=%(refname:short) form (clean lines)', () => {
    expect(parseBranchList('main\nfeature/x\ndev\n')).toEqual(['main', 'feature/x', 'dev'])
  })
  it('strips the leading "* "/"+ " markers of plain `git branch`', () => {
    expect(parseBranchList('* main\n  dev\n+ wt-branch')).toEqual(['main', 'dev', 'wt-branch'])
  })
  it('drops a detached-HEAD parenthetical line and blanks; handles CRLF', () => {
    expect(parseBranchList('* (HEAD detached at abc123)\r\n  main\r\n\r\n')).toEqual(['main'])
  })
  it('empty input → []', () => {
    expect(parseBranchList('')).toEqual([])
  })
})
