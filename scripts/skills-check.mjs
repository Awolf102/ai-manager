#!/usr/bin/env node
// Sanity-check which TRUSTED skill plugins the app will discover.
//   npm run skills:check
// Reads ~/.claude/plugins metadata the same way main/engine/skill-discovery.ts does.
// Filesystem/metadata check only — live loading is proven only by running the app.

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = join(homedir(), '.claude', 'plugins')
const read = (f) => {
  try {
    return JSON.parse(readFileSync(join(dir, f), 'utf8'))
  } catch {
    return null
  }
}
const THRESHOLD = 100000 // mirrors the DEFAULT skillInstallThreshold; a user's Settings value may differ
const markets = read('known_marketplaces.json') ?? {}
const cache = read('plugin-catalog-cache.json')
const plugins = cache?.catalog?.plugins ?? {}

const trusted = (author, repo, installs) =>
  String(author ?? '').toLowerCase() === 'anthropic' ||
  String(repo ?? '').toLowerCase().startsWith('anthropics/') ||
  (installs ?? 0) >= THRESHOLD

console.log('\n  Trusted skill plugins the app will discover\n')
let n = 0
for (const [key, e] of Object.entries(plugins)) {
  const at = key.lastIndexOf('@')
  const id = key.slice(0, at)
  const marketplace = key.slice(at + 1)
  const repo = markets[marketplace]?.source?.repo
  const author = e.marketplace_entry?.author?.name
  const installs = e.unique_installs ?? 0
  if (!trusted(author, repo, installs)) continue
  const loc = markets[marketplace]?.installLocation
  const onDisk = loc && (existsSync(join(loc, id, 'skills')) || existsSync(join(loc, 'plugins', id, 'skills')))
  const skills = (e.components?.skills ?? []).map((s) => s.name)
  if (!skills.length) continue
  n++
  console.log(`  ${onDisk ? '✓' : '·'} ${id}  (${author || marketplace}, ${installs} installs, ${skills.length} skills)${onDisk ? '' : '  [not on disk]'}`)
}
if (n === 0) console.log('  (none — add a marketplace: claude plugin marketplace add anthropics/knowledge-work-plugins)')
console.log('')
