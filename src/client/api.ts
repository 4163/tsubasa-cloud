import { hc, type InferResponseType } from 'hono/client';
import type { AppType } from '../server/app.js';
import { createDemoFetch } from './demo/index.js';

export const client = hc<AppType>('/', __DEMO_MODE__ ? { fetch: createDemoFetch() } : undefined);

export type FileRecord = InferResponseType<typeof client.api.files.$get, 200>['files'][number];
export type FolderRecord = InferResponseType<typeof client.api.folders.$get, 200>['folders'][number];

