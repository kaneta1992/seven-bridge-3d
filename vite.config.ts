import { defineConfig } from 'vitest/config';

// ビルド識別子（診断用）: CI では GITHUB_SHA 先頭7桁、ローカルは 'dev'。
// ロビー画面に表示し、ユーザーが古いキャッシュを掴んでいないか遠隔で判別できるようにする。
const buildId = (process.env.GITHUB_SHA ?? '').slice(0, 7) || 'dev';

// GitHub Pages 配信のため base は相対パス './'
export default defineConfig({
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
