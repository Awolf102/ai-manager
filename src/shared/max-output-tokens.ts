/** Clamp a user-entered max-output-tokens value to a sane range. 0 = off (Claude Code's default,
 *  32000). 128000 is the current top-tier model output ceiling (Opus 4.8 / Sonnet 5); the model's
 *  own cap bounds the effective value regardless, so this is only a UI sanity guard. */
export function clampMaxOutputTokens(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(128000, Math.floor(n)))
}

/** The env overlay for CLAUDE_CODE_MAX_OUTPUT_TOKENS. Empty when off (n <= 0), so applying it is
 *  additively byte-for-byte. */
export function maxOutputTokensEnv(n: number): Record<string, string> {
  return n > 0 ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(n) } : {}
}

/** Compose the final env for a headless run. `base` is the resolved backend env (run.env) or
 *  undefined. Off (n <= 0): return `base` unchanged — undefined stays undefined so the subprocess
 *  inherits process.env byte-for-byte. On: overlay the var onto `base ?? processEnv`. */
export function withMaxOutputTokensEnv(
  base: Record<string, string | undefined> | undefined,
  processEnv: Record<string, string | undefined>,
  n: number
): Record<string, string | undefined> | undefined {
  const overlay = maxOutputTokensEnv(n)
  return Object.keys(overlay).length > 0 ? { ...(base ?? processEnv), ...overlay } : base
}
