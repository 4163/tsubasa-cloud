import {
  getDriveClient,
  refreshAccountLiveQuota,
  resolveRemoteFolderTree,
  runBoundedConcurrency,
  withDriveRetry,
} from './client.js';
import { db, sqlite } from '../db/index.js';
import { accounts, files } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import path from 'node:path';

export function formatFolderId(poolId: number, virtualPath: string): string {
  return `${poolId}:${virtualPath}`;
}

// Drive file IDs accepted locally whose Tsubasa appProperties are still being stamped in the background.
// Cold reconciliation lists only stamped files, so it must not prune these rows mid-flight.
export const pendingAppPropertyDriveIds = new Set<string>();

export interface ColdSyncReport {
  accountId: string;
  filesIndexed: number;
  foldersIndexed: number;
  bytesTotal: number;
  conflictsDetected: number;
}

export interface DiscoveredFile {
  id: string;
  virtualPath: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  hash: string | null;
  accountId: string;
  driveFileId: string;
  isTrashed: boolean;
  poolId?: number;
}

let _insertFolderStmt: ReturnType<typeof sqlite.prepare> | null = null;
export function getInsertFolderStmt() {
  if (!_insertFolderStmt) {
    _insertFolderStmt = sqlite.prepare(`
      INSERT INTO folders (id, pool_id, virtual_path, name, parent_folder_id, updated_at)
      VALUES (?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(pool_id, virtual_path) DO UPDATE SET
        name = excluded.name,
        parent_folder_id = excluded.parent_folder_id,
        updated_at = unixepoch()
    `);
  }
  return _insertFolderStmt;
}

export const insertFolderStmt = {
  run(...args: any[]) {
    return (getInsertFolderStmt() as any).run(...args);
  },
};

let _upsertFileStmt: ReturnType<typeof sqlite.prepare> | null = null;
export function getUpsertFileStmt() {
  if (!_upsertFileStmt) {
    _upsertFileStmt = sqlite.prepare(`
      INSERT INTO files (
        id, pool_id, virtual_path, name, size_bytes, mime_type, hash,
        account_id, drive_file_id, folder_id, is_trashed, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(pool_id, virtual_path) DO UPDATE SET
        name = excluded.name,
        size_bytes = excluded.size_bytes,
        mime_type = excluded.mime_type,
        hash = excluded.hash,
        account_id = excluded.account_id,
        drive_file_id = excluded.drive_file_id,
        folder_id = excluded.folder_id,
        is_trashed = excluded.is_trashed,
        updated_at = unixepoch()
    `);
  }
  return _upsertFileStmt;
}

export const upsertFileStmt = {
  run(...args: any[]) {
    return (getUpsertFileStmt() as any).run(...args);
  },
};

let _deleteFileStmt: ReturnType<typeof sqlite.prepare> | null = null;
export function getDeleteFileStmt() {
  if (!_deleteFileStmt) {
    _deleteFileStmt = sqlite.prepare(`
      DELETE FROM files WHERE drive_file_id = ? AND account_id = ?
    `);
  }
  return _deleteFileStmt;
}

export const deleteFileStmt = {
  run(...args: any[]) {
    return (getDeleteFileStmt() as any).run(...args);
  },
};

let _trashFileStmt: ReturnType<typeof sqlite.prepare> | null = null;
export function getTrashFileStmt() {
  if (!_trashFileStmt) {
    _trashFileStmt = sqlite.prepare(`
      UPDATE files SET is_trashed = 1, trashed_at = unixepoch(), updated_at = unixepoch()
      WHERE drive_file_id = ? AND account_id = ?
    `);
  }
  return _trashFileStmt;
}

export const trashFileStmt = {
  run(...args: any[]) {
    return (getTrashFileStmt() as any).run(...args);
  },
};

let _selectFileByPathStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getSelectFileByPathStmt(): any {
  if (!_selectFileByPathStmt) {
    _selectFileByPathStmt = sqlite.prepare(
      'SELECT id, account_id, drive_file_id, is_trashed FROM files WHERE pool_id = ? AND virtual_path = ? LIMIT 1'
    );
  }
  return _selectFileByPathStmt;
}

