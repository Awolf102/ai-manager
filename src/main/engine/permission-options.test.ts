import { describe, it, expect } from 'vitest'
import { buildPermissionOptions } from './permission-options'

describe('buildPermissionOptions', () => {
  it('lockBypass clamps bypassPermissions to acceptEdits', () => {
    expect(buildPermissionOptions('bypassPermissions', { lockBypass: true }))
      .toEqual({ permissionMode: 'acceptEdits' })
  })
  it('without lock, bypass keeps the dangerous flag', () => {
    expect(buildPermissionOptions('bypassPermissions'))
      .toEqual({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true })
  })
  it('non-bypass modes are unaffected by the lock', () => {
    expect(buildPermissionOptions('acceptEdits', { lockBypass: true })).toEqual({ permissionMode: 'acceptEdits' })
    expect(buildPermissionOptions('auto', { lockBypass: true })).toEqual({ permissionMode: 'auto' })
  })
})
