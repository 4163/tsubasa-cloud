import crypto, { randomUUID } from 'node:crypto';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { bumpPoolRevision, db, sqlite } from '../db/index.js';
import { accounts, files, type FileRecord } from '../db/schema.js';
import {
  FileExceedsCeilingError,
  invalidatePooledStorageOverview,
  MAX_SINGLE_FILE_BYTES,
  recordTransferSync,
  reserveAccountCapacity,
  selectPlacementForFile,
  validateTargetPlacement,
} from '../storage/index.js';
import { normalizeVirtualPath } from '../virtualPath.js';
import { buildTsubasaAppProperties } from './appProperties.js';
import { getAccessToken, getDriveClient } from './client.js';
import { ItemNotFoundError, validateItemName } from './errors.js';
import { normalizeMd5 } from './jobHelpers.js';
import { ensureRemoteFolderHierarchy } from './mirror.js';
import { allocateUniqueVirtualPath, displaceTrashedFileAtPath } from './operationsDb.js';
import { enqueueDriveOutbox } from './outbox.js';
import { deleteRemoteFileIgnoreNotFound } from './outboxExecutors.js';
import { isSharePoolId } from './poolRegistry.js';
import { getAccountRootFolderId } from './remoteTree.js';
import { ensureLocalParentFolders, formatFolderId } from './sync.js';
import {
  SharePoolReadOnlyError,
  UploadConflictError,
  UploadValidationError,
} from './transfer.js';

export const SMALL_UPLOAD_FAST_PATH_BYTES = 5 * 1024 * 1024;
export const CHUNK_ALIGNMENT_BYTES = 256 * 1024;
export const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const MAX_CHUNK_SIZE_BYTES = 32 * 1024 * 1024;
const MAX_AGGREGATE_IN_FLIGHT_CHUNK_BYTES = 32 * 1024 * 1024;

export type ResumableUploadConflictMode = 'reject' | 'replace' | 'keep_both' | 'skip';

export class UploadIntegrityError extends Error {
  readonly code = 'CHECKSUM_MISMATCH' as const;
  constructor(message: string) {
    super(message);
    this.name = 'UploadIntegrityError';
  }
}

export class UploadSessionExpiredError extends Error {
  readonly code = 'UPLOAD_SESSION_EXPIRED' as const;
  readonly jobId: string;
  constructor(jobId: string, message = 'Drive resumable upload session expired; resume to restart from byte 0') {
    super(message);
    this.name = 'UploadSessionExpiredError';
    this.jobId = jobId;
  }
}

export class LocalFileChangedError extends Error {
  readonly code = 'LOCAL_FILE_CHANGED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LocalFileChangedError';
  }
}

export class UploadJobStateError extends Error {
  readonly code = 'JOB_NOT_ACTIVE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'UploadJobStateError';
  }
}

export interface VerifiedSmallUploadOptions {
  virtualPath: string;
  sizeBytes: number;
  mimeType?: string;
  hash?: string;
  targetAccountId?: string;
  poolId?: number;
  conflictMode?: 'reject' | 'replace' | 'keep_both';
}

export interface InitChunkedUploadOptions {
  virtualPath: string;
  sizeBytes: number;
  mimeType?: string;
  poolId?: number;
  targetAccountId?: string;
  localPath?: string;
  mtimeMs?: number;
  chunkSizeBytes?: number;
  conflictMode?: ResumableUploadConflictMode;
  expectedMd5?: string;
}

export interface InitChunkedUploadResult {
  skipped: false;
  jobId: string;
  itemId: string;
  fileId: string;
  status: 'running';
  accountId: string;
  poolId: number;
  virtualPath: string;
  chunkSizeBytes: number;
  offsetBytes: number;
  totalBytes: number;
  conflictMode: ResumableUploadConflictMode;
}

export interface SkippedChunkedUploadResult {
  skipped: true;
  reason: 'conflict_skip';
  existingFileId: string;
  poolId: number;
  virtualPath: string;
}

export interface UploadChunkResult {
  jobId: string;
  status: 'running' | 'completed';
  completed: boolean;
  offsetBytes: number;
  totalBytes: number;
  file?: FileRecord;
}

export interface ProbeUploadResult {
  jobId: string;
  status: 'running' | 'completed';
  offsetBytes: number;
  totalBytes: number;
  sessionRestarted: boolean;
  accountId: string;
  poolId: number;
  virtualPath: string;
  chunkSizeBytes: number;
  file?: FileRecord;
}

interface UploadJobMetadata {
  fileId: string;
  virtualPath: string;
  fileName: string;
  mimeType: string;
  localPath: string | null;
  sizeBytes: number;
  mtimeMs: number | null;
  chunkSizeBytes: number;
  conflictMode: ResumableUploadConflictMode;
  remoteParentFolderId: string;
  driveSessionUri: string;
  expectedMd5: string | null;
}

interface ActiveHashTracker {
  hash: crypto.Hash;
  nextOffset: number;
}

const activeUploadHashes = new Map<string, ActiveHashTracker>();
const inFlightUploadPaths = new Map<string, string>();
const activeUploadReservations = new Map<string, { releaseCapacity: () => void; inFlightKey: string; token: string }>();
const recordedTransferBytesByJob = new Map<string, number>();
const jobChunkChains = new Map<string, Promise<unknown>>();

let inFlightChunkBytesTotal = 0;
const chunkBudgetWaiters: Array<{
  bytes: number;
  resolve: () => void;
  reject: (err: unknown) => void;
  cleanup?: () => void;
}> = [];

const CONTENT_RANGE_RE = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i;
const DRIVE_308_RANGE_RE = /bytes=\d+-(\d+)/i;

function drainChunkBudgetWaiters(): void {
  while (chunkBudgetWaiters.length > 0) {
    const next = chunkBudgetWaiters[0];
    if (inFlightChunkBytesTotal + next.bytes > MAX_AGGREGATE_IN_FLIGHT_CHUNK_BYTES) {
      break;
    }
    chunkBudgetWaiters.shift();
    inFlightChunkBytesTotal += next.bytes;
    next.cleanup?.();
    next.resolve();
  }
}

