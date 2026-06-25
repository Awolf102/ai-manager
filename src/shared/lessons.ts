// The portable/project-specific lesson marker convention — the SINGLE source of
// truth. Pure (no node/DOM imports) so it's unit-testable in plain Node and usable
// by both the engine and the renderer. Reflection, mergeMemory, lessonsDigest, and
// the future portable-team all go through these helpers.

export type LessonScope = 'portable' | 'project'

const SCOPE_MARKER = /^\[(portable|project)\]\s*/i

/** Strip a leading `[portable]`/`[project]` marker. `scope: null` = untagged/legacy. */
export function parseLessonBullet(raw: string): { scope: LessonScope | null; text: string } {
  const m = raw.match(SCOPE_MARKER)
  if (m) return { scope: m[1].toLowerCase() as LessonScope, text: raw.slice(m[0].length).trim() }
  return { scope: null, text: raw.trim() }
}

/** Render a lesson with its marker, for writing into memory.md. */
export function formatLessonBullet(scope: LessonScope, text: string): string {
  return `[${scope}] ${text.trim()}`
}
