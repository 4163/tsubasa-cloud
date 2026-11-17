import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite, bumpPoolRevision } from '../db/index.js';
import { accounts, files, type FileRecord } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { authPool } from './auth.js';
import {
  getDriveClient,
  getAccountRootFolderId,
  withDriveRetry,
  markAccountQuotaDecreased,
} from './client.js';
import { ensureRemoteFolderHierarchy, normalizeVirtualPath } from './mirror.js';
import { ensureLocalParentFolders, formatFolderId } from './sync.js';
import { enqueueDriveOutbox } from './outbox.js';
import {
  selectPlacementForFile,
  validateTargetPlacement,
  MAX_SINGLE_FILE_BYTES,
  FileExceedsCeilingError,
  recordTransfer,
  invalidatePooledStorageOverview,
} from '../storage/index.js';

export type UploadConflictMode = 'reject' | 'replace' | 'keep_both';

export class UploadConflictError extends Error {}

export interface UploadOptions {
  virtualPath: string;
  sizeBytes: number;
  mimeType?: string;
  hash?: string;
  targetAccountId?: string;
  poolId?: number;
  conflictMode?: UploadConflictMode;
}

export interface ResumableSessionInfo {
  fileId: string;
  accountId: string;
  poolId: number;
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
  targetAccountEmail?: string;
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

  const driveTarget = getDriveClient(targetAccountId);

  if (sourceAccountId === targetAccountId) {
    const copyRes = await withDriveRetry(() =>
      driveTarget.files.copy({
        fileId: sourceDriveFileId,
        requestBody: {
          name: destFileName,
          parents: [targetRemoteFolderId],
          appProperties,
        },
        fields,
        supportsAllDrives: false,
      })
    );

    const newDriveFileId = copyRes.data.id;
    if (!newDriveFileId) {
      throw new Error('Google Drive server-side copy returned empty file ID');
    }
    return newDriveFileId;
  }

  if (!targetAccountEmail) {
    throw new Error('targetAccountEmail is required for cross-account Drive copy');
  }

  const driveSource = getDriveClient(sourceAccountId);

  const shareRes = await withDriveRetry(() =>
    driveSource.permissions.create({
      fileId: sourceDriveFileId,
      sendNotificationEmail: false,
      requestBody: {
        role: 'reader',
        type: 'user',
        emailAddress: targetAccountEmail,
      },
      supportsAllDrives: false,
    })
  );

