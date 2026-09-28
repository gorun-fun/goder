import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// grf-auto 技能正文构建期注入(与桌面构建同一份源文件,见 automation.ts)。
const grfAutoSkill = readFileSync(resolve(__dirname, '../internal/desktop/agentskills/grf-auto.md'), 'utf8');

// 嵌入库构建:单一 ESM 产物 dist-embed/grf-ui.js(零外部依赖,shadow DOM
// 自隔离),三方页面 <script type="module"> 引入即用。
export default defineConfig({
  define: {
    __GRF_AUTO_SKILL_MD__: JSON.stringify(grfAutoSkill),
    __GRF_UI_VERSION__: JSON.stringify("0.1.0"),
  },
  build: {
    outDir: 'dist-embed',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/entries/embed.ts'),
      formats: ['es'],
      fileName: () => 'grf-ui.js',
    },
    rollupOptions: {
      // @wailsio/runtime 只在桌面入口动态引入,库产物不含它。
      external: [/@wailsio\/runtime/],
    },
  },
});
