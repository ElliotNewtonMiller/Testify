import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Most server tests start a whole server on a fresh in-memory database. Alone each takes
    // a second or two, but with every test file running in parallel some go past vitest's 5s
    // default and fail at random, so allow more.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
