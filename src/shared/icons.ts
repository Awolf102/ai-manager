// Pure name -> icon-key mapping. Keep this free of React/lucide imports so the
// main process can compute an agent's icon when scaffolding the graph; the
// renderer maps the key to an actual lucide component (see iconComponents.tsx).

export type IconKey =
  | 'database'
  | 'palette'
  | 'cpu'
  | 'code'
  | 'server'
  | 'flask'
  | 'clipboard'
  | 'crown'
  | 'shield'
  | 'pencil'
  | 'search'
  | 'bot'
  | 'chart'
  | 'globe'
  | 'wrench'
  | 'bug'
  | 'book'

const RULES: { pattern: RegExp; icon: IconKey }[] = [
  { pattern: /data|sql|etl|warehouse|analyt|pipeline/i, icon: 'database' },
  { pattern: /design|ui|ux|visual|\bart\b|brand|creativ/i, icon: 'palette' },
  { pattern: /front.?end|web\b|css|react|html/i, icon: 'globe' },
  { pattern: /back.?end|server|\bapi\b|infra/i, icon: 'server' },
  { pattern: /devops|build|deploy|tooling/i, icon: 'wrench' },
  { pattern: /\bml\b|\bai\b|model|machine.?learn|llm/i, icon: 'cpu' },
  { pattern: /research|scientist|\bstudy\b/i, icon: 'flask' },
  { pattern: /\bqa\b|test|quality|bug/i, icon: 'bug' },
  { pattern: /security|\bsec\b|auth|threat/i, icon: 'shield' },
  { pattern: /writ|content|\bdoc\b|copy|editor/i, icon: 'pencil' },
  { pattern: /search|scout|\bfind\b|explor/i, icon: 'search' },
  { pattern: /chart|report|metric|dashboard/i, icon: 'chart' },
  { pattern: /book|knowledge|librar/i, icon: 'book' },
  { pattern: /software|engineer|develop|program|coder?/i, icon: 'code' }
]

const KIND_FALLBACK: Record<string, IconKey> = {
  orchestrator: 'crown',
  manager: 'clipboard',
  worker: 'bot'
}

/** Resolve an icon key from an agent name, falling back to its kind, then 'bot'. */
export function iconForName(name: string, kind?: string): IconKey {
  for (const r of RULES) if (r.pattern.test(name)) return r.icon
  if (kind && KIND_FALLBACK[kind]) return KIND_FALLBACK[kind]
  return 'bot'
}
