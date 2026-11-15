import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import stylexPlugin from 'unplugin-stylex/vite';
import path from 'node:path';

export default defineConfig({
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
    port: 5173,
    fs: {
      strict: false,
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});

