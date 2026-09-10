import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// 嵌入库构建:单一 ESM 产物 dist-embed/grf-ui.js(零外部依赖,shadow DOM
// 自隔离),三方页面 <script type="module"> 引入即用。
export default defineConfig({
  build: {
    outDir: 'dist-embed',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/embed/index.ts'),
      formats: ['es'],
      fileName: () => 'grf-ui.js',
    },
    rollupOptions: {
      // @wailsio/runtime 只在桌面入口动态引入,库产物不含它。
      external: [/@wailsio\/runtime/],
    },
  },
});
