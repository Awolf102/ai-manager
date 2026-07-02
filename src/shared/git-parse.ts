// Pure parsing of `git branch` output. No node/DOM imports — unit-tested in plain Node.
// Handles both `--format=%(refname:short)` (clean names) and plain `git branch`
// (with a leading '* '/'+ ' current/worktree marker + a "(HEAD detached…)" line).

export function parseBranchList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[*+]\s+/, '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('('))
}
