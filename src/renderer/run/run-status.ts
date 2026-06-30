export interface RunBanner {
  kind: 'success' | 'failure'
  text: string
}

/** The completion banner for a finished run, or null while idle/running. Pure. */
export function runBanner(run: { runId: string | null; running: boolean; error?: string }): RunBanner | null {
  if (!run.runId || run.running) return null
  return run.error ? { kind: 'failure', text: `Run failed: ${run.error}` } : { kind: 'success', text: 'Run complete' }
}

/** True when the user is NOT viewing the live Run tab (so a run-end deserves a toast). Pure. */
export function shouldToastRunEnd(view: { activeDockId: string | null; dockOpen: boolean }): boolean {
  return view.activeDockId !== 'run' || !view.dockOpen
}

/** The toast payload for a run that just ended. Pure. */
export function runEndToast(error?: string): { kind: 'success' | 'error'; message: string } {
  return error ? { kind: 'error', message: `Run failed: ${error}` } : { kind: 'success', message: 'Run complete' }
}
