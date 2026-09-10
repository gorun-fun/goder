import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// 桌面 app 构建(也用于浏览器直开调试):入口 main.ts + embed-demo。
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        embed: resolve(__dirname, 'embed-demo.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
