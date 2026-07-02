import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'node:path'
import { ensureLoginPath } from './engine/env'
import { killAllPtys } from './engine/pty-manager'
import { killAllServers } from './engine/server-manager'
import { registerIpc } from './ipc'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: '#1F1A38',
    title: 'Orkestr',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ensureLoginPath()
  // Production-only CSP (defense-in-depth). Skipped in dev so Vite HMR/websocket are untouched.
  if (!process.env.ELECTRON_RENDERER_URL) {
    const CSP =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' http://localhost:* http://127.0.0.1:*"
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } })
    })
  }
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  killAllPtys()
  killAllServers()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  killAllPtys()
  killAllServers()
})
