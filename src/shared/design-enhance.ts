// Pure prompt + constants for the design-system enhance pass. No node/DOM imports.

/** Curated design-craft skills forced onto the enhance pass (present in ~/.ai-manager/skills-pack/skills). */
export const DESIGN_SKILLS = [
  'emil-design-eng',
  'ui-ux-pro-max',
  'impeccable',
  'design-taste-frontend',
  'high-end-visual-design',
  'redesign-existing-projects',
  'review-animations'
]

/** One-click enhancement directions offered in the modal (plus a free-text box). */
export const ENHANCE_PRESETS: { id: string; label: string }[] = [
  { id: 'polish', label: 'Polish & refine' },
  { id: 'modernize', label: 'Modernize' },
  { id: 'motion', label: 'Add motion & micro-interactions' },
  { id: 'a11y', label: 'Improve accessibility & contrast' }
]

/** The copy-paste prompt shown in the modal's FAQ to export a faithful self-contained design system. */
export const DESIGN_SYSTEM_FAQ_PROMPT =
  'Produce ONE self-contained .html file of this design system: inline all CSS in a <style> tag, inline the icons as SVG and the fonts (or use a system-font stack), and include the color/type/spacing tokens, the component examples, the motion (CSS keyframes/transitions), and the written usage notes. Do NOT reference any external stylesheet, CDN, or font URL — everything must be inline so it renders and reads correctly offline.'

/** Prompt for the enhance pass. `directions` are preset labels; `note` is free text. */
export function enhanceDesignPrompt(currentHtml: string, directions: string[], note: string): string {
  const dirs = directions.length ? `\nRequested directions: ${directions.join(', ')}.` : ''
  const extra = note.trim() ? `\nAdditional instruction: ${note.trim()}` : ''
  return `You are enhancing an existing design system. Approach this as a creative team — Creative Director (overall direction), Art Director (visual hierarchy and composition), Visual Designer (execution and detail), and a motion designer (micro-interactions) — and apply your design-craft skills: typographic craft, spacing rhythm, color, elevation, and motion.${dirs}${extra}

Keep the design system's core identity (its palette, brand, and structure) — improve the CRAFT, do not replace it with something unrelated.

Write the enhanced result to the file ".ai-manager/design-enhanced.html" as ONE self-contained HTML page: inline all CSS, inline SVG icons and fonts (or a system-font stack), CSS-based motion — NO external stylesheet, CDN, or font URL. Produce ONLY that file.

Here is the current design system to enhance:

${currentHtml}

When done, reply with a one-line summary of what you improved.`
}
