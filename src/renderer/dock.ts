/** Decide the active dock tab after opening a terminal.
 * While a run is active and a view is showing, do NOT steal focus from it
 * (keeps the live run reachable); otherwise focus the new terminal. */
export function activeDockAfterOpenTerminal(opts: {
  running: boolean
  currentActive: string | null
  newTermId: string
}): string {
  if (opts.running && opts.currentActive) return opts.currentActive
  return opts.newTermId
}
