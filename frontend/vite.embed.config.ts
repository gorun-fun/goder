import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// goder-auto 技能正文构建期注入(与桌面构建同一份源文件,见 automation.ts)。
const goderAutoSkill = readFileSync(resolve(__dirname, '../internal/desktop/agentskills/goder-auto.md'), 'utf8');

// 嵌入库版本号与 package.json 同源读取(embed.ts 的 GODER_UI_VERSION
// define 注入;桌面 vite.config.ts 同款机制,改版本只改 package.json)。
const uiVersion = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version;

// 嵌入库构建:单一 ESM 产物 dist-embed/goder.js(零外部依赖,shadow DOM
// 自隔离),三方页面 <script type="module"> 引入即用。
export default defineConfig({
  define: {
    __GODER_AUTO_SKILL_MD__: JSON.stringify(goderAutoSkill),
    __GODER_UI_VERSION__: JSON.stringify(uiVersion),
  },
  build: {
    outDir: 'dist-embed',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/entries/embed.ts'),
      formats: ['es'],
      fileName: () => 'goder.js',
    },
    rollupOptions: {
      // @wailsio/runtime 只在桌面入口动态引入,库产物不含它。
      external: [/@wailsio\/runtime/],
    },
  },
});