let _selectFileByDriveIdStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getSelectFileByDriveIdStmt(): any {
  if (!_selectFileByDriveIdStmt) {
    _selectFileByDriveIdStmt = sqlite.prepare(
      'SELECT id, virtual_path, account_id, is_trashed FROM files WHERE pool_id = ? AND account_id = ? AND drive_file_id = ? LIMIT 1'
    );
  }
  return _selectFileByDriveIdStmt;
}

let _updateTrashedPathStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getUpdateTrashedPathStmt(): any {
  if (!_updateTrashedPathStmt) {
    _updateTrashedPathStmt = sqlite.prepare('UPDATE files SET virtual_path = ? WHERE id = ?');
  }
  return _updateTrashedPathStmt;
}

let _selectFileByIdStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getSelectFileByIdStmt(): any {
  if (!_selectFileByIdStmt) {
    _selectFileByIdStmt = sqlite.prepare('SELECT id, drive_file_id, account_id FROM files WHERE id = ? LIMIT 1');
  }
  return _selectFileByIdStmt;
}

let _updateMovedFileStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getUpdateMovedFileStmt(): any {
  if (!_updateMovedFileStmt) {
    _updateMovedFileStmt = sqlite.prepare('UPDATE files SET virtual_path = ?, folder_id = ? WHERE id = ?');
  }
  return _updateMovedFileStmt;
}

let _selectPendingDriveSyncStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getSelectPendingDriveSyncStmt(): any {
  if (!_selectPendingDriveSyncStmt) {
    _selectPendingDriveSyncStmt = sqlite.prepare(
      'SELECT drive_file_id FROM pending_drive_sync WHERE account_id = ?'
    );
  }
  return _selectPendingDriveSyncStmt;
}

let _deletePendingDriveSyncStmt: ReturnType<typeof sqlite.prepare> | null = null;
function getDeletePendingDriveSyncStmt(): any {
  if (!_deletePendingDriveSyncStmt) {
    _deletePendingDriveSyncStmt = sqlite.prepare(
      'DELETE FROM pending_drive_sync WHERE account_id = ? AND drive_file_id = ?'
    );
  }
  return _deletePendingDriveSyncStmt;
}

export function extractFolderPaths(virtualPath: string): string[] {
  const result: string[] = [];
  let currentDir = path.posix.dirname(virtualPath);
  while (currentDir && currentDir !== '/' && currentDir !== '.') {
    result.push(currentDir);
    currentDir = path.posix.dirname(currentDir);
  }
  return result;
}

export function insertFolderRecord(folderPath: string, poolId = 1): void {
  const folderName = path.posix.basename(folderPath);
  const parentPath = path.posix.dirname(folderPath);
  const parentId = parentPath === '/' || parentPath === '.' ? null : formatFolderId(poolId, parentPath);
  const id = formatFolderId(poolId, folderPath);
  insertFolderStmt.run(id, poolId, folderPath, folderName, parentId);
}

export function ensureLocalFolderHierarchy(virtualPathOrFolderPath: string, poolId = 1): void {
  const folders = extractFolderPaths(virtualPathOrFolderPath);
  if (virtualPathOrFolderPath.startsWith('/') && !virtualPathOrFolderPath.includes('.') && virtualPathOrFolderPath !== '/') {
    if (!folders.includes(virtualPathOrFolderPath)) {
      folders.unshift(virtualPathOrFolderPath);
    }
  }
  for (let i = folders.length - 1; i >= 0; i--) {
    insertFolderRecord(folders[i], poolId);
  }
}

