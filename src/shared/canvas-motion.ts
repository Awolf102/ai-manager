// Pure helper for canvas entrance motion (no node/DOM imports — unit-tested in plain Node).
// Mirrors octopus-layout.ts's forest/cycle handling: depth from the reporting tree, roots first.

/** Per-node entrance delay (ms), staggered by reporting-tree depth (roots = 0). Handoff edges ignored. */
export function entranceDelays(
  nodes: { id: string }[],
  edges: { source: string; target: string; kind?: 'report' | 'handoff' }[],
  stepMs = 50
): Record<string, number> {
  const MAX_DEPTH = 6
  const ids = new Set(nodes.map((n) => n.id))
  const children = new Map<string, string[]>()
  const hasParent = new Set<string>()
  for (const e of edges) {
    if (e.kind === 'handoff') continue
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    if (!children.has(e.source)) children.set(e.source, [])
    children.get(e.source)!.push(e.target)
    hasParent.add(e.target)
  }
  // roots = nodes with no incoming report edge
  const visited = new Set<string>()
  const depth: Record<string, number> = {}
  const queue: { id: string; d: number }[] = nodes
    .filter((nd) => !hasParent.has(nd.id))
    .map((nd) => ({ id: nd.id, d: 0 }))
  while (queue.length) {
    const { id, d } = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    depth[id] = d
    for (const c of children.get(id) ?? []) {
      if (!visited.has(c)) queue.push({ id: c, d: d + 1 })
    }
  }
  const out: Record<string, number> = {}
  for (const nd of nodes) out[nd.id] = Math.min(depth[nd.id] ?? 0, MAX_DEPTH) * stepMs
  return out
}