async function acquireChunkMemoryBudget(chunkBytes: number, signal?: AbortSignal): Promise<() => void> {
  if (chunkBytes <= 0) {
    return () => {};
  }
  if (chunkBytes > MAX_AGGREGATE_IN_FLIGHT_CHUNK_BYTES) {
    throw new UploadValidationError(
      `Chunk size (${chunkBytes} bytes) exceeds aggregate in-flight limit (${MAX_AGGREGATE_IN_FLIGHT_CHUNK_BYTES} bytes)`
    );
  }
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Upload chunk aborted');
  }

  if (
    chunkBudgetWaiters.length === 0 &&
    inFlightChunkBytesTotal + chunkBytes <= MAX_AGGREGATE_IN_FLIGHT_CHUNK_BYTES
  ) {
    inFlightChunkBytesTotal += chunkBytes;
  } else {
    await new Promise<void>((resolve, reject) => {
      const waiter: (typeof chunkBudgetWaiters)[number] = {
        bytes: chunkBytes,
        resolve,
        reject,
      };
      if (signal) {
        const onAbort = () => {
          const idx = chunkBudgetWaiters.indexOf(waiter);
          if (idx !== -1) {
            chunkBudgetWaiters.splice(idx, 1);
          }
          reject(signal.reason ?? new Error('Upload chunk aborted while waiting for memory budget'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      chunkBudgetWaiters.push(waiter);
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlightChunkBytesTotal = Math.max(0, inFlightChunkBytesTotal - chunkBytes);
    drainChunkBudgetWaiters();
  };
}

function serializeJobChunk<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prev = jobChunkChains.get(jobId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.then(
    () => undefined,
    () => undefined
  );
  jobChunkChains.set(jobId, tail);
  tail.finally(() => {
    if (jobChunkChains.get(jobId) === tail) {
      jobChunkChains.delete(jobId);
    }
  });
  return next;
}

function releaseUploadJobResources(jobId: string): void {
  activeUploadHashes.delete(jobId);
  const res = activeUploadReservations.get(jobId);
  if (res) {
    activeUploadReservations.delete(jobId);
    res.releaseCapacity();
    if (inFlightUploadPaths.get(res.inFlightKey) === res.token) {
      inFlightUploadPaths.delete(res.inFlightKey);
    }
  }
}

function recordUnloggedUploadBytes(
  jobId: string,
  accountId: string,
  poolId: number,
  totalUploadedSoFar: number
): void {
  const safeTotal = Math.max(0, Math.round(totalUploadedSoFar));
  const alreadyRecorded = recordedTransferBytesByJob.get(jobId) ?? 0;
  const delta = safeTotal - alreadyRecorded;
  if (delta <= 0) {
    return;
  }
  try {
    recordTransferSync(accountId, 'upload', delta, Date.now(), poolId);
    recordedTransferBytesByJob.set(jobId, alreadyRecorded + delta);
  } catch (err) {
    console.warn(`Failed to record partial upload bytes for job ${jobId} (${accountId}):`, err);
  }
}

function validateUploadPath(rawPath: string): string {
  const normalized = normalizeVirtualPath(rawPath);
  if (normalized === '/') {
    throw new UploadValidationError('Upload virtualPath cannot be root "/"');
  }
  for (const segment of normalized.split('/').filter(Boolean)) {
    try {
      validateItemName(segment);
    } catch (err) {
      throw new UploadValidationError(err instanceof Error ? err.message : String(err));
    }
  }
  return normalized;
}

function allocateKeepBothUploadPath(poolId: number, basePath: string): string {
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
      inFlightUploadPaths.has(`${poolId}:${candidatePath}`) ||
      Boolean(checkActiveStmt.get(poolId, candidatePath)),
  });
}

async function deleteRemoteDriveFileWithFallback(
  accountId: string,
  poolId: number,
  fileId: string,
  driveFileId: string
): Promise<void> {
  try {
    const drive = getDriveClient(accountId);
    await deleteRemoteFileIgnoreNotFound(drive, driveFileId);
  } catch (err) {
    console.warn(`Failed to delete mismatched/aborted Drive file ${driveFileId} on ${accountId}:`, err);
    enqueueDriveOutbox([
      {
        accountId,
        poolId,
        opType: 'file_delete',
        driveFileId,
        payload: { fileId, driveFileId },
      },
    ]);
  }
}

function commitUploadedFileToSqlite(params: {
  fileId: string;
  poolId: number;
  virtualPath: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  resolvedHash: string | null;
  accountId: string;
  driveFileId: string;
  jobId?: string;
  itemId?: string;
  verifiedHash?: string | null;
}): FileRecord {
  const {
    fileId,
    poolId,
    virtualPath,
    fileName,
    sizeBytes,
    mimeType,
    resolvedHash,
    accountId,
    driveFileId,
    jobId,
    itemId,
    verifiedHash,
  } = params;

  const parentDir = path.posix.dirname(virtualPath);
  const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

  ensureLocalParentFolders(virtualPath, poolId);

  sqlite.transaction(() => {
    displaceTrashedFileAtPath(poolId, virtualPath, { appendShortId: true });

    const oldActiveRow = sqlite
      .prepare(
        'SELECT id, account_id, drive_file_id, size_bytes FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0'
      )
      .get(poolId, virtualPath) as
      | { id: string; account_id: string; drive_file_id: string; size_bytes: number }
      | undefined;

    if (oldActiveRow && oldActiveRow.drive_file_id !== driveFileId) {
      enqueueDriveOutbox([
        {
          accountId: oldActiveRow.account_id,
          poolId,
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
        fileId,
        poolId,
        virtualPath,
        fileName,
        sizeBytes,
        mimeType,
        resolvedHash,
        accountId,
        driveFileId,
        folderId
      );

    if (oldActiveRow) {
      if (oldActiveRow.account_id === accountId) {
        const netDelta = sizeBytes - oldActiveRow.size_bytes;
        sqlite
          .prepare('UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes + ?), updated_at = unixepoch() WHERE id = ?')
          .run(netDelta, accountId);
      } else {
        sqlite
          .prepare('UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes - ?), updated_at = unixepoch() WHERE id = ?')
          .run(oldActiveRow.size_bytes, oldActiveRow.account_id);
        sqlite
          .prepare('UPDATE accounts SET quota_used_bytes = quota_used_bytes + ?, updated_at = unixepoch() WHERE id = ?')
          .run(sizeBytes, accountId);
      }
    } else {
      sqlite
        .prepare('UPDATE accounts SET quota_used_bytes = quota_used_bytes + ?, updated_at = unixepoch() WHERE id = ?')
        .run(sizeBytes, accountId);
    }

    const alreadyRecorded = jobId ? (recordedTransferBytesByJob.get(jobId) ?? 0) : 0;
    const remainingToRecord = Math.max(0, sizeBytes - alreadyRecorded);
    if (remainingToRecord > 0) {
      recordTransferSync(accountId, 'upload', remainingToRecord, Date.now(), poolId);
    }

    if (itemId) {
      sqlite
        .prepare(
          `UPDATE transfer_job_items
           SET status = 'completed',
               dest_drive_file_id = ?,
               verified_hash = ?,
               transferred_bytes = ?,
               last_error = NULL,
               updated_at = unixepoch()
           WHERE id = ?`
        )
        .run(driveFileId, verifiedHash ?? resolvedHash, sizeBytes, itemId);
    }

    if (jobId) {
      sqlite
        .prepare(
          `UPDATE transfer_jobs
           SET status = 'completed',
               completed_items = 1,
               failed_items = 0,
               transferred_bytes = ?,
               last_error = NULL,
               completed_at = unixepoch(),
               updated_at = unixepoch()
           WHERE id = ?`
        )
        .run(sizeBytes, jobId);
    }
  }).immediate();

  if (jobId) {
    recordedTransferBytesByJob.delete(jobId);
    releaseUploadJobResources(jobId);
  }

  invalidatePooledStorageOverview(poolId);
  bumpPoolRevision(poolId);

  const saved = sqlite
    .prepare(
      `SELECT
         id,
         pool_id as poolId,
         virtual_path as virtualPath,
         name,
         size_bytes as sizeBytes,
         mime_type as mimeType,
         hash,
         account_id as accountId,
         drive_file_id as driveFileId,
         folder_id as folderId,
         is_trashed as isTrashed,
         trashed_at as trashedAt,
         created_at as createdAt,
         updated_at as updatedAt
       FROM files
       WHERE pool_id = ? AND virtual_path = ?
       LIMIT 1`
    )
    .get(poolId, virtualPath) as
    | {
        id: string;
        poolId: number;
        virtualPath: string;
        name: string;
        sizeBytes: number;
        mimeType: string;
        hash: string | null;
        accountId: string;
        driveFileId: string;
        folderId: string | null;
        isTrashed: number;
        trashedAt: number | null;
        createdAt: number;
        updatedAt: number;
      }
    | undefined;

  if (!saved) {
    throw new Error(`Uploaded file missing from SQLite index: ${virtualPath}`);
  }

  return {
    ...saved,
    isTrashed: Boolean(saved.isTrashed),
    trashedAt: saved.trashedAt !== null ? new Date(saved.trashedAt * 1000) : null,
    createdAt: new Date(saved.createdAt * 1000),
    updatedAt: new Date(saved.updatedAt * 1000),
  };
}

/**
 * Single-shot multipart fast path for files <= 5 MiB with streaming MD5 calculation
 * and Drive md5Checksum verification before any SQLite commit.
 */
export async function executeVerifiedSmallUpload(
  options: VerifiedSmallUploadOptions,
  bodyStream: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal
): Promise<FileRecord> {
  const {
    sizeBytes,
    mimeType = 'application/octet-stream',
    hash,
    conflictMode = 'reject',
  } = options;

  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > SMALL_UPLOAD_FAST_PATH_BYTES) {
    throw new UploadValidationError(
      `Small upload fast path requires 0 <= sizeBytes <= ${SMALL_UPLOAD_FAST_PATH_BYTES}`
    );
  }

  const initialVirtualPath = validateUploadPath(options.virtualPath);
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
    .prepare('SELECT id, account_id, size_bytes FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0')
    .get(poolId, initialVirtualPath) as { id: string; account_id: string; size_bytes: number } | undefined;

  let virtualPath = initialVirtualPath;
  const initialInFlight = inFlightUploadPaths.has(`${poolId}:${initialVirtualPath}`);

  if (existingActive) {
    if (conflictMode === 'reject') {
      throw new UploadConflictError(
        `A file named "${path.posix.basename(initialVirtualPath)}" already exists at ${initialVirtualPath}`
      );
    }
    if (conflictMode === 'keep_both') {
      virtualPath = allocateKeepBothUploadPath(poolId, initialVirtualPath);
    } else if (initialInFlight) {
      throw new UploadConflictError(
        `An upload for "${path.posix.basename(initialVirtualPath)}" is already in progress at ${initialVirtualPath}`
      );
    }
  } else if (initialInFlight) {
    if (conflictMode === 'keep_both') {
      virtualPath = allocateKeepBothUploadPath(poolId, initialVirtualPath);
    } else {
      throw new UploadConflictError(
        `An upload for "${path.posix.basename(initialVirtualPath)}" is already in progress at ${initialVirtualPath}`
      );
    }
  }

  const inFlightKey = `${poolId}:${virtualPath}`;
  const uploadToken = randomUUID();
  inFlightUploadPaths.set(inFlightKey, uploadToken);

  let releaseCapacity: () => void = () => {};

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
        const decision = await selectPlacementForFile({ virtualPath, sizeBytes }, undefined, Date.now(), undefined, poolId);
        accountId = decision.accountId;
      }
    } else {
      const decision = await selectPlacementForFile({ virtualPath, sizeBytes }, undefined, Date.now(), undefined, poolId);
      accountId = decision.accountId;
    }

    releaseCapacity = reserveAccountCapacity(accountId, sizeBytes);

    const md5Hasher = crypto.createHash('md5');
    const chunks: Uint8Array[] = [];
    let actualBytes = 0;

    if (bodyStream) {
      const reader = bodyStream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        actualBytes += value.byteLength;
        if (actualBytes > sizeBytes) {
          await reader.cancel().catch(() => {});
          throw new UploadValidationError(`Upload stream exceeded declared sizeBytes (${sizeBytes})`);
        }
        md5Hasher.update(value);
        chunks.push(value);
      }
    }

    if (actualBytes !== sizeBytes) {
      throw new UploadValidationError(
        `Upload size mismatch for "${virtualPath}": expected ${sizeBytes} bytes, received ${actualBytes}`
      );
    }

    const localMd5 = md5Hasher.digest('hex').toLowerCase();
    const declaredMd5 = normalizeMd5(hash);
    if (declaredMd5 && declaredMd5 !== localMd5) {
      throw new UploadIntegrityError(
        `Uploaded stream MD5 (${localMd5}) does not match declared hash (${declaredMd5})`
      );
    }

    const payloadBuffer = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
    const rootFolderId = await getAccountRootFolderId(accountId);
    const drive = getDriveClient(accountId);
    const remoteParentFolderId = await ensureRemoteFolderHierarchy(drive, rootFolderId, path.posix.dirname(virtualPath));
    const accessToken = await getAccessToken(accountId);
    const fileName = path.posix.basename(virtualPath);
    const fileId = randomUUID();

    const metadata = {
      name: fileName,
      parents: [remoteParentFolderId],
      appProperties: buildTsubasaAppProperties({
        virtualPath,
        virtualId: fileId,
        checksum: hash || localMd5,
      }),
    };

    const boundary = `tsubasa_${randomUUID().replace(/-/g, '')}`;
    const metadataPart =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`;
    const closingPart = `\r\n--${boundary}--`;
    const bodyBuffer = Buffer.concat([
      Buffer.from(metadataPart, 'utf8'),
      payloadBuffer,
      Buffer.from(closingPart, 'utf8'),
    ]);

    const uploadRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,md5Checksum,sha256Checksum',
      {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': String(bodyBuffer.byteLength),
        },
        body: bodyBuffer,
      }
    );

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Google Drive multipart upload failed: ${uploadRes.status} ${errText}`);
    }

    const driveData = (await uploadRes.json()) as {
      id: string;
      name: string;
      size?: string;
      md5Checksum?: string;
      sha256Checksum?: string;
    };

    const driveMd5 = driveData.md5Checksum?.toLowerCase() ?? null;
    const driveSize = driveData.size !== undefined ? Number(driveData.size) : null;

    if ((driveMd5 && driveMd5 !== localMd5) || (driveSize !== null && driveSize !== sizeBytes)) {
      if (sizeBytes > 0) {
        try {
          recordTransferSync(accountId, 'upload', sizeBytes, Date.now(), poolId);
        } catch {
          // Best-effort accounting for discarded upload bytes.
        }
      }
      await deleteRemoteDriveFileWithFallback(accountId, poolId, fileId, driveData.id);
      throw new UploadIntegrityError(
        `Drive checksum/size mismatch for "${virtualPath}": local md5=${localMd5} size=${sizeBytes}, remote md5=${driveMd5} size=${driveSize}`
      );
    }

    const resolvedHash = hash || driveMd5 || localMd5;
    return commitUploadedFileToSqlite({
      fileId,
      poolId,
      virtualPath,
      fileName,
      sizeBytes,
      mimeType,
      resolvedHash,
      accountId,
      driveFileId: driveData.id,
      verifiedHash: driveMd5 ?? localMd5,
    });
  } finally {
    releaseCapacity();
    if (inFlightUploadPaths.get(inFlightKey) === uploadToken) {
      inFlightUploadPaths.delete(inFlightKey);
    }
  }
}

