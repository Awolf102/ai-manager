export interface LayoutNode {
  id: string
  kind: 'orchestrator' | 'manager' | 'worker'
}
export interface LayoutEdge {
  source: string
  target: string
  kind?: 'report' | 'handoff'
  order?: number | null
}
export interface Positioned {
  id: string
  position: { x: number; y: number }
}

const CARD_W = 200
const COL_GAP = 48
const SLOT = CARD_W + COL_GAP // horizontal slot per leaf
const ROW_GAP = 150 // vertical gap between layers
const STAGGER = 46 // alternating y offset for fanned siblings
const ARCH_GAP = 150 // how far above the orchestrator direct workers sit

export function octopusLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Positioned[] {
  const ids = nodes.map((n) => n.id)
  const idSet = new Set(ids)
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]))

  // report children only (handoff ignored); ordered by `order` (nulls last) then input order
  const childrenOf = new Map<string, string[]>()
  const hasParent = new Set<string>()
  edges
    .filter((e) => e.kind !== 'handoff' && idSet.has(e.source) && idSet.has(e.target))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.order ?? Infinity) - (b.e.order ?? Infinity) || a.i - b.i)
    .forEach(({ e }) => {
      if (!childrenOf.has(e.source)) childrenOf.set(e.source, [])
      childrenOf.get(e.source)!.push(e.target)
      hasParent.add(e.target)
    })

  const roots = ids.filter((id) => !hasParent.has(id))

  // Reduce the report graph to a forest: each node is kept under its first-seen
  // parent only. This drops cycle back-edges and second parents so the recursive
  // layout below can never re-enter a node (no infinite recursion / double-place).
  // Nodes left unreachable (e.g. a pure A<->B cycle with no root) fall to the
  // defensive trailing row at the end.
  const treeChildren = new Map<string, string[]>()
  const seen = new Set<string>(roots)
  const buildTree = (id: string): void => {
    for (const c of childrenOf.get(id) ?? []) {
      if (seen.has(c)) continue
      seen.add(c)
      if (!treeChildren.has(id)) treeChildren.set(id, [])
      treeChildren.get(id)!.push(c)
      buildTree(c)
    }
  }
  for (const r of roots) buildTree(r)
  const children = (id: string): string[] => treeChildren.get(id) ?? []

  const pos = new Map<string, { x: number; y: number }>()
  let leafCursor = 0

  // tidy-tree: leaves take sequential x slots; parents center over their children.
  // depth 0 = the row directly under the orchestrator.
  const place = (id: string, depth: number, siblingIndex: number): { minX: number; maxX: number } => {
    const kids = children(id)
    const y = ROW_GAP * (depth + 1)
    if (kids.length === 0) {
      const x = leafCursor * SLOT
      leafCursor++
      pos.set(id, { x, y: y + (siblingIndex % 2) * STAGGER })
      return { minX: x, maxX: x }
    }
    let minX = Infinity
    let maxX = -Infinity
    kids.forEach((k, i) => {
      const r = place(k, depth + 1, i)
      minX = Math.min(minX, r.minX)
      maxX = Math.max(maxX, r.maxX)
    })
    pos.set(id, { x: (minX + maxX) / 2, y })
    return { minX, maxX }
  }

  const primary = roots.find((id) => kindOf.get(id) === 'orchestrator') ?? roots[0] ?? null

  if (primary) {
    const kids = children(primary)
    const directWorkers = kids.filter((k) => kindOf.get(k) === 'worker' && children(k).length === 0)
    const subtreeRoots = kids.filter((k) => !directWorkers.includes(k))

    let minX = Infinity
    let maxX = -Infinity
    subtreeRoots.forEach((k, i) => {
      const r = place(k, 0, i)
      minX = Math.min(minX, r.minX)
      maxX = Math.max(maxX, r.maxX)
    })
    const centerX = subtreeRoots.length ? (minX + maxX) / 2 : leafCursor * SLOT
    pos.set(primary, { x: centerX, y: 0 })
    if (!subtreeRoots.length) leafCursor++ // lone orchestrator still consumes a slot

    directWorkers.forEach((w, i) => {
      const offset = i - (directWorkers.length - 1) / 2
      pos.set(w, { x: centerX + offset * SLOT, y: -ARCH_GAP })
    })
  }

  // other roots / disconnected trees → laid out to the right (their roots at the managers' row)
  for (const r of roots) {
    if (r === primary || pos.has(r)) continue
    place(r, 0, 0)
  }
  // defensive: anything still unplaced (orphans, pure-cycle nodes) → trailing slot
  for (const id of ids) {
    if (pos.has(id)) continue
    pos.set(id, { x: leafCursor * SLOT, y: ROW_GAP })
    leafCursor++
  }

  return ids.map((id) => ({ id, position: pos.get(id) ?? { x: 0, y: 0 } }))
}
