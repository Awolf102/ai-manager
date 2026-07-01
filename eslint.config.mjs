// Minimal ESLint flat config — a targeted tripwire for React Rules-of-Hooks
// violations (the class that once blanked the app on project-open; see
// docs/superpowers/specs/2026-07-01-eslint-hooks-gate-design.md). Intentionally
// NOT a full lint regime: only the two react-hooks rules, so it stays a focused
// safety net rather than a sweeping cleanup.
import reactHooks from 'eslint-plugin-react-hooks'
import tsParser from '@typescript-eslint/parser'

export default [
  { ignores: ['out/**', 'node_modules/**', 'dist/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The app-breaker — a hook after a conditional return, etc. Hard error (blocks the gate).
      'react-hooks/rules-of-hooks': 'error',
      // Advisory + noisy; non-blocking. Kept as `warn` (not off) so existing
      // per-line disable directives stay valid and new cases still surface.
      'react-hooks/exhaustive-deps': 'warn'
    }
  }
]