async function openDriveResumableSession(params: {
  accountId: string;
  remoteParentFolderId: string;
  fileName: string;
  fileId: string;
  virtualPath: string;
  sizeBytes: number;
  mimeType: string;
  expectedMd5: string | null;
  signal?: AbortSignal;
}): Promise<string> {
  const accessToken = await getAccessToken(params.accountId);
  const metadata = {
    name: params.fileName,
    parents: [params.remoteParentFolderId],
    appProperties: buildTsubasaAppProperties({
      virtualPath: params.virtualPath,
      virtualId: params.fileId,
      checksum: params.expectedMd5 ?? undefined,
    }),
  };

  const initRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,md5Checksum,sha256Checksum',
    {
      method: 'POST',
      signal: params.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': params.mimeType,
        'X-Upload-Content-Length': String(params.sizeBytes),
      },
      body: JSON.stringify(metadata),
    }
  );

  if (!initRes.ok) {
    const errText = await initRes.text().catch(() => '');
    throw new Error(`Google Drive resumable session init rejected: ${initRes.status} ${errText}`);
  }

  const uploadLocation = initRes.headers.get('Location');
  if (!uploadLocation) {
    throw new Error('Google Drive did not return a resumable upload Location URL');
  }
  return uploadLocation;
}

export async function initChunkedResumableUpload(
  options: InitChunkedUploadOptions
): Promise<InitChunkedUploadResult | SkippedChunkedUploadResult> {
  const {
    sizeBytes,
    mimeType = 'application/octet-stream',
    conflictMode = 'reject',
    localPath = null,
    mtimeMs = null,
    chunkSizeBytes = DEFAULT_CHUNK_SIZE_BYTES,
  } = options;

  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new UploadValidationError(`Invalid upload sizeBytes: ${sizeBytes}`);
  }
  if (sizeBytes > MAX_SINGLE_FILE_BYTES) {
    throw new FileExceedsCeilingError(sizeBytes);
  }
  if (
    !Number.isSafeInteger(chunkSizeBytes) ||
    chunkSizeBytes <= 0 ||
    chunkSizeBytes > MAX_CHUNK_SIZE_BYTES ||
    chunkSizeBytes % CHUNK_ALIGNMENT_BYTES !== 0
  ) {
    throw new UploadValidationError(
      `chunkSizeBytes must be a positive multiple of ${CHUNK_ALIGNMENT_BYTES} bytes up to ${MAX_CHUNK_SIZE_BYTES} bytes`
    );
  }

  const initialVirtualPath = validateUploadPath(options.virtualPath);
  const expectedMd5 = normalizeMd5(options.expectedMd5);

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
    .prepare('SELECT id, account_id, size_bytes FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0')
    .get(poolId, initialVirtualPath) as { id: string; account_id: string; size_bytes: number } | undefined;

  let virtualPath = initialVirtualPath;
  const initialInFlight = inFlightUploadPaths.has(`${poolId}:${initialVirtualPath}`);

  if (existingActive) {
    if (conflictMode === 'skip') {
      return {
        skipped: true,
        reason: 'conflict_skip',
        existingFileId: existingActive.id,
        poolId,
        virtualPath: initialVirtualPath,
      };
    }
    if (conflictMode === 'reject') {
      throw new UploadConflictError(
        `A file named "${path.posix.basename(initialVirtualPath)}" already exists at ${initialVirtualPath}`
      );
    }
    if (conflictMode === 'keep_both') {
      virtualPath = allocateKeepBothUploadPath(poolId, initialVirtualPath);
    } else if (initialInFlight) {
      throw new UploadConflictError(
        `An upload for "${path.posix.basename(initialVirtualPath)}" is already in progress at ${initialVirtualPath}`
      );
    }
  } else if (initialInFlight) {
    if (conflictMode === 'keep_both') {
      virtualPath = allocateKeepBothUploadPath(poolId, initialVirtualPath);
    } else {
      throw new UploadConflictError(
        `An upload for "${path.posix.basename(initialVirtualPath)}" is already in progress at ${initialVirtualPath}`
      );
    }
  }

  const inFlightKey = `${poolId}:${virtualPath}`;
  const jobId = randomUUID();
  inFlightUploadPaths.set(inFlightKey, jobId);

  let releaseCapacity: () => void = () => {};

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
        const decision = await selectPlacementForFile({ virtualPath, sizeBytes }, undefined, Date.now(), undefined, poolId);
        accountId = decision.accountId;
      }
    } else {
      const decision = await selectPlacementForFile({ virtualPath, sizeBytes }, undefined, Date.now(), undefined, poolId);
      accountId = decision.accountId;
    }

    releaseCapacity = reserveAccountCapacity(accountId, sizeBytes);

    const rootFolderId = await getAccountRootFolderId(accountId);
    const drive = getDriveClient(accountId);
    const remoteParentFolderId = await ensureRemoteFolderHierarchy(drive, rootFolderId, path.posix.dirname(virtualPath));
    const fileName = path.posix.basename(virtualPath);
    const fileId = randomUUID();
    const driveSessionUri = await openDriveResumableSession({
      accountId,
      remoteParentFolderId,
      fileName,
      fileId,
      virtualPath,
      sizeBytes,
      mimeType,
      expectedMd5,
    });

    const itemId = randomUUID();
    const metadata: UploadJobMetadata = {
      fileId,
      virtualPath,
      fileName,
      mimeType,
      localPath,
      sizeBytes,
      mtimeMs,
      chunkSizeBytes,
      conflictMode,
      remoteParentFolderId,
      driveSessionUri,
      expectedMd5,
    };

    sqlite.transaction(() => {
      sqlite
        .prepare(
          `INSERT INTO transfer_jobs (
            id, kind, status, pool_id, account_id, conflict_policy, mode,
            total_items, completed_items, failed_items, skipped_items,
            total_bytes, transferred_bytes, metadata_json, created_at, updated_at
          ) VALUES (?, 'upload', 'running', ?, ?, ?, 'chunked', 1, 0, 0, 0, ?, 0, ?, unixepoch(), unixepoch())`
        )
        .run(jobId, poolId, accountId, conflictMode, sizeBytes, JSON.stringify(metadata));

      sqlite
        .prepare(
          `INSERT INTO transfer_job_items (
            id, job_id, status, target_account_id, local_path, virtual_path, file_name,
            mime_type, size_bytes, transferred_bytes, mtime_ms, expected_hash,
            drive_session_uri, transfer_mode, created_at, updated_at
          ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'chunked', unixepoch(), unixepoch())`
        )
        .run(
          itemId,
          jobId,
          accountId,
          localPath,
          virtualPath,
          fileName,
          mimeType,
          sizeBytes,
          mtimeMs,
          expectedMd5,
          driveSessionUri
        );
    }).immediate();

    activeUploadReservations.set(jobId, { releaseCapacity, inFlightKey, token: jobId });
    activeUploadHashes.set(jobId, { hash: crypto.createHash('md5'), nextOffset: 0 });

    return {
      skipped: false,
      jobId,
      itemId,
      fileId,
      status: 'running',
      accountId,
      poolId,
      virtualPath,
      chunkSizeBytes,
      offsetBytes: 0,
      totalBytes: sizeBytes,
      conflictMode,
    };
  } catch (err) {
    releaseCapacity();
    if (inFlightUploadPaths.get(inFlightKey) === jobId) {
      inFlightUploadPaths.delete(inFlightKey);
    }
    throw err;
  }
}

