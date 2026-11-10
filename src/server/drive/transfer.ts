import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { accounts, files, type FileRecord } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { authPool } from './auth.js';
import { getDriveClient, getAccountRootFolderId } from './client.js';
import { ensureRemoteFolderHierarchy, normalizeVirtualPath } from './mirror.js';
import { ensureLocalFolderHierarchy } from './sync.js';
import {
  selectPlacementForFile,
  validateTargetPlacement,
  MAX_SINGLE_FILE_BYTES,
  FileExceedsCeilingError,
  recordTransfer,
} from '../storage/index.js';

export interface UploadOptions {
  virtualPath: string;
  sizeBytes: number;
  mimeType?: string;
  hash?: string;
  targetAccountId?: string;
}

export interface ResumableSessionInfo {
  fileId: string;
  accountId: string;
  virtualPath: string;
  sizeBytes: number;
  mimeType: string;
  uploadLocation: string;
}

async function getAccessToken(accountId: string): Promise<string> {
  const authClient = authPool.getClient(accountId);
  if (!authClient) {
    throw new Error(`Account ${accountId} not registered in auth pool`);
  }
  const tokenInfo = await authClient.getAccessToken();
  if (!tokenInfo.token) {
    throw new Error(`Failed to acquire Google access token for account ${accountId}`);
  }
  return tokenInfo.token;
}

export interface CopyCrossAccountOptions {
  sourceAccountId: string;
  sourceDriveFileId: string;
  targetAccountId: string;
  targetAccountEmail: string;
  targetRemoteFolderId: string;
  destFileName: string;
  appProperties: Record<string, string>;
  fields?: string;
}

export async function copyDriveFileCrossAccount(
  options: CopyCrossAccountOptions
): Promise<string> {
  const {
    sourceAccountId,
    sourceDriveFileId,
    targetAccountId,
    targetAccountEmail,
    targetRemoteFolderId,
    destFileName,
    appProperties,
    fields = 'id, name, size',
  } = options;

  const driveSource = getDriveClient(sourceAccountId);
  const driveTarget = getDriveClient(targetAccountId);

  const shareRes = await driveSource.permissions.create({
    fileId: sourceDriveFileId,
    requestBody: {
      role: 'reader',
      type: 'user',
      emailAddress: targetAccountEmail,
    },
    supportsAllDrives: false,
  });

  const permissionId = shareRes.data.id;
  try {
    const copyRes = await driveTarget.files.copy({
      fileId: sourceDriveFileId,
      requestBody: {
        name: destFileName,
        parents: [targetRemoteFolderId],
        appProperties,
      },
      fields,
      supportsAllDrives: false,
    });

    const newDriveFileId = copyRes.data.id;
    if (!newDriveFileId) {
      throw new Error('Google Drive cross-account copy returned empty file ID');
    }
    return newDriveFileId;
  } finally {
    if (permissionId) {
      try {
        await driveSource.permissions.delete({
          fileId: sourceDriveFileId,
          permissionId,
          supportsAllDrives: false,
        });
      } catch (cleanupErr) {
        console.warn(`Failed to cleanup temp reader permission on ${sourceDriveFileId}:`, cleanupErr);
      }
    }
  }
}

export async function deleteDriveFileIgnoreNotFound(
  accountId: string,
  driveFileId: string
): Promise<void> {
  try {
    const drive = getDriveClient(accountId);
    await drive.files.delete({
      fileId: driveFileId,
      supportsAllDrives: false,
    });
  } catch (err: unknown) {
    const isNotFound =
      (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 404) ||
      (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 404) ||
      (err instanceof Error && err.message.toLowerCase().includes('not found'));

    if (!isNotFound) {
      console.warn(`Drive delete warning for ${driveFileId}:`, err instanceof Error ? err.message : String(err));
    }
  }
}

