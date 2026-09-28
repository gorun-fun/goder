import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// goder-auto 技能正文构建期注入(单一源文件在 Go 侧目录,与 go:embed
// 同一份;core 不再跨树 ?raw 引用,见 core/store/automation.ts)。
const goderAutoSkill = readFileSync(resolve(__dirname, '../internal/desktop/agentskills/goder-auto.md'), 'utf8');

// 桌面 app 构建(也用于浏览器直开调试):入口 main.ts + embed-demo。
export default defineConfig({
  define: {
    __GODER_AUTO_SKILL_MD__: JSON.stringify(goderAutoSkill),
    __GODER_UI_VERSION__: JSON.stringify("0.1.0"),
  },
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
    // embed-demo 等页面可能引用仓库内资源,dev server 放行 frontend
    // 之外的仓库路径(core 的跨树 ?raw 已改为 define 注入,与此无关)。
    fs: { allow: [resolve(__dirname, '..')] },
  },
});
