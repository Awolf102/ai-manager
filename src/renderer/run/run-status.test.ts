import { describe, it, expect } from 'vitest'
import { runBanner, shouldToastRunEnd, runEndToast } from './run-status'

describe('runBanner', () => {
  it('is null when no run has started', () => {
    expect(runBanner({ runId: null, running: false })).toBeNull()
  })
  it('is null while running', () => {
    expect(runBanner({ runId: 'r1', running: true })).toBeNull()
  })
  it('is success when finished with no error', () => {
    expect(runBanner({ runId: 'r1', running: false })).toEqual({ kind: 'success', text: 'Run complete' })
  })
  it('is failure with the error message when finished with an error', () => {
    expect(runBanner({ runId: 'r1', running: false, error: 'boom' })).toEqual({ kind: 'failure', text: 'Run failed: boom' })
  })
})

describe('shouldToastRunEnd', () => {
  it('is false when viewing the Run tab', () => {
    expect(shouldToastRunEnd({ activeDockId: 'run', dockOpen: true })).toBe(false)
  })
  it('is true when on another dock tab', () => {
    expect(shouldToastRunEnd({ activeDockId: 'history', dockOpen: true })).toBe(true)
  })
  it('is true when the dock is hidden even if Run is the active id', () => {
    expect(shouldToastRunEnd({ activeDockId: 'run', dockOpen: false })).toBe(true)
  })
  it('is true when nothing is active', () => {
    expect(shouldToastRunEnd({ activeDockId: null, dockOpen: true })).toBe(true)
  })
})

describe('runEndToast', () => {
  it('is a success toast with no error', () => {
    expect(runEndToast()).toEqual({ kind: 'success', message: 'Run complete' })
  })
  it('is an error toast with the message when failed', () => {
    expect(runEndToast('boom')).toEqual({ kind: 'error', message: 'Run failed: boom' })
  })
})
