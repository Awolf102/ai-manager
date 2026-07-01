import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleHelp, Clock, Folder, FolderOpen, PanelRight, Paperclip, Plus, Settings as SettingsIcon, Terminal, Users } from 'lucide-react'
import { useStore } from './store'
import TeamMenu from './TeamMenu'
import FaqModal from './FaqModal'
import OrgChart from './canvas/OrgChart'
import AgentConfigPanel from './panels/AgentConfigPanel'
import RoleMemoryEditor from './panels/RoleMemoryEditor'
import TerminalPane from './terminal/TerminalPane'
import GoalBar from './run/GoalBar'
import RunView from './run/RunView'
import HistoryView from './run/HistoryView'
import SettingsModal from './SettingsModal'
import ContextModal from './ContextModal'
import { BrandMark } from './BrandMark'
import CanvasEmptyState from './CanvasEmptyState'
import HitlModal from './HitlModal'
import ConfirmDialog from './ConfirmDialog'
import ToastViewport from './ToastViewport'
import PanelDivider from './PanelDivider'
import { computeBodyGrid, INSPECTOR_MIN, INSPECTOR_MAX, DOCK_HEIGHT_MIN, DOCK_WIDTH_MIN, DOCK_WIDTH_MAX } from './layout'
import { AGENT_KINDS } from '../shared/types'
import type { AgentKind, AuthStatus, ProjectGraph, ProjectMeta } from '../shared/types'
import { Modal } from './Modal'
import { rovingIndex } from './roving'