  const permissionId = shareRes.data.id;
  try {
    const copyRes = await withDriveRetry(() =>
      driveTarget.files.copy({
        fileId: sourceDriveFileId,
        requestBody: {
          name: destFileName,
          parents: [targetRemoteFolderId],
          appProperties,
        },
        fields,
        supportsAllDrives: false,
      })
    );

    const newDriveFileId = copyRes.data.id;
    if (!newDriveFileId) {
      throw new Error('Google Drive cross-account copy returned empty file ID');
    }
    return newDriveFileId;
  } finally {
    if (permissionId) {
      void withDriveRetry(() =>
        driveSource.permissions.delete({
          fileId: sourceDriveFileId,
          permissionId,
          supportsAllDrives: false,
        })
      ).catch((cleanupErr) => {
        console.warn(`Failed to cleanup temp reader permission on ${sourceDriveFileId}:`, cleanupErr);
      });
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

const SMALL_UPLOAD_MULTIPART_BYTES = 5 * 1024 * 1024;
const VALID_RANGE_HEADER_RE = /^bytes=(?:\d+-\d*|\d*-\d+)(?:\s*,\s*(?:\d+-\d*|\d*-\d+))*$/i;
const inFlightUploadPaths = new Set<string>();

function allocateKeepBothPath(poolId: number, basePath: string): string {
  const checkActiveStmt = sqlite.prepare(
    'SELECT 1 FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0 LIMIT 1'
  );

  const isPathTaken = (candidatePath: string): boolean =>
    inFlightUploadPaths.has(`${poolId}:${candidatePath}`) || Boolean(checkActiveStmt.get(poolId, candidatePath));

  if (!isPathTaken(basePath)) {
    return basePath;
  }

  const dir = path.posix.dirname(basePath);
  const baseName = path.posix.basename(basePath);
  const ext = path.posix.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;

  for (let n = 1; ; n++) {
    const candidateName = `${stem} (${n})${ext}`;
    const candidatePath = dir === '/' || dir === '.' ? `/${candidateName}` : `${dir}/${candidateName}`;
    if (!isPathTaken(candidatePath)) {
      return candidatePath;
    }
  }
}

interface PreparedUploadTarget {
  fileId: string;
  accountId: string;
  poolId: number;
  virtualPath: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  remoteParentFolderId: string;
  accessToken: string;
  metadata: {
    name: string;
    parents: string[];
    appProperties: Record<string, string>;
  };
}

async function prepareUploadTarget(
  options: UploadOptions,
  reserveInFlight = false
): Promise<PreparedUploadTarget> {
  const { sizeBytes, mimeType = 'application/octet-stream', hash, conflictMode = 'reject' } = options;
  const initialVirtualPath = normalizeVirtualPath(options.virtualPath);

  if (sizeBytes > MAX_SINGLE_FILE_BYTES) {
    throw new FileExceedsCeilingError(sizeBytes);
  }

  let poolId = options.poolId ?? 1;
  if (options.targetAccountId) {
    const accRow = await db.query.accounts.findFirst({ where: eq(accounts.id, options.targetAccountId) });
    if (accRow) {
      poolId = accRow.poolId;
    }
  }

  const existingActive = sqlite
    .prepare(
      'SELECT id, account_id, drive_file_id, size_bytes FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0'
    )
    .get(poolId, initialVirtualPath) as
    | { id: string; account_id: string; drive_file_id: string; size_bytes: number }
    | undefined;

  let virtualPath = initialVirtualPath;
  if (existingActive) {
    if (conflictMode === 'reject') {
      throw new UploadConflictError(
        `A file named "${path.posix.basename(initialVirtualPath)}" already exists at ${initialVirtualPath}`
      );
    }
    if (conflictMode === 'keep_both') {
      virtualPath = allocateKeepBothPath(poolId, initialVirtualPath);
    }
  } else if (conflictMode === 'keep_both' && inFlightUploadPaths.has(`${poolId}:${initialVirtualPath}`)) {
    virtualPath = allocateKeepBothPath(poolId, initialVirtualPath);
  }

  const inFlightKey = `${poolId}:${virtualPath}`;
  if (reserveInFlight) {
    inFlightUploadPaths.add(inFlightKey);
  }

  try {
    let accountId: string;
    if (options.targetAccountId) {
      await validateTargetPlacement(options.targetAccountId, sizeBytes, Date.now(), options.poolId);
      accountId = options.targetAccountId;
    } else if (conflictMode === 'replace' && existingActive) {
      try {
        await validateTargetPlacement(existingActive.account_id, sizeBytes, Date.now(), poolId);
        accountId = existingActive.account_id;
      } catch {
        const decision = await selectPlacementForFile(
          { virtualPath, sizeBytes },
          undefined,
          Date.now(),
          undefined,
          poolId
        );
        accountId = decision.accountId;
      }
    } else {
      const decision = await selectPlacementForFile(
        { virtualPath, sizeBytes },
        undefined,
        Date.now(),
        undefined,
        poolId
      );
      accountId = decision.accountId;
    }

    const rootFolderId = await getAccountRootFolderId(accountId);
    const drive = getDriveClient(accountId);
    const folderDir = path.posix.dirname(virtualPath);
    const remoteParentFolderId = await ensureRemoteFolderHierarchy(drive, rootFolderId, folderDir);

    const accessToken = await getAccessToken(accountId);
    const fileName = path.posix.basename(virtualPath);
    const fileId = randomUUID();

    return {
      fileId,
      accountId,
      poolId,
      virtualPath,
      fileName,
      sizeBytes,
      mimeType,
      remoteParentFolderId,
      accessToken,
      metadata: {
        name: fileName,
        parents: [remoteParentFolderId],
        appProperties: {
          tsubasa_managed: 'true',
          tsubasa_virtual_path: virtualPath,
          tsubasa_virtual_id: fileId,
          tsubasa_checksum: hash || '',
        },
      },
    };
  } catch (err) {
    if (reserveInFlight) {
      inFlightUploadPaths.delete(inFlightKey);
    }
    throw err;
  }
}

async function createResumableSession(
  target: PreparedUploadTarget,
  signal?: AbortSignal
): Promise<string> {
  const initRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,md5Checksum,sha256Checksum',
    {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${target.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': target.mimeType,
        'X-Upload-Content-Length': String(target.sizeBytes),
      },
      body: JSON.stringify(target.metadata),
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

  return uploadLocation;
}

export async function initiateResumableUpload(
  options: UploadOptions
): Promise<ResumableSessionInfo> {
  const target = await prepareUploadTarget(options);
  const uploadLocation = await createResumableSession(target);

  return {
    fileId: target.fileId,
    accountId: target.accountId,
    poolId: target.poolId,
    virtualPath: target.virtualPath,
    sizeBytes: target.sizeBytes,
    mimeType: target.mimeType,
    uploadLocation,
  };
}

async function readStreamToBuffer(stream: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  if (!stream) {
    return Buffer.alloc(0);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function executeStreamingUpload(
  options: UploadOptions,
  bodyStream: ReadableStream | null,
  signal?: AbortSignal
): Promise<FileRecord> {
  const target = await prepareUploadTarget(options, true);
  const inFlightKey = `${target.poolId}:${target.virtualPath}`;

  try {
    let actualBytes = 0;
    const countingStream = bodyStream
      ? bodyStream.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              actualBytes += chunk.byteLength;
              if (actualBytes > MAX_SINGLE_FILE_BYTES) {
                controller.error(new FileExceedsCeilingError(actualBytes));
                return;
              }
              controller.enqueue(chunk);
            },
          })
        )
      : null;

    let uploadRes: Response;
    if (target.sizeBytes <= SMALL_UPLOAD_MULTIPART_BYTES) {
      const payloadBuffer = await readStreamToBuffer(countingStream);
      const boundary = `tsubasa_${randomUUID().replace(/-/g, '')}`;
      const metadataPart =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(target.metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${target.mimeType}\r\n\r\n`;
      const closingPart = `\r\n--${boundary}--`;
      const bodyBuffer = Buffer.concat([
        Buffer.from(metadataPart, 'utf8'),
        payloadBuffer,
        Buffer.from(closingPart, 'utf8'),
      ]);

      uploadRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,md5Checksum,sha256Checksum',
        {
          method: 'POST',
          signal,
          headers: {
            Authorization: `Bearer ${target.accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
            'Content-Length': String(bodyBuffer.byteLength),
          },
          body: bodyBuffer,
        }
      );
    } else {
      const uploadLocation = await createResumableSession(target, signal);
      const requestInit: RequestInit & { duplex?: string } = {
        method: 'PUT',
        signal,
        headers: {
          'Content-Length': String(target.sizeBytes),
          'Content-Type': target.mimeType,
        },
        duplex: 'half',
        body: countingStream ?? Buffer.alloc(0),
      };

      uploadRes = await fetch(uploadLocation, requestInit);
    }

    if (uploadRes.status === 308) {
      const errText = await uploadRes.text().catch(() => '');
      throw new Error(`Google Drive resumable upload incomplete (308): ${errText}`);
    }

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Google Drive stream upload failed: ${uploadRes.status} ${errText}`);
    }

    const driveData = (await uploadRes.json()) as {
      id: string;
      name: string;
      size?: string;
      md5Checksum?: string;
      sha256Checksum?: string;
    };

    const finalBytes = bodyStream ? actualBytes : 0;
    const resolvedHash = options.hash || driveData.md5Checksum || driveData.sha256Checksum || null;
    const parentDir = path.posix.dirname(target.virtualPath);
    const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(target.poolId, parentDir);

    ensureLocalParentFolders(target.virtualPath, target.poolId);

    sqlite.transaction(() => {
      const collidingTrashed = sqlite
        .prepare('SELECT id FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1')
        .get(target.poolId, target.virtualPath) as { id: string } | undefined;

      if (collidingTrashed) {
        sqlite
          .prepare('UPDATE files SET virtual_path = ?, updated_at = unixepoch() WHERE id = ?')
          .run(`${target.virtualPath}.trashed-${Date.now()}-${collidingTrashed.id.slice(0, 6)}`, collidingTrashed.id);
      }

      const oldActiveRow = sqlite
        .prepare(
          'SELECT id, account_id, drive_file_id, size_bytes FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0'
        )
        .get(target.poolId, target.virtualPath) as
        | { id: string; account_id: string; drive_file_id: string; size_bytes: number }
        | undefined;

      if (oldActiveRow && oldActiveRow.drive_file_id !== driveData.id) {
        enqueueDriveOutbox([
          {
            accountId: oldActiveRow.account_id,
            poolId: target.poolId,
            opType: 'file_delete',
            driveFileId: oldActiveRow.drive_file_id,
            payload: { fileId: oldActiveRow.id, driveFileId: oldActiveRow.drive_file_id },
          },
        ]);
      }

      sqlite
        .prepare(
          `INSERT INTO files (
            id, pool_id, virtual_path, name, size_bytes, mime_type, hash,
            account_id, drive_file_id, folder_id, is_trashed, trashed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, unixepoch(), unixepoch())
          ON CONFLICT(pool_id, virtual_path) DO UPDATE SET
            name = excluded.name,
            size_bytes = excluded.size_bytes,
            mime_type = excluded.mime_type,
            hash = excluded.hash,
            account_id = excluded.account_id,
            drive_file_id = excluded.drive_file_id,
            folder_id = excluded.folder_id,
            is_trashed = 0,
            trashed_at = NULL,
            updated_at = unixepoch()`
        )
        .run(
          target.fileId,
          target.poolId,
          target.virtualPath,
          target.fileName,
          finalBytes,
          target.mimeType,
          resolvedHash,
          target.accountId,
          driveData.id,
          folderId
        );

      if (oldActiveRow) {
        if (oldActiveRow.account_id === target.accountId) {
          const netDelta = finalBytes - oldActiveRow.size_bytes;
          sqlite
            .prepare('UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes + ?), updated_at = unixepoch() WHERE id = ?')
            .run(netDelta, target.accountId);
        } else {
          sqlite
            .prepare('UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes - ?), updated_at = unixepoch() WHERE id = ?')
            .run(oldActiveRow.size_bytes, oldActiveRow.account_id);
          sqlite
            .prepare('UPDATE accounts SET quota_used_bytes = quota_used_bytes + ?, updated_at = unixepoch() WHERE id = ?')
            .run(finalBytes, target.accountId);
        }
      } else {
        sqlite
          .prepare('UPDATE accounts SET quota_used_bytes = quota_used_bytes + ?, updated_at = unixepoch() WHERE id = ?')
          .run(finalBytes, target.accountId);
      }
    }).immediate();

    await recordTransfer(target.accountId, 'upload', finalBytes);
    invalidatePooledStorageOverview(target.poolId);
    bumpPoolRevision(target.poolId);

    const saved = await db.query.files.findFirst({
      where: and(eq(files.poolId, target.poolId), eq(files.virtualPath, target.virtualPath)),
    });
    if (!saved) {
      throw new Error(`Uploaded file missing from SQLite index: ${target.virtualPath}`);
    }
    return saved;
  } finally {
    inFlightUploadPaths.delete(inFlightKey);
  }
}

export async function getStreamingDownload(
  fileIdOrPath: string,
  poolId?: number,
  options?: { rangeHeader?: string | null; signal?: AbortSignal }
): Promise<{
  stream: ReadableStream;
  file: FileRecord;
  status: 200 | 206;
  contentLength: number;
  contentRange?: string;
  totalBytes: number;
}> {
  const conditions = [
    sql`${files.id} = ${fileIdOrPath} OR ${files.virtualPath} = ${fileIdOrPath} OR ${files.driveFileId} = ${fileIdOrPath}`,
    eq(files.isTrashed, false),
  ];
  if (poolId !== undefined) {
    conditions.push(eq(files.poolId, poolId));
  }

  const file = await db.query.files.findFirst({
    where: and(...conditions),
  });

  if (!file) {
    throw new Error(`Active file not found: ${fileIdOrPath}`);
  }

  const accessToken = await getAccessToken(file.accountId);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  const trimmedRange = options?.rangeHeader?.trim();
  if (trimmedRange && VALID_RANGE_HEADER_RE.test(trimmedRange)) {
    headers.Range = trimmedRange;
  }

  const driveRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.driveFileId)}?alt=media`,
    {
      headers,
      signal: options?.signal,
    }
  );

  if (!driveRes.ok || !driveRes.body) {
    await driveRes.body?.cancel().catch(() => {});
    const err = new Error(`Google Drive download stream failed with status ${driveRes.status}`) as Error & {
      status?: number;
    };
    err.status = driveRes.status;
    throw err;
  }

  const status: 200 | 206 = driveRes.status === 206 ? 206 : 200;
  const contentRange = driveRes.headers.get('Content-Range') ?? undefined;
  const rawContentLength = driveRes.headers.get('Content-Length');
  const parsedContentLength = rawContentLength !== null ? Number(rawContentLength) : NaN;
  const contentLength =
    Number.isFinite(parsedContentLength) && parsedContentLength >= 0 ? parsedContentLength : file.sizeBytes;

  let totalBytes = file.sizeBytes;
  if (contentRange) {
    const match = /\/(\d+)$/.exec(contentRange);
    if (match) {
      totalBytes = Number(match[1]);
    }
  }

  const reader = driveRes.body.getReader();
  let bytesStreamed = 0;
  let recorded = false;
  const flushTransferLog = () => {
    if (recorded || bytesStreamed <= 0) {
      return;
    }
    recorded = true;
    void recordTransfer(file.accountId, 'download', bytesStreamed).catch((err) => {
      console.warn(`Failed to record download transfer for ${file.id}:`, err);
    });
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          flushTransferLog();
          controller.close();
          return;
        }
        bytesStreamed += value.byteLength;
        controller.enqueue(value);
      } catch (err) {
        flushTransferLog();
        controller.error(err);
      }
    },
    async cancel(reason) {
      flushTransferLog();
      await reader.cancel(reason).catch(() => {});
    },
  });

  return {
    stream,
    file,
    status,
    contentLength,
    contentRange,
    totalBytes,
  };
}

