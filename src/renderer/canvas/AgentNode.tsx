import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Play, TerminalSquare } from 'lucide-react'
import type { AgentNodeData } from '../../shared/types'
import { iconComponent } from './iconComponents'
import { useStore } from '../store'

export type AgentFlowNode = Node<{ agent: AgentNodeData }, 'agent'>

function AgentNodeImpl({ data, selected }: NodeProps<AgentFlowNode>) {
  const agent = data.agent
  const Icon = iconComponent(agent.icon)
  const openTerminal = useStore((s) => s.openTerminal)
  const status = useStore((s) => s.run.nodeStatus[agent.id])
  const active = status && status !== 'idle'

  return (
    <div
      className={`agent-node kind-${agent.kind} ${selected ? 'selected' : ''} ${
        active ? `run-${status}` : ''
      }`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="agent-node-head">
        <span className="agent-icon">
          <Icon size={18} />
        </span>
        <div className="agent-meta">
          <div className="agent-name">{agent.name}</div>
          <div className="agent-kind">{agent.kind}</div>
        </div>
        {active && <span className={`agent-status st-${status}`}>{status}</span>}
      </div>
      <div className="agent-node-actions">
        <button
          title="Run a task on this agent (headless)"
          onClick={(e) => {
            e.stopPropagation()
            openTerminal(agent, 'headless')
          }}
        >
          <Play size={13} /> Run
        </button>
        <button
          title="Open an interactive claude terminal as this agent"
          onClick={(e) => {
            e.stopPropagation()
            openTerminal(agent, 'interactive')
          }}
        >
          <TerminalSquare size={13} /> Terminal
        </button>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

export default memo(AgentNodeImpl)
