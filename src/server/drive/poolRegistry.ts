import { sqlite } from '../db/index.js';

export const POOL_FOLDER_PREFIX = '_Tsubasa~ Pool ';
export const SHARE_POOL_FOLDER_NAME = '_Tsubasa~ Pool share';
// Reserve a high positive ID range so Share Pool never shifts sequential standard Pool IDs (Pool 2, Pool 3, ...).
export const SHARE_POOL_RESERVE_ID = 1_000_000;

export interface PoolFolderDescriptor {
  kind: 'share' | 'standard';
  poolNumber: number | null;
}

export function getPoolDriveFolderName(poolId: number): string {
  return `_Tsubasa~ Pool ${poolId}`;
}

export function resolvePoolDriveFolderName(poolId: number): string {
  const row = sqlite
    .prepare('SELECT drive_folder_name FROM pools WHERE id = ?')
    .get(poolId) as { drive_folder_name: string } | undefined;
  return row?.drive_folder_name || getPoolDriveFolderName(poolId);
}

export function parsePoolFolderDescriptor(name: string): PoolFolderDescriptor | null {
  const trimmed = name.trim();
  if (trimmed === SHARE_POOL_FOLDER_NAME) {
    return { kind: 'share', poolNumber: null };
  }

  const match = /^_Tsubasa~ Pool ([1-9]\d*)$/.exec(trimmed);
  if (!match) return null;
  return { kind: 'standard', poolNumber: Number(match[1]) };
}

export function parsePoolIdFromFolderName(name: string): number | null {
  const descriptor = parsePoolFolderDescriptor(name);
  if (!descriptor || descriptor.kind !== 'standard') return null;
  return descriptor.poolNumber;
}

export function ensurePoolExistsInDb(poolId: number): void {
  if (poolId === SHARE_POOL_RESERVE_ID) {
    ensureSharePoolExistsInDb();
    return;
  }
  const folderName = getPoolDriveFolderName(poolId);
  sqlite
    .prepare(
      `INSERT INTO pools (id, name, drive_folder_name) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`
    )
    .run(poolId, `Pool ${poolId}`, folderName);
}

export function isSharePoolId(poolId: number): boolean {
  if (poolId === SHARE_POOL_RESERVE_ID) {
    return true;
  }
  const row = sqlite
    .prepare('SELECT is_share_pool as isSharePool FROM pools WHERE id = ? LIMIT 1')
    .get(poolId) as { isSharePool: number } | undefined;
  return Boolean(row?.isSharePool);
}

export function ensureSharePoolExistsInDb(): number {
  return sqlite.transaction(() => {
    const existing = sqlite
      .prepare('SELECT id FROM pools WHERE is_share_pool = 1 OR drive_folder_name = ? LIMIT 1')
      .get(SHARE_POOL_FOLDER_NAME) as { id: number } | undefined;
    if (existing) {
      return existing.id;
    }

    const maxRow = sqlite
      .prepare('SELECT MAX(id) as maxId FROM pools')
      .get() as { maxId: number | null } | undefined;
    const nextId = Math.max(SHARE_POOL_RESERVE_ID, (maxRow?.maxId ?? 0) + 1);

    sqlite
      .prepare(
        `INSERT INTO pools (id, name, drive_folder_name, is_share_pool) VALUES (?, ?, ?, 1)`
      )
      .run(nextId, 'Share Pool', SHARE_POOL_FOLDER_NAME);

    return nextId;
  })();
}
