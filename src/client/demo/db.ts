import type { DiscrepancyReport } from '../types.js';
import { getParentDir, normalizeVirtualPath } from '../utils/virtualPath.js';
import { buildInitialDemoDataset } from './seed.js';

export const DEMO_DB_NAME = 'tsubasa-demo-v1';
export const DEMO_DB_VERSION = 1;
export const DEMO_SEED_VERSION = 2;
const DEMO_SYNC_CHANNEL_NAME = 'tsubasa-demo-sync';

export type DemoSyncEventType = 'mutated' | 'reset';

export interface DemoSyncEvent {
  type: DemoSyncEventType;
  senderId: string;
  ts: number;
}

export interface DemoMetaRecord {
  key: 'state';
  seedVersion: number;
  nextPoolId: number;
  usedPersonaEmails: string[];
}

export interface DemoPoolRecord {
  id: number;
  name: string;
  slug: string;
  sortOrder: number;
  driveFolderName: string;
  isSharePool: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DemoAccountRecord {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  poolId: number;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  syncState: 'idle' | 'syncing' | 'error';
  isDisabled: boolean;
  authorized: boolean;
  sourceFile: string;
  clientId: string;
  mtimeMs: number;
  rootFolderId: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface DemoFolderRecord {
  id: string;
  poolId: number;
  virtualPath: string;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DemoFileRecord {
  id: string;
  poolId: number;
  virtualPath: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  hash: string | null;
  accountId: string;
  driveFileId: string;
  folderId: string | null;
  isTrashed: boolean;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contentText?: string;
}

export interface DemoTransferLogRecord {
  id: string;
  accountId: string;
  transferType: 'upload' | 'download';
  byteCount: number;
  timestamp: number;
}

export type DemoDiscrepancyRecord = DiscrepancyReport;

export interface DemoShareLinkRecord {
  id: string;
  poolId: number;
  batchFolderName: string;
  accountId: string;
  driveFolderId: string;
  webViewLink: string;
  filesCount: number;
  bytesAllocated: number;
}

export interface DemoSeedDataset {
  meta: DemoMetaRecord;
  pools: DemoPoolRecord[];
  accounts: DemoAccountRecord[];
  folders: DemoFolderRecord[];
  files: DemoFileRecord[];
  transferLogs: DemoTransferLogRecord[];
  discrepancies: DemoDiscrepancyRecord[];
  shareLinks: DemoShareLinkRecord[];
}

export const DEMO_STORES = [
  'meta',
  'pools',
  'accounts',
  'folders',
  'files',
  'transferLogs',
  'discrepancies',
  'shareLinks',
] as const;

export type DemoStoreName = (typeof DEMO_STORES)[number];

export interface DemoDatabaseState {
  meta: DemoMetaRecord;
  pools: DemoPoolRecord[];
  accounts: DemoAccountRecord[];
  folders: DemoFolderRecord[];
  files: DemoFileRecord[];
  transferLogs: DemoTransferLogRecord[];
  discrepancies: DemoDiscrepancyRecord[];
  shareLinks: DemoShareLinkRecord[];
}

export function formatDemoFolderId(poolId: number, virtualPath: string): string {
  return `${poolId}:${normalizeVirtualPath(virtualPath)}`;
}

export function getDemoBaseName(virtualPath: string): string {
  const normalized = normalizeVirtualPath(virtualPath);
  if (normalized === '/') return '/';
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

export function joinDemoPath(dir: string, name: string): string {
  const normDir = normalizeVirtualPath(dir);
  const cleanName = name.replace(/^\/+/, '');
  return normDir === '/' ? normalizeVirtualPath(`/${cleanName}`) : normalizeVirtualPath(`${normDir}/${cleanName}`);
}

export function extractParentFolderPaths(virtualPath: string): string[] {
  const normalized = normalizeVirtualPath(virtualPath);
  const paths: string[] = [];
  let current = getParentDir(normalized);
  while (current !== '/') {
    paths.push(current);
    current = getParentDir(current);
  }
  return paths.reverse();
}

export function generateDemoId(prefix?: string): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}-${uuid}` : uuid;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionToPromise(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

let openDbPromise: Promise<IDBDatabase> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
const DEMO_TAB_ID = generateDemoId('tab');
let syncSenderChannel: BroadcastChannel | null = null;

function notifyDemoSync(type: DemoSyncEventType): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    if (!syncSenderChannel) {
      syncSenderChannel = new BroadcastChannel(DEMO_SYNC_CHANNEL_NAME);
    }
    const payload: DemoSyncEvent = {
      type,
      senderId: DEMO_TAB_ID,
      ts: Date.now(),
    };
    syncSenderChannel.postMessage(payload);
  } catch {
    // Ignore BroadcastChannel errors in restricted iframe or privacy contexts.
  }
}

export function subscribeDemoSync(listener: (event: DemoSyncEvent) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') {
    return () => {};
  }
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(DEMO_SYNC_CHANNEL_NAME);
  } catch {
    return () => {};
  }

  channel.onmessage = (msg: MessageEvent<unknown>) => {
    const data = msg.data as Partial<DemoSyncEvent> | null;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'mutated' && data.type !== 'reset') return;
    if (typeof data.senderId !== 'string' || data.senderId === DEMO_TAB_ID) return;
    listener({
      type: data.type,
      senderId: data.senderId,
      ts: typeof data.ts === 'number' ? data.ts : Date.now(),
    });
  };

  return () => {
    try {
      channel.onmessage = null;
      channel.close();
    } catch {
      // Ignore close errors if channel was already closed.
    }
  };
}

function createObjectStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains('meta')) {
    db.createObjectStore('meta', { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains('pools')) {
    db.createObjectStore('pools', { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains('accounts')) {
    const store = db.createObjectStore('accounts', { keyPath: 'id' });
    store.createIndex('by_pool', 'poolId', { unique: false });
  }
  if (!db.objectStoreNames.contains('folders')) {
    const store = db.createObjectStore('folders', { keyPath: 'id' });
    store.createIndex('by_pool', 'poolId', { unique: false });
    store.createIndex('by_pool_path', ['poolId', 'virtualPath'], { unique: false });
  }
  if (!db.objectStoreNames.contains('files')) {
    const store = db.createObjectStore('files', { keyPath: 'id' });
    store.createIndex('by_pool', 'poolId', { unique: false });
    store.createIndex('by_account', 'accountId', { unique: false });
    store.createIndex('by_pool_path', ['poolId', 'virtualPath'], { unique: false });
  }
  if (!db.objectStoreNames.contains('transferLogs')) {
    const store = db.createObjectStore('transferLogs', { keyPath: 'id' });
    store.createIndex('by_account', 'accountId', { unique: false });
  }
  if (!db.objectStoreNames.contains('discrepancies')) {
    db.createObjectStore('discrepancies', { keyPath: 'accountId' });
  }
  if (!db.objectStoreNames.contains('shareLinks')) {
    const store = db.createObjectStore('shareLinks', { keyPath: 'id' });
    store.createIndex('by_pool', 'poolId', { unique: false });
  }
}

async function writeDatasetToDb(db: IDBDatabase, dataset: DemoSeedDataset): Promise<void> {
  const tx = db.transaction(DEMO_STORES as unknown as string[], 'readwrite');

  for (const storeName of DEMO_STORES) {
    tx.objectStore(storeName).clear();
  }

  tx.objectStore('meta').put({
    ...dataset.meta,
    key: 'state',
  });

  const poolsStore = tx.objectStore('pools');
  for (const pool of dataset.pools) {
    poolsStore.put(pool);
  }

  const accountsStore = tx.objectStore('accounts');
  for (const account of dataset.accounts) {
    accountsStore.put(account);
  }

  const foldersStore = tx.objectStore('folders');
  for (const folder of dataset.folders) {
    foldersStore.put(folder);
  }

  const filesStore = tx.objectStore('files');
  for (const file of dataset.files) {
    filesStore.put(file);
  }

  const logsStore = tx.objectStore('transferLogs');
  for (const log of dataset.transferLogs) {
    logsStore.put(log);
  }

  const discrepanciesStore = tx.objectStore('discrepancies');
  for (const disc of dataset.discrepancies) {
    discrepanciesStore.put(disc);
  }

  const shareLinksStore = tx.objectStore('shareLinks');
  for (const link of dataset.shareLinks) {
    shareLinksStore.put(link);
  }

  await transactionToPromise(tx);
}

async function openAndSeedDb(): Promise<IDBDatabase> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DEMO_DB_NAME, DEMO_DB_VERSION);
    req.onupgradeneeded = () => {
      createObjectStores(req.result);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open demo IndexedDB'));
  });

  const tx = db.transaction('meta', 'readonly');
  const meta = (await requestToPromise(tx.objectStore('meta').get('state'))) as DemoMetaRecord | undefined;
  await transactionToPromise(tx);

  if (!meta || meta.seedVersion !== DEMO_SEED_VERSION) {
    const dataset = buildInitialDemoDataset(Date.now());
    await writeDatasetToDb(db, dataset);
  }

  db.onversionchange = () => {
    db.close();
    openDbPromise = null;
  };

  return db;
}

export async function getDemoDb(): Promise<IDBDatabase> {
  if (!openDbPromise) {
    openDbPromise = openAndSeedDb().catch((err) => {
      openDbPromise = null;
      throw err;
    });
  }
  return openDbPromise;
}

export function withDemoWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export async function loadDemoState(): Promise<DemoDatabaseState> {
  const db = await getDemoDb();
  const tx = db.transaction(DEMO_STORES as unknown as string[], 'readonly');

  const [meta, pools, accounts, folders, files, transferLogs, discrepancies, shareLinks] = await Promise.all([
    requestToPromise(tx.objectStore('meta').get('state')) as Promise<DemoMetaRecord | undefined>,
    requestToPromise(tx.objectStore('pools').getAll()) as Promise<DemoPoolRecord[]>,
    requestToPromise(tx.objectStore('accounts').getAll()) as Promise<DemoAccountRecord[]>,
    requestToPromise(tx.objectStore('folders').getAll()) as Promise<DemoFolderRecord[]>,
    requestToPromise(tx.objectStore('files').getAll()) as Promise<DemoFileRecord[]>,
    requestToPromise(tx.objectStore('transferLogs').getAll()) as Promise<DemoTransferLogRecord[]>,
    requestToPromise(tx.objectStore('discrepancies').getAll()) as Promise<DemoDiscrepancyRecord[]>,
    requestToPromise(tx.objectStore('shareLinks').getAll()) as Promise<DemoShareLinkRecord[]>,
  ]);

  await transactionToPromise(tx);

  return {
    meta: meta ?? {
      key: 'state',
      seedVersion: DEMO_SEED_VERSION,
      nextPoolId: 3,
      usedPersonaEmails: [],
    },
    pools,
    accounts,
    folders,
    files,
    transferLogs,
    discrepancies,
    shareLinks,
  };
}

export async function getAllRecords<T>(storeName: DemoStoreName): Promise<T[]> {
  const db = await getDemoDb();
  const tx = db.transaction(storeName, 'readonly');
  const rows = (await requestToPromise(tx.objectStore(storeName).getAll())) as T[];
  await transactionToPromise(tx);
  return rows;
}

export async function getRecordByKey<T>(storeName: DemoStoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await getDemoDb();
  const tx = db.transaction(storeName, 'readonly');
  const row = (await requestToPromise(tx.objectStore(storeName).get(key))) as T | undefined;
  await transactionToPromise(tx);
  return row;
}

export async function getRecordsByIndex<T>(
  storeName: DemoStoreName,
  indexName: string,
  query: IDBValidKey | IDBKeyRange
): Promise<T[]> {
  const db = await getDemoDb();
  const tx = db.transaction(storeName, 'readonly');
  const rows = (await requestToPromise(tx.objectStore(storeName).index(indexName).getAll(query))) as T[];
  await transactionToPromise(tx);
  return rows;
}

export async function runStoreMutation(
  stores: DemoStoreName[],
  mutate: (tx: IDBTransaction) => void
): Promise<void> {
  const db = await getDemoDb();
  const tx = db.transaction(stores, 'readwrite');
  mutate(tx);
  await transactionToPromise(tx);
  notifyDemoSync('mutated');
}

export async function resetDemoDatabase(): Promise<void> {
  await withDemoWriteLock(async () => {
    if (openDbPromise) {
      try {
        const currentDb = await openDbPromise;
        currentDb.close();
      } catch {
        // Ignore close errors if previous open failed
      }
      openDbPromise = null;
    }

    const deleted = await new Promise<boolean>((resolve) => {
      const req = indexedDB.deleteDatabase(DEMO_DB_NAME);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    });

    if (deleted) {
      await getDemoDb();
      notifyDemoSync('reset');
      return;
    }

    // Fallback when another handle momentarily blocks deleteDatabase: clear and re-seed in place.
    const db = await getDemoDb();
    const dataset = buildInitialDemoDataset(Date.now());
    await writeDatasetToDb(db, dataset);
    notifyDemoSync('reset');
  });
}