export default function App() {
  const graph = useStore((s) => s.graph)
  const setGraph = useStore((s) => s.setGraph)
  const terminals = useStore((s) => s.terminals)
  const activeDockId = useStore((s) => s.activeDockId)
  const setActiveDock = useStore((s) => s.setActiveDock)
  const closeTerminal = useStore((s) => s.closeTerminal)
  const selectedId = useStore((s) => s.selectedAgentId)
  const showRunView = useStore((s) => s.showRunView)
  const dockOpen = useStore((s) => s.dockOpen)
  const toggleDock = useStore((s) => s.toggleDock)
  const runRunning = useStore((s) => s.run.running)
  const showHistory = useStore((s) => s.showHistory)
  const openHistory = useStore((s) => s.openHistory)
  const applyOrchestration = useStore((s) => s.applyOrchestration)
  const requestConfirm = useStore((s) => s.requestConfirm)
  const notify = useStore((s) => s.notify)
  const resumable = useStore((s) => s.resumable)
  const resumableDismissed = useStore((s) => s.resumableDismissed)
  const refreshResumable = useStore((s) => s.refreshResumable)
  const dismissResumableBanner = useStore((s) => s.dismissResumableBanner)
  const layout = useStore((s) => s.layout)
  const loadLayout = useStore((s) => s.loadLayout)
  const setZoneSize = useStore((s) => s.setZoneSize)
  const toggleZoneCollapsed = useStore((s) => s.toggleZoneCollapsed)
  const setZonePlacement = useStore((s) => s.setZonePlacement)
  const focusGoal = useStore((s) => s.focusGoal)
  const [showAdd, setShowAdd] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showContext, setShowContext] = useState(false)
  const [showFaq, setShowFaq] = useState(false)
  const [dragDepth, setDragDepth] = useState(0)

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
  useEffect(() => {
    if (graph?.project.path) loadLayout(graph.project.path)
  }, [graph?.project.path, loadLayout])

  const authBanner =
    !authChecking && auth && auth.state !== 'ok' ? (
      <AuthBanner status={auth} onRecheck={() => void recheckAuth()} />
    ) : null

  const onOpen = (g: ProjectGraph): void => {
    setGraph(g)
    void refreshResumable(true)
  }

  const handleBuild = async (): Promise<void> => {
    try {
      const g = await window.api.createAgent({ name: 'Orchestrator', kind: 'orchestrator' })
      setGraph(g)
      focusGoal()
    } catch {
      notify({ kind: 'error', message: 'Could not create the Orchestrator.' })
    }
  }

  if (!graph) {
    return (
      <>
        <ProjectPicker onOpen={onOpen} />
        {authBanner}
      </>
    )
  }

  const dockHasContent = terminals.length > 0 || showRunView || showHistory
  const showDock = dockOpen && dockHasContent
  // The grid must not reserve the dock's track when the dock isn't shown,
  // otherwise an empty strip remains at the bottom. Treat it as collapsed.
  const grid = computeBodyGrid({ ...layout, dock: { ...layout.dock, collapsed: layout.dock.collapsed || !showDock } })

  const dockTabIds: string[] = [
    ...(showRunView ? ['run'] : []),
    ...(showHistory ? ['history'] : []),
    ...terminals.map((t) => t.id)
  ]
  const dockTabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const onDockTabKeyDown = (e: React.KeyboardEvent, id: string): void => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && id !== 'run' && id !== 'history') {
      e.preventDefault()
      closeTerminal(id)
      return
    }
    const ni = rovingIndex(e.key, dockTabIds.indexOf(id), dockTabIds.length, 'horizontal')
    if (ni == null) return
    e.preventDefault()
    const next = dockTabIds[ni]
    setActiveDock(next)
    dockTabRefs.current[next]?.focus()
  }

  const hasFiles = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')
  const onDragEnter = (e: React.DragEvent): void => {
    if (hasFiles(e)) {
      e.preventDefault()
      setDragDepth((d) => d + 1)
    }
  }
  const onDragOver = (e: React.DragEvent): void => {
    if (hasFiles(e)) e.preventDefault()
  }
  const onDragLeave = (e: React.DragEvent): void => {
    if (hasFiles(e)) setDragDepth((d) => Math.max(0, d - 1))
  }
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragDepth(0)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.getPathForFile(f))
      .filter((p) => p) // drop non-file items (text/url) whose path is ''
    if (paths.length === 0) return
    const r = await window.api.addContextPaths(paths)
    setGraph(r.graph)
    if (r.skipped.length) notify({ kind: 'info', message: `Skipped: ${r.skipped.join(', ')}` })
  }

  return (
    <div
      className={`app ${resumable.length > 0 && !resumableDismissed ? 'has-resume-banner' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e)}
    >
      {dragDepth > 0 && <div className="ctx-drop-overlay">Drop files or folders to add as project context</div>}
      {resumable.length > 0 && !resumableDismissed && (
        <div className="resume-banner">
          <span>{resumable.length} run{resumable.length > 1 ? 's' : ''} can be resumed.</span>
          <button className="btn tiny" onClick={() => openHistory()}>View</button>
          <button className="btn tiny" onClick={() => dismissResumableBanner()}>Dismiss</button>
        </div>
      )}
      <div className="topbar">
        <div className="topbar-brand">
          <BrandMark size={20} />
          <span className="topbar-wordmark">Orkestr</span>
        </div>
        <span className="topbar-sep" aria-hidden="true" />
        <span className="project">{graph.project.name}</span>
        <button className="btn" title="Switch to another project" onClick={async () => { const g = await window.api.pickProjectFolder(); if (g) { setGraph(g); void refreshResumable(true) } }}><FolderOpen size={14} /> Switch project</button>

        <span className="spacer" />

        <div className="topbar-group">
          <AuthPill checking={authChecking} status={auth} onClick={() => void recheckAuth()} />
        </div>
        <span className="topbar-sep" aria-hidden="true" />
        <div className="topbar-group">
          <button className="btn" title="Run history" onClick={() => openHistory()}><Clock size={14} /> History{resumable.length > 0 && <span className="resume-badge">{resumable.length}</span>}</button>
          <button className={`btn ctx-btn ${showContext ? 'active' : ''}`} title="Project context — files & folders for the team" onClick={() => setShowContext(true)}><Paperclip size={14} /> Context{((graph.context?.length ?? 0) + (graph.contextFolders?.length ?? 0)) > 0 && <span className="ctx-badge">{(graph.context?.length ?? 0) + (graph.contextFolders?.length ?? 0)}</span>}</button>
          <button
            className={`btn ${showDock ? 'active' : ''}`}
            title={showDock ? 'Hide the bottom panel' : 'Show the bottom panel'}
            onClick={() => toggleDock()}
          >
            <Terminal size={14} /> Terminal
          </button>
        </div>
        <span className="topbar-sep" aria-hidden="true" />
        <div className="topbar-group">
          <TeamMenu />
          {graph.linkedTeam && (<span className="team-link" title={`Linked team brain: ${graph.linkedTeam.path}`}><Users size={12} /> {graph.linkedTeam.path.split(/[\\/]/).pop()}</span>)}
          <button className={`btn ${showSettings ? 'active' : ''}`} title="Settings" onClick={() => setShowSettings(true)}><SettingsIcon size={14} /> Settings</button>
          <button className={`btn faq-btn ${showFaq ? 'active' : ''}`} title="How to prompt" onClick={() => setShowFaq(true)}><CircleHelp size={15} /></button>
        </div>
        <span className="topbar-sep" aria-hidden="true" />
        <button className="btn primary" onClick={() => setShowAdd(true)}><Plus size={14} /> Add agent</button>
      </div>

      <div
        className="body"
        style={{ gridTemplateColumns: grid.columns, gridTemplateRows: grid.rows, gridTemplateAreas: grid.areas }}
      >
        <div className="zone-main" style={{ gridArea: 'main' }}>
          <GoalBar />
          <div className="canvas-wrap">
            <OrgChart />
            {graph.nodes.length === 0 && (
              <CanvasEmptyState onBuild={() => void handleBuild()} onAdd={() => setShowAdd(true)} />
            )}
          </div>
        </div>

        <div className={`zone-inspector ${layout.inspector.collapsed ? 'collapsed' : ''}`} style={{ gridArea: 'inspector' }}>
          {!layout.inspector.collapsed && (
            <PanelDivider
              axis="x"
              invert={layout.inspector.placement === 'right'}
              getStart={() => layout.inspector.size}
              onResize={(px) => setZoneSize('inspector', px, window.innerHeight)}
              size={layout.inspector.size}
              min={INSPECTOR_MIN}
              max={INSPECTOR_MAX}
              label="Resize inspector panel"
            />
          )}
          <div className="zone-head">
            <span>Inspector</span>
            <span className="spacer" />
            <button className="btn tiny" title="Move left/right" onClick={() => setZonePlacement('inspector', layout.inspector.placement === 'right' ? 'left' : 'right')}>⇄</button>
            <button className="btn tiny" title="Collapse" onClick={() => toggleZoneCollapsed('inspector')}>×</button>
          </div>
          <div className="zone-body">
            {selectedId ? (<><AgentConfigPanel /><RoleMemoryEditor /></>) : (
              <div className="inspector-empty">
                <PanelRight size={20} className="inspector-empty-icon" />
                <p>Select an agent to edit its role, memory, and skills.</p>
                <p className="dim">
                  Drag from the <b>bottom</b> of one node to the <b>top</b> of another to make it delegate work
                  down the chain.
                </p>
              </div>
            )}
          </div>
        </div>

        {showDock && (
          <div className={`zone-dock ${layout.dock.collapsed ? 'collapsed' : ''}`} style={{ gridArea: 'dock' }}>
            {!layout.dock.collapsed && (() => {
                const dockAxis = layout.dock.placement === 'right' ? 'x' : 'y'
                return (
                  <PanelDivider
                    axis={dockAxis}
                    invert={true}
                    getStart={() => layout.dock.size}
                    onResize={(px) => setZoneSize('dock', px, window.innerHeight)}
                    size={layout.dock.size}
                    min={dockAxis === 'x' ? DOCK_WIDTH_MIN : DOCK_HEIGHT_MIN}
                    max={dockAxis === 'x' ? DOCK_WIDTH_MAX : Math.round(window.innerHeight * 0.6)}
                    label="Resize terminal panel"
                  />
                )
              })()}
            <div className="terminal-dock">
              <div className="term-tabs" role="tablist" aria-label="Terminal dock">
                {showRunView && (
                  <button
                    ref={(el) => { dockTabRefs.current['run'] = el }}
                    className={`term-tab mode-run ${activeDockId === 'run' ? 'active' : ''} ${runRunning ? 'running' : ''}`}
                    role="tab"
                    id="dock-tab-run"
                    aria-selected={activeDockId === 'run'}
                    aria-controls="dock-panel-run"
                    tabIndex={activeDockId === 'run' ? 0 : -1}
                    onClick={() => setActiveDock('run')}
                    onKeyDown={(e) => onDockTabKeyDown(e, 'run')}
                  >
                    <span className="dot" /> Run{runRunning && <span className="run-live" title="Run in progress">● running</span>}
                  </button>
                )}
                {showHistory && (
                  <button
                    ref={(el) => { dockTabRefs.current['history'] = el }}
                    className={`term-tab mode-run ${activeDockId === 'history' ? 'active' : ''}`}
                    role="tab"
                    id="dock-tab-history"
                    aria-selected={activeDockId === 'history'}
                    aria-controls="dock-panel-history"
                    tabIndex={activeDockId === 'history' ? 0 : -1}
                    onClick={() => setActiveDock('history')}
                    onKeyDown={(e) => onDockTabKeyDown(e, 'history')}
                  >
                    <span className="dot" /> History
                  </button>
                )}
                {terminals.map((t) => (
                  <div key={t.id} className="term-tab-wrap" role="presentation">
                    <button
                      ref={(el) => { dockTabRefs.current[t.id] = el }}
                      className={`term-tab mode-${t.mode} ${activeDockId === t.id ? 'active' : ''}`}
                      role="tab"
                      id={`dock-tab-${t.id}`}
                      aria-selected={activeDockId === t.id}
                      aria-controls={`dock-panel-${t.id}`}
                      tabIndex={activeDockId === t.id ? 0 : -1}
                      onClick={() => setActiveDock(t.id)}
                      onKeyDown={(e) => onDockTabKeyDown(e, t.id)}
                    >
                      <span className="dot" /> {t.agentName} · {t.mode === 'headless' ? 'run' : 'shell'}
                    </button>
                    <button
                      className="term-tab-close"
                      aria-label={`Close ${t.agentName} terminal`}
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
                  <div className={`term-slot ${activeDockId === 'run' ? 'active' : ''}`} role="tabpanel" id="dock-panel-run" aria-labelledby="dock-tab-run" tabIndex={0}>
                    <RunView />
                  </div>
                )}
                {showHistory && (
                  <div className={`term-slot ${activeDockId === 'history' ? 'active' : ''}`} role="tabpanel" id="dock-panel-history" aria-labelledby="dock-tab-history" tabIndex={0}>
                    <HistoryView />
                  </div>
                )}
                {terminals.map((t) => (
                  <div key={t.id} className={`term-slot ${activeDockId === t.id ? 'active' : ''}`} role="tabpanel" id={`dock-panel-${t.id}`} aria-labelledby={`dock-tab-${t.id}`} tabIndex={0}>
                    <TerminalPane tab={t} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* collapsed dock re-open affordance (inspector re-open lives next to Run in the goal bar) */}
        {showDock && layout.dock.collapsed && (
          <button className="zone-reopen reopen-dock" onClick={() => toggleZoneCollapsed('dock')} title="Show dock">▴</button>
        )}
      </div>

      {showAdd && <AddAgentModal onClose={() => setShowAdd(false)} onCreated={setGraph} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showContext && <ContextModal onClose={() => setShowContext(false)} />}
      {showFaq && <FaqModal onClose={() => setShowFaq(false)} />}
      <HitlModal />
      <ConfirmDialog />
      <ToastViewport />
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
        <div className="picker-identity">
          <BrandMark size={48} />
          <h1 className="picker-wordmark">Orkestr</h1>
          <p className="picker-tagline">Conduct a team of agents.</p>
        </div>
        <button
          className="btn primary picker-open"
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
              <button
                className="recent-item"
                key={r.path}
                onClick={async () => {
                  const g = await window.api.openProject(r.path)
                  if (g) onOpen(g)
                }}
              >
                <Folder size={16} className="recent-icon" />
                <span className="recent-meta">
                  <span className="recent-name">{r.name}</span>
                  <span className="path">{r.path}</span>
                </span>
              </button>
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
    <Modal onClose={onClose}>{(close) => (<>
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
          <button className="btn" onClick={() => close()}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void create()}>
            Create
          </button>
        </div>
    </>)}</Modal>
  )
}
