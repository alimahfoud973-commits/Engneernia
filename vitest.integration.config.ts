import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Integration tests run against a REAL PostgreSQL instance.
 *
 * They are separate from the unit suite on purpose: the unit suite must stay
 * fast and dependency-free, while these exist specifically to prove things
 * that cannot be proven with a mock — namely that Row-Level Security holds
 * when the application layer does not.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.itest.ts'],
    setupFiles: ['./vitest.setup.integration.ts'],
    // Shared database state: run files in sequence rather than racing.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
