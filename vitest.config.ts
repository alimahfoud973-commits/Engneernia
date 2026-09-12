import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Server modules guard themselves with `import 'server-only'`, which
      // throws unless the bundler applies the `react-server` export condition.
      // Vitest runs plain Node, so it resolves the client entry and blows up.
      // Aliasing to the package's own no-op server entry keeps the guard real
      // in the application build while letting the tests import the modules.
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      thresholds: {
        'src/lib/money/**': { statements: 100, branches: 95, functions: 100, lines: 100 },
      },
    },
  },
});
