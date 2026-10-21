import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The MCP App must ship as one self-contained HTML document (Alexa+ webview / MCP Apps hosts).
export default defineConfig({
  root: 'app',
  plugins: [viteSingleFile()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020', assetsInlineLimit: 100_000_000 },
});
