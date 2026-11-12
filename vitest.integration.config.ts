import { defineConfig } from 'vitest/config';

// Integration runs Long Tail and DBOS in process against Postgres (docker compose).
// NODE_ENV stays off 'test' so Long Tail uses the connection string given to start().
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 120_000,
    hookTimeout: 180_000,
    env: { NODE_ENV: 'development', LOG_LEVEL: 'warn' },
  },
});
