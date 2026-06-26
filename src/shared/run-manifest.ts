// Pure prompt-building + output-parsing for the Run-result manifest detection.
// No node/DOM imports — unit-tested in plain Node, used by the engine.
import type { RunManifest } from './types'

const TYPES: RunManifest['type'][] = ['web', 'static', 'cli', 'library', 'unknown']

export function detectManifestPrompt(goal: string, projectFiles: string, lastRunReport: string): string {
  return `You are figuring out how to LAUNCH and OPEN the app your team just built in this project, so a single button can run it. Inspect the project (you may read files) and report a single manifest.

GOAL (context only — the built artifact already exists on disk):
${goal || '(none given)'}

PROJECT FILES (a digest; read more if you need to):
${projectFiles || '(none)'}

MOST RECENT RUN REPORT (how the team described what they built; may mention the start command/port):
${lastRunReport || '(none)'}

Decide:
- "type": "web" (a server you start, e.g. vite/flask/express), "static" (HTML/CSS/JS with no server), "cli", "library", or "unknown".
- "startCommand": the exact shell command to start it from the project root (e.g. "npm run dev", "flask run", "python3 -m http.server 8000"). For a "static" site with no server, emit a SERVING command (python3 -m http.server <port>) rather than a file path, so relative asset paths resolve the same way over http://localhost. For "cli"/"library"/"unknown" you may leave it "".
- "port": the port it listens on as a number (pick the framework's conventional port if not configured: vite 5173, flask 5000, http.server 8000, express often 3000). Omit if there is no server.
- "path": the entry path to open, defaulting to "/".
- "notes": one short line on why you chose this, or any caveat.

Reply with ONLY this JSON code block (no other text):
\`\`\`json
{ "type": "web", "startCommand": "npm run dev", "port": 5173, "path": "/", "notes": "" }
\`\`\``
}

export function parseManifest(text: string): RunManifest | null {
  const parsed = parseJsonBlock(text)
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  const rawType = String(o.type ?? '')
  const type = (TYPES as string[]).includes(rawType) ? (rawType as RunManifest['type']) : 'unknown'
  const startCommand = String(o.startCommand ?? '').trim()
  const portNum = Number(o.port)
  const port = Number.isInteger(portNum) && portNum > 0 ? portNum : undefined
  let path = String(o.path ?? '/').trim() || '/'
  if (!path.startsWith('/')) path = '/' + path
  const notes = o.notes != null && String(o.notes).trim() ? String(o.notes).trim() : undefined
  return { type, startCommand, ...(port !== undefined ? { port } : {}), path, ...(notes ? { notes } : {}) }
}

function parseJsonBlock(text: string): unknown {
  const candidates: string[] = []
  const fences = [...text.matchAll(/\x60{3}(?:json)?\s*([\s\S]*?)\x60{3}/gi)]
  // (\x60 = backtick; matches a ```json … ``` fenced block without literal backticks here)
  if (fences.length) candidates.push(fences[fences.length - 1][1])
  candidates.push(text)
  for (const c of candidates) {
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1))
    } catch {
      // try the next candidate
    }
  }
  return null
}