interface LoadedUploadJob {
  jobId: string;
  itemId: string;
  status: string;
  poolId: number;
  accountId: string;
  metadata: UploadJobMetadata;
  transferredBytes: number;
  driveSessionUri: string;
  sizeBytes: number;
  mtimeMs: number | null;
  expectedHash: string | null;
}

function loadUploadJob(jobId: string): LoadedUploadJob {
  const job = sqlite
    .prepare(
      `SELECT id, kind, status, pool_id as poolId, account_id as accountId,
              total_bytes as totalBytes, transferred_bytes as transferredBytes,
              metadata_json as metadataJson
       FROM transfer_jobs
       WHERE id = ? AND kind = 'upload'
       LIMIT 1`
    )
    .get(jobId) as
    | {
        id: string;
        kind: string;
        status: string;
        poolId: number | null;
        accountId: string | null;
        totalBytes: number;
        transferredBytes: number;
        metadataJson: string | null;
      }
    | undefined;

  if (!job) {
    throw new ItemNotFoundError(`Upload transfer job '${jobId}' not found`);
  }

  const item = sqlite
    .prepare(
      `SELECT id, status, target_account_id as targetAccountId, local_path as localPath,
              virtual_path as virtualPath, file_name as fileName, mime_type as mimeType,
              size_bytes as sizeBytes, transferred_bytes as transferredBytes,
              mtime_ms as mtimeMs, expected_hash as expectedHash, drive_session_uri as driveSessionUri
       FROM transfer_job_items
       WHERE job_id = ?
       LIMIT 1`
    )
    .get(jobId) as
    | {
        id: string;
        status: string;
        targetAccountId: string | null;
        localPath: string | null;
        virtualPath: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
        transferredBytes: number;
        mtimeMs: number | null;
        expectedHash: string | null;
        driveSessionUri: string | null;
      }
    | undefined;

  if (!item) {
    throw new ItemNotFoundError(`Upload job '${jobId}' has no item record`);
  }

  let parsedMeta: Partial<UploadJobMetadata> = {};
  if (job.metadataJson) {
    try {
      parsedMeta = JSON.parse(job.metadataJson) as Partial<UploadJobMetadata>;
    } catch {
      parsedMeta = {};
    }
  }

  const accountId = item.targetAccountId || job.accountId;
  const poolId = job.poolId ?? 1;
  const driveSessionUri = item.driveSessionUri || parsedMeta.driveSessionUri;
  if (!accountId || !driveSessionUri) {
    throw new UploadJobStateError(`Upload job '${jobId}' is missing account or Drive session URI`);
  }

  const metadata: UploadJobMetadata = {
    fileId: parsedMeta.fileId || randomUUID(),
    virtualPath: item.virtualPath,
    fileName: item.fileName,
    mimeType: item.mimeType,
    localPath: item.localPath ?? parsedMeta.localPath ?? null,
    sizeBytes: item.sizeBytes,
    mtimeMs: item.mtimeMs ?? parsedMeta.mtimeMs ?? null,
    chunkSizeBytes: parsedMeta.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES,
    conflictMode: parsedMeta.conflictMode ?? 'reject',
    remoteParentFolderId: parsedMeta.remoteParentFolderId ?? '',
    driveSessionUri,
    expectedMd5: item.expectedHash ?? parsedMeta.expectedMd5 ?? null,
  };

  return {
    jobId,
    itemId: item.id,
    status: job.status,
    poolId,
    accountId,
    metadata,
    transferredBytes: item.transferredBytes,
    driveSessionUri,
    sizeBytes: item.sizeBytes,
    mtimeMs: item.mtimeMs,
    expectedHash: item.expectedHash,
  };
}

