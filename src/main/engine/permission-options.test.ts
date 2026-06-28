import { describe, it, expect } from 'vitest'
import { buildPermissionOptions } from './permission-options'

describe('buildPermissionOptions', () => {
  it('sets allowDangerouslySkipPermissions for bypassPermissions', () => {
    expect(buildPermissionOptions('bypassPermissions')).toEqual({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true
    })
  })

  it('does not set the flag for non-bypass modes', () => {
    for (const mode of ['auto', 'acceptEdits', 'default', 'plan'] as const) {
      const out = buildPermissionOptions(mode)
      expect(out).toEqual({ permissionMode: mode })
      expect('allowDangerouslySkipPermissions' in out).toBe(false)
    }
  })
})
