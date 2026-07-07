import type { StreamAgentOptions } from '../agent-runner'

/**
 * A pluggable agent runtime. The engine's Eng.runAgent seam targets this shape.
 * Every harness is an in-process object; whether run() internally uses the Claude
 * SDK, an in-process JS SDK, or manages a subprocess is hidden behind this signature.
 */
export interface Harness {
  run(opts: StreamAgentOptions): Promise<{ text: string; sessionId?: string }>
}
