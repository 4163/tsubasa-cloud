import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { accounts, files, type FileRecord } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { authPool } from './auth.js';
import { getDriveClient, ensureRootFolder } from './client.js';
import { ensureRemoteFolderHierarchy, normalizeVirtualPath } from './mirror.js';
import {
  selectPlacementForFile,
  MAX_SINGLE_FILE_BYTES,
  FileExceedsCeilingError,
  recordTransfer,
} from '../storage/index.js';

export interface UploadOptions {
  virtualPath: string;
  sizeBytes: number;
  mimeType?: string;
  hash?: string;
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

async function getAccountRootFolderId(accountId: string): Promise<string> {
  const accountRecord = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (accountRecord?.rootFolderId) {
    return accountRecord.rootFolderId;
  }

  const drive = getDriveClient(accountId);
  const rootId = await ensureRootFolder(drive);

  await db
    .update(accounts)
    .set({ rootFolderId: rootId, updatedAt: new Date() })
    .where(eq(accounts.id, accountId));

  return rootId;
}

export async function initiateResumableUpload(
  options: UploadOptions
): Promise<ResumableSessionInfo> {
  const { sizeBytes, mimeType = 'application/octet-stream', hash } = options;
  const virtualPath = normalizeVirtualPath(options.virtualPath);

  if (sizeBytes > MAX_SINGLE_FILE_BYTES) {
    throw new FileExceedsCeilingError(sizeBytes);
  }

  const decision = await selectPlacementForFile({ virtualPath, sizeBytes });
  const accountId = decision.accountId;

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

  const drive = getDriveClient(file.accountId);
  await drive.files.update({
    fileId: file.driveFileId,
    requestBody: { trashed: true },
    supportsAllDrives: false,
  });

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

  const drive = getDriveClient(file.accountId);
  await drive.files.update({
    fileId: file.driveFileId,
    requestBody: { trashed: false },
    supportsAllDrives: false,
  });

  const updated = await db
    .update(files)
    .set({
      isTrashed: false,
      trashedAt: null,
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

  const drive = getDriveClient(file.accountId);
  await drive.files.delete({
    fileId: file.driveFileId,
    supportsAllDrives: false,
  });

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
      const drive = getDriveClient(f.accountId);
      await drive.files.delete({
        fileId: f.driveFileId,
        supportsAllDrives: false,
      });

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
    } catch {
      // Continue purging remaining items if one fails
    }
  }

  return { filesPurged, bytesReclaimed };
}

