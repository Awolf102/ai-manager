// Pure prompt + asset for the design-preview gate. No node/DOM imports.

/**
 * A curated, de-branded structural exemplar for the design-preview generator.
 * Teaches SECTION STRUCTURE + a token-driven, self-contained approach ONLY —
 * it deliberately uses neutral placeholder tokens, never a real palette/font,
 * so generated previews don't inherit one project's look.
 */
export const INSPIRATION_GUIDE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>Design System</title>
<style>
  /* Token-driven: define ALL colors/type as CSS variables chosen to fit the project's domain, then use them. */
  :root{
    --font-sans: system-ui, sans-serif;      /* choose a domain-appropriate stack */
    --font-mono: ui-monospace, monospace;
    --bg:#ffffff; --surface:#f5f5f5; --text:#111111; --muted:#666666; --accent:#333333; --border:#e5e5e5;
  }
  body{font-family:var(--font-sans);background:var(--bg);color:var(--text);margin:0;padding:32px;line-height:1.6}
  .section{margin-bottom:48px} .swatch{display:inline-block;width:64px;height:64px;border-radius:8px;margin-right:8px}
  .type-row{display:flex;gap:16px;align-items:baseline;margin-bottom:12px}
</style></head>
<body>
  <!-- 1. BRAND: product name + one-line positioning -->
  <section class="section"><h1>[Brand name]</h1><p>[One-line positioning]</p></section>
  <!-- 2. PALETTE: one swatch per token, each labelled with its hex + role -->
  <section class="section"><h2>Color</h2><span class="swatch" style="background:var(--accent)"></span></section>
  <!-- 3. TYPE SCALE: one row per role with px / weight / letter-spacing / line-height -->
  <section class="section"><h2>Type</h2>
    <div class="type-row"><span style="font-size:48px;font-weight:600">Display</span><code>48px / 600 / -0.03em / 1.1</code></div>
    <!-- also Heading 1, Heading 2, Heading 3, Body, Small, Label, Code -->
  </section>
  <!-- 4. COMPONENTS: primary + secondary button, input, card -->
  <section class="section"><h2>Components</h2></section>
  <!-- 5. APP-SHELL MOCK: topbar + sidebar + content region -->
  <section class="section"><h2>App shell</h2></section>
</body></html>`

/**
 * Prompt for the design-preview generation step. `guide` non-empty ⇒ injected
 * as a FORMAT-ONLY structural exemplar. `guide === ''` ⇒ byte-identical to the
 * no-guide branch (default param).
 */
export function designPreviewPrompt(goal: string, guide = ''): string {
  const guideBlock = guide
    ? `\n\nUse this structural exemplar for FORMAT ONLY — adopt its section structure and token-driven, self-contained approach, but choose colors, fonts, and mood that fit THIS project's domain (do NOT copy the exemplar's palette or fonts):\n\n${guide}`
    : ''
  return `You are producing a design-system PREVIEW for this goal:
${goal}

Write ONE self-contained HTML page to the file "design-preview.html" in the project root, showing, in order: (1) brand direction (name + one-line positioning), (2) the color palette as labelled swatches, (3) the type scale (each role with px / weight / letter-spacing / line-height), (4) key components (buttons, input, card), (5) a small app-shell mock.

Hard requirements:
- SELF-CONTAINED: inline all CSS in a <style> tag and use a system font stack (or an embedded @font-face). Do NOT reference any external stylesheet, CDN, or @import (e.g. Google Fonts) — they are blocked when the page is previewed and will silently fall back.
- Choose a visual direction that fits the project's domain and audience (e.g. an art shop reads expressive and artistic; a B2B SaaS reads minimal and professional).
- Produce ONLY this preview file — do not build the app, install anything, or edit other files.${guideBlock}

When done, reply with a one-line confirmation.`
}
