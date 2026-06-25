// Filesystem-safe slug rules — the single source of truth, used by project-store
// (agent dirs) and team import (uniquifying imported agents). Pure.

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
  )
}

export function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = base
  let i = 2
  while (taken.has(slug)) slug = `${base}-${i++}`
  return slug
}
