import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
  type NodeTypes
} from '@xyflow/react'
import AgentNode, { type AgentFlowNode } from './AgentNode'
import CanvasLegend from './CanvasLegend'
import CoachMarks from './CoachMarks'
import { useStore } from '../store'
import { applyOrderClick } from '../../shared/workflow-order'
import { octopusLayout } from '../../shared/octopus-layout'
import type { GraphEdge, ProjectGraph } from '../../shared/types'

const nodeTypes: NodeTypes = { agent: AgentNode }

function toNodes(graph: ProjectGraph): AgentFlowNode[] {
  return graph.nodes.map((a) => ({
    id: a.id,
    type: 'agent',
    position: a.position,
    data: { agent: a }
  }))
}

function toEdges(graph: ProjectGraph): Edge[] {
  return graph.edges.map((e) => {
    if (e.kind === 'handoff') {
      return { id: e.id, source: e.source, target: e.target, animated: false, className: 'edge-handoff' }
    }
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      animated: e.order == null,
      label: e.order != null ? String(e.order) : undefined,
      className: e.order != null ? 'edge-ordered' : undefined
    }
  })
}

export default function OrgChart() {
  const graph = useStore((s) => s.graph)!
  const setGraph = useStore((s) => s.setGraph)
  const patchPositions = useStore((s) => s.patchPositions)
  const select = useStore((s) => s.select)
  const requestConfirm = useStore((s) => s.requestConfirm)

  const [nodes, setNodes, onNodesChange] = useNodesState<AgentFlowNode>(toNodes(graph))
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toEdges(graph))

  // Re-seed the canvas when the node set or an agent's display fields change.
  // Position-only changes (dragging) don't alter the signature, so drags aren't
  // clobbered.
  const nodeSig = useMemo(
    () => graph.nodes.map((n) => `${n.id}:${n.name}:${n.icon}:${n.kind}`).join('|'),
    [graph.nodes]
  )
  useEffect(() => {
    setNodes(toNodes(graph))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeSig])

  const edgeSig = useMemo(
    () => graph.edges.map((e) => `${e.id}:${e.order ?? ''}:${e.kind ?? ''}`).join('|'),
    [graph.edges]
  )
  useEffect(() => {
    setEdges(toEdges(graph))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeSig])

  const applyLayout = useCallback(() => {
    const positioned = octopusLayout(
      graph.nodes.map((n) => ({ id: n.id, kind: n.kind })),
      graph.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind, order: e.order }))
    )
    const posById = new Map(positioned.map((p) => [p.id, p.position]))
    setNodes((prev) => prev.map((n) => (posById.has(n.id) ? { ...n, position: posById.get(n.id)! } : n)))
    patchPositions(positioned)
    void window.api.setNodePositions(positioned)
  }, [graph.nodes, graph.edges, setNodes, patchPositions])

  // Structure = node ids+kinds + the report edges (handoff edges & positions excluded).
  const structSig = useMemo(
    () =>
      graph.nodes.map((n) => `${n.id}:${n.kind}`).sort().join('|') +
      '#' +
      graph.edges
        .filter((e) => e.kind !== 'handoff')
        .map((e) => `${e.source}>${e.target}`)
        .sort()
        .join('|'),
    [graph.nodes, graph.edges]
  )
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return // respect saved positions on first load
    }
    applyLayout()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structSig])

  const persistEdges = useCallback(
    async (next: GraphEdge[]) => {
      setGraph(await window.api.setEdges(next))
    },
    [setGraph]
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return
      if (graph.edges.some((e) => e.source === c.source && e.target === c.target)) return
      void persistEdges([
        ...graph.edges,
        { id: `${c.source}->${c.target}`, source: c.source, target: c.target }
      ])
    },
    [graph.edges, persistEdges]
  )

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      const ids = new Set(deleted.map((d) => d.id))
      void persistEdges(graph.edges.filter((e) => !ids.has(e.id)))
    },
    [graph.edges, persistEdges]
  )

  const onBeforeDelete = useCallback(
    async ({ nodes: del }: { nodes: AgentFlowNode[]; edges: Edge[] }): Promise<boolean> => {
      if (del.length === 0) return true // edge-only deletion — no confirm
      const names = del.map((n) => graph.nodes.find((g) => g.id === n.id)?.name ?? 'agent')
      return requestConfirm({
        title: del.length === 1 ? 'Delete agent?' : `Delete ${del.length} agents?`,
        body: `${names.join(', ')} — saved memory will be moved to trash (.ai-manager/.trash), recoverable from disk.`,
        confirmLabel: 'Delete',
        danger: true
      })
    },
    [graph.nodes, requestConfirm]
  )

  const onNodesDelete = useCallback(
    async (deleted: { id: string }[]) => {
      let g = graph
      for (const d of deleted) g = await window.api.deleteAgent(d.id)
      setGraph(g)
      select(null)
    },
    [graph, setGraph, select]
  )

  const onNodeDragStop = useCallback(() => {
    const positions = nodes.map((n) => ({ id: n.id, position: n.position }))
    patchPositions(positions)
    void window.api.setNodePositions(positions)
  }, [nodes, patchPositions])

  const [orderMode, setOrderMode] = useState(false)
  const orchIds = useMemo(
    () => new Set(graph.nodes.filter((n) => n.kind === 'orchestrator').map((n) => n.id)),
    [graph.nodes]
  )

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)

  const onEdgeClick = useCallback<EdgeMouseHandler<Edge>>(
    (_, edge) => {
      if (orderMode) {
        if (orchIds.has(edge.source)) void persistEdges(applyOrderClick(graph.edges, edge.id))
        return
      }
      setSelectedEdgeId(edge.id)
    },
    [orderMode, orchIds, graph.edges, persistEdges]
  )

  const selectedEdge = graph.edges.find((e) => e.id === selectedEdgeId) ?? null
  const convertSelected = useCallback(() => {
    if (!selectedEdge) return
    const nextKind = selectedEdge.kind === 'handoff' ? 'report' : 'handoff'
    void persistEdges(
      graph.edges.map((e) => (e.id === selectedEdge.id ? { ...e, kind: nextKind, order: undefined } : e))
    )
  }, [selectedEdge, graph.edges, persistEdges])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onEdgesDelete={onEdgesDelete}
      onNodesDelete={onNodesDelete}
      onBeforeDelete={onBeforeDelete}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={(_, n) => select(n.id)}
      onEdgeClick={onEdgeClick}
      onPaneClick={() => {
        select(null)
        setSelectedEdgeId(null)
      }}
      fitView
      colorMode="dark"
      proOptions={{ hideAttribution: true }}
    >
      {selectedEdge && !orderMode && (
        <Panel position="top-left">
          <button className="btn" onClick={convertSelected}>
            {selectedEdge.kind === 'handoff' ? 'Make reporting' : 'Make handoff'}
          </button>
        </Panel>
      )}
      <Panel position="top-right">
        <button className="btn" onClick={applyLayout} title="Auto-arrange the team into a tidy hierarchy">
          Tidy
        </button>
        <button
          className={`btn order-toggle ${orderMode ? 'active' : ''}`}
          onClick={() => setOrderMode((v) => !v)}
          title="Click top-level flow lines in the order their teams should run"
        >
          {orderMode ? 'Ordering — click edges in run order' : 'Order'}
        </button>
      </Panel>
      <Background gap={22} color="#1d2230" />
      <Controls showInteractive={false} />
      <Panel position="bottom-left"><CanvasLegend /></Panel>
      <Panel position="top-center"><CoachMarks /></Panel>
    </ReactFlow>
  )
}
