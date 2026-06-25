import { useCallback, useEffect, useState } from 'react'
import { Clock, CloudDownload, CloudUpload, Download, FolderOpen, Plus, Settings as SettingsIcon, Upload, Users } from 'lucide-react'
import { useStore } from './store'
import OrgChart from './canvas/OrgChart'
import AgentConfigPanel from './panels/AgentConfigPanel'
import RoleMemoryEditor from './panels/RoleMemoryEditor'
import TerminalPane from './terminal/TerminalPane'
import GoalBar from './run/GoalBar'
import RunView from './run/RunView'
import HistoryView from './run/HistoryView'
import SettingsModal from './SettingsModal'
import { AGENT_KINDS } from '../shared/types'
import type { AgentKind, AuthStatus, ProjectGraph, ProjectMeta } from '../shared/types'

export default function App() {
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)
  const terminals = useStore((s) => s.terminals)
  const activeDockId = useStore((s) => s.activeDockId)
  const setActiveDock = useStore((s) => s.setActiveDock)
  const closeTerminal = useStore((s) => s.closeTerminal)
  const selectedId = useStore((s) => s.selectedAgentId)
  const showRunView = useStore((s) => s.showRunView)
  const showHistory = useStore((s) => s.showHistory)
  const openHistory = useStore((s) => s.openHistory)
  const applyOrchestration = useStore((s) => s.applyOrchestration)
  const [showAdd, setShowAdd] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [authChecking, setAuthChecking] = useState(true)
  const recheckAuth = useCallback(async () => {
    setAuthChecking(true)
    try {
      setAuth(await window.api.checkAuth())
    } finally {
      setAuthChecking(false)
    }
  }, [])

  // subscribe to orchestration events + check login once
  useEffect(() => window.api.onOrchestration(applyOrchestration), [applyOrchestration])
  useEffect(() => {
    void recheckAuth()
  }, [recheckAuth])

  const authBanner =
    !authChecking && auth && auth.state !== 'ok' ? (
      <AuthBanner status={auth} onRecheck={() => void recheckAuth()} />
    ) : null

  if (!graph) {
    return (
      <>
        <ProjectPicker onOpen={setGraph} />
        {authBanner}
      </>
    )
  }

  const showDock = terminals.length > 0 || showRunView || showHistory

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">AI Manager</span>
        <span className="project">{graph.project.name}</span>
        <span className="spacer" />
        <AuthPill checking={authChecking} status={auth} onClick={() => void recheckAuth()} />
        <button
          className="btn"
          onClick={async () => {
            const g = await window.api.pickProjectFolder()
            if (g) setGraph(g)
          }}
        >
          <FolderOpen size={14} /> Switch project
        </button>
        <button className="btn" title="Run history" onClick={() => openHistory()}>
          <Clock size={14} />
        </button>
        <button
          className="btn"
          title="Export team to a file"
          onClick={async () => {
            await window.api.exportTeam()
          }}
        >
          <Upload size={14} />
        </button>
        <button
          className="btn"
          title="Import a team into this project"
          onClick={async () => {
            const r = await window.api.importTeam()
            if (r.imported && r.graph) setGraph(r.graph)
            else if (r.error) window.alert(r.error)
          }}
        >
          <Download size={14} />
        </button>
        {graph.linkedTeam && (
          <span className="team-link" title={`Linked team brain: ${graph.linkedTeam.path}`}>
            <Users size={12} /> {graph.linkedTeam.path.split(/[\\/]/).pop()}
          </span>
        )}
        <button
          className="btn"
          title="Sync this project's portable lessons to the team brain"
          onClick={async () => {
            const r = await window.api.syncToTeam()
            if (r.synced && r.graph) setGraph(r.graph)
          }}
        >
          <CloudUpload size={14} />
        </button>
        <button
          className="btn"
          title="Refresh this project's agents from the team brain"
          onClick={async () => {
            const r = await window.api.refreshFromTeam()
            if (r.refreshed && r.graph) {
              setGraph(r.graph)
              window.alert(`Updated ${r.updated} agent(s) from the team brain.`)
            } else if (r.error) {
              window.alert(r.error)
            }
          }}
        >
          <CloudDownload size={14} />
        </button>
        <button className="btn" title="Settings" onClick={() => setShowSettings(true)}>
          <SettingsIcon size={14} />
        </button>
        <button className="btn primary" onClick={() => setShowAdd(true)}>
          <Plus size={14} /> Add agent
        </button>
      </div>

      <div className="body">
        <div className={`main ${showDock ? 'has-dock' : ''}`}>
          <GoalBar />
          <div className="canvas-wrap">
            <OrgChart />
          </div>

          {showDock && (
            <div className="terminal-dock">
              <div className="term-tabs">
                {showRunView && (
                  <div
                    className={`term-tab mode-run ${activeDockId === 'run' ? 'active' : ''}`}
                    onClick={() => setActiveDock('run')}
                  >
                    <span className="dot" /> Run
                  </div>
                )}
                {showHistory && (
                  <div
                    className={`term-tab mode-run ${activeDockId === 'history' ? 'active' : ''}`}
                    onClick={() => setActiveDock('history')}
                  >
                    <span className="dot" /> History
                  </div>
                )}
                {terminals.map((t) => (
                  <div
                    key={t.id}
                    className={`term-tab mode-${t.mode} ${activeDockId === t.id ? 'active' : ''}`}
                    onClick={() => setActiveDock(t.id)}
                  >
                    <span className="dot" /> {t.agentName} · {t.mode === 'headless' ? 'run' : 'shell'}
                    <button
                      className="close"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTerminal(t.id)
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <div className="term-stack">
                {showRunView && (
                  <div className={`term-slot ${activeDockId === 'run' ? 'active' : ''}`}>
                    <RunView />
                  </div>
                )}
                {showHistory && (
                  <div className={`term-slot ${activeDockId === 'history' ? 'active' : ''}`}>
                    <HistoryView />
                  </div>
                )}
                {terminals.map((t) => (
                  <div key={t.id} className={`term-slot ${activeDockId === t.id ? 'active' : ''}`}>
                    <TerminalPane tab={t} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="sidepanel">
          {selectedId ? (
            <>
              <AgentConfigPanel />
              <RoleMemoryEditor />
            </>
          ) : (
            <div className="empty-hint">
              Select an agent to edit its role, memory, and settings.
              <br />
              <br />
              Drag from the <b>bottom</b> of one node to the <b>top</b> of another to make it{' '}
              <b>delegate</b> work down the chain. Then give the Orchestrator a goal up top.
            </div>
          )}
        </div>
      </div>

      {showAdd && <AddAgentModal onClose={() => setShowAdd(false)} onCreated={setGraph} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {authBanner}
    </div>
  )
}

function AuthPill({
  checking,
  status,
  onClick
}: {
  checking: boolean
  status: AuthStatus | null
  onClick: () => void
}) {
  const state = checking ? 'checking' : (status?.state ?? 'checking')
  const label =
    state === 'checking'
      ? 'Claude…'
      : state === 'ok'
        ? 'Claude ✓'
        : state === 'logged-out'
          ? 'login needed'
          : state === 'no-cli'
            ? 'no CLI'
            : 'auth ?'
  return (
    <button
      className={`auth-pill auth-${state}`}
      onClick={onClick}
      title="Claude Code login status — click to re-check"
    >
      {label}
    </button>
  )
}

function AuthBanner({ status, onRecheck }: { status: AuthStatus; onRecheck: () => void }) {
  const text =
    status.state === 'no-cli'
      ? 'Claude Code CLI not found. Make sure `claude` is installed and on your PATH, then re-check.'
      : status.state === 'logged-out'
        ? 'Not logged into Claude Code. Run `claude` once in your Terminal to log in, then re-check.'
        : (status.message ?? 'Could not verify the Claude Code login.')
  return (
    <div className={`auth-banner auth-${status.state}`}>
      <span>⚠ {text}</span>
      <button className="btn tiny" onClick={onRecheck}>
        Re-check
      </button>
    </div>
  )
}

function ProjectPicker({ onOpen }: { onOpen: (g: ProjectGraph) => void }) {
  const [recents, setRecents] = useState<ProjectMeta[]>([])
  useEffect(() => {
    void window.api.getRecentProjects().then(setRecents)
  }, [])

  return (
    <div className="picker">
      <div className="picker-card">
        <h1>AI Manager</h1>
        <p>Choose a project folder — all your agents will work inside it.</p>
        <button
          className="btn primary"
          onClick={async () => {
            const g = await window.api.pickProjectFolder()
            if (g) onOpen(g)
          }}
        >
          <FolderOpen size={14} /> Open project folder…
        </button>

        {recents.length > 0 && (
          <div className="recent-list">
            <div className="label">Recent</div>
            {recents.map((r) => (
              <div
                className="recent-item"
                key={r.path}
                onClick={async () => {
                  const g = await window.api.openProject(r.path)
                  if (g) onOpen(g)
                }}
              >
                <span>{r.name}</span>
                <span className="path">{r.path}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function AddAgentModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (g: ProjectGraph) => void
}) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<AgentKind>('worker')

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    const g = await window.api.createAgent({ name: name.trim(), kind })
    onCreated(g)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add agent</h2>
        <div className="field">
          <label>Name</label>
          <input
            autoFocus
            value={name}
            placeholder="e.g. Data Engineer"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
            }}
          />
        </div>
        <div className="field">
          <label>Role in the chain</label>
          <div className="seg">
            {AGENT_KINDS.map((k) => (
              <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
                {k}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void create()}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
