import { useCallback, useEffect, useMemo } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type NodeTypes
} from '@xyflow/react'
import AgentNode, { type AgentFlowNode } from './AgentNode'
import { useStore } from '../store'
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
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: true
  }))
}

export default function OrgChart() {
  const graph = useStore((s) => s.graph)!
  const setGraph = useStore((s) => s.setGraph)
  const patchPositions = useStore((s) => s.patchPositions)
  const select = useStore((s) => s.select)

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

  const edgeSig = useMemo(() => graph.edges.map((e) => e.id).join('|'), [graph.edges])
  useEffect(() => {
    setEdges(toEdges(graph))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeSig])

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
      onNodeDragStop={onNodeDragStop}
      onNodeClick={(_, n) => select(n.id)}
      onPaneClick={() => select(null)}
      fitView
      colorMode="dark"
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={22} color="#1d2230" />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}
