import path from 'node:path';
import { db, sqlite, bumpPoolRevision } from '../db/index.js';
import { files, type FileRecord } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { markAccountQuotaDecreased } from './client.js';
import { ensureLocalParentFolders, formatFolderId } from './sync.js';
import { allocateUniqueVirtualPath, displaceTrashedFileAtPath } from './operationsDb.js';
import { enqueueDriveOutbox } from './outbox.js';
import { ItemNotFoundError } from './errors.js';
import { invalidatePooledStorageOverview } from '../storage/index.js';

export async function trashFile(fileId: string): Promise<FileRecord> {
  let poolId = 0;
  let wasAlreadyTrashed = false;

  sqlite.transaction(() => {
    const row = sqlite
      .prepare('SELECT id, pool_id, account_id, drive_file_id, is_trashed FROM files WHERE id = ?')
      .get(fileId) as
      | {
          id: string;
          pool_id: number;
          account_id: string;
          drive_file_id: string;
          is_trashed: number;
        }
      | undefined;

    if (!row) {
      throw new ItemNotFoundError(`File ${fileId} not found`);
    }

    poolId = row.pool_id;
    wasAlreadyTrashed = row.is_trashed === 1;
    if (wasAlreadyTrashed) {
      return;
    }

    sqlite
      .prepare(
        'UPDATE files SET is_trashed = 1, trashed_at = unixepoch(), updated_at = unixepoch() WHERE id = ?'
      )
      .run(fileId);

    enqueueDriveOutbox([
      {
        accountId: row.account_id,
        poolId: row.pool_id,
        opType: 'file_trash',
        driveFileId: row.drive_file_id,
        payload: {
          fileId: row.id,
          driveFileId: row.drive_file_id,
        },
      },
    ]);
  }).immediate();

  if (!wasAlreadyTrashed) {
    bumpPoolRevision(poolId);
  }

  const updated = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });
  if (!updated) {
    throw new ItemNotFoundError(`File ${fileId} not found`);
  }
  return updated;
}

function allocateRestoredPath(poolId: number, basePath: string, selfId: string): string {
  const checkActiveStmt = sqlite.prepare(
    'SELECT 1 FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0 AND id != ? LIMIT 1'
  );

  return allocateUniqueVirtualPath({
    targetDir: path.posix.dirname(basePath),
    baseName: path.posix.basename(basePath),
    kind: 'file',
    style: 'restored',
    startCounter: 1,
    isTaken: (candidatePath) => Boolean(checkActiveStmt.get(poolId, candidatePath, selfId)),
  });
}

export async function restoreFile(fileId: string): Promise<FileRecord> {
  let poolId = 0;

  sqlite.transaction(() => {
    const row = sqlite
      .prepare('SELECT id, pool_id, virtual_path, name, account_id, drive_file_id FROM files WHERE id = ?')
      .get(fileId) as
      | {
          id: string;
          pool_id: number;
          virtual_path: string;
          name: string;
          account_id: string;
          drive_file_id: string;
        }
      | undefined;

    if (!row) {
      throw new ItemNotFoundError(`File ${fileId} not found`);
    }

    poolId = row.pool_id;
    const strippedPath = row.virtual_path.replace(/\.trashed-\d+(?:-[a-zA-Z0-9]+)?$/, '');
    const restoredPath = allocateRestoredPath(row.pool_id, strippedPath, row.id);
    const restoredName = path.posix.basename(restoredPath);
    const parentDir = path.posix.dirname(restoredPath);
    const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(row.pool_id, parentDir);
    const pathOrNameChanged = restoredPath !== row.virtual_path || restoredName !== row.name;

    ensureLocalParentFolders(restoredPath, row.pool_id);

    displaceTrashedFileAtPath(row.pool_id, restoredPath, {
      excludeFileId: row.id,
      appendShortId: true,
    });

    sqlite
      .prepare(
        'UPDATE files SET virtual_path = ?, name = ?, folder_id = ?, is_trashed = 0, trashed_at = NULL, updated_at = unixepoch() WHERE id = ?'
      )
      .run(restoredPath, restoredName, folderId, row.id);

    enqueueDriveOutbox([
      {
        accountId: row.account_id,
        poolId: row.pool_id,
        opType: 'file_restore',
        driveFileId: row.drive_file_id,
        payload: {
          fileId: row.id,
          driveFileId: row.drive_file_id,
          restoredPath,
          ...(pathOrNameChanged ? { newVirtualPath: restoredPath, newName: restoredName } : {}),
        },
      },
    ]);
  }).immediate();

  bumpPoolRevision(poolId);

  const updated = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });
  if (!updated) {
    throw new ItemNotFoundError(`File ${fileId} not found`);
  }
  return updated;
}

