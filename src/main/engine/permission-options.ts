import type { PermissionMode } from '../../shared/types'

/** SDK permission options for a mode. The SDK REQUIRES allowDangerouslySkipPermissions=true
 *  whenever permissionMode is 'bypassPermissions' (sdk.d.ts), else the run errors. */
export function buildPermissionOptions(
  mode: PermissionMode
): { permissionMode: PermissionMode; allowDangerouslySkipPermissions?: true } {
  if (mode === 'bypassPermissions') {
    return { permissionMode: mode, allowDangerouslySkipPermissions: true }
  }
  return { permissionMode: mode }
}
