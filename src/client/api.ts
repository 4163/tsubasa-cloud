import { hc } from 'hono/client';
import type { AppType } from '../server/app.js';

export const client = hc<AppType>('/');

