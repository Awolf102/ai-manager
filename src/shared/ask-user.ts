// Pure parsing for human-in-the-loop user requests (Stage 3). No node/DOM imports —
// unit-tested in plain Node. Mirrors shared/handoff.ts: extracts a {question} ask
// from a worker's output. Workers-only; gated by maxUserRequests in the engine.

export interface AskUserRequest {
  question: string
}

/**
 * Parse an ask-user request from worker output, or null. Prefers the LAST own-line
 * ```ask fenced JSON object with a `question` field. Returns null when absent,
 * malformed, or `question` is empty/whitespace. The closing fence must be on its own
 * line so a ``` inside the JSON value does not end the block early.
 */
export function parseAskUser(text: string): AskUserRequest | null {
  const obj = extractAskObject(text)
  if (!obj) return null
  const question = String(obj.question ?? '').trim()
  if (!question) return null
  return { question }
}

function extractAskObject(text: string): { question?: unknown } | null {
  const blocks = [...text.matchAll(/```ask[^\n]*\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1])
  for (let i = blocks.length - 1; i >= 0; i--) {
    const parsed = tryParseObject(blocks[i])
    if (parsed && 'question' in parsed) return parsed
  }
  return null
}

function tryParseObject(s: string): { question?: unknown } | null {
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const o = JSON.parse(s.slice(start, end + 1))
    return o && typeof o === 'object' ? (o as { question?: unknown }) : null
  } catch {
    return null
  }
}
