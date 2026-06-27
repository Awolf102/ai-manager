// Pure derivation of a plain-English activity phrase from a Claude Code tool call.
// No node/DOM imports — unit-tested in plain Node (like shared/effort.ts). Never throws.

export function narrateTool(name: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')

  switch (name) {
    case 'Bash': {
      const desc = str(o.description).trim()
      if (desc) return desc
      const cmd = str(o.command).trim()
      return cmd ? `Running \`${clip(cmd, 80)}\`` : 'Running a command'
    }
    case 'Read':
      return `Reading ${basename(str(o.file_path)) || 'a file'}`
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${basename(str(o.file_path)) || 'a file'}`
    case 'Write':
      return `Writing ${basename(str(o.file_path)) || 'a file'}`
    case 'NotebookEdit':
      return `Editing ${basename(str(o.notebook_path)) || 'a notebook'}`
    case 'Grep': {
      const p = str(o.pattern).trim()
      return p ? `Searching for "${clip(p, 60)}"` : 'Searching files'
    }
    case 'Glob': {
      const p = str(o.pattern).trim()
      return p ? `Finding files: ${clip(p, 60)}` : 'Finding files'
    }
    case 'WebFetch': {
      const u = str(o.url).trim()
      return u ? `Fetching ${host(u)}` : 'Fetching a page'
    }
    case 'WebSearch': {
      const q = str(o.query).trim()
      return q ? `Searching the web: ${clip(q, 60)}` : 'Searching the web'
    }
    case 'TodoWrite':
      return 'Updating the task list'
    case 'Task': {
      const d = str(o.description).trim()
      return d ? `Delegating to a subagent: ${clip(d, 60)}` : 'Delegating to a subagent'
    }
    default:
      if (name.startsWith('mcp__')) {
        const parts = name.split('__')
        const server = parts[1] ?? ''
        const tool = parts.slice(2).join('__') || name
        return server ? `Using ${tool} (${server})` : `Using ${tool}`
      }
      return `Using ${name}`
  }
}

/** Last path segment (handles / and \), or '' for an empty string. */
function basename(p: string): string {
  if (!p) return ''
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** Best-effort host from a URL via regex (no URL/DOM dependency). Falls back to the input. */
function host(u: string): string {
  const m = u.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i)
  return m ? m[1] : u
}

/** Truncate with an ellipsis when longer than n. */
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
