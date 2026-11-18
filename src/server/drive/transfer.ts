import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite, bumpPoolRevision } from '../db/index.js';
import { accounts, files, type FileRecord } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { getAccessToken, getDriveClient } from './client.js';
import { isSharePoolId } from './poolRegistry.js';
import { buildTsubasaAppProperties } from './appProperties.js';
import { allocateUniqueVirtualPath, displaceTrashedFileAtPath } from './operationsDb.js';
import { getAccountRootFolderId } from './remoteTree.js';
import { ensureRemoteFolderHierarchy } from './mirror.js';
import { normalizeVirtualPath } from '../virtualPath.js';
import { ensureLocalParentFolders, formatFolderId } from './sync.js';
import { enqueueDriveOutbox } from './outbox.js';
import { ItemNotFoundError, validateItemName } from './errors.js';
import {
  selectPlacementForFile,
  validateTargetPlacement,
  reserveAccountCapacity,
  MAX_SINGLE_FILE_BYTES,
  FileExceedsCeilingError,
  recordTransfer,
  recordTransferSync,
  invalidatePooledStorageOverview,
} from '../storage/index.js';

export type UploadConflictMode = 'reject' | 'replace' | 'keep_both';

export class UploadConflictError extends Error {}
export class SharePoolReadOnlyError extends Error {}
export class UploadValidationError extends Error {}

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

const SMALL_UPLOAD_MULTIPART_BYTES = 5 * 1024 * 1024;
const VALID_RANGE_HEADER_RE = /^bytes=(?:\d+-\d*|\d*-\d+)(?:\s*,\s*(?:\d+-\d*|\d*-\d+))*$/i;
const inFlightUploadPaths = new Map<string, string>();

