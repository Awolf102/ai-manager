// Pure parsing for lateral peer handoffs (Phase 3). No node/DOM imports — unit-tested
// in plain Node. Extracts a {to, ask} consult request from an agent's output and
// resolves the target against the asker's reachable handoff peers.

export interface HandoffRequest {
  peerId: string
  ask: string
}

/**
 * Parse a handoff request from agent output, or null. Prefers a ```handoff fenced
 * block; resolves `to` to a peer id by exact id then case-insensitive name. Returns
 * null when absent, malformed, `ask` is empty, or `to` is not a reachable peer.
 */
export function parseHandoff(
  text: string,
  peers: { id: string; name: string }[]
): HandoffRequest | null {
  const obj = extractHandoffObject(text)
  if (!obj) return null
  const to = String(obj.to ?? '').trim()
  const ask = String(obj.ask ?? '').trim()
  if (!to || !ask) return null
  const peer =
    peers.find((p) => p.id === to) ?? peers.find((p) => p.name.toLowerCase() === to.toLowerCase())
  if (!peer) return null
  return { peerId: peer.id, ask }
}

/** The last ```handoff fenced JSON object that has a `to` or `ask` field, or null. */
function extractHandoffObject(text: string): { to?: unknown; ask?: unknown } | null {
  const blocks = [...text.matchAll(/```handoff\s*([\s\S]*?)```/gi)].map((m) => m[1])
  for (let i = blocks.length - 1; i >= 0; i--) {
    const parsed = tryParseObject(blocks[i])
    if (parsed && ('to' in parsed || 'ask' in parsed)) return parsed
  }
  return null
}

function tryParseObject(s: string): { to?: unknown; ask?: unknown } | null {
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const o = JSON.parse(s.slice(start, end + 1))
    return o && typeof o === 'object' ? (o as { to?: unknown; ask?: unknown }) : null
  } catch {
    return null
  }
}
