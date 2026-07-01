// Pure token-efficiency helpers. No node/DOM/engine imports — unit-tested in
// plain Node like shared/model-caps.ts. Off/neutral inputs return no-op values
// so the whole feature is byte-for-byte identical when disabled.
import type { Effort } from './types'
import { EFFORT_LEVELS } from './types'

export type OutputMode = 'normal' | 'terse' | 'code-only'

/** A system-prompt append that biases the agent toward fewer output tokens.
 *  '' for 'normal' (byte-for-byte). Non-normal modes always exempt any code or
 *  required structured/JSON block so routing/review/plan steps still work. */
export function outputModeInstruction(mode: OutputMode): string {
  if (mode === 'terse') {
    return (
      '\n\n## Output mode: terse\n' +
      'Keep prose to a minimum. No preamble, no restating the task, no narration of ' +
      'what you are about to do, no closing summary beyond one line. Give only the ' +
      'essential result. This does NOT apply to code or to any structured/JSON block ' +
      'you were asked to produce — always output those in full.'
    )
  }
  if (mode === 'code-only') {
    return (
      '\n\n## Output mode: code only\n' +
      'Output only code and essential results — file edits, commands, and the minimal ' +
      'text needed to be understood. Omit explanations, narration, and summaries unless ' +
      'explicitly asked. Any code block or required structured/JSON reply must still be ' +
      'produced in full.'
    )
  }
  return ''
}

/** Cap an effort DOWN to `ceiling` (pure min by level). undefined in -> undefined out. */
export function capEffort(effort: Effort | undefined, ceiling: Effort): Effort | undefined {
  if (!effort) return undefined
  return EFFORT_LEVELS.indexOf(effort) <= EFFORT_LEVELS.indexOf(ceiling) ? effort : ceiling
}
