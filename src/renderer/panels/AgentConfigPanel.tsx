import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { AGENT_KINDS, MODELS } from '../../shared/types'
import type { AgentKind, AgentNodeData, DiscoveredPlugin } from '../../shared/types'
import BackendsModal from '../BackendsModal'

export default function AgentConfigPanel() {
  const graph = useStore((s) => s.graph)
  const selectedId = useStore((s) => s.selectedAgentId)
  const setGraph = useStore((s) => s.setGraph)
  const select = useStore((s) => s.select)
  const requestConfirm = useStore((s) => s.requestConfirm)

  const [catalog, setCatalog] = useState<DiscoveredPlugin[] | null>(null)
  const [showBackends, setShowBackends] = useState(false)
  useEffect(() => {
    void window.api.listSkills().then(setCatalog)
  }, [])

  const agent = graph?.nodes.find((n) => n.id === selectedId)
  if (!agent) return null

  const backends = graph?.backends ?? []
  const selectedBackend = backends.find((b) => b.id === agent.backendId)
  const modelOptions = selectedBackend ? selectedBackend.models : MODELS
  const validModel = (opts: readonly { id: string }[], cur: string): string =>
    opts.some((o) => o.id === cur) ? cur : (opts[0]?.id ?? cur)

  const update = async (patch: Partial<AgentNodeData>): Promise<void> => {
    setGraph(await window.api.updateAgent({ id: agent.id, ...patch }))
  }
  const remove = async (): Promise<void> => {
    const ok = await requestConfirm({
      title: 'Delete agent?',
      body: `"${agent.name}" and its saved memory will be moved to trash (.ai-manager/.trash) — recoverable from disk.`,
      confirmLabel: 'Delete agent',
      danger: true
    })
    if (!ok) return
    setGraph(await window.api.deleteAgent(agent.id))
    select(null)
  }

  const onBackendChange = (id: string): void => {
    const b = backends.find((x) => x.id === id)
    const opts = b ? b.models : MODELS
    void update({ backendId: id || undefined, model: validModel(opts, agent.model) })
  }

  const assigned = new Set(agent.skills ?? [])
  const toggleSkill = (id: string): void => {
    const next = new Set(assigned)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    void update({ skills: [...next] })
  }

  return (
    <div className="panel-section">
      <h3>Agent</h3>
      <div className="field">
        <label>Name</label>
        <input value={agent.name} onChange={(e) => update({ name: e.target.value })} />
      </div>
      <div className="field">
        <label>Role in the chain</label>
        <select value={agent.kind} onChange={(e) => update({ kind: e.target.value as AgentKind })}>
          {AGENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Backend</label>
        <select value={agent.backendId ?? ''} onChange={(e) => onBackendChange(e.target.value)}>
          <option value="">Claude (default)</option>
          {backends.map((b) => (<option key={b.id} value={b.id}>{b.label}</option>))}
        </select>
        <button className="linklike" onClick={() => setShowBackends(true)}>Manage backends…</button>
      </div>
      <div className="field">
        <label>Model</label>
        <select value={agent.model} onChange={(e) => update({ model: e.target.value })}>
          {modelOptions.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
        </select>
      </div>
      <div className="field">
        <label>Skills{assigned.size > 0 ? ` (${assigned.size})` : ''}</label>
        <div className="skills-picker">
          {catalog !== null && catalog.length === 0 && (
            <div className="muted" style={{ fontSize: 12 }}>
              No trusted skills found. Install plugins via Claude Code (`claude plugin marketplace add …`).
            </div>
          )}
          {(catalog ?? []).map((plugin) => (
            <details key={plugin.id} className="skill-group">
              <summary>
                {plugin.id}{' '}
                <span className="muted">
                  · {plugin.author || plugin.marketplace}
                  {plugin.author?.toLowerCase() === 'anthropic'
                    ? ' ✓'
                    : plugin.uniqueInstalls
                      ? ` · ${Math.round(plugin.uniqueInstalls / 1000)}k installs`
                      : ''}
                </span>
              </summary>
              {plugin.skills.map((s) => (
                <label key={s.id} className="check skill-row" title={s.description}>
                  <input type="checkbox" checked={assigned.has(s.id)} onChange={() => toggleSkill(s.id)} />
                  {s.name}
                </label>
              ))}
            </details>
          ))}
        </div>
      </div>
      {agent.sessionId && (
        <div className="field">
          <label>Last session id</label>
          <input readOnly value={agent.sessionId} />
        </div>
      )}
      <button className="btn danger" onClick={remove}>
        <Trash2 size={13} /> Delete agent
      </button>
      {showBackends && <BackendsModal onClose={() => setShowBackends(false)} />}
    </div>
  )
}
