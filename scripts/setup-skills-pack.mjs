#!/usr/bin/env node
// Populate the AI Manager skills pack: create the plugin manifest, install Playwright
// (incl. Chromium), and copy each bare design skill into <pack>/skills/.
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, cpSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const pack = process.argv[2] || join(homedir(), '.ai-manager', 'skills-pack')
const skillsDir = join(pack, 'skills')
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' })

mkdirSync(join(pack, '.claude-plugin'), { recursive: true })
mkdirSync(skillsDir, { recursive: true })
writeFileSync(
  join(pack, '.claude-plugin', 'plugin.json'),
  JSON.stringify({ name: 'ai-manager-skills-pack', version: '1.0.0', description: 'AI Manager curated always-available skills' }, null, 2)
)

// --- Playwright (known layout) ---
const pwTmp = join(tmpdir(), `pw-skill-${process.pid}`)
rmSync(pwTmp, { recursive: true, force: true })
run(`git clone --depth 1 https://github.com/lackeyjb/playwright-skill.git "${pwTmp}"`)
cpSync(join(pwTmp, 'skills', 'playwright-skill'), join(skillsDir, 'playwright-skill'), { recursive: true })
run('npm run setup', join(skillsDir, 'playwright-skill')) // npm install + npx playwright install chromium
rmSync(pwTmp, { recursive: true, force: true })

// --- Design skills: run each installer in a temp project, copy resulting .claude/skills/* ---
// (impeccable's `/impeccable init` is a Claude Code slash command; run it once yourself if its
//  setup needs it. This copies whatever skill folders the installers emit.)
const designInstalls = [
  'npx -y skills add emilkowalski/skill',
  'npx -y skills add Leonxlnx/taste-skill',
  'npx -y impeccable install',
  'npx -y uipro init --ai claude'
]
for (const cmd of designInstalls) {
  const t = join(tmpdir(), `skill-${process.pid}-${Math.abs(hash(cmd))}`)
  rmSync(t, { recursive: true, force: true })
  mkdirSync(t, { recursive: true })
  try {
    run(cmd, t)
    const src = join(t, '.claude', 'skills')
    if (existsSync(src)) {
      for (const name of readdirSync(src)) cpSync(join(src, name), join(skillsDir, name), { recursive: true })
    } else {
      console.warn(`[warn] "${cmd}" produced no .claude/skills/ in ${t} — inspect and copy manually.`)
    }
  } catch (e) {
    console.warn(`[warn] "${cmd}" failed: ${e.message} — skipping; install manually if needed.`)
  } finally {
    rmSync(t, { recursive: true, force: true })
  }
}

// tiny stable hash for temp dir names (Math.random is fine here; not in the app)
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h }

console.log(`\nSkills pack ready at: ${pack}`)
console.log('Skills installed:', existsSync(skillsDir) ? readdirSync(skillsDir).join(', ') : '(none)')
