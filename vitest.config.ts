import { defineConfig } from 'vitest/config'

// Unit tests run in plain Node — the modules under test (run-state, run-store)
// are intentionally free of electron/DOM imports so they need no special env.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false
  }
})
