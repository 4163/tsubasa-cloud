import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { createAccountsRouter, type AuthCompletedEvent } from './routes/accounts.js';
import discrepanciesRouter from './routes/discrepancies.js';
import filesRouter from './routes/files.js';
import foldersRouter from './routes/folders.js';
import instanceRouter from './routes/instance.js';
import itemsRouter from './routes/items.js';
import poolsRouter from './routes/pools.js';
import rebalanceRouter from './routes/rebalance.js';
import shareRouter from './routes/share.js';
import storageRouter from './routes/storage.js';
import syncRouter from './routes/sync.js';
import transfersRouter from './routes/transfers.js';
import trashRouter from './routes/trash.js';

export type { AuthCompletedEvent } from './routes/accounts.js';

export interface CreateAppOptions {
  enableHttpLogger?: boolean;
  enableCompress?: boolean;
  staticDir?: string;
  onAuthCompleted?: (payload: AuthCompletedEvent) => void;
}

const STATIC_MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return STATIC_MIME_TYPES[ext] ?? 'application/octet-stream';
}

function isPathWithinDir(rootDir: string, candidatePath: string): boolean {
  const rel = path.relative(rootDir, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function readStaticFileIfExists(filePath: string): Promise<Buffer | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return await fs.promises.readFile(filePath);
  } catch {
    return null;
  }
}

function createStaticResponse(
  method: string,
  filePath: string,
  content: Buffer,
  cacheControl: string
): Response {
  const headers = new Headers({
    'Content-Type': getContentType(filePath),
    'Content-Length': String(content.byteLength),
    'Cache-Control': cacheControl,
  });
  const body = method === 'HEAD' ? null : new Uint8Array(content);
  return new Response(body, { status: 200, headers });
}

// Attach the static fallback route as a statement on the already-chained router
// so createApp's inferred Hono route generic (AppType) stays unchanged for Hono RPC.
function attachStaticFrontend(
  router: { on: Hono['on'] },
  staticDir: string
): void {
  const resolvedStaticDir = path.resolve(staticDir);
  const indexHtmlPath = path.join(resolvedStaticDir, 'index.html');

  router.on(['GET', 'HEAD'], '*', async (c) => {
    const reqPath = c.req.path;
    if (reqPath === '/api' || reqPath.startsWith('/api/')) {
      return c.notFound();
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(reqPath);
    } catch {
      return c.text('Bad Request', 400);
    }

    if (decodedPath.includes('\0')) {
      return c.notFound();
    }

    const relativePath = decodedPath.replace(/^\/+/, '');
    const isAssetRequest = decodedPath.startsWith('/assets/');

    if (relativePath.length > 0) {
      const candidatePath = path.resolve(resolvedStaticDir, relativePath);
      if (!isPathWithinDir(resolvedStaticDir, candidatePath)) {
        return c.notFound();
      }

      const content = await readStaticFileIfExists(candidatePath);
      if (content !== null) {
        const cacheControl = isAssetRequest ? 'public, max-age=31536000, immutable' : 'no-cache';
        return createStaticResponse(c.req.method, candidatePath, content, cacheControl);
      }

      if (isAssetRequest) {
        return c.notFound();
      }
    }

    const indexContent = await readStaticFileIfExists(indexHtmlPath);
    if (indexContent === null) {
      return c.notFound();
    }

    return createStaticResponse(c.req.method, indexHtmlPath, indexContent, 'no-cache');
  });
}

export function createApp(options: CreateAppOptions = {}) {
  const {
    enableHttpLogger = true,
    enableCompress = true,
    staticDir,
    onAuthCompleted,
  } = options;
  const app = new Hono();

  if (enableCompress) {
    app.use('*', compress());
  }

  if (enableHttpLogger) {
    const httpLogger = logger();
    app.use('*', async (c, next) => {
      if (c.req.path === '/api/instance/heartbeat' || c.req.path === '/api/health') {
        return next();
      }
      return httpLogger(c, next);
    });
  }

  app.use('*', cors());

  const routes = app
    .route('/', instanceRouter)
    .route('/', poolsRouter)
    .route('/', storageRouter)
    .route('/', createAccountsRouter({ serveStatic: Boolean(staticDir), onAuthCompleted }))
    .route('/', syncRouter)
    .route('/', foldersRouter)
    .route('/', filesRouter)
    .route('/', itemsRouter)
    .route('/', trashRouter)
    .route('/', discrepanciesRouter)
    .route('/', rebalanceRouter)
    .route('/', shareRouter)
    .route('/', transfersRouter);

  if (staticDir) {
    attachStaticFrontend(routes, staticDir);
  }

  return routes;
}

export type AppType = ReturnType<typeof createApp>;
