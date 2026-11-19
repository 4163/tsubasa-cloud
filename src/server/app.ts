import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import accountsRouter from './routes/accounts.js';
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
import trashRouter from './routes/trash.js';

export interface CreateAppOptions {
  enableHttpLogger?: boolean;
  enableCompress?: boolean;
}

export function createApp(options: CreateAppOptions = {}) {
  const { enableHttpLogger = true, enableCompress = true } = options;
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

  return app
    .route('/', instanceRouter)
    .route('/', poolsRouter)
    .route('/', storageRouter)
    .route('/', accountsRouter)
    .route('/', syncRouter)
    .route('/', foldersRouter)
    .route('/', filesRouter)
    .route('/', itemsRouter)
    .route('/', trashRouter)
    .route('/', discrepanciesRouter)
    .route('/', rebalanceRouter)
    .route('/', shareRouter);
}

const routes = createApp();

export type AppType = typeof routes;
export default routes;
