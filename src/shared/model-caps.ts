// Per-model reasoning-effort capability + clamp. Pure — no node/DOM/engine imports;
// unit-tested in plain Node like shared/effort.ts and shared/team-spawn.ts.
import type { Effort } from './types'
import { EFFORT_LEVELS } from './types'

/** Effort levels each model supports, low->high. Empty = model has no effort parameter. */
export const MODEL_EFFORT_CAPS: Record<string, Effort[]> = {
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'], // no xhigh
  'claude-haiku-4-5': [] // no effort parameter at all
}

/**
 * Clamp a requested effort to what `model` actually supports.
 * - no effort requested            -> undefined
 * - unknown model (no caps entry)  -> requested unchanged (no clamp data)
 * - model with no effort levels    -> undefined (e.g. Haiku)
 * - supported level                -> unchanged
 * - unsupported level              -> nearest supported level >= requested (round up),
 *                                     or the model's ceiling if the request exceeds it.
 */
export function clampEffort(model: string, effort: Effort | undefined): Effort | undefined {
  if (!effort) return undefined
  const caps = MODEL_EFFORT_CAPS[model]
  if (caps === undefined) return effort
  if (caps.length === 0) return undefined
  if (caps.includes(effort)) return effort
  const want = EFFORT_LEVELS.indexOf(effort)
  const sorted = [...caps].sort((a, b) => EFFORT_LEVELS.indexOf(a) - EFFORT_LEVELS.indexOf(b))
  const up = sorted.find((c) => EFFORT_LEVELS.indexOf(c) >= want)
  return up ?? sorted[sorted.length - 1]
}
