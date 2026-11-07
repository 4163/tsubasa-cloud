import path from 'node:path';
import { db } from '../db/index.js';
import { accounts, files, type FileRecord } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getDriveClient } from './client.js';
import { normalizeVirtualPath } from './mirror.js';
import { MAX_SINGLE_FILE_BYTES } from '../storage/index.js';

export interface ExternalFileDiscrepancy {
  driveFileId: string;
  name: string;
  virtualPath: string;
  sizeBytes: number;
  mimeType: string;
  accountId: string;
  discrepancyType: 'unindexed' | 'modified' | 'over_ceiling';
}

export interface MissingFileDiscrepancy {
  fileId: string;
  driveFileId: string;
  virtualPath: string;
  accountId: string;
}

export interface DiscrepancyReport {
  accountId: string;
  scannedFiles: number;
  unindexed: ExternalFileDiscrepancy[];
  modified: ExternalFileDiscrepancy[];
  overCeiling: ExternalFileDiscrepancy[];
  missingRemote: MissingFileDiscrepancy[];
}

export async function scanAccountDiscrepancies(accountId: string): Promise<DiscrepancyReport> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (!account || !account.rootFolderId) {
    throw new Error(`Account ${accountId} not registered or missing root folder`);
  }

  const drive = getDriveClient(accountId);
  const knownFiles = await db.query.files.findMany({
    where: and(eq(files.accountId, accountId), eq(files.isTrashed, false)),
  });

  const knownMapByDriveId = new Map<string, FileRecord>();
  for (const kf of knownFiles) {
    knownMapByDriveId.set(kf.driveFileId, kf);
  }

  const foundRemoteIds = new Set<string>();
  const unindexed: ExternalFileDiscrepancy[] = [];
  const modified: ExternalFileDiscrepancy[] = [];
  const overCeiling: ExternalFileDiscrepancy[] = [];

  let pageToken: string | undefined = undefined;

  do {
    const listRes: any = await drive.files.list({
      q: `'${account.rootFolderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(id, name, size, mimeType, md5Checksum, appProperties)',
      pageSize: 1000,
      pageToken,
      spaces: 'drive',
      supportsAllDrives: false,
    });

    for (const remote of listRes.data.files || []) {
      if (!remote.id || !remote.name) continue;
      foundRemoteIds.add(remote.id);

      const sizeBytes = Number(remote.size || 0);
      const virtualPath = normalizeVirtualPath(
        remote.appProperties?.tsubasa_virtual_path || `/${remote.name}`
      );
      const isOverCeiling = sizeBytes > MAX_SINGLE_FILE_BYTES;

      if (isOverCeiling) {
        overCeiling.push({
          driveFileId: remote.id,
          name: remote.name,
          virtualPath,
          sizeBytes,
          mimeType: remote.mimeType || 'application/octet-stream',
          accountId,
          discrepancyType: 'over_ceiling',
        });
        continue;
      }

      const existing = knownMapByDriveId.get(remote.id);
      if (!existing) {
        unindexed.push({
          driveFileId: remote.id,
          name: remote.name,
          virtualPath,
          sizeBytes,
          mimeType: remote.mimeType || 'application/octet-stream',
          accountId,
          discrepancyType: 'unindexed',
        });
      } else if (existing.sizeBytes !== sizeBytes || existing.virtualPath !== virtualPath) {
        modified.push({
          driveFileId: remote.id,
          name: remote.name,
          virtualPath,
          sizeBytes,
          mimeType: remote.mimeType || 'application/octet-stream',
          accountId,
          discrepancyType: 'modified',
        });
      }
    }

    pageToken = listRes.data.nextPageToken || undefined;
  } while (pageToken);

  const missingRemote: MissingFileDiscrepancy[] = [];
  for (const kf of knownFiles) {
    if (!foundRemoteIds.has(kf.driveFileId)) {
      missingRemote.push({
        fileId: kf.id,
        driveFileId: kf.driveFileId,
        virtualPath: kf.virtualPath,
        accountId,
      });
    }
  }

  return {
    accountId,
    scannedFiles: foundRemoteIds.size,
    unindexed,
    modified,
    overCeiling,
    missingRemote,
  };
}

export async function acceptExternalFile(
  accountId: string,
  driveFileId: string,
  targetVirtualPath?: string
): Promise<FileRecord> {
  const drive = getDriveClient(accountId);
  const fileRes = await drive.files.get({
    fileId: driveFileId,
    fields: 'id, name, size, mimeType, md5Checksum, appProperties',
    supportsAllDrives: false,
  });

  const remote = fileRes.data;
  if (!remote.id || !remote.name) {
    throw new Error(`File ${driveFileId} not found in Google Drive`);
  }

  const sizeBytes = Number(remote.size || 0);
  const virtualPath = normalizeVirtualPath(
    targetVirtualPath || remote.appProperties?.tsubasa_virtual_path || `/${remote.name}`
  );
  const fileName = path.posix.basename(virtualPath);
  const fileId = remote.appProperties?.tsubasa_virtual_id || remote.id;

  await drive.files.update({
    fileId: remote.id,
    requestBody: {
      appProperties: {
        tsubasa_managed: 'true',
        tsubasa_virtual_path: virtualPath,
        tsubasa_virtual_id: fileId,
      },
    },
    supportsAllDrives: false,
  });

  const inserted = await db
    .insert(files)
    .values({
      id: fileId,
      virtualPath,
      name: fileName,
      sizeBytes,
      mimeType: remote.mimeType || 'application/octet-stream',
      hash: remote.md5Checksum || null,
      accountId,
      driveFileId: remote.id,
      isTrashed: false,
    })
    .onConflictDoUpdate({
      target: files.virtualPath,
      set: {
        name: fileName,
        sizeBytes,
        mimeType: remote.mimeType || 'application/octet-stream',
        hash: remote.md5Checksum || null,
        accountId,
        driveFileId: remote.id,
        isTrashed: false,
        updatedAt: new Date(),
      },
    })
    .returning();

  return inserted[0];
}

export async function ejectFileToDriveRoot(accountId: string, driveFileId: string): Promise<void> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (!account || !account.rootFolderId) {
    throw new Error(`Account ${accountId} does not have a registered root folder`);
  }

  const drive = getDriveClient(accountId);

  await drive.files.update({
    fileId: driveFileId,
    addParents: 'root',
    removeParents: account.rootFolderId,
    supportsAllDrives: false,
  });

  await db.delete(files).where(and(eq(files.driveFileId, driveFileId), eq(files.accountId, accountId)));
}

