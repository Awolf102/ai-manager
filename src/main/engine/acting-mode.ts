import type { Autonomy, PermissionMode } from '../../shared/types'

/** Map the project Autonomy to the SDK permission mode used for acting steps. Pure. */
export function actingModeFor(autonomy: Autonomy): PermissionMode {
  if (autonomy === 'full') return 'bypassPermissions'
  if (autonomy === 'cautious') return 'acceptEdits'
  return 'auto'
}
