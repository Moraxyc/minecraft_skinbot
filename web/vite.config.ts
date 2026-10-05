import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
});
