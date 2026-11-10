import { hc, type InferResponseType } from 'hono/client';
import type { AppType } from '../server/app.js';

export const client = hc<AppType>('/');

export type FilesResponse = InferResponseType<typeof client.api.files.$get, 200>;
export type FileRecord = FilesResponse['files'][number];

export type FoldersResponse = InferResponseType<typeof client.api.folders.$get, 200>;
export type FolderRecord = FoldersResponse['folders'][number];
export type Folder = FolderRecord;

export type PoolsResponse = InferResponseType<typeof client.api.pools.$get, 200>;
export type PoolRecord = PoolsResponse['pools'][number];

