import type { PermissionMode } from '../../shared/types'

/** SDK permission options for a mode. The SDK REQUIRES allowDangerouslySkipPermissions=true
 *  whenever permissionMode is 'bypassPermissions' (sdk.d.ts), else the run errors.
 *  When `lockBypass` is set, any bypass is clamped down to 'acceptEdits' (Full-auto lock). */
export function buildPermissionOptions(
  mode: PermissionMode,
  opts?: { lockBypass?: boolean }
): { permissionMode: PermissionMode; allowDangerouslySkipPermissions?: true } {
  const effective: PermissionMode = opts?.lockBypass && mode === 'bypassPermissions' ? 'acceptEdits' : mode
  if (effective === 'bypassPermissions') {
    return { permissionMode: effective, allowDangerouslySkipPermissions: true }
  }
  return { permissionMode: effective }
}
