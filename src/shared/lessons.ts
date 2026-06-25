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

/** Cleaned raw lesson bullets under `## Lessons` (marker still attached). Comments
 * and whitespace are normalized; blank lines and the `(none yet)` placeholder are dropped. */
export function lessonBullets(memory: string): string[] {
  const lines = memory.split('\n')
  const start = lines.findIndex((l) => /^##\s+lessons\s*$/i.test(l.trim()))
  if (start === -1) return []
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (/^##\s+/.test(raw)) break // next section
    if (!raw.startsWith('- ')) continue
    const bullet = raw.slice(2).replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ').trim()
    if (!bullet || /^\(none yet\)$/i.test(bullet)) continue
    out.push(bullet)
  }
  return out
}

/** All `portable`-scoped lesson texts (uncapped, marker stripped). `project` and
 * untagged are excluded — the transfer side of the portable/project asymmetry. */
export function portableLessons(memory: string): string[] {
  return lessonBullets(memory)
    .map((b) => parseLessonBullet(b))
    .filter((l) => l.scope === 'portable')
    .map((l) => l.text)
}
