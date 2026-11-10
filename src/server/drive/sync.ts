import { getDriveClient, resolveRemoteFolderTree } from './client.js';
import { db, sqlite } from '../db/index.js';
import { accounts, files } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import path from 'node:path';

export function formatFolderId(poolId: number, virtualPath: string): string {
  return `${poolId}:${virtualPath}`;
}

export interface ColdSyncReport {
  accountId: string;
  filesIndexed: number;
  foldersIndexed: number;
  bytesTotal: number;
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

export function upsertFileRecord(f: DiscoveredFile): void {
  const poolId = f.poolId ?? 1;
  const parentPath = path.posix.dirname(f.virtualPath);
  const folderId = parentPath === '/' || parentPath === '.' ? null : formatFolderId(poolId, parentPath);

  const existingById = sqlite
    .prepare('SELECT id, virtual_path FROM files WHERE pool_id = ? AND (id = ? OR drive_file_id = ?)')
    .get(poolId, f.id, f.driveFileId) as { id: string; virtual_path: string } | undefined;

  if (existingById && existingById.virtual_path !== f.virtualPath) {
    sqlite
      .prepare('UPDATE files SET virtual_path = ?, folder_id = ? WHERE id = ?')
      .run(f.virtualPath, folderId, existingById.id);
  }

  upsertFileStmt.run(
    f.id,
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
}

export async function runColdReconciliation(accountId: string): Promise<ColdSyncReport> {
  const drive = getDriveClient(accountId);

  await db.update(accounts).set({ syncState: 'syncing' }).where(eq(accounts.id, accountId));

  try {
    const accountRecord = await db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
    });

    if (!accountRecord?.rootFolderId) {
      throw new Error(`Account ${accountId} does not have a registered root folder`);
    }

    const poolId = accountRecord.poolId ?? 1;
    const folderTree = await resolveRemoteFolderTree(drive, accountRecord.rootFolderId);
    const validFolderIds = folderTree.folderIds;
    const discoveredFiles: DiscoveredFile[] = [];
    const discoveredFolderPaths = new Set<string>();

    for (const folder of folderTree.folders) {
      discoveredFolderPaths.add(folder.virtualPath);
    }

    let pageToken: string | undefined = undefined;

    do {
      const res: any = await drive.files.list({
        q: "appProperties has { key='tsubasa_managed' and value='true' } and mimeType != 'application/vnd.google-apps.folder'",
        fields: 'nextPageToken, files(id, name, size, mimeType, md5Checksum, sha256Checksum, trashed, parents, appProperties)',
        pageSize: 1000,
        pageToken,
        spaces: 'drive',
        supportsAllDrives: false,
      });

      for (const item of res.data.files || []) {
        if (!item.id || !item.name) continue;

        const isInside = Boolean(item.parents?.some((p: string) => validFolderIds.has(p)));
        if (!isInside) {
          drive.files
            .update({
              fileId: item.id,
              requestBody: {
                appProperties: {
                  tsubasa_managed: null,
                  tsubasa_virtual_path: null,
                  tsubasa_virtual_id: null,
                } as any,
              },
              supportsAllDrives: false,
            })
            .catch(() => {});
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

    const localAccountFiles = await db.query.files.findMany({
      where: and(
        eq(files.accountId, accountId),
        eq(files.poolId, poolId),
        eq(files.isTrashed, false)
      ),
    });

    const discoveredDriveIds = new Set(discoveredFiles.map((f) => f.driveFileId));

    const applySync = sqlite.transaction(() => {
      for (const folder of folderTree.folders) {
        insertFolderRecord(folder.virtualPath, poolId);
      }

      for (const folderPath of discoveredFolderPaths) {
        insertFolderRecord(folderPath, poolId);
      }

      for (const f of discoveredFiles) {
        upsertFileRecord(f);
      }

      for (const lf of localAccountFiles) {
        if (!discoveredDriveIds.has(lf.driveFileId)) {
          deleteFileStmt.run(lf.driveFileId, accountId);
        }
      }
    });

    applySync();

    const tokenRes = await drive.changes.getStartPageToken({
      supportsAllDrives: false,
    });

    const startToken = tokenRes.data.startPageToken || null;
    const totalBytes = discoveredFiles.reduce((acc, f) => acc + (f.isTrashed ? 0 : f.sizeBytes), 0);

    await db
      .update(accounts)
      .set({
        syncState: 'idle',
        lastSyncToken: startToken,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));

    return {
      accountId,
      filesIndexed: discoveredFiles.length,
      foldersIndexed: discoveredFolderPaths.size,
      bytesTotal: totalBytes,
    };
  } catch (err) {
    await db.update(accounts).set({ syncState: 'error' }).where(eq(accounts.id, accountId));
    throw err;
  }
}