function allocateKeepBothPath(poolId: number, basePath: string): string {
  const checkActiveStmt = sqlite.prepare(
    'SELECT 1 FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0 LIMIT 1'
  );

  return allocateUniqueVirtualPath({
    targetDir: path.posix.dirname(basePath),
    baseName: path.posix.basename(basePath),
    kind: 'file',
    style: 'numbered',
    startCounter: 1,
    isTaken: (candidatePath) =>
      inFlightUploadPaths.has(`${poolId}:${candidatePath}`) || Boolean(checkActiveStmt.get(poolId, candidatePath)),
  });
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
  uploadToken: string;
  releaseCapacity: () => void;
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

  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new UploadValidationError(`Invalid upload sizeBytes: ${sizeBytes}`);
  }
  if (sizeBytes > MAX_SINGLE_FILE_BYTES) {
    throw new FileExceedsCeilingError(sizeBytes);
  }

  const initialVirtualPath = normalizeVirtualPath(options.virtualPath);
  if (initialVirtualPath === '/') {
    throw new UploadValidationError('Upload virtualPath cannot be root "/"');
  }
  for (const segment of initialVirtualPath.split('/').filter(Boolean)) {
    try {
      validateItemName(segment);
    } catch (err) {
      throw new UploadValidationError(err instanceof Error ? err.message : String(err));
    }
  }

  let poolId = options.poolId ?? 1;
  if (options.targetAccountId) {
    const accRow = await db.query.accounts.findFirst({ where: eq(accounts.id, options.targetAccountId) });
    if (accRow) {
      poolId = accRow.poolId;
    }
  }
  if (isSharePoolId(poolId)) {
    throw new SharePoolReadOnlyError('Uploading directly to Share Pool is disabled');
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
    } else if (inFlightUploadPaths.has(`${poolId}:${initialVirtualPath}`)) {
      throw new UploadConflictError(
        `An upload for "${path.posix.basename(initialVirtualPath)}" is already in progress at ${initialVirtualPath}`
      );
    }
  } else if (inFlightUploadPaths.has(`${poolId}:${initialVirtualPath}`)) {
    if (conflictMode === 'keep_both') {
      virtualPath = allocateKeepBothPath(poolId, initialVirtualPath);
    } else {
      throw new UploadConflictError(
        `An upload for "${path.posix.basename(initialVirtualPath)}" is already in progress at ${initialVirtualPath}`
      );
    }
  }

  const inFlightKey = `${poolId}:${virtualPath}`;
  const uploadToken = randomUUID();
  let releaseCapacity: () => void = () => {};
  if (reserveInFlight) {
    inFlightUploadPaths.set(inFlightKey, uploadToken);
  }

  try {
    let accountId: string;
    if (options.targetAccountId) {
      await validateTargetPlacement(options.targetAccountId, sizeBytes, Date.now(), poolId);
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

    if (reserveInFlight) {
      releaseCapacity = reserveAccountCapacity(accountId, sizeBytes);
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
      uploadToken,
      releaseCapacity,
      metadata: {
        name: fileName,
        parents: [remoteParentFolderId],
        appProperties: buildTsubasaAppProperties({
          virtualPath,
          virtualId: fileId,
          checksum: hash,
        }),
      },
    };
  } catch (err) {
    releaseCapacity();
    if (reserveInFlight && inFlightUploadPaths.get(inFlightKey) === uploadToken) {
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
              if (actualBytes > target.sizeBytes || (target.sizeBytes === 0 && actualBytes > 0)) {
                controller.error(
                  new UploadValidationError(
                    `Upload stream exceeded declared sizeBytes (${target.sizeBytes})`
                  )
                );
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
      if (payloadBuffer.byteLength !== target.sizeBytes) {
        throw new UploadValidationError(
          `Upload size mismatch for "${target.virtualPath}": expected ${target.sizeBytes} bytes, received ${payloadBuffer.byteLength}`
        );
      }
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

      try {
        uploadRes = await fetch(uploadLocation, requestInit);
      } catch (err) {
        if (actualBytes > 0) {
          try {
            recordTransferSync(target.accountId, 'upload', actualBytes, Date.now(), target.poolId);
          } catch (logErr) {
            console.warn(`Failed to record aborted resumable upload bytes for ${target.accountId}:`, logErr);
          }
        }
        throw err;
      }
    }

    if (uploadRes.status === 308) {
      if (target.sizeBytes > SMALL_UPLOAD_MULTIPART_BYTES && actualBytes > 0) {
        try {
          recordTransferSync(target.accountId, 'upload', actualBytes, Date.now(), target.poolId);
        } catch (logErr) {
          console.warn(`Failed to record incomplete resumable upload bytes for ${target.accountId}:`, logErr);
        }
      }
      const errText = await uploadRes.text().catch(() => '');
      throw new Error(`Google Drive resumable upload incomplete (308): ${errText}`);
    }

    if (!uploadRes.ok) {
      if (target.sizeBytes > SMALL_UPLOAD_MULTIPART_BYTES && actualBytes > 0) {
        try {
          recordTransferSync(target.accountId, 'upload', actualBytes, Date.now(), target.poolId);
        } catch (logErr) {
          console.warn(`Failed to record failed resumable upload bytes for ${target.accountId}:`, logErr);
        }
      }
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
    if (finalBytes !== target.sizeBytes) {
      throw new UploadValidationError(
        `Upload stream byte count (${finalBytes}) does not match declared sizeBytes (${target.sizeBytes})`
      );
    }
    const resolvedHash = options.hash || driveData.md5Checksum || driveData.sha256Checksum || null;
    const parentDir = path.posix.dirname(target.virtualPath);
    const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(target.poolId, parentDir);

    ensureLocalParentFolders(target.virtualPath, target.poolId);

    sqlite.transaction(() => {
      displaceTrashedFileAtPath(target.poolId, target.virtualPath, { appendShortId: true });

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
            id = excluded.id,
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

      recordTransferSync(target.accountId, 'upload', finalBytes, Date.now(), target.poolId);
    }).immediate();

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
    target.releaseCapacity();
    if (inFlightUploadPaths.get(inFlightKey) === target.uploadToken) {
      inFlightUploadPaths.delete(inFlightKey);
    }
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
    throw new ItemNotFoundError(`Active file not found: ${fileIdOrPath}`);
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