export async function trashFile(fileId: string): Promise<FileRecord> {
  const file = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });

  if (!file) {
    throw new Error(`File ${fileId} not found`);
  }

  sqlite.transaction(() => {
    sqlite
      .prepare(
        'UPDATE files SET is_trashed = 1, trashed_at = unixepoch(), updated_at = unixepoch() WHERE id = ?'
      )
      .run(fileId);

    enqueueDriveOutbox([
      {
        accountId: file.accountId,
        poolId: file.poolId,
        opType: 'file_trash',
        driveFileId: file.driveFileId,
        payload: {
          fileId: file.id,
          driveFileId: file.driveFileId,
        },
      },
    ]);
  }).immediate();

  bumpPoolRevision(file.poolId);

  const updated = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });
  return updated ?? { ...file, isTrashed: true };
}

function allocateRestoredPath(poolId: number, basePath: string, selfId: string): string {
  const checkActiveStmt = sqlite.prepare(
    'SELECT 1 FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0 AND id != ? LIMIT 1'
  );

  if (!checkActiveStmt.get(poolId, basePath, selfId)) {
    return basePath;
  }

  const dir = path.posix.dirname(basePath);
  const baseName = path.posix.basename(basePath);
  const ext = path.posix.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;

  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ' (restored)' : ` (restored ${n})`;
    const candidateName = `${stem}${suffix}${ext}`;
    const candidatePath = dir === '/' || dir === '.' ? `/${candidateName}` : `${dir}/${candidateName}`;
    if (!checkActiveStmt.get(poolId, candidatePath, selfId)) {
      return candidatePath;
    }
  }
}

