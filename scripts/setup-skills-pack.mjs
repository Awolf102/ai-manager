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

// --- Design skills: install into ONE temp dir with the correct non-interactive flags,
// then copy only the CURATED set into the pack. The `skills` CLI agent id is `claude-code`
// (not `claude`); uipro ships as the `uipro-cli` npm package. impeccable's `/impeccable init`
// is a Claude Code slash command — run it once yourself for its full design context.
const SELECTED = [
  'emil-design-eng',            // emilkowalski/skill
  'review-animations',          // emilkowalski/skill
  'design-taste-frontend',      // Leonxlnx/taste-skill
  'high-end-visual-design',     // Leonxlnx/taste-skill
  'redesign-existing-projects', // Leonxlnx/taste-skill
  'ui-ux-pro-max',              // uipro-cli
  'impeccable'                  // npx impeccable install
]
const designCmds = [
  'npx -y skills add emilkowalski/skill -y --copy --skill "*" --agent claude-code',
  'npx -y skills add Leonxlnx/taste-skill -y --copy --skill "*" --agent claude-code',
  'npx -y uipro-cli init --ai claude --force',
  'npx -y impeccable install'
]
const dTmp = join(tmpdir(), `skills-design-${process.pid}`)
rmSync(dTmp, { recursive: true, force: true })
mkdirSync(dTmp, { recursive: true })
for (const cmd of designCmds) {
  try {
    run(cmd, dTmp)
  } catch (e) {
    console.warn(`[warn] "${cmd}" failed: ${e.message} — skipping; install manually if needed.`)
  }
}
const dSrc = join(dTmp, '.claude', 'skills')
for (const name of SELECTED) {
  const from = join(dSrc, name)
  if (existsSync(from)) {
    cpSync(from, join(skillsDir, name), { recursive: true })
    console.log(`  + ${name}`)
  } else {
    console.warn(`[warn] selected skill "${name}" not found in ${dSrc} — install it manually.`)
  }
}
rmSync(dTmp, { recursive: true, force: true })

console.log(`\nSkills pack ready at: ${pack}`)
console.log('Skills installed:', existsSync(skillsDir) ? readdirSync(skillsDir).join(', ') : '(none)')
