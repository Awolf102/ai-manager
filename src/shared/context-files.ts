// Pure helpers for project context files (no node/DOM imports — unit-tested in plain Node,
// used by the main process and the agent runner). The .ai-manager/context/ path is the
// documented location agents read; it mirrors AIM_DIR in project-store.ts.
import type { ContextFile } from './types'

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic']

/** True when the file name's extension is a known image type. */
export function isImageName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return false
  return IMAGE_EXT.includes(name.slice(dot + 1).toLowerCase())
}

/** A name not already in `existing`, suffixing "-2", "-3", … before the extension on collision. */
export function uniqueContextName(existing: string[], original: string): string {
  const taken = new Set(existing)
  if (!taken.has(original)) return original
  const dot = original.lastIndexOf('.')
  const stem = dot === -1 ? original : original.slice(0, dot)
  const ext = dot === -1 ? '' : original.slice(dot)
  let i = 2
  while (taken.has(`${stem}-${i}${ext}`)) i++
  return `${stem}-${i}${ext}`
}

/** The system-prompt section listing the user's reference files, or '' when there are none. */
export function buildContextBlock(context: ContextFile[]): string {
  if (!context || context.length === 0) return ''
  const lines = context.map((c) => {
    const tag = c.isImage ? ' (image)' : ''
    const note = c.note.trim() ? ` — ${c.note.trim()}` : ''
    return `- .ai-manager/context/${c.fileName}${tag}${note}`
  })
  return [
    '## Reference context the user provided',
    'The user attached these reference files for this project. Read the relevant ones before you plan, build, or review (the Read tool shows images). Treat them as authoritative context for the goal.',
    ...lines
  ].join('\n')
}
