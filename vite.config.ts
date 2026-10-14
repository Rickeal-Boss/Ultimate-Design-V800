import { defineConfig } from 'vite';

// three@0.186.1 的 package.json exports 已内置 "three/addons/*" 映射，
// 无需额外 alias；base 用相对路径便于静态托管。
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600
  }
});