export async function restoreFile(fileId: string): Promise<FileRecord> {
  const file = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });

  if (!file) {
    throw new Error(`File ${fileId} not found`);
  }

  const strippedPath = file.virtualPath.replace(/\.trashed-\d+(?:-[a-zA-Z0-9]+)?$/, '');
  const restoredPath = allocateRestoredPath(file.poolId, strippedPath, file.id);
  const restoredName = path.posix.basename(restoredPath);
  const parentDir = path.posix.dirname(restoredPath);
  const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(file.poolId, parentDir);
  const pathOrNameChanged = restoredPath !== file.virtualPath || restoredName !== file.name;

  ensureLocalParentFolders(restoredPath, file.poolId);

  sqlite.transaction(() => {
    const collidingTrashed = sqlite
      .prepare('SELECT id FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 1 AND id != ?')
      .get(file.poolId, restoredPath, file.id) as { id: string } | undefined;

    if (collidingTrashed) {
      sqlite
        .prepare('UPDATE files SET virtual_path = ?, updated_at = unixepoch() WHERE id = ?')
        .run(`${restoredPath}.trashed-${Date.now()}-${collidingTrashed.id.slice(0, 6)}`, collidingTrashed.id);
    }

    sqlite
      .prepare(
        'UPDATE files SET virtual_path = ?, name = ?, folder_id = ?, is_trashed = 0, trashed_at = NULL, updated_at = unixepoch() WHERE id = ?'
      )
      .run(restoredPath, restoredName, folderId, file.id);

    enqueueDriveOutbox([
      {
        accountId: file.accountId,
        poolId: file.poolId,
        opType: 'file_restore',
        driveFileId: file.driveFileId,
        payload: {
          fileId: file.id,
          driveFileId: file.driveFileId,
          ...(pathOrNameChanged ? { newVirtualPath: restoredPath, newName: restoredName } : {}),
        },
      },
    ]);
  }).immediate();

  bumpPoolRevision(file.poolId);

  const updated = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });
  return (
    updated ?? {
      ...file,
      virtualPath: restoredPath,
      name: restoredName,
      folderId,
      isTrashed: false,
      trashedAt: null,
    }
  );
}

