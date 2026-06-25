#!/usr/bin/env node
// Friendly checkpoint inspector for the AI Manager smoke test.
//   npm run smoke:check                 → auto-finds your most-recently-opened project
//   npm run smoke:check -- /path/to/dir → inspect a specific project folder
//
// Tells you, in plain English, whether a run checkpoint exists and its state.

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The app records opened projects here; the first entry is the most recent. */
function recentProjectPath() {
  const files = [
    'Library/Application Support/ai-manager/recent-projects.json',
    'Library/Application Support/Electron/recent-projects.json',
    '.config/ai-manager/recent-projects.json',
    '.config/Electron/recent-projects.json'
  ].map((p) => join(homedir(), p))
  for (const f of files) {
    try {
      const list = JSON.parse(readFileSync(f, 'utf8'))
      if (Array.isArray(list) && list[0]?.path) return list[0].path
    } catch {
      // try the next candidate
    }
  }
  return null
}

const project = process.argv[2] || recentProjectPath() || process.cwd()
const dir = join(project, '.ai-manager', 'runs', '.checkpoints')

console.log(`\n  Project:     ${project}`)
console.log(`  Checkpoints: ${dir}\n`)

let files
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.json'))
} catch {
  console.log('  (no checkpoint folder yet — no orchestration run has started in this project)\n')
  process.exit(0)
}

if (files.length === 0) {
  console.log('  ✓ No active checkpoint — the app is idle, or the last run finished cleanly.\n')
  process.exit(0)
}

for (const f of files) {
  try {
    const s = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    console.log(`  ● ${f}`)
    console.log(`      status: ${s.status}   phase: ${s.phase}   cursor: ${s.cursor}`)
    const tasks = Object.values(s.tasks || {})
    if (tasks.length === 0) {
      console.log('      (no tasks yet — still planning)')
    } else {
      for (const t of tasks) {
        const title = t.task?.title ?? t.task?.id ?? '?'
        console.log(`      • ${title}  [${t.status}]  → ${t.ownerId || 'unassigned'}`)
      }
    }
    console.log('')
  } catch (e) {
    console.log(`  ! could not read ${f}: ${e.message}\n`)
  }
}

console.log('  Tip: re-run during a run to watch tasks flip to "done"; after a clean')
console.log('  finish it should say "No active checkpoint"; after a crash it stays "running".\n')
