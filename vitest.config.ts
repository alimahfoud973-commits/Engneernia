import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // The financial core is held to a higher bar than the rest of the app.
      thresholds: {
        'src/lib/money/**': { statements: 100, branches: 95, functions: 100, lines: 100 },
      },
    },
  },
});
