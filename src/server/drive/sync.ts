import { getDriveClient } from './client.js';
import { db, sqlite } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import path from 'node:path';

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
}

export const insertFolderStmt = sqlite.prepare(`
  INSERT INTO folders (id, virtual_path, name, parent_folder_id, updated_at)
  VALUES (?, ?, ?, ?, unixepoch())
  ON CONFLICT(virtual_path) DO UPDATE SET
    name = excluded.name,
    updated_at = unixepoch()
`);

export const upsertFileStmt = sqlite.prepare(`
  INSERT INTO files (
    id, virtual_path, name, size_bytes, mime_type, hash,
    account_id, drive_file_id, is_trashed, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  ON CONFLICT(virtual_path) DO UPDATE SET
    name = excluded.name,
    size_bytes = excluded.size_bytes,
    mime_type = excluded.mime_type,
    hash = excluded.hash,
    account_id = excluded.account_id,
    drive_file_id = excluded.drive_file_id,
    is_trashed = excluded.is_trashed,
    updated_at = unixepoch()
`);

export const deleteFileStmt = sqlite.prepare(`
  DELETE FROM files WHERE drive_file_id = ? AND account_id = ?
`);

export const trashFileStmt = sqlite.prepare(`
  UPDATE files SET is_trashed = 1, trashed_at = unixepoch(), updated_at = unixepoch()
  WHERE drive_file_id = ? AND account_id = ?
`);

export function extractFolderPaths(virtualPath: string): string[] {
  const result: string[] = [];
  let currentDir = path.posix.dirname(virtualPath);
  while (currentDir && currentDir !== '/' && currentDir !== '.') {
    result.push(currentDir);
    currentDir = path.posix.dirname(currentDir);
  }
  return result;
}

export function insertFolderRecord(folderPath: string): void {
  const folderName = path.posix.basename(folderPath);
  const parentPath = path.posix.dirname(folderPath);
  const parentId = parentPath === '/' || parentPath === '.' ? null : parentPath;
  insertFolderStmt.run(folderPath, folderPath, folderName, parentId);
}

export function upsertFileRecord(f: DiscoveredFile): void {
  upsertFileStmt.run(
    f.id,
    f.virtualPath,
    f.name,
    f.sizeBytes,
    f.mimeType,
    f.hash,
    f.accountId,
    f.driveFileId,
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

    const discoveredFiles: DiscoveredFile[] = [];
    const discoveredFolderPaths = new Set<string>();

    let pageToken: string | undefined = undefined;

    do {
      const res: any = await drive.files.list({
        q: "appProperties has { key='tsubasa_managed' and value='true' }",
        fields: 'nextPageToken, files(id, name, size, mimeType, md5Checksum, sha256Checksum, trashed, appProperties)',
        pageSize: 1000,
        pageToken,
        spaces: 'drive',
        supportsAllDrives: false,
      });

      for (const item of res.data.files || []) {
        if (!item.id || !item.name) continue;

        const virtualPath = item.appProperties?.tsubasa_virtual_path || `/${item.name}`;
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
        });

        for (const folder of extractFolderPaths(virtualPath)) {
          discoveredFolderPaths.add(folder);
        }
      }

      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);

    const applySync = sqlite.transaction(() => {
      for (const folderPath of discoveredFolderPaths) {
        insertFolderRecord(folderPath);
      }

      for (const f of discoveredFiles) {
        upsertFileRecord(f);
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