export function upsertFileRecord(f: DiscoveredFile): 'indexed' | 'conflict' {
  const poolId = f.poolId ?? 1;
  const parentPath = path.posix.dirname(f.virtualPath);
  const folderId = parentPath === '/' || parentPath === '.' ? null : formatFolderId(poolId, parentPath);

  const existingAtPath = getSelectFileByPathStmt().get(poolId, f.virtualPath) as
    | { id: string; account_id: string; drive_file_id: string; is_trashed: number }
    | undefined;

  const existingByDriveId = getSelectFileByDriveIdStmt().get(poolId, f.accountId, f.driveFileId) as
    | { id: string; virtual_path: string; account_id: string; is_trashed: number }
    | undefined;

  if (existingAtPath && existingAtPath.drive_file_id !== f.driveFileId) {
    if (existingAtPath.is_trashed === 0) {
      return 'conflict';
    }
    if (f.isTrashed) {
      return 'conflict';
    }
    getUpdateTrashedPathStmt().run(
      `${f.virtualPath}.trashed-${Date.now()}-${existingAtPath.id.slice(0, 6)}`,
      existingAtPath.id
    );
  }

  const existingById = getSelectFileByIdStmt().get(f.id) as
    | { id: string; drive_file_id: string; account_id: string }
    | undefined;

  const effectiveId = existingByDriveId
    ? existingByDriveId.id
    : existingById && (existingById.drive_file_id !== f.driveFileId || existingById.account_id !== f.accountId)
      ? f.driveFileId
      : f.id;

  if (existingByDriveId && existingByDriveId.virtual_path !== f.virtualPath) {
    getUpdateMovedFileStmt().run(f.virtualPath, folderId, existingByDriveId.id);
  }

  upsertFileStmt.run(
    effectiveId,
    poolId,
    f.virtualPath,
    f.name,
    f.sizeBytes,
    f.mimeType,
    f.hash,
    f.accountId,
    f.driveFileId,
    folderId,
    f.isTrashed ? 1 : 0
  );

  return 'indexed';
}

const inFlightColdSyncs = new Map<string, Promise<ColdSyncReport>>();

export function runColdReconciliation(accountId: string): Promise<ColdSyncReport> {
  const existing = inFlightColdSyncs.get(accountId);
  if (existing) {
    return existing;
  }

  const promise = executeColdReconciliation(accountId).finally(() => {
    inFlightColdSyncs.delete(accountId);
  });
  inFlightColdSyncs.set(accountId, promise);
  return promise;
}

