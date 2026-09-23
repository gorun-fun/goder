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
    // core/store/automation.ts 以 ?raw 引 internal/desktop/agentskills/
    // 下的技能源文件(与 Go go:embed 同一份),dev server 需放行
    // frontend 之外的仓库路径。
    fs: { allow: [resolve(__dirname, '..')] },
  },
});
