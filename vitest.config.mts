import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['{bin,lib}/**/*.test.ts'],
    setupFiles: ['vitest.setup.ts'],
  },
});