export function cleanupOrphanedShareLinksForPool(poolId: number): void {
  sqlite
    .prepare(
      `DELETE FROM share_links
       WHERE pool_id = ?
         AND (
           (
             share_links.files_count > 0
             AND NOT EXISTS (
               SELECT 1 FROM files fi
               WHERE fi.pool_id = share_links.pool_id
                 AND fi.account_id = share_links.account_id
                 AND (
                   fi.virtual_path = '/' || share_links.batch_folder_name
                   OR (
                     fi.virtual_path >= '/' || share_links.batch_folder_name || '/'
                     AND fi.virtual_path < '/' || share_links.batch_folder_name || '0'
                   )
                 )
             )
           )
           OR (
             NOT EXISTS (
               SELECT 1 FROM folders f
               WHERE f.pool_id = share_links.pool_id
                 AND f.virtual_path = '/' || share_links.batch_folder_name
             )
             AND NOT EXISTS (
               SELECT 1 FROM files fi
               WHERE fi.pool_id = share_links.pool_id
                 AND (
                   fi.virtual_path = '/' || share_links.batch_folder_name
                   OR (
                     fi.virtual_path >= '/' || share_links.batch_folder_name || '/'
                     AND fi.virtual_path < '/' || share_links.batch_folder_name || '0'
                   )
                 )
             )
           )
         )`
    )
    .run(poolId);
}

export async function purgeFile(fileId: string): Promise<FileRecord> {
  let purgedFile: FileRecord | undefined;

  sqlite.transaction(() => {
    purgedFile = db.select().from(files).where(eq(files.id, fileId)).get();
    if (!purgedFile) {
      throw new ItemNotFoundError(`File ${fileId} not found`);
    }

    sqlite.prepare('DELETE FROM files WHERE id = ?').run(fileId);
    cleanupOrphanedShareLinksForPool(purgedFile.poolId);

    sqlite
      .prepare(
        'UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes - ?), updated_at = unixepoch() WHERE id = ?'
      )
      .run(purgedFile.sizeBytes, purgedFile.accountId);

    enqueueDriveOutbox([
      {
        accountId: purgedFile.accountId,
        poolId: purgedFile.poolId,
        opType: 'file_delete',
        driveFileId: purgedFile.driveFileId,
        payload: {
          fileId: purgedFile.id,
          driveFileId: purgedFile.driveFileId,
        },
      },
    ]);
  }).immediate();

  if (!purgedFile) {
    throw new ItemNotFoundError(`File ${fileId} not found`);
  }

  markAccountQuotaDecreased(purgedFile.accountId);
  invalidatePooledStorageOverview(purgedFile.poolId);
  bumpPoolRevision(purgedFile.poolId);

  return purgedFile;
}

export async function emptyTrash(poolId?: number): Promise<{ filesPurged: number; bytesReclaimed: number }> {
  let filesPurged = 0;
  let bytesReclaimed = 0;
  const bytesByAccount = new Map<string, number>();

  sqlite.transaction(() => {
    const trashedFiles = db
      .select()
      .from(files)
      .where(
        poolId !== undefined
          ? and(eq(files.isTrashed, true), eq(files.poolId, poolId))
          : eq(files.isTrashed, true)
      )
      .all();

    if (trashedFiles.length === 0) {
      return;
    }

    filesPurged = trashedFiles.length;
    for (const f of trashedFiles) {
      bytesReclaimed += f.sizeBytes;
      bytesByAccount.set(f.accountId, (bytesByAccount.get(f.accountId) ?? 0) + f.sizeBytes);
    }

    const deleteFileStmt = sqlite.prepare('DELETE FROM files WHERE id = ?');
    const touchedPoolIds = new Set<number>();
    for (const f of trashedFiles) {
      deleteFileStmt.run(f.id);
      touchedPoolIds.add(f.poolId);
    }
    for (const pid of touchedPoolIds) {
      cleanupOrphanedShareLinksForPool(pid);
    }

    const decrementQuotaStmt = sqlite.prepare(
      'UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes - ?), updated_at = unixepoch() WHERE id = ?'
    );
    for (const [accountId, bytes] of bytesByAccount) {
      decrementQuotaStmt.run(bytes, accountId);
    }

    enqueueDriveOutbox(
      trashedFiles.map((f) => ({
        accountId: f.accountId,
        poolId: f.poolId,
        opType: 'file_delete' as const,
        driveFileId: f.driveFileId,
        payload: {
          fileId: f.id,
          driveFileId: f.driveFileId,
        },
      }))
    );
  }).immediate();

  if (filesPurged === 0) {
    return { filesPurged: 0, bytesReclaimed: 0 };
  }

  for (const accountId of bytesByAccount.keys()) {
    markAccountQuotaDecreased(accountId);
  }
  invalidatePooledStorageOverview(poolId);
  bumpPoolRevision(poolId);

  return { filesPurged, bytesReclaimed };
}
