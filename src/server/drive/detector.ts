import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite } from '../db/index.js';
import { accounts, files, type Account, type FileRecord } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getDriveClient, resolveRemoteFolderTree, refreshAccountLiveQuota } from './client.js';
import { normalizeVirtualPath } from './mirror.js';
import { MAX_SINGLE_FILE_BYTES } from '../storage/index.js';
import { ensureLocalFolderHierarchy, insertFolderRecord, formatFolderId } from './sync.js';
import { getAvailableCopyPath } from './operations.js';

export type ConflictResolutionAction = 'keep_both' | 'deduplicate' | 'replace_existing' | 'eject';

export interface ExternalFileDiscrepancy {
  driveFileId: string;
  name: string;
  virtualPath: string;
  sizeBytes: number;
  mimeType: string;
  accountId: string;
  discrepancyType: 'unindexed' | 'modified' | 'over_ceiling';
}

export interface PathConflictDiscrepancy {
  driveFileId: string;
  name: string;
  virtualPath: string;
  sizeBytes: number;
  mimeType: string;
  hash: string | null;
  modifiedTime: string | null;
  accountId: string;
  accountEmail: string;
  accountDisplayName: string;
  discrepancyType: 'conflict';
  isExactDuplicate: boolean;
  existingFile: {
    fileId: string;
    driveFileId: string;
    accountId: string;
    accountEmail: string;
    accountDisplayName: string;
    sizeBytes: number;
    hash: string | null;
    updatedAt: string | null;
  };
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
  conflicts: PathConflictDiscrepancy[];
  unindexed: ExternalFileDiscrepancy[];
  modified: ExternalFileDiscrepancy[];
  overCeiling: ExternalFileDiscrepancy[];
  missingRemote: MissingFileDiscrepancy[];
}

function normalizeHash(raw?: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/^(sha256-|md5-)/, '');
  return cleaned || null;
}

function isExactDuplicateMatch(
  remoteSize: number,
  remoteHashes: Array<string | null | undefined>,
  localSize: number,
  localHash: string | null
): boolean {
  if (remoteSize !== localSize) return false;

  const normLocal = normalizeHash(localHash);
  const remoteSet = new Set<string>();
  for (const h of remoteHashes) {
    const nh = normalizeHash(h);
    if (nh) remoteSet.add(nh);
  }

  if (remoteSize === 0 && !normLocal && remoteSet.size === 0) {
    return true;
  }

  if (normLocal && remoteSet.has(normLocal)) {
    return true;
  }

  return false;
}

