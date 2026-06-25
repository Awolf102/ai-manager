#!/usr/bin/env node
// Sanity-check that the per-agent skill plugins are installed where the app
// expects, and list the skills each one offers.
//   npm run skills:check
//
// This is a filesystem check only — it confirms the runner's plugin paths
// resolve to real installed plugins. It does NOT prove the SDK loads them at
// runtime; only running the app does that.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Mirrors resolvePluginPath() in src/main/engine/agent-runner.ts
const base = join(homedir(), '.claude', 'plugins', 'marketplaces')
const PLUGINS = [
  { id: 'engineering', path: join(base, 'knowledge-work-plugins', 'engineering') },
  { id: 'data', path: join(base, 'knowledge-work-plugins', 'data') },
  { id: 'design', path: join(base, 'knowledge-work-plugins', 'design') },
  {
    id: 'frontend-design',
    path: join(base, 'claude-plugins-official', 'plugins', 'frontend-design')
  }
]

function skillNames(skillsDir) {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      try {
        const m = readFileSync(join(skillsDir, d.name, 'SKILL.md'), 'utf8').match(/^name:\s*(.+)$/m)
        return m ? m[1].trim() : d.name
      } catch {
        return d.name
      }
    })
}

console.log('\n  Per-agent skills — plugin availability check\n')
let missing = 0
for (const p of PLUGINS) {
  const skillsDir = join(p.path, 'skills')
  if (!existsSync(skillsDir)) {
    missing++
    console.log(`  ✗ ${p.id}  — MISSING`)
    console.log(`      expected at: ${p.path}`)
    continue
  }
  let names = []
  try {
    names = skillNames(skillsDir)
  } catch {
    // leave names empty
  }
  console.log(`  ✓ ${p.id}  (${names.length} skills)`)
  console.log(`      ${names.map((n) => `${p.id}:${n}`).join(', ')}`)
}

console.log('')
if (missing > 0) {
  console.log(`  ${missing} plugin(s) missing. For the Anthropic ones, add the marketplace:`)
  console.log('    claude plugin marketplace add anthropics/knowledge-work-plugins\n')
} else {
  console.log('  All skill plugins present. (Live loading is only proven by running the app.)\n')
}
console.log('  The catalog the app offers per agent: src/shared/skill-catalog.ts\n')
