import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/**/tests/**/*.test.ts'],
    // Each test spawns the release script, which spawns tar, npm and pnpm.
    testTimeout: 30_000,
  },
});
