import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // The CLI test spawns the built bin.
    testTimeout: 30_000,
  },
});