export async function initiateResumableUpload(
  options: UploadOptions
): Promise<ResumableSessionInfo> {
  const { sizeBytes, mimeType = 'application/octet-stream', hash } = options;
  const virtualPath = normalizeVirtualPath(options.virtualPath);

  if (sizeBytes > MAX_SINGLE_FILE_BYTES) {
    throw new FileExceedsCeilingError(sizeBytes);
  }

  let accountId: string;
  if (options.targetAccountId) {
    await validateTargetPlacement(options.targetAccountId, sizeBytes);
    accountId = options.targetAccountId;
  } else {
    const decision = await selectPlacementForFile({ virtualPath, sizeBytes });
    accountId = decision.accountId;
  }

  const rootFolderId = await getAccountRootFolderId(accountId);
  const drive = getDriveClient(accountId);
  const folderDir = path.posix.dirname(virtualPath);
  const remoteParentFolderId = await ensureRemoteFolderHierarchy(drive, rootFolderId, folderDir);

  const accessToken = await getAccessToken(accountId);
  const fileName = path.posix.basename(virtualPath);
  const fileId = randomUUID();

  const initRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(sizeBytes),
      },
      body: JSON.stringify({
        name: fileName,
        parents: [remoteParentFolderId],
        appProperties: {
          tsubasa_managed: 'true',
          tsubasa_virtual_path: virtualPath,
          tsubasa_virtual_id: fileId,
          tsubasa_checksum: hash || '',
        },
      }),
    }
  );

  if (!initRes.ok) {
    const errorBody = await initRes.text();
    throw new Error(`Google Drive resumable init rejected: ${initRes.status} ${errorBody}`);
  }

  const uploadLocation = initRes.headers.get('Location');
  if (!uploadLocation) {
    throw new Error('Google Drive did not return a resumable upload location URL');
  }

  return {
    fileId,
    accountId,
    virtualPath,
    sizeBytes,
    mimeType,
    uploadLocation,
  };
}

export async function executeStreamingUpload(
  options: UploadOptions,
  bodyStream: ReadableStream
): Promise<FileRecord> {
  const session = await initiateResumableUpload(options);

  const requestInit: RequestInit & { duplex?: string } = {
    method: 'PUT',
    headers: {
      'Content-Length': String(session.sizeBytes),
      'Content-Type': session.mimeType,
    },
    duplex: 'half',
    body: bodyStream,
  };

  const uploadRes = await fetch(session.uploadLocation, requestInit);

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`Google Drive stream upload failed: ${uploadRes.status} ${errText}`);
  }

  const driveData = (await uploadRes.json()) as {
    id: string;
    name: string;
    size?: string;
    md5Checksum?: string;
  };

  const fileName = path.posix.basename(session.virtualPath);
  ensureLocalFolderHierarchy(session.virtualPath);
  const parentDir = path.posix.dirname(session.virtualPath);
  const folderId = parentDir === '/' || parentDir === '.' ? null : parentDir;

  const insertedRecords = await db
    .insert(files)
    .values({
      id: session.fileId,
      virtualPath: session.virtualPath,
      name: fileName,
      sizeBytes: session.sizeBytes,
      mimeType: session.mimeType,
      hash: options.hash || driveData.md5Checksum || null,
      accountId: session.accountId,
      driveFileId: driveData.id,
      folderId,
      isTrashed: false,
    })
    .onConflictDoUpdate({
      target: files.virtualPath,
      set: {
        name: fileName,
        sizeBytes: session.sizeBytes,
        mimeType: session.mimeType,
        hash: options.hash || driveData.md5Checksum || null,
        accountId: session.accountId,
        driveFileId: driveData.id,
        folderId,
        isTrashed: false,
        updatedAt: new Date(),
      },
    })
    .returning();

  await recordTransfer(session.accountId, 'upload', session.sizeBytes);

  await db
    .update(accounts)
    .set({
      quotaUsedBytes: sql`${accounts.quotaUsedBytes} + ${session.sizeBytes}`,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, session.accountId));

  return insertedRecords[0];
}

