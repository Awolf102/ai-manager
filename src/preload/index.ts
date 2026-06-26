import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/types'
import type {
  AgentStreamEvent,
  OrchestrationEvent,
  PtyDataEvent,
  PtyExitEvent,
  RendererApi,
  ServerLogEvent,
  ServerReadyEvent,
  ServerStatusEvent
} from '../shared/types'

function sub<T>(channel: string, cb: (e: T) => void): () => void {
  const listener = (_: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: RendererApi = {
  pickProjectFolder: () => ipcRenderer.invoke(IPC.pickProjectFolder),
  openProject: (path) => ipcRenderer.invoke(IPC.openProject, path),
  getRecentProjects: () => ipcRenderer.invoke(IPC.getRecentProjects),
  createAgent: (input) => ipcRenderer.invoke(IPC.createAgent, input),
  updateAgent: (agent) => ipcRenderer.invoke(IPC.updateAgent, agent),
  deleteAgent: (agentId) => ipcRenderer.invoke(IPC.deleteAgent, agentId),
  setEdges: (edges) => ipcRenderer.invoke(IPC.setEdges, edges),
  setNodePositions: (positions) => ipcRenderer.invoke(IPC.setNodePositions, positions),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  readRole: (agentId) => ipcRenderer.invoke(IPC.readRole, agentId),
  writeRole: (agentId, content) => ipcRenderer.invoke(IPC.writeRole, agentId, content),
  readMemory: (agentId) => ipcRenderer.invoke(IPC.readMemory, agentId),
  writeMemory: (agentId, content) => ipcRenderer.invoke(IPC.writeMemory, agentId, content),
  runHeadless: (input) => ipcRenderer.invoke(IPC.runHeadless, input),
  cancelHeadless: (runId) => ipcRenderer.invoke(IPC.cancelHeadless, runId),
  onAgentStream: (cb) => sub<AgentStreamEvent>(IPC.agentStream, cb),
  spawnPty: (input) => ipcRenderer.invoke(IPC.spawnPty, input),
  writePty: (ptyId, data) => ipcRenderer.send(IPC.writePty, ptyId, data),
  resizePty: (ptyId, cols, rows) => ipcRenderer.send(IPC.resizePty, ptyId, cols, rows),
  killPty: (ptyId) => ipcRenderer.send(IPC.killPty, ptyId),
  onPtyData: (cb) => sub<PtyDataEvent>(IPC.ptyData, cb),
  onPtyExit: (cb) => sub<PtyExitEvent>(IPC.ptyExit, cb),
  startRun: (input) => ipcRenderer.invoke(IPC.startRun, input),
  stopRun: (runId) => ipcRenderer.invoke(IPC.stopRun, runId),
  onOrchestration: (cb) => sub<OrchestrationEvent>(IPC.orchestration, cb),
  checkAuth: () => ipcRenderer.invoke(IPC.checkAuth),
  listRuns: () => ipcRenderer.invoke(IPC.listRuns),
  loadRun: (file) => ipcRenderer.invoke(IPC.loadRun, file),
  exportTeam: () => ipcRenderer.invoke(IPC.exportTeam),
  importTeam: () => ipcRenderer.invoke(IPC.importTeam),
  syncToTeam: () => ipcRenderer.invoke(IPC.syncTeam),
  refreshFromTeam: () => ipcRenderer.invoke(IPC.refreshTeam),
  draftRoles: (input) => ipcRenderer.invoke(IPC.draftRoles, input),
  spawnTeam: (input) => ipcRenderer.invoke(IPC.spawnTeam, input),
  applySpawnedTeam: (input) => ipcRenderer.invoke(IPC.applySpawn, input),
  detectManifest: (input) => ipcRenderer.invoke(IPC.detectManifest, input),
  launchServer: (input) => ipcRenderer.invoke(IPC.launchServer, input),
  stopServer: (serverId) => ipcRenderer.send(IPC.stopServer, serverId),
  openProjectPath: () => ipcRenderer.send(IPC.openPath),
  addContext: (paths) => ipcRenderer.invoke(IPC.addContext, paths),
  updateContext: (id, note) => ipcRenderer.invoke(IPC.updateContext, id, note),
  removeContext: (id) => ipcRenderer.invoke(IPC.removeContext, id),
  contextThumbnail: (id) => ipcRenderer.invoke(IPC.contextThumbnail, id),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  listSkills: () => ipcRenderer.invoke(IPC.listSkills),
  onServerLog: (cb) => sub<ServerLogEvent>(IPC.serverLog, cb),
  onServerStatus: (cb) => sub<ServerStatusEvent>(IPC.serverStatus, cb),
  onServerReady: (cb) => sub<ServerReadyEvent>(IPC.serverReady, cb)
}

contextBridge.exposeInMainWorld('api', api)