async function executeColdReconciliation(accountId: string): Promise<ColdSyncReport> {
  const drive = getDriveClient(accountId);

  await db.update(accounts).set({ syncState: 'syncing' }).where(eq(accounts.id, accountId));

  try {
    const accountRecord = await db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
    });

    if (!accountRecord?.rootFolderId) {
      throw new Error(`Account ${accountId} does not have a registered root folder`);
    }

    // Capture the change token before crawling so edits made during the crawl are replayed on the next delta sync.
    const tokenRes = await withDriveRetry(() =>
      drive.changes.getStartPageToken({
        supportsAllDrives: false,
      })
    );
    const startToken = tokenRes.data.startPageToken || null;

    const poolId = accountRecord.poolId ?? 1;
    const folderTree = await resolveRemoteFolderTree(drive, accountRecord.rootFolderId);
    const validFolderIds = folderTree.folderIds;
    const discoveredFiles: DiscoveredFile[] = [];
    const discoveredFolderPaths = new Set<string>();
    const orphanDriveIds: string[] = [];

    for (const folder of folderTree.folders) {
      discoveredFolderPaths.add(folder.virtualPath);
    }

    let pageToken: string | undefined = undefined;

    do {
      const res: any = await withDriveRetry(() =>
        drive.files.list({
          q: "appProperties has { key='tsubasa_managed' and value='true' } and mimeType != 'application/vnd.google-apps.folder'",
          fields: 'nextPageToken, files(id, name, size, mimeType, md5Checksum, sha256Checksum, trashed, parents, appProperties)',
          pageSize: 1000,
          pageToken,
          spaces: 'drive',
          supportsAllDrives: false,
        })
      );

      for (const item of res.data.files || []) {
        if (!item.id || !item.name) continue;

        const isInside = Boolean(item.parents?.some((p: string) => validFolderIds.has(p)));
        if (!isInside) {
          orphanDriveIds.push(item.id);
          continue;
        }

        const parentFolderPath = item.parents?.map((p: string) => folderTree.folderPathById.get(p)).find(Boolean) || '/';
        const computedPath = parentFolderPath === '/' ? `/${item.name}` : `${parentFolderPath}/${item.name}`;
        const virtualPath = item.appProperties?.tsubasa_virtual_path || computedPath;
        const fileId = item.appProperties?.tsubasa_virtual_id || item.id;
        const hash = item.appProperties?.tsubasa_checksum || item.md5Checksum || item.sha256Checksum || null;

        discoveredFiles.push({
          id: fileId,
          virtualPath,
          name: item.name,
          sizeBytes: Number(item.size || 0),
          mimeType: item.mimeType || 'application/octet-stream',
          hash,
          accountId,
          driveFileId: item.id,
          isTrashed: Boolean(item.trashed),
          poolId,
        });

        for (const folder of extractFolderPaths(virtualPath)) {
          discoveredFolderPaths.add(folder);
        }
      }

      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);

    await runBoundedConcurrency(orphanDriveIds, 5, async (orphanId) => {
      await withDriveRetry(() =>
        drive.files.update({
          fileId: orphanId,
          requestBody: {
            appProperties: {
              tsubasa_managed: null,
              tsubasa_virtual_path: null,
              tsubasa_virtual_id: null,
            } as any,
          },
          supportsAllDrives: false,
        })
      ).catch(() => {});
    });

    const localAccountFiles = await db.query.files.findMany({
      where: and(eq(files.accountId, accountId), eq(files.poolId, poolId)),
    });

    const pendingRows = getSelectPendingDriveSyncStmt().all(accountId) as Array<{ drive_file_id: string }>;
    const pendingDbDriveIds = new Set(pendingRows.map((r) => r.drive_file_id));

    const discoveredDriveIds = new Set(discoveredFiles.map((f) => f.driveFileId));
    let indexedCount = 0;
    let conflictsDetected = 0;
    let indexedActiveBytes = 0;

    const applySync = sqlite.transaction(() => {
      indexedCount = 0;
      conflictsDetected = 0;
      indexedActiveBytes = 0;

      for (const lf of localAccountFiles) {
        if (
          !discoveredDriveIds.has(lf.driveFileId) &&
          !pendingAppPropertyDriveIds.has(lf.driveFileId) &&
          !pendingDbDriveIds.has(lf.driveFileId)
        ) {
          deleteFileStmt.run(lf.driveFileId, accountId);
        }
      }

      for (const driveFileId of discoveredDriveIds) {
        if (pendingDbDriveIds.has(driveFileId)) {
          getDeletePendingDriveSyncStmt().run(accountId, driveFileId);
        }
      }

      for (const folder of folderTree.folders) {
        insertFolderRecord(folder.virtualPath, poolId);
      }

      for (const folderPath of discoveredFolderPaths) {
        insertFolderRecord(folderPath, poolId);
      }

      for (const f of discoveredFiles) {
        const status = upsertFileRecord(f);
        if (status === 'conflict') {
          if (!f.isTrashed) {
            conflictsDetected++;
          }
        } else {
          indexedCount++;
          if (!f.isTrashed) {
            indexedActiveBytes += f.sizeBytes;
          }
        }
      }
    });

    applySync();

    await db
      .update(accounts)
      .set({
        syncState: 'idle',
        lastSyncToken: startToken,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));

    await refreshAccountLiveQuota(accountId).catch((err) => {
      console.warn(`[cold-sync] Failed to refresh live quota for ${accountId}:`, err);
    });

    return {
      accountId,
      filesIndexed: indexedCount,
      foldersIndexed: discoveredFolderPaths.size,
      bytesTotal: indexedActiveBytes,
      conflictsDetected,
    };
  } catch (err) {
    await db.update(accounts).set({ syncState: 'error' }).where(eq(accounts.id, accountId));
    throw err;
  }
}
