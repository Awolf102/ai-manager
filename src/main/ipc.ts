import { dialog, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { IPC } from '../shared/types'
import type {
  AgentNodeData,
  CreateAgentInput,
  GraphEdge,
  ProjectSettings,
  RunHeadlessInput,
  SpawnPtyInput,
  StartRunInput,
  SpawnedMember
} from '../shared/types'
import * as store from './engine/project-store'
import { validateTeamBundle } from '../shared/team-bundle'
import * as runner from './engine/agent-runner'
import * as ptyMgr from './engine/pty-manager'
import * as orchestrator from './engine/orchestrator'
import { checkAuth } from './engine/auth'
import { draftRoles } from './engine/role-drafter'
import { spawnTeam } from './engine/team-spawner'
import { detectManifest } from './engine/manifest-detector'
import * as serverMgr from './engine/server-manager'

export function registerIpc(): void {
  // ---- project ----
  ipcMain.handle(IPC.pickProjectFolder, async () => {
    const r = await dialog.showOpenDialog({
      title: 'Choose a project folder for your agents',
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    serverMgr.killAllServers()
    return store.openProject(r.filePaths[0])
  })
  ipcMain.handle(IPC.openProject, (_e, path: string) => {
    serverMgr.killAllServers()
    return store.openProject(path)
  })
  ipcMain.handle(IPC.getRecentProjects, () => store.getRecentProjects())

  // ---- graph / agents ----
  ipcMain.handle(IPC.createAgent, (_e, input: CreateAgentInput) => store.createAgent(input))
  ipcMain.handle(IPC.updateAgent, (_e, agent: Partial<AgentNodeData> & { id: string }) =>
    store.updateAgent(agent)
  )
  ipcMain.handle(IPC.deleteAgent, (_e, agentId: string) => store.deleteAgent(agentId))
  ipcMain.handle(IPC.setEdges, (_e, edges: GraphEdge[]) => store.setEdges(edges))
  ipcMain.handle(
    IPC.setNodePositions,
    (_e, positions: { id: string; position: { x: number; y: number } }[]) =>
      store.setNodePositions(positions)
  )
  ipcMain.handle(IPC.updateSettings, (_e, patch: Partial<ProjectSettings>) =>
    store.updateSettings(patch)
  )

  // ---- role / memory ----
  ipcMain.handle(IPC.readRole, (_e, id: string) => store.readRole(id))
  ipcMain.handle(IPC.writeRole, (_e, id: string, content: string) => store.writeRole(id, content))
  ipcMain.handle(IPC.readMemory, (_e, id: string) => store.readMemory(id))
  ipcMain.handle(IPC.writeMemory, (_e, id: string, content: string) =>
    store.writeMemory(id, content)
  )

  // ---- headless runs ----
  ipcMain.handle(IPC.runHeadless, (e: IpcMainInvokeEvent, input: RunHeadlessInput) =>
    runner.runHeadless(e.sender, input)
  )
  ipcMain.handle(IPC.cancelHeadless, (_e, runId: string) => runner.cancelHeadless(runId))

  // ---- interactive pty ----
  ipcMain.handle(IPC.spawnPty, (e: IpcMainInvokeEvent, input: SpawnPtyInput) =>
    ptyMgr.spawnPty(e.sender, input)
  )
  ipcMain.on(IPC.writePty, (_e, ptyId: string, data: string) => ptyMgr.writePty(ptyId, data))
  ipcMain.on(IPC.resizePty, (_e, ptyId: string, cols: number, rows: number) =>
    ptyMgr.resizePty(ptyId, cols, rows)
  )
  ipcMain.on(IPC.killPty, (_e, ptyId: string) => ptyMgr.killPty(ptyId))

  // ---- orchestration runs ----
  ipcMain.handle(IPC.startRun, (e: IpcMainInvokeEvent, input: StartRunInput) =>
    orchestrator.startRun(e.sender, input)
  )
  ipcMain.handle(IPC.stopRun, (_e, runId: string) => orchestrator.stopRun(runId))

  // ---- auth ----
  ipcMain.handle(IPC.checkAuth, () => checkAuth())

  // ---- run history ----
  ipcMain.handle(IPC.listRuns, () => store.listRuns())
  ipcMain.handle(IPC.loadRun, (_e, file: string) => store.loadRun(file))

  // ---- portable team ----
  ipcMain.handle(IPC.exportTeam, async () => {
    const bundle = await store.exportTeam()
    const r = await dialog.showSaveDialog({
      title: 'Export team',
      defaultPath: `${bundle.name || 'team'}.aimteam.json`,
      filters: [{ name: 'AI Manager team', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return { saved: false }
    await fs.writeFile(r.filePath, JSON.stringify(bundle, null, 2), 'utf8')
    return { saved: true, path: r.filePath }
  })
  ipcMain.handle(IPC.importTeam, async () => {
    const r = await dialog.showOpenDialog({
      title: 'Import team',
      properties: ['openFile'],
      filters: [{ name: 'AI Manager team', extensions: ['json'] }]
    })
    if (r.canceled || r.filePaths.length === 0) return { imported: false }
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(r.filePaths[0], 'utf8'))
    } catch {
      return { imported: false, error: 'That file is not valid JSON.' }
    }
    const v = validateTeamBundle(parsed)
    if (!v.ok) return { imported: false, error: v.error }
    const graph = await store.importTeam(v.bundle, r.filePaths[0])
    return { imported: true, graph }
  })

  // ---- team brain (B2 living team) ----
  ipcMain.handle(IPC.syncTeam, async () => {
    const linked = store.getLinkedTeam()
    let brainPath: string
    if (linked) brainPath = linked.path
    else {
      const r = await dialog.showSaveDialog({
        title: 'Sync to team',
        defaultPath: 'team.aimteam.json',
        filters: [{ name: 'AI Manager team', extensions: ['json'] }]
      })
      if (r.canceled || !r.filePath) return { synced: false }
      brainPath = r.filePath
    }
    const { graph } = await store.syncToTeam(brainPath, randomUUID())
    return { synced: true, graph, teamPath: brainPath }
  })
  ipcMain.handle(IPC.refreshTeam, async () => {
    const linked = store.getLinkedTeam()
    let brainPath: string
    if (linked) brainPath = linked.path
    else {
      const r = await dialog.showOpenDialog({
        title: 'Refresh from team',
        properties: ['openFile'],
        filters: [{ name: 'AI Manager team', extensions: ['json'] }]
      })
      if (r.canceled || r.filePaths.length === 0) return { refreshed: false }
      brainPath = r.filePaths[0]
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(brainPath, 'utf8'))
    } catch {
      return { refreshed: false, error: 'That team file is not valid JSON.' }
    }
    const v = validateTeamBundle(parsed)
    if (!v.ok) return { refreshed: false, error: v.error }
    const { updated, graph } = await store.refreshFromTeam(v.bundle, brainPath)
    return { refreshed: true, updated, graph }
  })

  // ---- role drafting ----
  ipcMain.handle(
    IPC.draftRoles,
    async (e: IpcMainInvokeEvent, input: { goal: string; orchestratorId: string }) => {
      try {
        const drafts = await draftRoles({
          goal: input.goal,
          orchestratorId: input.orchestratorId,
          wc: e.sender,
          abort: new AbortController(),
          runId: 'draft-roles'
        })
        return { ok: true, drafts }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // ---- team spawning ----
  ipcMain.handle(
    IPC.spawnTeam,
    async (e: IpcMainInvokeEvent, input: { goal: string; orchestratorId: string }) => {
      try {
        const members = await spawnTeam({
          goal: input.goal,
          orchestratorId: input.orchestratorId,
          wc: e.sender,
          abort: new AbortController(),
          runId: 'spawn-team'
        })
        return { ok: true, members }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  ipcMain.handle(
    IPC.applySpawn,
    (_e, input: { members: SpawnedMember[]; orchestratorId: string }) =>
      store.applySpawnedTeam(input.members, input.orchestratorId)
  )

  // ---- run result (launch the built app) ----
  ipcMain.handle(
    IPC.detectManifest,
    async (e: IpcMainInvokeEvent, input: { goal: string; orchestratorId: string }) => {
      try {
        const manifest = await detectManifest({
          goal: input.goal,
          orchestratorId: input.orchestratorId,
          wc: e.sender,
          abort: new AbortController(),
          runId: 'detect-manifest'
        })
        return { ok: true, manifest }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
  ipcMain.handle(
    IPC.launchServer,
    (e: IpcMainInvokeEvent, input: { startCommand: string; port?: number; path?: string }) =>
      serverMgr.launchServer(e.sender, input)
  )
  ipcMain.on(IPC.stopServer, (_e, serverId: string) => serverMgr.stopServer(serverId))
  ipcMain.on(IPC.openPath, () => {
    void shell.openPath(store.getCurrentProjectPath())
  })
}
