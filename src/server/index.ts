import { serve } from '@hono/node-server';
import app from './app.js';
import { initializeDatabase } from './db/init.js';

initializeDatabase();

const port = Number(process.env.PORT) || 3000;

console.log(`Tsubasa server listening on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});

