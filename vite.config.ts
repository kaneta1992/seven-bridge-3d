import { defineConfig } from 'vitest/config';

// GitHub Pages 配信のため base は相対パス './'
export default defineConfig({
  base: './',
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
