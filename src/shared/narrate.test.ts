import { describe, it, expect } from 'vitest'
import { narrateTool } from './narrate'

describe('narrateTool', () => {
  it('uses the Bash description when present', () => {
    expect(narrateTool('Bash', { command: 'npm test', description: 'Run the test suite' }))
      .toBe('Run the test suite')
  })

  it('falls back to the Bash command when there is no description', () => {
    expect(narrateTool('Bash', { command: 'npm test' })).toBe('Running `npm test`')
  })

  it('handles Bash with neither description nor command', () => {
    expect(narrateTool('Bash', {})).toBe('Running a command')
  })

  it('clips a very long Bash command', () => {
    const cmd = 'echo ' + 'x'.repeat(200)
    const out = narrateTool('Bash', { command: cmd })
    expect(out.startsWith('Running `echo ')).toBe(true)
    expect(out.endsWith('`')).toBe(true)
    expect(out.length).toBeLessThan(95) // 80-char clip + "Running ``"
  })

  it('reads with a basename from a nested path', () => {
    expect(narrateTool('Read', { file_path: '/home/u/proj/src/app.tsx' })).toBe('Reading app.tsx')
  })

  it('edits with a basename (Edit + MultiEdit)', () => {
    expect(narrateTool('Edit', { file_path: 'src/styles.css' })).toBe('Editing styles.css')
    expect(narrateTool('MultiEdit', { file_path: 'src/x.ts' })).toBe('Editing x.ts')
  })

  it('handles a Windows-style path separator', () => {
    expect(narrateTool('Write', { file_path: 'C:\\Users\\me\\notes.md' })).toBe('Writing notes.md')
  })

  it('narrates NotebookEdit from notebook_path', () => {
    expect(narrateTool('NotebookEdit', { notebook_path: 'a/b/analysis.ipynb' }))
      .toBe('Editing analysis.ipynb')
  })

  it('quotes a Grep pattern', () => {
    expect(narrateTool('Grep', { pattern: 'TODO' })).toBe('Searching for "TODO"')
  })

  it('narrates Glob', () => {
    expect(narrateTool('Glob', { pattern: '**/*.ts' })).toBe('Finding files: **/*.ts')
  })

  it('extracts the host for WebFetch', () => {
    expect(narrateTool('WebFetch', { url: 'https://docs.example.com/x/y' }))
      .toBe('Fetching docs.example.com')
  })

  it('falls back to the raw url when WebFetch has no scheme', () => {
    expect(narrateTool('WebFetch', { url: 'example.com/page' })).toBe('Fetching example.com/page')
  })

  it('clips a WebSearch query', () => {
    expect(narrateTool('WebSearch', { query: 'how to center a div' }))
      .toBe('Searching the web: how to center a div')
  })

  it('narrates TodoWrite', () => {
    expect(narrateTool('TodoWrite', { todos: [] })).toBe('Updating the task list')
  })

  it('narrates Task with and without a description', () => {
    expect(narrateTool('Task', { description: 'Find the bug' }))
      .toBe('Delegating to a subagent: Find the bug')
    expect(narrateTool('Task', {})).toBe('Delegating to a subagent')
  })

  it('narrates an MCP tool by server + tool', () => {
    expect(narrateTool('mcp__github__create_issue', {})).toBe('Using create_issue (github)')
  })

  it('narrates an unknown tool by name', () => {
    expect(narrateTool('Frobnicate', { x: 1 })).toBe('Using Frobnicate')
  })

  it('never throws on malformed input', () => {
    expect(() => narrateTool('Read', null)).not.toThrow()
    expect(() => narrateTool('Bash', 'not-an-object')).not.toThrow()
    expect(narrateTool('Read', null)).toBe('Reading a file')
    expect(narrateTool('Edit', 42)).toBe('Editing a file')
  })

  it('narrates the last segment for a trailing-slash path (not the whole path)', () => {
    expect(narrateTool('Read', { file_path: '/a/b/c/' })).toBe('Reading c')
  })

  it('strips userinfo from a fetched host', () => {
    expect(narrateTool('WebFetch', { url: 'https://user:pass@example.com/page' })).toBe('Fetching example.com')
  })
})
