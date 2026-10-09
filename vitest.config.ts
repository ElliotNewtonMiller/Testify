import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Claude Code keeps git worktrees (other checkouts of this repo) under .claude/worktrees;
    // their copies of the tests must not run here -- they test old code against this checkout.
    exclude: [...configDefaults.exclude, '.claude/**'],
    // Most server tests start a whole server on a fresh in-memory database. Alone each takes
    // a second or two, but with every test file running in parallel some go past vitest's 5s
    // default and fail at random, so allow more.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