export async function scanAccountDiscrepancies(accountId: string): Promise<DiscrepancyReport> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (!account || !account.rootFolderId) {
    throw new Error(`Account ${accountId} not registered or missing root folder`);
  }

  const drive = getDriveClient(accountId);
  const poolId = account.poolId ?? 1;
  const folderTree = await resolveRemoteFolderTree(drive, account.rootFolderId);
  const validFolderIds = folderTree.folderIds;

  // Sync discovered remote folders into SQLite folders table so folders created directly in Drive are reflected
  for (const folder of folderTree.folders) {
    insertFolderRecord(folder.virtualPath, poolId);
  }

  const poolAccounts = await db.query.accounts.findMany({
    where: eq(accounts.poolId, poolId),
  });
  const accountMap = new Map<string, Account>(poolAccounts.map((a) => [a.id, a]));

  const allPoolActiveFiles = await db.query.files.findMany({
    where: and(eq(files.poolId, poolId), eq(files.isTrashed, false)),
  });

  const knownFiles = allPoolActiveFiles.filter((f) => f.accountId === accountId);
  const knownMapByDriveId = new Map<string, FileRecord>();
  for (const kf of knownFiles) {
    knownMapByDriveId.set(kf.driveFileId, kf);
  }

  const activeFileByPath = new Map<string, FileRecord>();
  for (const pf of allPoolActiveFiles) {
    const existing = activeFileByPath.get(pf.virtualPath);
    if (!existing || (existing.accountId === accountId && pf.accountId !== accountId)) {
      activeFileByPath.set(pf.virtualPath, pf);
    }
  }

  const foundRemoteIds = new Set<string>();
  const conflicts: PathConflictDiscrepancy[] = [];
  const unindexed: ExternalFileDiscrepancy[] = [];
  const modified: ExternalFileDiscrepancy[] = [];
  const overCeiling: ExternalFileDiscrepancy[] = [];

  const folderIdList = Array.from(validFolderIds);
  const CHUNK_SIZE = 20;

  for (let i = 0; i < folderIdList.length; i += CHUNK_SIZE) {
    const chunk = folderIdList.slice(i, i + CHUNK_SIZE);
    const parentQuery = chunk.map((id) => `'${id}' in parents`).join(' or ');
    let pageToken: string | undefined = undefined;

    do {
      const listRes: any = await drive.files.list({
        q: `(${parentQuery}) and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'nextPageToken, files(id, name, size, mimeType, md5Checksum, sha256Checksum, modifiedTime, parents, appProperties)',
        pageSize: 1000,
        pageToken,
        spaces: 'drive',
        supportsAllDrives: false,
      });

      for (const remote of listRes.data.files || []) {
        if (!remote.id || !remote.name) continue;
        foundRemoteIds.add(remote.id);

        const sizeBytes = Number(remote.size || 0);
        const parentFolderPath = remote.parents?.map((p: string) => folderTree.folderPathById.get(p)).find(Boolean) || '/';
        const computedPath = parentFolderPath === '/' ? `/${remote.name}` : `${parentFolderPath}/${remote.name}`;
        const virtualPath = normalizeVirtualPath(
          remote.appProperties?.tsubasa_virtual_path || computedPath
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

        const occupantAtPath = activeFileByPath.get(virtualPath);
        if (occupantAtPath && occupantAtPath.driveFileId !== remote.id) {
          const ownerAcc = accountMap.get(occupantAtPath.accountId);
          const remoteHash =
            remote.appProperties?.tsubasa_checksum || remote.md5Checksum || remote.sha256Checksum || null;
          const isExactDuplicate = isExactDuplicateMatch(
            sizeBytes,
            [remote.appProperties?.tsubasa_checksum, remote.md5Checksum, remote.sha256Checksum],
            occupantAtPath.sizeBytes,
            occupantAtPath.hash
          );

          conflicts.push({
            driveFileId: remote.id,
            name: remote.name,
            virtualPath,
            sizeBytes,
            mimeType: remote.mimeType || 'application/octet-stream',
            hash: remoteHash,
            modifiedTime: remote.modifiedTime || null,
            accountId,
            accountEmail: account.email,
            accountDisplayName: account.displayName,
            discrepancyType: 'conflict',
            isExactDuplicate,
            existingFile: {
              fileId: occupantAtPath.id,
              driveFileId: occupantAtPath.driveFileId,
              accountId: occupantAtPath.accountId,
              accountEmail: ownerAcc?.email || occupantAtPath.accountId,
              accountDisplayName: ownerAcc?.displayName || occupantAtPath.accountId,
              sizeBytes: occupantAtPath.sizeBytes,
              hash: occupantAtPath.hash,
              updatedAt: occupantAtPath.updatedAt ? new Date(occupantAtPath.updatedAt).toISOString() : null,
            },
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
  }

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
    conflicts,
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
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  const poolId = account?.poolId ?? 1;

  const drive = getDriveClient(accountId);
  const fileRes = await drive.files.get({
    fileId: driveFileId,
    fields: 'id, name, size, mimeType, md5Checksum, parents, appProperties',
    supportsAllDrives: false,
  });

  const remote = fileRes.data;
  if (!remote.id || !remote.name) {
    throw new Error(`File ${driveFileId} not found in Google Drive`);
  }

  let finalVirtualPath = targetVirtualPath || remote.appProperties?.tsubasa_virtual_path;
  if (!finalVirtualPath) {
    if (account?.rootFolderId) {
      const folderTree = await resolveRemoteFolderTree(drive, account.rootFolderId);
      const parentFolderPath = remote.parents?.map((p: string) => folderTree.folderPathById.get(p)).find(Boolean) || '/';
      finalVirtualPath = parentFolderPath === '/' ? `/${remote.name}` : `${parentFolderPath}/${remote.name}`;
    } else {
      finalVirtualPath = `/${remote.name}`;
    }
  }

  const sizeBytes = Number(remote.size || 0);
  const virtualPath = normalizeVirtualPath(finalVirtualPath);
  const fileName = path.posix.basename(virtualPath);

  sqlite
    .prepare('UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1')
    .run(`${virtualPath}.trashed-${Date.now()}`, poolId, virtualPath);

  const candidateId = remote.appProperties?.tsubasa_virtual_id || remote.id;
  const idCollision = sqlite
    .prepare('SELECT id, drive_file_id, account_id FROM files WHERE id = ? LIMIT 1')
    .get(candidateId) as { id: string; drive_file_id: string; account_id: string } | undefined;
  const fileId =
    idCollision && (idCollision.drive_file_id !== remote.id || idCollision.account_id !== accountId)
      ? randomUUID()
      : candidateId;

  ensureLocalFolderHierarchy(virtualPath, poolId);
  const parentDir = path.posix.dirname(virtualPath);
  const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

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
      poolId,
      virtualPath,
      name: fileName,
      sizeBytes,
      mimeType: remote.mimeType || 'application/octet-stream',
      hash: remote.md5Checksum || null,
      accountId,
      driveFileId: remote.id,
      folderId,
      isTrashed: false,
    })
    .onConflictDoUpdate({
      target: [files.poolId, files.virtualPath],
      set: {
        name: fileName,
        sizeBytes,
        mimeType: remote.mimeType || 'application/octet-stream',
        hash: remote.md5Checksum || null,
        accountId,
        driveFileId: remote.id,
        folderId,
        isTrashed: false,
        updatedAt: new Date(),
      },
    })
    .returning();

  return inserted[0];
}

export async function resolvePathConflict(
  accountId: string,
  driveFileId: string,
  resolution: ConflictResolutionAction,
  targetVirtualPath?: string
): Promise<{
  resolution: ConflictResolutionAction;
  accountId: string;
  driveFileId: string;
  virtualPath?: string;
  file?: FileRecord;
}> {
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  if (!account) {
    throw new Error(`Account ${accountId} not registered`);
  }
  const poolId = account.poolId ?? 1;

  if (resolution === 'eject') {
    await ejectFileToDriveRoot(accountId, driveFileId);
    return { resolution: 'eject', accountId, driveFileId };
  }

  if (resolution === 'deduplicate') {
    const drive = getDriveClient(accountId);
    await drive.files.update({
      fileId: driveFileId,
      requestBody: {
        trashed: true,
        appProperties: {
          tsubasa_managed: null,
          tsubasa_virtual_path: null,
          tsubasa_virtual_id: null,
        } as any,
      },
      supportsAllDrives: false,
    });
    await db.delete(files).where(and(eq(files.driveFileId, driveFileId), eq(files.accountId, accountId)));
    await refreshAccountLiveQuota(accountId).catch(() => {});
    return { resolution: 'deduplicate', accountId, driveFileId };
  }

  const drive = getDriveClient(accountId);
  const fileRes = await drive.files.get({
    fileId: driveFileId,
    fields: 'id, name, size, mimeType, md5Checksum, sha256Checksum, parents, appProperties',
    supportsAllDrives: false,
  });

  const remote = fileRes.data;
  if (!remote.id || !remote.name) {
    throw new Error(`File ${driveFileId} not found in Google Drive`);
  }

  let rawPath = targetVirtualPath || remote.appProperties?.tsubasa_virtual_path;
  if (!rawPath) {
    if (account.rootFolderId) {
      const folderTree = await resolveRemoteFolderTree(drive, account.rootFolderId);
      const parentFolderPath =
        remote.parents?.map((p: string) => folderTree.folderPathById.get(p)).find(Boolean) || '/';
      rawPath = parentFolderPath === '/' ? `/${remote.name}` : `${parentFolderPath}/${remote.name}`;
    } else {
      rawPath = `/${remote.name}`;
    }
  }

  const baseVirtualPath = normalizeVirtualPath(rawPath);
  const sizeBytes = Number(remote.size || 0);
  const checksum = remote.appProperties?.tsubasa_checksum || remote.md5Checksum || remote.sha256Checksum || null;

  const resolveNonCollidingFileId = (): string => {
    const candidateId = remote.appProperties?.tsubasa_virtual_id;
    if (!candidateId) return randomUUID();
    const idCollision = sqlite
      .prepare('SELECT id, drive_file_id, account_id FROM files WHERE id = ? LIMIT 1')
      .get(candidateId) as { id: string; drive_file_id: string; account_id: string } | undefined;
    if (!idCollision || (idCollision.drive_file_id === remote.id && idCollision.account_id === accountId)) {
      return candidateId;
    }
    return randomUUID();
  };

  if (resolution === 'keep_both') {
    const parentDir = path.posix.dirname(baseVirtualPath);
    const baseName = path.posix.basename(baseVirtualPath);
    const newVirtualPath = await getAvailableCopyPath(parentDir, baseName, 'file', poolId);
    const newFileName = path.posix.basename(newVirtualPath);

    await db.delete(files).where(and(eq(files.driveFileId, remote.id), eq(files.accountId, accountId)));
    const fileId = resolveNonCollidingFileId();

    await drive.files.update({
      fileId: remote.id,
      requestBody: {
        name: newFileName,
        appProperties: {
          tsubasa_managed: 'true',
          tsubasa_virtual_path: newVirtualPath,
          tsubasa_virtual_id: fileId,
          tsubasa_checksum: checksum || '',
        },
      },
      supportsAllDrives: false,
    });

    ensureLocalFolderHierarchy(newVirtualPath, poolId);
    const newParentDir = path.posix.dirname(newVirtualPath);
    const folderId = newParentDir === '/' || newParentDir === '.' ? null : formatFolderId(poolId, newParentDir);

    sqlite
      .prepare('UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1')
      .run(`${newVirtualPath}.trashed-${Date.now()}`, poolId, newVirtualPath);

    const inserted = await db
      .insert(files)
      .values({
        id: fileId,
        poolId,
        virtualPath: newVirtualPath,
        name: newFileName,
        sizeBytes,
        mimeType: remote.mimeType || 'application/octet-stream',
        hash: checksum,
        accountId,
        driveFileId: remote.id,
        folderId,
        isTrashed: false,
      })
      .returning();

    return {
      resolution: 'keep_both',
      accountId,
      driveFileId,
      virtualPath: newVirtualPath,
      file: inserted[0],
    };
  }

  // replace_existing
  const existingActive = await db.query.files.findFirst({
    where: and(eq(files.poolId, poolId), eq(files.virtualPath, baseVirtualPath), eq(files.isTrashed, false)),
  });

  if (existingActive && existingActive.driveFileId !== remote.id) {
    try {
      const prevDrive = getDriveClient(existingActive.accountId);
      await prevDrive.files.update({
        fileId: existingActive.driveFileId,
        requestBody: {
          trashed: true,
          appProperties: {
            tsubasa_managed: null,
            tsubasa_virtual_path: null,
            tsubasa_virtual_id: null,
          } as any,
        },
        supportsAllDrives: false,
      });
      await refreshAccountLiveQuota(existingActive.accountId).catch(() => {});
    } catch (err) {
      console.warn(
        `Failed to trash replaced Drive file ${existingActive.driveFileId} on ${existingActive.accountId}:`,
        err
      );
    }
    await db.delete(files).where(eq(files.id, existingActive.id));
  }

  await db.delete(files).where(and(eq(files.driveFileId, remote.id), eq(files.accountId, accountId)));
  const fileId = resolveNonCollidingFileId();

  sqlite
    .prepare('UPDATE files SET virtual_path = ? WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1')
    .run(`${baseVirtualPath}.trashed-${Date.now()}`, poolId, baseVirtualPath);

  const fileName = path.posix.basename(baseVirtualPath);
  ensureLocalFolderHierarchy(baseVirtualPath, poolId);
  const parentDir = path.posix.dirname(baseVirtualPath);
  const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

  await drive.files.update({
    fileId: remote.id,
    requestBody: {
      name: fileName,
      appProperties: {
        tsubasa_managed: 'true',
        tsubasa_virtual_path: baseVirtualPath,
        tsubasa_virtual_id: fileId,
        tsubasa_checksum: checksum || '',
      },
    },
    supportsAllDrives: false,
  });

  const inserted = await db
    .insert(files)
    .values({
      id: fileId,
      poolId,
      virtualPath: baseVirtualPath,
      name: fileName,
      sizeBytes,
      mimeType: remote.mimeType || 'application/octet-stream',
      hash: checksum,
      accountId,
      driveFileId: remote.id,
      folderId,
      isTrashed: false,
    })
    .onConflictDoUpdate({
      target: [files.poolId, files.virtualPath],
      set: {
        name: fileName,
        sizeBytes,
        mimeType: remote.mimeType || 'application/octet-stream',
        hash: checksum,
        accountId,
        driveFileId: remote.id,
        folderId,
        isTrashed: false,
        updatedAt: new Date(),
      },
    })
    .returning();

  return {
    resolution: 'replace_existing',
    accountId,
    driveFileId,
    virtualPath: baseVirtualPath,
    file: inserted[0],
  };
}

export async function ejectFileToDriveRoot(accountId: string, driveFileId: string): Promise<void> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (!account || !account.rootFolderId) {
    throw new Error(`Account ${accountId} does not have a registered root folder`);
  }

  const drive = getDriveClient(accountId);

  const fileRes = await drive.files.get({
    fileId: driveFileId,
    fields: 'parents',
    supportsAllDrives: false,
  });

  const parentsToRemove = (fileRes.data.parents || []).join(',');

  await drive.files.update({
    fileId: driveFileId,
    addParents: 'root',
    removeParents: parentsToRemove || account.rootFolderId,
    requestBody: {
      appProperties: {
        tsubasa_managed: null,
        tsubasa_virtual_path: null,
        tsubasa_virtual_id: null,
      } as any,
    },
    supportsAllDrives: false,
  });

  await db.delete(files).where(and(eq(files.driveFileId, driveFileId), eq(files.accountId, accountId)));
}

export async function removeMissingFile(accountId: string, driveFileId: string): Promise<void> {
  const drive = getDriveClient(accountId);

  try {
    await drive.files.update({
      fileId: driveFileId,
      requestBody: {
        appProperties: {
          tsubasa_managed: null,
          tsubasa_virtual_path: null,
          tsubasa_virtual_id: null,
        } as any,
      },
      supportsAllDrives: false,
    });
  } catch {
    // Non-fatal if the file was deleted from Drive entirely
  }

  await db.delete(files).where(and(eq(files.driveFileId, driveFileId), eq(files.accountId, accountId)));
}


