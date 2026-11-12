import { defineConfig } from 'vitest/config';

// End to end against the running stack: docker compose up -d --build, then npm run test:e2e.
// Talks to Long Tail and the review-order app over HTTP only; LT_URL and APP_URL override the ports.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
