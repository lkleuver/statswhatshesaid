import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // E2E tests spin up sub-processes; give them more headroom than unit tests.
    testTimeout: 15000,
  },
})
