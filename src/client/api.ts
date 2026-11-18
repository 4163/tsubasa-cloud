import { hc, type InferResponseType } from 'hono/client';
import type { AppType } from '../server/app.js';

export const client = hc<AppType>('/');

export type FileRecord = InferResponseType<typeof client.api.files.$get, 200>['files'][number];
export type FolderRecord = InferResponseType<typeof client.api.folders.$get, 200>['folders'][number];

