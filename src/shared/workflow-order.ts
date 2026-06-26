// Pure workflow-ordering logic for the canvas (Phase 1). No node/DOM imports —
// unit-tested in plain Node. `deriveOrderDeps` runs at route time (order → task deps);
// `applyOrderClick` runs in the canvas (stamp/clear + re-pack).

/**
 * Turn top-level edge ordering into task dependencies. For the orchestrator's
 * direct-child edges that carry an `order`, every task under the team ordered k
 * gains a dependency on every task under teams ordered < k. Returns a map of
 * taskId -> extra dependency taskIds (only tasks that gain deps). {} when nothing
 * is ordered, so callers add no deps and behavior is unchanged.
 */
export function deriveOrderDeps(
  edges: { source: string; target: string; order?: number }[],
  orchestratorId: string,
  tasks: { id: string; ownerId: string | null }[]
): Record<string, string[]> {
  const children = new Map<string, string[]>()
  for (const e of edges) {
    const list = children.get(e.source) ?? []
    list.push(e.target)
    children.set(e.source, list)
  }
  const teams = edges
    .filter((e) => e.source === orchestratorId && typeof e.order === 'number')
    .map((e) => ({ root: e.target, order: e.order as number }))
    .sort((a, b) => a.order - b.order)
  if (teams.length === 0) return {}

  const subtree = (root: string): Set<string> => {
    const seen = new Set<string>([root])
    const queue = [root]
    while (queue.length) {
      const n = queue.shift()!
      for (const c of children.get(n) ?? []) {
        if (!seen.has(c)) {
          seen.add(c)
          queue.push(c)
        }
      }
    }
    return seen
  }

  const teamTasks = teams.map((t) => {
    const nodes = subtree(t.root)
    const ids = tasks.filter((x) => x.ownerId !== null && nodes.has(x.ownerId)).map((x) => x.id)
    return ids
  })

  const out: Record<string, string[]> = {}
  for (let k = 0; k < teamTasks.length; k++) {
    const earlier = [...new Set(teamTasks.slice(0, k).flat())]
    if (earlier.length === 0) continue
    for (const id of teamTasks[k]) out[id] = earlier
  }
  return out
}

/**
 * Stamp execution order onto a top-level edge by id. If the edge is unordered,
 * it gets the next number (max existing + 1). If it already has an order, the
 * order is cleared and higher orders re-pack down to stay contiguous (1..N).
 * Caller must pre-validate that `clickedId` is an orderable (top-level) edge.
 */
export function applyOrderClick<E extends { id: string; order?: number }>(
  edges: E[],
  clickedId: string
): E[] {
  const clicked = edges.find((e) => e.id === clickedId)
  if (!clicked) return edges
  if (typeof clicked.order === 'number') {
    const cleared = clicked.order
    return edges.map((e) =>
      e.id === clickedId
        ? { ...e, order: undefined }
        : typeof e.order === 'number' && e.order > cleared
          ? { ...e, order: e.order - 1 }
          : e
    )
  }
  const max = edges.reduce((m, e) => (typeof e.order === 'number' && e.order > m ? e.order : m), 0)
  return edges.map((e) => (e.id === clickedId ? { ...e, order: max + 1 } : e))
}