function parseDrive308Offset(rangeHeader: string | null, fallbackOffset: number): number {
  if (!rangeHeader) {
    return fallbackOffset;
  }
  const match = DRIVE_308_RANGE_RE.exec(rangeHeader);
  if (!match) {
    return fallbackOffset;
  }
  const lastByte = Number(match[1]);
  return Number.isSafeInteger(lastByte) && lastByte >= 0 ? lastByte + 1 : fallbackOffset;
}

function markUploadJobFailed(
  jobId: string,
  itemId: string,
  accountId: string,
  poolId: number,
  uploadedBytesSoFar: number,
  errorMessage: string
): void {
  recordUnloggedUploadBytes(jobId, accountId, poolId, uploadedBytesSoFar);
  recordedTransferBytesByJob.delete(jobId);
  releaseUploadJobResources(jobId);
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE transfer_job_items
         SET status = 'failed', last_error = ?, updated_at = unixepoch()
         WHERE id = ?`
      )
      .run(errorMessage, itemId);
    sqlite
      .prepare(
        `UPDATE transfer_jobs
         SET status = 'failed', failed_items = 1, last_error = ?, updated_at = unixepoch()
         WHERE id = ?`
      )
      .run(errorMessage, jobId);
  }).immediate();
}

async function uploadResumableChunkInternal(params: {
  jobId: string;
  contentRangeHeader: string | null | undefined;
  localMd5Header?: string | null;
  bodyStream: ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
}): Promise<UploadChunkResult> {
  const loaded = loadUploadJob(params.jobId);
  if (loaded.status === 'cancelled') {
    throw new UploadJobStateError(`Upload job '${params.jobId}' has been cancelled`);
  }
  if (loaded.status === 'completed') {
    const existing = await db.query.files.findFirst({
      where: and(eq(files.poolId, loaded.poolId), eq(files.virtualPath, loaded.metadata.virtualPath)),
    });
    return {
      jobId: loaded.jobId,
      status: 'completed',
      completed: true,
      offsetBytes: loaded.sizeBytes,
      totalBytes: loaded.sizeBytes,
      file: existing ?? undefined,
    };
  }
  if (loaded.status === 'failed') {
    throw new UploadJobStateError(`Upload job '${params.jobId}' failed and cannot accept chunks`);
  }

  let start = 0;
  let end = -1;
  let total = loaded.sizeBytes;
  let chunkLength = 0;
  let isFinalChunk = false;

  if (loaded.sizeBytes === 0) {
    isFinalChunk = true;
    chunkLength = 0;
  } else {
    const rawRange = params.contentRangeHeader?.trim();
    if (!rawRange) {
      throw new UploadValidationError('Content-Range header (bytes start-end/total) is required');
    }
    const match = CONTENT_RANGE_RE.exec(rawRange);
    if (!match) {
      throw new UploadValidationError(`Invalid Content-Range header: ${rawRange}`);
    }
    start = Number(match[1]);
    end = Number(match[2]);
    total = Number(match[3]);

    if (total !== loaded.sizeBytes) {
      throw new UploadValidationError(
        `Content-Range total (${total}) does not match job sizeBytes (${loaded.sizeBytes})`
      );
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= total) {
      throw new UploadValidationError(`Invalid byte bounds in Content-Range: ${rawRange}`);
    }

    chunkLength = end - start + 1;
    if (chunkLength > MAX_CHUNK_SIZE_BYTES) {
      throw new UploadValidationError(
        `Chunk size (${chunkLength} bytes) exceeds maximum single-chunk limit of ${MAX_CHUNK_SIZE_BYTES} bytes`
      );
    }
    if (start % CHUNK_ALIGNMENT_BYTES !== 0) {
      throw new UploadValidationError(
        `Chunk start offset (${start}) must align to ${CHUNK_ALIGNMENT_BYTES}-byte boundaries`
      );
    }
    isFinalChunk = end + 1 === total;
    if (!isFinalChunk && chunkLength % CHUNK_ALIGNMENT_BYTES !== 0) {
      throw new UploadValidationError(
        `Non-final chunk size (${chunkLength}) must be a multiple of ${CHUNK_ALIGNMENT_BYTES} bytes`
      );
    }
    if (!params.bodyStream) {
      throw new UploadValidationError('Chunk request body stream is missing');
    }
  }

  const releaseChunkBudget = await acquireChunkMemoryBudget(chunkLength, params.signal);

  try {
    if (start === 0) {
      activeUploadHashes.set(loaded.jobId, { hash: crypto.createHash('md5'), nextOffset: 0 });
    }
    const tracker = activeUploadHashes.get(loaded.jobId);
    const canHashSequentially = Boolean(tracker && tracker.nextOffset === start);
    if (tracker && !canHashSequentially) {
      activeUploadHashes.delete(loaded.jobId);
    }

    let streamedBytes = 0;
    const bodyToSend =
      chunkLength === 0
        ? Buffer.alloc(0)
        : params.bodyStream!.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                streamedBytes += chunk.byteLength;
                if (streamedBytes > chunkLength) {
                  controller.error(
                    new UploadValidationError(
                      `Chunk stream exceeded Content-Range length (${chunkLength} bytes)`
                    )
                  );
                  return;
                }
                if (canHashSequentially && tracker) {
                  tracker.hash.update(chunk);
                }
                controller.enqueue(chunk);
              },
            })
          );

    const accessToken = await getAccessToken(loaded.accountId);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Length': String(chunkLength),
      'Content-Type': loaded.metadata.mimeType,
    };
    if (chunkLength > 0) {
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    }

    const requestInit: RequestInit & { duplex?: string } = {
      method: 'PUT',
      signal: params.signal,
      headers,
      body: bodyToSend,
      ...(chunkLength > 0 ? { duplex: 'half' } : {}),
    };

    let driveRes: Response;
    try {
      driveRes = await fetch(loaded.driveSessionUri, requestInit);
    } catch (err) {
      recordUnloggedUploadBytes(
        loaded.jobId,
        loaded.accountId,
        loaded.poolId,
        Math.max(loaded.transferredBytes, start + streamedBytes)
      );
      throw err;
    }

    if (driveRes.status === 404 || driveRes.status === 410) {
      recordUnloggedUploadBytes(
        loaded.jobId,
        loaded.accountId,
        loaded.poolId,
        Math.max(loaded.transferredBytes, start + streamedBytes)
      );
      releaseUploadJobResources(loaded.jobId);
      sqlite
        .prepare(`UPDATE transfer_jobs SET status = 'paused', pause_reason = 'SESSION_EXPIRED', updated_at = unixepoch() WHERE id = ?`)
        .run(loaded.jobId);
      throw new UploadSessionExpiredError(loaded.jobId);
    }

    if (driveRes.status === 308) {
      if (canHashSequentially && tracker) {
        tracker.nextOffset = end + 1;
      }
      const confirmedOffset = parseDrive308Offset(driveRes.headers.get('Range'), end + 1);
      sqlite.transaction(() => {
        sqlite
          .prepare(
            `UPDATE transfer_job_items SET transferred_bytes = ?, status = 'running', updated_at = unixepoch() WHERE id = ?`
          )
          .run(confirmedOffset, loaded.itemId);
        sqlite
          .prepare(
            `UPDATE transfer_jobs SET transferred_bytes = ?, status = 'running', pause_reason = NULL, updated_at = unixepoch() WHERE id = ?`
          )
          .run(confirmedOffset, loaded.jobId);
      }).immediate();

      return {
        jobId: loaded.jobId,
        status: 'running',
        completed: false,
        offsetBytes: confirmedOffset,
        totalBytes: total,
      };
    }

    if (!driveRes.ok) {
      recordUnloggedUploadBytes(
        loaded.jobId,
        loaded.accountId,
        loaded.poolId,
        Math.max(loaded.transferredBytes, start + streamedBytes)
      );
      const errText = await driveRes.text().catch(() => '');
      throw new Error(`Google Drive chunk upload failed (${driveRes.status}): ${errText}`);
    }

    // Final chunk completed (HTTP 200 or 201)
    const driveData = (await driveRes.json()) as {
      id: string;
      name: string;
      size?: string;
      md5Checksum?: string;
      sha256Checksum?: string;
    };

    if (chunkLength > 0 && streamedBytes !== chunkLength) {
      await deleteRemoteDriveFileWithFallback(loaded.accountId, loaded.poolId, loaded.metadata.fileId, driveData.id);
      const msg = `Chunk byte count mismatch: expected ${chunkLength}, streamed ${streamedBytes}`;
      markUploadJobFailed(
        loaded.jobId,
        loaded.itemId,
        loaded.accountId,
        loaded.poolId,
        Math.max(loaded.transferredBytes, start + streamedBytes),
        msg
      );
      throw new UploadIntegrityError(msg);
    }

    let serverComputedMd5: string | null = null;
    if (canHashSequentially && tracker && (total === 0 || end + 1 === total)) {
      serverComputedMd5 = tracker.hash.digest('hex').toLowerCase();
    }
    activeUploadHashes.delete(loaded.jobId);

    const clientMd5 = normalizeMd5(params.localMd5Header);
    const expectedMd5 = clientMd5 || serverComputedMd5 || normalizeMd5(loaded.expectedHash);
    const driveMd5 = driveData.md5Checksum?.toLowerCase() ?? null;
    const driveSize = driveData.size !== undefined ? Number(driveData.size) : null;

    if (clientMd5 && serverComputedMd5 && clientMd5 !== serverComputedMd5) {
      await deleteRemoteDriveFileWithFallback(loaded.accountId, loaded.poolId, loaded.metadata.fileId, driveData.id);
      const msg = `Client MD5 (${clientMd5}) disagrees with streamed MD5 (${serverComputedMd5}); remote file deleted`;
      markUploadJobFailed(loaded.jobId, loaded.itemId, loaded.accountId, loaded.poolId, total, msg);
      throw new UploadIntegrityError(msg);
    }

    if ((expectedMd5 && driveMd5 && expectedMd5 !== driveMd5) || (driveSize !== null && driveSize !== total)) {
      await deleteRemoteDriveFileWithFallback(loaded.accountId, loaded.poolId, loaded.metadata.fileId, driveData.id);
      const msg = `Drive verification failed for "${loaded.metadata.virtualPath}": expected md5=${expectedMd5} size=${total}, got md5=${driveMd5} size=${driveSize}; remote file deleted`;
      markUploadJobFailed(loaded.jobId, loaded.itemId, loaded.accountId, loaded.poolId, total, msg);
      throw new UploadIntegrityError(msg);
    }

    const resolvedHash = driveMd5 || expectedMd5 || driveData.sha256Checksum || null;
    const savedFile = commitUploadedFileToSqlite({
      fileId: loaded.metadata.fileId,
      poolId: loaded.poolId,
      virtualPath: loaded.metadata.virtualPath,
      fileName: loaded.metadata.fileName,
      sizeBytes: total,
      mimeType: loaded.metadata.mimeType,
      resolvedHash,
      accountId: loaded.accountId,
      driveFileId: driveData.id,
      jobId: loaded.jobId,
      itemId: loaded.itemId,
      verifiedHash: driveMd5 ?? expectedMd5,
    });

    return {
      jobId: loaded.jobId,
      status: 'completed',
      completed: true,
      offsetBytes: total,
      totalBytes: total,
      file: savedFile,
    };
  } finally {
    releaseChunkBudget();
  }
}

export function uploadResumableChunk(params: {
  jobId: string;
  contentRangeHeader: string | null | undefined;
  localMd5Header?: string | null;
  bodyStream: ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
}): Promise<UploadChunkResult> {
  return serializeJobChunk(params.jobId, () => uploadResumableChunkInternal(params));
}

export async function probeOrResumeUploadJob(
  jobId: string,
  verifyLocal?: { localPath?: string; sizeBytes?: number; mtimeMs?: number; localMd5?: string }
): Promise<ProbeUploadResult> {
  const loaded = loadUploadJob(jobId);

  if (loaded.status === 'cancelled') {
    throw new UploadJobStateError(`Upload job '${jobId}' was cancelled and cannot be resumed`);
  }

  if (verifyLocal?.sizeBytes !== undefined && verifyLocal.sizeBytes !== loaded.sizeBytes) {
    throw new LocalFileChangedError(
      `Local file size changed (was ${loaded.sizeBytes}, now ${verifyLocal.sizeBytes}); aborting resume.`
    );
  }
  if (
    verifyLocal?.mtimeMs !== undefined &&
    loaded.mtimeMs !== null &&
    Math.round(verifyLocal.mtimeMs) !== Math.round(loaded.mtimeMs)
  ) {
    throw new LocalFileChangedError(
      `Local file mtimeMs changed (was ${loaded.mtimeMs}, now ${verifyLocal.mtimeMs}); aborting resume.`
    );
  }

  if (loaded.status === 'completed') {
    const existing = await db.query.files.findFirst({
      where: and(eq(files.poolId, loaded.poolId), eq(files.virtualPath, loaded.metadata.virtualPath)),
    });
    return {
      jobId: loaded.jobId,
      status: 'completed',
      offsetBytes: loaded.sizeBytes,
      totalBytes: loaded.sizeBytes,
      sessionRestarted: false,
      accountId: loaded.accountId,
      poolId: loaded.poolId,
      virtualPath: loaded.metadata.virtualPath,
      chunkSizeBytes: loaded.metadata.chunkSizeBytes,
      file: existing ?? undefined,
    };
  }

  const accessToken = await getAccessToken(loaded.accountId);
  const probeRes = await fetch(loaded.driveSessionUri, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Length': '0',
      'Content-Range': `bytes */${loaded.sizeBytes}`,
    },
  });

  if (probeRes.status === 308) {
    const offsetBytes = parseDrive308Offset(probeRes.headers.get('Range'), 0);
    activeUploadHashes.delete(loaded.jobId);
    if (!activeUploadReservations.has(loaded.jobId)) {
      const inFlightKey = `${loaded.poolId}:${loaded.metadata.virtualPath}`;
      const releaseCapacity = reserveAccountCapacity(loaded.accountId, Math.max(0, loaded.sizeBytes - offsetBytes));
      inFlightUploadPaths.set(inFlightKey, loaded.jobId);
      activeUploadReservations.set(loaded.jobId, { releaseCapacity, inFlightKey, token: loaded.jobId });
    }
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `UPDATE transfer_job_items SET transferred_bytes = ?, status = 'running', updated_at = unixepoch() WHERE id = ?`
        )
        .run(offsetBytes, loaded.itemId);
      sqlite
        .prepare(
          `UPDATE transfer_jobs SET transferred_bytes = ?, status = 'running', pause_reason = NULL, updated_at = unixepoch() WHERE id = ?`
        )
        .run(offsetBytes, loaded.jobId);
    }).immediate();

    return {
      jobId: loaded.jobId,
      status: 'running',
      offsetBytes,
      totalBytes: loaded.sizeBytes,
      sessionRestarted: false,
      accountId: loaded.accountId,
      poolId: loaded.poolId,
      virtualPath: loaded.metadata.virtualPath,
      chunkSizeBytes: loaded.metadata.chunkSizeBytes,
    };
  }

  if (probeRes.status === 404 || probeRes.status === 410) {
    recordUnloggedUploadBytes(loaded.jobId, loaded.accountId, loaded.poolId, loaded.transferredBytes);
    recordedTransferBytesByJob.delete(loaded.jobId);
    releaseUploadJobResources(loaded.jobId);

    await validateTargetPlacement(loaded.accountId, loaded.sizeBytes, Date.now(), loaded.poolId);
    const rootFolderId = await getAccountRootFolderId(loaded.accountId);
    const drive = getDriveClient(loaded.accountId);
    const remoteParentFolderId =
      loaded.metadata.remoteParentFolderId ||
      (await ensureRemoteFolderHierarchy(drive, rootFolderId, path.posix.dirname(loaded.metadata.virtualPath)));

    const newSessionUri = await openDriveResumableSession({
      accountId: loaded.accountId,
      remoteParentFolderId,
      fileName: loaded.metadata.fileName,
      fileId: loaded.metadata.fileId,
      virtualPath: loaded.metadata.virtualPath,
      sizeBytes: loaded.sizeBytes,
      mimeType: loaded.metadata.mimeType,
      expectedMd5: loaded.metadata.expectedMd5,
    });

    const updatedMeta: UploadJobMetadata = {
      ...loaded.metadata,
      remoteParentFolderId,
      driveSessionUri: newSessionUri,
    };

    const inFlightKey = `${loaded.poolId}:${loaded.metadata.virtualPath}`;
    const releaseCapacity = reserveAccountCapacity(loaded.accountId, loaded.sizeBytes);
    inFlightUploadPaths.set(inFlightKey, loaded.jobId);
    activeUploadReservations.set(loaded.jobId, { releaseCapacity, inFlightKey, token: loaded.jobId });
    activeUploadHashes.set(loaded.jobId, { hash: crypto.createHash('md5'), nextOffset: 0 });

    sqlite.transaction(() => {
      sqlite
        .prepare(
          `UPDATE transfer_job_items
           SET drive_session_uri = ?, transferred_bytes = 0, status = 'running', last_error = NULL, updated_at = unixepoch()
           WHERE id = ?`
        )
        .run(newSessionUri, loaded.itemId);
      sqlite
        .prepare(
          `UPDATE transfer_jobs
           SET status = 'running', transferred_bytes = 0, failed_items = 0, pause_reason = NULL, last_error = NULL,
               metadata_json = ?, updated_at = unixepoch()
           WHERE id = ?`
        )
        .run(JSON.stringify(updatedMeta), loaded.jobId);
    }).immediate();

    return {
      jobId: loaded.jobId,
      status: 'running',
      offsetBytes: 0,
      totalBytes: loaded.sizeBytes,
      sessionRestarted: true,
      accountId: loaded.accountId,
      poolId: loaded.poolId,
      virtualPath: loaded.metadata.virtualPath,
      chunkSizeBytes: loaded.metadata.chunkSizeBytes,
    };
  }

  if (probeRes.ok) {
    const driveData = (await probeRes.json()) as {
      id: string;
      name: string;
      size?: string;
      md5Checksum?: string;
      sha256Checksum?: string;
    };
    const expectedMd5 = normalizeMd5(verifyLocal?.localMd5) || normalizeMd5(loaded.expectedHash);
    const driveMd5 = driveData.md5Checksum?.toLowerCase() ?? null;
    if (expectedMd5 && driveMd5 && expectedMd5 !== driveMd5) {
      await deleteRemoteDriveFileWithFallback(loaded.accountId, loaded.poolId, loaded.metadata.fileId, driveData.id);
      const msg = `Drive checksum mismatch on completed session probe: expected ${expectedMd5}, got ${driveMd5}`;
      markUploadJobFailed(loaded.jobId, loaded.itemId, loaded.accountId, loaded.poolId, loaded.sizeBytes, msg);
      throw new UploadIntegrityError(msg);
    }

    const savedFile = commitUploadedFileToSqlite({
      fileId: loaded.metadata.fileId,
      poolId: loaded.poolId,
      virtualPath: loaded.metadata.virtualPath,
      fileName: loaded.metadata.fileName,
      sizeBytes: loaded.sizeBytes,
      mimeType: loaded.metadata.mimeType,
      resolvedHash: driveMd5 || expectedMd5 || driveData.sha256Checksum || null,
      accountId: loaded.accountId,
      driveFileId: driveData.id,
      jobId: loaded.jobId,
      itemId: loaded.itemId,
      verifiedHash: driveMd5 ?? expectedMd5,
    });

    return {
      jobId: loaded.jobId,
      status: 'completed',
      offsetBytes: loaded.sizeBytes,
      totalBytes: loaded.sizeBytes,
      sessionRestarted: false,
      accountId: loaded.accountId,
      poolId: loaded.poolId,
      virtualPath: loaded.metadata.virtualPath,
      chunkSizeBytes: loaded.metadata.chunkSizeBytes,
      file: savedFile,
    };
  }

  const errText = await probeRes.text().catch(() => '');
  throw new Error(`Drive upload resume probe failed (${probeRes.status}): ${errText}`);
}

export async function cancelUploadJob(jobId: string): Promise<{ jobId: string; status: 'cancelled' }> {
  const loaded = loadUploadJob(jobId);

  if (loaded.status !== 'completed') {
    recordUnloggedUploadBytes(loaded.jobId, loaded.accountId, loaded.poolId, loaded.transferredBytes);
  }
  recordedTransferBytesByJob.delete(jobId);
  releaseUploadJobResources(jobId);

  if (loaded.status !== 'completed' && loaded.driveSessionUri) {
    try {
      const accessToken = await getAccessToken(loaded.accountId);
      await fetch(loaded.driveSessionUri, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
    } catch {
      // Best-effort abort of Google Drive resumable upload session.
    }
  }

  sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE transfer_job_items
         SET status = 'cancelled', updated_at = unixepoch()
         WHERE job_id = ? AND status NOT IN ('completed', 'skipped')`
      )
      .run(jobId);
    sqlite
      .prepare(
        `UPDATE transfer_jobs
         SET status = 'cancelled', pause_reason = NULL, updated_at = unixepoch()
         WHERE id = ? AND status != 'completed'`
      )
      .run(jobId);
  }).immediate();

  return { jobId, status: 'cancelled' };
}
