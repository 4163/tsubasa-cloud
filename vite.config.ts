import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import stylexPlugin from 'unplugin-stylex/vite';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SITE_ORIGIN = 'https://tsubasa.moe.page';

function resolveSiteOrigin(): string {
  const raw = process.env.VITE_SITE_ORIGIN?.trim() || DEFAULT_SITE_ORIGIN;
  return raw.replace(/\/+$/, '');
}

function resolveSiteBase(origin: string): string {
  const pathname = new URL(origin).pathname.replace(/^\/+|\/+$/g, '');
  return pathname ? `/${pathname}/` : '/';
}

function siteOriginPlugin(origin: string, base: string): Plugin {
  const placeholder = /%VITE_SITE_ORIGIN%/g;
  const policyPath = `${base}data-policy`;

  const rewriteCleanRoutes = (
    req: { url?: string },
    _res: unknown,
    next: () => void,
  ) => {
    if (req.url === policyPath || req.url?.startsWith(`${policyPath}?`)) {
      req.url = `${policyPath}/index.html${req.url.slice(policyPath.length)}`;
    }
    next();
  };

  return {
    name: 'tsubasa-site-origin',
    configureServer(server) {
      server.middlewares.use(rewriteCleanRoutes);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewriteCleanRoutes);
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(placeholder, origin);
      },
    },
    writeBundle(options) {
      const outDir = options.dir ? path.resolve(options.dir) : path.resolve(__dirname, 'dist');
      for (const fileName of ['robots.txt', 'sitemap.xml']) {
        const target = path.join(outDir, fileName);
        if (!fs.existsSync(target)) continue;
        const content = fs.readFileSync(target, 'utf8');
        fs.writeFileSync(target, content.replace(placeholder, origin), 'utf8');
      }
    },
  };
}

const siteOrigin = resolveSiteOrigin();
const siteBase = resolveSiteBase(siteOrigin);

export default defineConfig({
  base: siteBase,
  appType: 'mpa',
  plugins: [
    siteOriginPlugin(siteOrigin, siteBase),
    stylexPlugin({
      stylex: {
        useCSSLayers: true,
      },
    }),
    react(),
  ],
  server: {
    port: 28302,
    fs: {
      strict: false,
    },
  },
  preview: {
    port: 28303,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        dataPolicy: path.resolve(__dirname, 'data-policy/index.html'),
      },
    },
  },
});