export async function getStreamingDownload(fileIdOrPath: string): Promise<{
  stream: ReadableStream;
  file: FileRecord;
}> {
  const file = await db.query.files.findFirst({
    where: and(
      sql`${files.id} = ${fileIdOrPath} OR ${files.virtualPath} = ${fileIdOrPath} OR ${files.driveFileId} = ${fileIdOrPath}`,
      eq(files.isTrashed, false)
    ),
  });

  if (!file) {
    throw new Error(`Active file not found: ${fileIdOrPath}`);
  }

  const accessToken = await getAccessToken(file.accountId);
  const driveRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.driveFileId)}?alt=media`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!driveRes.ok || !driveRes.body) {
    throw new Error(`Google Drive download stream failed with status ${driveRes.status}`);
  }

  await recordTransfer(file.accountId, 'download', file.sizeBytes);

  return {
    stream: driveRes.body,
    file,
  };
}

export async function trashFile(fileId: string): Promise<FileRecord> {
  const file = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });

  if (!file) {
    throw new Error(`File ${fileId} not found`);
  }

  try {
    const drive = getDriveClient(file.accountId);
    await drive.files.update({
      fileId: file.driveFileId,
      requestBody: { trashed: true },
      supportsAllDrives: false,
    });
  } catch (err) {
    console.warn(`Drive trash file warning for ${file.id}:`, err);
  }

  const updated = await db
    .update(files)
    .set({
      isTrashed: true,
      trashedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(files.id, fileId))
    .returning();

  return updated[0];
}

export async function restoreFile(fileId: string): Promise<FileRecord> {
  const file = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });

  if (!file) {
    throw new Error(`File ${fileId} not found`);
  }

  try {
    const drive = getDriveClient(file.accountId);
    await drive.files.update({
      fileId: file.driveFileId,
      requestBody: { trashed: false },
      supportsAllDrives: false,
    });
  } catch (err) {
    console.warn(`Drive restore file warning for ${file.id}:`, err);
  }

  ensureLocalFolderHierarchy(file.virtualPath);
  const parentDir = path.posix.dirname(file.virtualPath);
  const folderId = parentDir === '/' || parentDir === '.' ? null : parentDir;

  const updated = await db
    .update(files)
    .set({
      isTrashed: false,
      trashedAt: null,
      folderId,
      updatedAt: new Date(),
    })
    .where(eq(files.id, fileId))
    .returning();

  return updated[0];
}

export async function purgeFile(fileId: string): Promise<FileRecord> {
  const file = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });

  if (!file) {
    throw new Error(`File ${fileId} not found`);
  }

  await deleteDriveFileIgnoreNotFound(file.accountId, file.driveFileId);

  await db.delete(files).where(eq(files.id, fileId));

  await db
    .update(accounts)
    .set({
      quotaUsedBytes: sql`MAX(0, ${accounts.quotaUsedBytes} - ${file.sizeBytes})`,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, file.accountId));

  return file;
}

export async function emptyTrash(): Promise<{ filesPurged: number; bytesReclaimed: number }> {
  const trashedFiles = await db.query.files.findMany({
    where: eq(files.isTrashed, true),
  });

  let filesPurged = 0;
  let bytesReclaimed = 0;

  for (const f of trashedFiles) {
    try {
      await deleteDriveFileIgnoreNotFound(f.accountId, f.driveFileId);

      await db.delete(files).where(eq(files.id, f.id));

      await db
        .update(accounts)
        .set({
          quotaUsedBytes: sql`MAX(0, ${accounts.quotaUsedBytes} - ${f.sizeBytes})`,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, f.accountId));

      filesPurged++;
      bytesReclaimed += f.sizeBytes;
    } catch (err) {
      console.error(`Failed to purge local file ${f.id}:`, err);
    }
  }

  return { filesPurged, bytesReclaimed };
}

