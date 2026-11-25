import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import stylexPlugin from 'unplugin-stylex/vite';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SERVER_PORT, DEFAULT_WEB_DEV_PORT } from './src/server/ports.js';

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, './package.json'), 'utf8'),
) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
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
});

