// Pure parsing for headless follow-through (Phase-3 #12, cycle 1). No node/DOM
// imports — unit-tested in plain Node. Mirrors shared/ask-user.ts: extracts every
// ```followup fenced JSON object carrying a {summary, decision}. Workers-only;
// gated by followThrough === 'headless' in the engine. (Cycle 2 adds question/options.)

export interface FollowUp {
  summary: string
  decision: string
}

/** Parse every own-line ```followup fenced JSON object with non-empty summary AND
 *  decision, in document order. The closing fence must be on its own line so a ```
 *  inside a JSON value does not end the block early. */
export function parseFollowUps(text: string): FollowUp[] {
  const blocks = [...text.matchAll(/```followup[^\n]*\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1])
  const out: FollowUp[] = []
  for (const b of blocks) {
    const o = tryParseObject(b)
    if (!o) continue
    const summary = String(o.summary ?? '').trim()
    const decision = String(o.decision ?? '').trim()
    if (summary && decision) out.push({ summary, decision })
  }
  return out
}

export interface FollowUpAsk {
  summary: string
  question: string
  options: string[]
}

/** Parse the LAST own-line ```followup block carrying a non-empty summary + question.
 *  options optional → array of non-empty strings capped to 4. null when absent/malformed. */
export function parseFollowUpAsk(text: string): FollowUpAsk | null {
  const blocks = [...text.matchAll(/```followup[^\n]*\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1])
  for (let i = blocks.length - 1; i >= 0; i--) {
    const o = tryParseObject(blocks[i]) as { summary?: unknown; question?: unknown; options?: unknown } | null
    if (!o) continue
    const summary = String(o.summary ?? '').trim()
    const question = String(o.question ?? '').trim()
    if (!summary || !question) continue
    const options = Array.isArray(o.options)
      ? o.options.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 4)
      : []
    return { summary, question, options }
  }
  return null
}

function tryParseObject(s: string): { summary?: unknown; decision?: unknown } | null {
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const o = JSON.parse(s.slice(start, end + 1))
    return o && typeof o === 'object' ? (o as { summary?: unknown; decision?: unknown }) : null
  } catch {
    return null
  }
}
