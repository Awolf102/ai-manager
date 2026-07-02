// Pure .env parsing/serialization + plain-English labels. No node/DOM imports —
// unit-tested in plain Node. Used by the AI-free env editor (Phase-3 #13).

export interface EnvEntry {
  key: string
  value: string
}

const KV = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

function unquote(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    const inner = v.slice(1, -1)
    return v[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n') : inner
  }
  return v
}

/** Parse a single line into a KV entry, or null for comments/blank/non-KV lines. */
function parseKvLine(line: string): EnvEntry | null {
  if (/^\s*#/.test(line) || /^\s*$/.test(line)) return null
  const m = KV.exec(line)
  if (!m) return null
  return { key: m[1], value: unquote(m[2]) }
}

/** KV entries for display: first-appearance order, last value wins. */
export function parseEnvEntries(text: string): EnvEntry[] {
  const m = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const kv = parseKvLine(line)
    if (kv) m.set(kv.key, kv.value)
  }
  return [...m].map(([key, value]) => ({ key, value }))
}

function needsQuote(value: string): boolean {
  return /[\s#="'`]/.test(value) || value.includes('\n')
}

function formatKv(key: string, value: string): string {
  if (value === '') return `${key}=`
  if (needsQuote(value)) {
    return `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
  }
  return `${key}=${value}`
}

/** Reconcile `desired` into the existing text, preserving comments/blanks + retained-key
 *  positions. Retained key → rewrite in place; missing key → drop; new key → append. */
export function applyEnvEdits(existingText: string, desired: EnvEntry[]): string {
  const desiredMap = new Map(desired.map((e) => [e.key, e.value]))
  const seen = new Set<string>()
  const lines = existingText === '' ? [] : existingText.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    const kv = parseKvLine(line)
    if (!kv) {
      out.push(line)
      continue
    }
    if (seen.has(kv.key)) continue // drop duplicate lines of an already-handled key
    if (desiredMap.has(kv.key)) {
      out.push(formatKv(kv.key, desiredMap.get(kv.key)!))
      seen.add(kv.key)
    } else {
      seen.add(kv.key) // deleted — drop this line (and future dups)
    }
  }
  for (const e of desired) {
    if (!seen.has(e.key)) {
      out.push(formatKv(e.key, e.value))
      seen.add(e.key)
    }
  }
  const result = out.join('\n')
  return result.length && !result.endsWith('\n') ? result + '\n' : result
}

const LABELS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'Anthropic API key',
  OPENAI_API_KEY: 'OpenAI API key',
  DATABASE_URL: 'Database URL',
  PORT: 'Port',
  NODE_ENV: 'Environment',
  JWT_SECRET: 'JWT secret',
  REDIS_URL: 'Redis URL',
  STRIPE_SECRET_KEY: 'Stripe secret key',
  STRIPE_PUBLISHABLE_KEY: 'Stripe publishable key',
  SUPABASE_URL: 'Supabase URL',
  SUPABASE_ANON_KEY: 'Supabase anon key'
}

const ACRONYMS = new Set([
  'API', 'URL', 'URI', 'ID', 'DB', 'JWT', 'SDK', 'HTTP', 'HTTPS', 'SSH', 'AWS',
  'GCP', 'S3', 'IP', 'SSL', 'TLS', 'CORS', 'CDN', 'UUID', 'CI', 'CD'
])

/** Plain-English label for a key: curated map, else humanized (acronyms upper-cased). */
export function labelFor(key: string): string {
  if (LABELS[key]) return LABELS[key]
  const words = key.split('_').filter(Boolean)
  if (words.length === 0) return key
  return words
    .map((w, i) => {
      const up = w.toUpperCase()
      if (ACRONYMS.has(up)) return up
      const lower = w.toLowerCase()
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
    })
    .join(' ')
}