export async function purgeFile(fileId: string): Promise<FileRecord> {
  const file = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });

  if (!file) {
    throw new Error(`File ${fileId} not found`);
  }

  sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM files WHERE id = ?').run(fileId);

    sqlite
      .prepare(
        'UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes - ?), updated_at = unixepoch() WHERE id = ?'
      )
      .run(file.sizeBytes, file.accountId);

    enqueueDriveOutbox([
      {
        accountId: file.accountId,
        poolId: file.poolId,
        opType: 'file_delete',
        driveFileId: file.driveFileId,
        payload: {
          fileId: file.id,
          driveFileId: file.driveFileId,
        },
      },
    ]);
  }).immediate();

  markAccountQuotaDecreased(file.accountId);
  invalidatePooledStorageOverview(file.poolId);
  bumpPoolRevision(file.poolId);

  return file;
}

export async function emptyTrash(poolId?: number): Promise<{ filesPurged: number; bytesReclaimed: number }> {
  const trashedFiles = await db.query.files.findMany({
    where:
      poolId !== undefined
        ? and(eq(files.isTrashed, true), eq(files.poolId, poolId))
        : eq(files.isTrashed, true),
  });

  if (trashedFiles.length === 0) {
    return { filesPurged: 0, bytesReclaimed: 0 };
  }

  const bytesByAccount = new Map<string, number>();
  let bytesReclaimed = 0;
  for (const f of trashedFiles) {
    bytesReclaimed += f.sizeBytes;
    bytesByAccount.set(f.accountId, (bytesByAccount.get(f.accountId) ?? 0) + f.sizeBytes);
  }

  sqlite.transaction(() => {
    const deleteFileStmt = sqlite.prepare('DELETE FROM files WHERE id = ?');
    for (const f of trashedFiles) {
      deleteFileStmt.run(f.id);
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

  for (const accountId of bytesByAccount.keys()) {
    markAccountQuotaDecreased(accountId);
  }
  invalidatePooledStorageOverview(poolId);
  bumpPoolRevision(poolId);

  return { filesPurged: trashedFiles.length, bytesReclaimed };
}

