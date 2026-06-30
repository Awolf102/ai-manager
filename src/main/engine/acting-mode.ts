import type { Autonomy, PermissionMode } from '../../shared/types'

/** Map the project Autonomy to the SDK permission mode used for acting steps. Pure. */
export function actingModeFor(autonomy: Autonomy): PermissionMode {
  if (autonomy === 'full') return 'bypassPermissions'
  if (autonomy === 'cautious') return 'acceptEdits'
  return 'auto'
}

/** Permission mode for a direct (non-orchestrated) per-agent launch: the acting
 *  mode for the project Autonomy, clamped to 'acceptEdits' when the "never bypass
 *  permissions" lock is on — so the lock is genuinely engine-wide. Pure. */
export function launchMode(autonomy: Autonomy, lockBypassPermissions: boolean): PermissionMode {
  const mode = actingModeFor(autonomy)
  return lockBypassPermissions && mode === 'bypassPermissions' ? 'acceptEdits' : mode
}
