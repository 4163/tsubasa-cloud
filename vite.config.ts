import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import stylexPlugin from 'unplugin-stylex/vite';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SERVER_PORT, DEFAULT_WEB_DEV_PORT } from './src/server/ports.js';

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, './package.json'), 'utf8'),
) as { version: string };

function demoHtmlPlugin(): Plugin {
  return {
    name: 'tsubasa-demo-html',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html
          .replace(/^\s*<link\b[^>]*href="\/(?:favicon[^"]*|apple-touch-icon\.png)"[^>]*\/?>\r?\n?/gm, '')
          .replace(/^\s*<link\b[^>]*rel="preload"[^>]*href="\/src\/client\/assets\/fonts\/[^"]*"[^>]*\/?>\r?\n?/gm, '')
          .replaceAll("'tsubasa-theme-choice'", "'tsubasa-demo-theme-choice'");
      },
    },
  };
}

const DEMO_NOOP_VIRTUAL_ID = '\0tsubasa-demo-noop';
const DEMO_BACKDROP_NOOP_VIRTUAL_ID = '\0tsubasa-demo-backdrop-noop';

function stripDemoModulePlugin(): Plugin {
  const demoDir = path.resolve(__dirname, './src/client/demo').replace(/\\/g, '/');
  return {
    name: 'tsubasa-strip-demo-module',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      if (!source.includes('demo')) return null;
      const resolved = path.resolve(path.dirname(importer), source).replace(/\\/g, '/');
      if (resolved === `${demoDir}/index.js` || resolved === `${demoDir}/index.ts` || resolved === `${demoDir}/index`) {
        return DEMO_NOOP_VIRTUAL_ID;
      }
      if (
        resolved === `${demoDir}/backdrop.js` ||
        resolved === `${demoDir}/backdrop.ts` ||
        resolved === `${demoDir}/backdrop`
      ) {
        return DEMO_BACKDROP_NOOP_VIRTUAL_ID;
      }
      return null;
    },
    load(id) {
      if (id === DEMO_BACKDROP_NOOP_VIRTUAL_ID) {
        return 'export const DemoWorkspaceBackdrop = () => null;';
      }
      if (id !== DEMO_NOOP_VIRTUAL_ID) return null;
      return [
        'export const createDemoFetch = () => fetch;',
        'export const runDemoUpload = async () => ({ ok: false, error: "Demo mode disabled" });',
        'export const authorizeDemoAccount = async () => ({ ok: false, error: "Demo mode disabled" });',
        'export const recordDemoDownload = async () => {};',
        'export const resetDemoState = async () => {};',
      ].join('\n');
    },
  };
}

export default defineConfig(({ mode }) => {
  const isDemo = mode === 'demo';

  return {
    ...(isDemo ? { base: './', publicDir: false as const } : {}),
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __DEMO_MODE__: JSON.stringify(isDemo),
    },
    plugins: [
      ...(isDemo ? [demoHtmlPlugin()] : [stripDemoModulePlugin()]),
      stylexPlugin({
        stylex: {
          useCSSLayers: true,
        },
      }),
      react(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      ...(isDemo ? { outDir: 'dist/demo', emptyOutDir: true } : {}),
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.replace(/\\/g, '/');
            if (
              normalized.includes('/node_modules/react/') ||
              normalized.includes('/node_modules/react-dom/') ||
              normalized.includes('/node_modules/scheduler/')
            ) {
              return 'react-vendor';
            }
            if (
              normalized.includes('/node_modules/@tanstack/react-virtual/') ||
              normalized.includes('/node_modules/@tanstack/virtual-core/')
            ) {
              return 'virtualizer';
            }
            if (normalized.includes('/node_modules/hono/')) {
              return 'hono';
            }
          },
        },
      },
    },
    server: {
      port: DEFAULT_WEB_DEV_PORT,
      fs: {
        strict: false,
      },
      proxy: {
        '/api': {
          target: `http://localhost:${DEFAULT_SERVER_PORT}`,
          changeOrigin: true,
        },
      },
    },
  };
});

