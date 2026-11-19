import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { google, type drive_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { bumpPoolRevision, sqlite } from '../db/index.js';
import {
  getEligibleAccounts,
  InsufficientStorageError,
  invalidatePooledStorageOverview,
  MAX_SINGLE_FILE_BYTES,
  recordTransferSync,
  reserveAccountCapacity,
  selectPlacementForFile,
} from '../storage/index.js';
import { normalizeVirtualPath } from '../virtualPath.js';
import { buildTsubasaAppProperties } from './appProperties.js';
import { authPool } from './auth.js';
import { getAccessToken, getDriveClient } from './client.js';
import { invalidateDiscrepancyCache } from './discrepancyCache.js';
import {
  getDriveErrorStatus,
  isDriveNotFoundError,
  ItemNotFoundError,
  withDriveRetry,
} from './errors.js';
import {
  deleteDriveFileWithOutboxFallback,
  incrementTransferJobProgress,
  normalizeMd5,
  reconcileTransferJobCounters,
  revokeJobShares,
  sleepMs,
} from './jobHelpers.js';
import { ensureRemoteFolderHierarchy } from './mirror.js';
import { allocateUniqueVirtualPath, displaceTrashedFileAtPath } from './operationsDb.js';
import { enqueueDriveOutbox } from './outbox.js';
import { isSharePoolId } from './poolRegistry.js';
import { getAccountRootFolderId } from './remoteTree.js';
import { UploadJobStateError } from './resumableUpload.js';
import {
  acquireSourceOAuthClient,
  getSourceTokenPath,
  parseSourceCredentialFile,
  type AcquiredSourceDriveClient,
  type CachedSourceTokenRecord,
  type SourceAuthScopeMode,
} from './sourceAuth.js';
import { ensureLocalParentFolders, formatFolderId } from './sync.js';
import { SharePoolReadOnlyError, UploadValidationError } from './transfer.js';

export const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
export const GOOGLE_WORKSPACE_MIME_PREFIX = 'application/vnd.google-apps.';

export type ImportDriveMode = 'copy' | 'stream';
export type ImportDriveConflictMode = 'skip' | 'reject' | 'replace' | 'keep_both';
export type ImportSkipReason =
  | 'skipped_workspace_doc'
  | 'skipped_shortcut'
  | 'skipped_not_copyable'
  | 'skipped_exceeds_ceiling'
  | 'skipped_conflict';

export interface DiscoveredSourceItem {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  md5Checksum: string | null;
  relativePath: string;
  destVirtualPath: string;
  /** Folder ID used for folder-level temporary reader share, or null for My Drive root loose files. */
  shareScopeFolderId: string | null;
  effectiveMode: ImportDriveMode;
  skipReason: ImportSkipReason | null;
  canCopy: boolean;
  canShare: boolean;
}

export interface ImportDrivePlanOptions {
  folderIdOrUrl: string;
  destPath?: string;
  poolId?: number;
  sourceAuthPath: string;
  mode?: ImportDriveMode;
  conflictMode?: ImportDriveConflictMode;
  noBrowser?: boolean;
  homeDir?: string;
}

export interface ImportDriveStartOptions extends ImportDrivePlanOptions {
  wait?: boolean;
}

export interface ImportDrivePlanSummary {
  sourceFolderId: string;
  isRootTarget: boolean;
  destPath: string;
  poolId: number;
  mode: ImportDriveMode;
  conflictMode: ImportDriveConflictMode;
  sourceEmail: string | null;
  totalDiscovered: number;
  importableCount: number;
  importableBytes: number;
  rootLooseStreamCount: number;
  shareFolderCount: number;
  skipCounts: Record<ImportSkipReason, number>;
  availablePoolHeadroomBytes: number;
  availableDailyBudgetBytes: number;
  hasSufficientHeadroom: boolean;
  dailyCapPauseExpected: boolean;
  items: Array<{
    sourceDriveFileId: string;
    relativePath: string;
    destVirtualPath: string;
    sizeBytes: number;
    md5Checksum: string | null;
    effectiveMode: ImportDriveMode;
    shareScopeFolderId: string | null;
    status: 'import' | ImportSkipReason;
  }>;
}

export interface ImportDriveJobResult {
  jobId: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  poolId: number;
  sourceFolderId: string;
  destPath: string;
  mode: ImportDriveMode;
  conflictMode: ImportDriveConflictMode;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  skippedItems: number;
  totalBytes: number;
  transferredBytes: number;
  pauseReason: string | null;
  lastError: string | null;
  queued: boolean;
}

interface ImportDriveJobMetadata {
  sourceFolderId: string;
  isRootTarget: boolean;
  destPath: string;
  sourceAuthPath: string;
  sourceScopeMode: SourceAuthScopeMode;
  sourceEmail: string | null;
  mode: ImportDriveMode;
  conflictMode: ImportDriveConflictMode;
  homeDir?: string;
  noBrowser?: boolean;
}

const ACL_PROPAGATION_BACKOFF_MS = [300, 800, 1_500, 2_500, 4_000];
const RAW_DRIVE_ID_RE = /^[a-zA-Z0-9_-]{3,200}$/;

const activeImportJobs = new Map<string, Promise<ImportDriveJobResult>>();
const cancelledImportJobs = new Set<string>();

/**
 * Loads a cached external Drive client strictly from disk without ever launching
 * interactive browser OAuth or stdin prompts. Used on job cancellation and startup recovery.
 */
function tryLoadCachedSourceDriveNonInteractive(
  credPath: string | undefined,
  scopeMode: SourceAuthScopeMode = 'drive',
  homeDir?: string
): { drive: drive_v3.Drive | null; reason?: string } {
  if (!credPath) {
    return { drive: null, reason: 'missing source credential path in job metadata' };
  }

  let config: ReturnType<typeof parseSourceCredentialFile>;
  try {
    config = parseSourceCredentialFile(credPath);
  } catch (err) {
    return {
      drive: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const tokenPath = getSourceTokenPath(config.clientId, scopeMode, homeDir);
  if (!fs.existsSync(tokenPath)) {
    return { drive: null, reason: 'no cached source OAuth token on disk' };
  }

  let record: Partial<CachedSourceTokenRecord>;
  try {
    record = JSON.parse(fs.readFileSync(tokenPath, 'utf8')) as Partial<CachedSourceTokenRecord>;
  } catch (err) {
    return {
      drive: null,
      reason: `unreadable cached source token (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  const tokens = record.tokens;
  const hasRefresh = Boolean(tokens?.refresh_token);
  const hasUnexpiredAccess = Boolean(
    tokens?.access_token &&
      typeof tokens.expiry_date === 'number' &&
      tokens.expiry_date > Date.now() + 60_000
  );
  if (!tokens || (!hasRefresh && !hasUnexpiredAccess)) {
    return { drive: null, reason: 'cached source OAuth token is expired and lacks a refresh token' };
  }

  const client = new OAuth2Client(config.clientId, config.clientSecret);
  client.setCredentials(tokens);
  return { drive: google.drive({ version: 'v3', auth: client }) };
}

export function parseDriveFolderIdOrUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new UploadValidationError('Source Drive folder ID or URL is required');
  }

  if (trimmed.toLowerCase() === 'root') {
    return 'root';
  }

  if (/^https?:\/\//i.test(trimmed) || trimmed.includes('drive.google.com')) {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      throw new UploadValidationError(`Invalid Google Drive folder URL: ${input}`);
    }

    if (/\/drive\/(?:u\/\d+\/)?my-drive\/?$/i.test(url.pathname)) {
      return 'root';
    }

    const folderMatch = /\/folders\/([a-zA-Z0-9_-]+)/.exec(url.pathname);
    if (folderMatch?.[1]) {
      return folderMatch[1];
    }

    const idParam = url.searchParams.get('id')?.trim();
    if (idParam && (idParam.toLowerCase() === 'root' || RAW_DRIVE_ID_RE.test(idParam))) {
      return idParam.toLowerCase() === 'root' ? 'root' : idParam;
    }

    throw new UploadValidationError(`Could not extract a Google Drive folder ID from URL: ${input}`);
  }

  if (!RAW_DRIVE_ID_RE.test(trimmed)) {
    throw new UploadValidationError(`Invalid Google Drive folder ID: ${input}`);
  }

  return trimmed;
}

export function classifySourceDriveItem(params: {
  mimeType: string;
  sizeBytes: number;
  canCopy?: boolean;
}): ImportSkipReason | null {
  const { mimeType, sizeBytes, canCopy } = params;
  if (mimeType === GOOGLE_SHORTCUT_MIME) {
    return 'skipped_shortcut';
  }
  if (mimeType.startsWith(GOOGLE_WORKSPACE_MIME_PREFIX) && mimeType !== GOOGLE_FOLDER_MIME) {
    return 'skipped_workspace_doc';
  }
  if (canCopy === false) {
    return 'skipped_not_copyable';
  }
  if (sizeBytes > MAX_SINGLE_FILE_BYTES) {
    return 'skipped_exceeds_ceiling';
  }
  return null;
}

/**
 * Computes folder-level share scope and effective transfer mode for an item.
 * Google Drive forbids permissions.create on My Drive 'root': top-level subfolders
 * get folder-level reader shares while loose files directly under 'root' stream.
 */
export function resolveRootSplitTransferStrategy(params: {
  isRootTarget: boolean;
  requestedMode: ImportDriveMode;
  sourceRootFolderId: string;
  topLevelSubfolderId: string | null;
}): { shareScopeFolderId: string | null; effectiveMode: ImportDriveMode } {
  if (params.requestedMode === 'stream') {
    return { shareScopeFolderId: null, effectiveMode: 'stream' };
  }
  if (params.isRootTarget) {
    if (!params.topLevelSubfolderId) {
      return { shareScopeFolderId: null, effectiveMode: 'stream' };
    }
    return { shareScopeFolderId: params.topLevelSubfolderId, effectiveMode: 'copy' };
  }
  return { shareScopeFolderId: params.sourceRootFolderId, effectiveMode: 'copy' };
}

function sanitizeSegment(rawName: string): string {
  const cleaned = rawName.replace(/[\\/]/g, '_').replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return 'unnamed';
  }
  return cleaned;
}

async function detectIsRootFolder(drive: drive_v3.Drive, folderId: string): Promise<boolean> {
  if (folderId === 'root') {
    return true;
  }
  try {
    const rootRes = await withDriveRetry(() =>
      drive.files.get({
        fileId: 'root',
        fields: 'id',
        supportsAllDrives: true,
      })
    );
    return Boolean(rootRes.data.id && rootRes.data.id === folderId);
  } catch {
    return false;
  }
}

async function listDirectChildren(
  drive: drive_v3.Drive,
  parentId: string
): Promise<drive_v3.Schema$File[]> {
  const results: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;

  do {
    const res = await withDriveRetry(() =>
      drive.files.list({
        q: `'${parentId.replace(/'/g, "\\'")}' in parents and trashed = false`,
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 1000,
        pageToken,
        fields:
          'nextPageToken, files(id, name, mimeType, size, md5Checksum, parents, capabilities(canCopy,canShare), shortcutDetails)',
      })
    );

    const files = res.data.files ?? [];
    for (const f of files) {
      if (f.id && f.name) {
        results.push(f);
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return results;
}

async function scanExternalDriveTree(params: {
  drive: drive_v3.Drive;
  sourceFolderId: string;
  isRootTarget: boolean;
  destBasePath: string;
  poolId: number;
  requestedMode: ImportDriveMode;
  conflictMode: ImportDriveConflictMode;
}): Promise<DiscoveredSourceItem[]> {
  const { drive, sourceFolderId, isRootTarget, destBasePath, poolId, requestedMode, conflictMode } = params;
  const discovered: DiscoveredSourceItem[] = [];
  const visitedFolders = new Set<string>([sourceFolderId]);
  const usedVirtualPaths = new Set<string>();

  const existingFileStmt = sqlite.prepare(
    'SELECT id, hash FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0 LIMIT 1'
  );

  interface QueueEntry {
    folderId: string;
    relativeDir: string;
    topLevelSubfolderId: string | null;
    depth: number;
  }

  const queue: QueueEntry[] = [
    { folderId: sourceFolderId, relativeDir: '', topLevelSubfolderId: null, depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = await listDirectChildren(drive, current.folderId);

    children.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    for (const child of children) {
      const childId = child.id!;
      const safeName = sanitizeSegment(child.name || childId);
      const mimeType = child.mimeType || 'application/octet-stream';
      const relPath = current.relativeDir ? `${current.relativeDir}/${safeName}` : safeName;

      if (mimeType === GOOGLE_FOLDER_MIME) {
        if (!visitedFolders.has(childId)) {
          visitedFolders.add(childId);
          queue.push({
            folderId: childId,
            relativeDir: relPath,
            topLevelSubfolderId: current.depth === 0 ? childId : current.topLevelSubfolderId,
            depth: current.depth + 1,
          });
        }
        continue;
      }

      const parsedSize = child.size !== undefined && child.size !== null ? Number(child.size) : 0;
      const sizeBytes = Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : 0;
      const md5Checksum = normalizeMd5(child.md5Checksum);
      const canCopy = child.capabilities?.canCopy !== false;
      const canShare = child.capabilities?.canShare !== false;

      let destVirtualPath = normalizeVirtualPath(
        destBasePath === '/' ? `/${relPath}` : `${destBasePath}/${relPath}`
      );

      // Deduplicate same-name Drive files inside the same folder cleanly.
      if (usedVirtualPaths.has(destVirtualPath)) {
        destVirtualPath = allocateUniqueVirtualPath({
          targetDir: path.posix.dirname(destVirtualPath),
          baseName: path.posix.basename(destVirtualPath),
          kind: 'file',
          style: 'numbered',
          startCounter: 1,
          isTaken: (cand) => usedVirtualPaths.has(cand),
        });
      }
      usedVirtualPaths.add(destVirtualPath);

      let skipReason = classifySourceDriveItem({ mimeType, sizeBytes, canCopy });

      if (!skipReason) {
        const existing = existingFileStmt.get(poolId, destVirtualPath) as
          | { id: string; hash: string | null }
          | undefined;
        if (existing) {
          if (conflictMode === 'skip') {
            skipReason = 'skipped_conflict';
          } else if (conflictMode === 'keep_both') {
            destVirtualPath = allocateUniqueVirtualPath({
              targetDir: path.posix.dirname(destVirtualPath),
              baseName: path.posix.basename(destVirtualPath),
              kind: 'file',
              style: 'numbered',
              startCounter: 1,
              isTaken: (cand) =>
                usedVirtualPaths.has(cand) || Boolean(existingFileStmt.get(poolId, cand)),
            });
            usedVirtualPaths.add(destVirtualPath);
          }
        }
      }

      const { shareScopeFolderId, effectiveMode } = resolveRootSplitTransferStrategy({
        isRootTarget,
        requestedMode,
        sourceRootFolderId: sourceFolderId,
        topLevelSubfolderId: current.topLevelSubfolderId,
      });

      discovered.push({
        id: childId,
        name: path.posix.basename(destVirtualPath),
        mimeType,
        sizeBytes,
        md5Checksum,
        relativePath: relPath,
        destVirtualPath,
        shareScopeFolderId,
        effectiveMode,
        skipReason,
        canCopy,
        canShare,
      });
    }
  }

  return discovered;
}

export async function planImportDrive(
  options: ImportDrivePlanOptions
): Promise<ImportDrivePlanSummary> {
  const poolId = options.poolId ?? 1;
  if (isSharePoolId(poolId)) {
    throw new SharePoolReadOnlyError('Importing directly into Share Pool is disabled');
  }

  const sourceFolderId = parseDriveFolderIdOrUrl(options.folderIdOrUrl);
  const destPath = normalizeVirtualPath(options.destPath || '/');
  const mode: ImportDriveMode = options.mode ?? 'copy';
  const conflictMode: ImportDriveConflictMode = options.conflictMode ?? 'skip';
  const scopeMode: SourceAuthScopeMode = mode === 'stream' ? 'drive.readonly' : 'drive';

  const sourceAuth = await acquireSourceOAuthClient({
    credPath: options.sourceAuthPath,
    scopeMode,
    noBrowser: options.noBrowser,
    homeDir: options.homeDir,
  });

  const isRootTarget = await detectIsRootFolder(sourceAuth.drive, sourceFolderId);
  const discovered = await scanExternalDriveTree({
    drive: sourceAuth.drive,
    sourceFolderId,
    isRootTarget,
    destBasePath: destPath,
    poolId,
    requestedMode: mode,
    conflictMode,
  });

  const skipCounts: Record<ImportSkipReason, number> = {
    skipped_workspace_doc: 0,
    skipped_shortcut: 0,
    skipped_not_copyable: 0,
    skipped_exceeds_ceiling: 0,
    skipped_conflict: 0,
  };

  let importableCount = 0;
  let importableBytes = 0;
  let rootLooseStreamCount = 0;
  const shareFolders = new Set<string>();

  for (const item of discovered) {
    if (item.skipReason) {
      skipCounts[item.skipReason] += 1;
      continue;
    }
    importableCount += 1;
    importableBytes += item.sizeBytes;
    if (item.effectiveMode === 'stream' && isRootTarget && !item.shareScopeFolderId) {
      rootLooseStreamCount += 1;
    }
    if (item.shareScopeFolderId) {
      shareFolders.add(item.shareScopeFolderId);
    }
  }

  const eligible = await getEligibleAccounts(poolId);
  const availablePoolHeadroomBytes = eligible.reduce((sum, acc) => sum + acc.headroomBytes, 0);
  const availableDailyBudgetBytes = eligible.reduce(
    (sum, acc) => sum + acc.transferStats.remainingUploadBytes24h,
    0
  );

  return {
    sourceFolderId,
    isRootTarget,
    destPath,
    poolId,
    mode,
    conflictMode,
    sourceEmail: sourceAuth.email,
    totalDiscovered: discovered.length,
    importableCount,
    importableBytes,
    rootLooseStreamCount,
    shareFolderCount: shareFolders.size,
    skipCounts,
    availablePoolHeadroomBytes,
    availableDailyBudgetBytes,
    hasSufficientHeadroom: availablePoolHeadroomBytes >= importableBytes,
    dailyCapPauseExpected: importableBytes > availableDailyBudgetBytes,
    items: discovered.map((item) => ({
      sourceDriveFileId: item.id,
      relativePath: item.relativePath,
      destVirtualPath: item.destVirtualPath,
      sizeBytes: item.sizeBytes,
      md5Checksum: item.md5Checksum,
      effectiveMode: item.effectiveMode,
      shareScopeFolderId: item.shareScopeFolderId,
      status: item.skipReason ?? 'import',
    })),
  };
}

export async function revokeExternalImportJobShares(
  jobId: string,
  sourceDrive: drive_v3.Drive | null
): Promise<{ revokedCount: number; failedCount: number }> {
  const shares = sqlite
    .prepare(
      `SELECT source_folder_id as sourceFolderId,
              target_account_id as targetAccountId,
              permission_id as permissionId
       FROM transfer_job_shares
       WHERE job_id = ? AND revoked_at IS NULL`
    )
    .all(jobId) as Array<{
    sourceFolderId: string;
    targetAccountId: string;
    permissionId: string;
  }>;

  if (shares.length === 0) {
    return { revokedCount: 0, failedCount: 0 };
  }

  if (!sourceDrive) {
    return { revokedCount: 0, failedCount: shares.length };
  }

  let revokedCount = 0;
  let failedCount = 0;
  const markRevokedStmt = sqlite.prepare(
    `UPDATE transfer_job_shares
     SET revoked_at = unixepoch()
     WHERE job_id = ? AND source_folder_id = ? AND target_account_id = ? AND permission_id = ?`
  );

  for (const share of shares) {
    try {
      await withDriveRetry(() =>
        sourceDrive.permissions.delete({
          fileId: share.sourceFolderId,
          permissionId: share.permissionId,
          supportsAllDrives: true,
        })
      );
      markRevokedStmt.run(jobId, share.sourceFolderId, share.targetAccountId, share.permissionId);
      revokedCount += 1;
    } catch (err) {
      if (isDriveNotFoundError(err)) {
        markRevokedStmt.run(jobId, share.sourceFolderId, share.targetAccountId, share.permissionId);
        revokedCount += 1;
      } else {
        failedCount += 1;
        console.warn(
          `Failed to revoke external import permission ${share.permissionId} on folder ${share.sourceFolderId} (job ${jobId}):`,
          err
        );
      }
    }
  }

  return { revokedCount, failedCount };
}

async function ensureExternalFolderShare(params: {
  jobId: string;
  sourceDrive: drive_v3.Drive;
  sourceFolderId: string;
  targetAccountId: string;
  targetAccountEmail: string;
}): Promise<string> {
  const existing = sqlite
    .prepare(
      `SELECT permission_id as permissionId
       FROM transfer_job_shares
       WHERE job_id = ? AND source_folder_id = ? AND target_account_id = ? AND revoked_at IS NULL
       LIMIT 1`
    )
    .get(params.jobId, params.sourceFolderId, params.targetAccountId) as
    | { permissionId: string }
    | undefined;

  if (existing) {
    return existing.permissionId;
  }

  const shareRes = await withDriveRetry(() =>
    params.sourceDrive.permissions.create({
      fileId: params.sourceFolderId,
      sendNotificationEmail: false,
      supportsAllDrives: true,
      requestBody: {
        role: 'reader',
        type: 'user',
        emailAddress: params.targetAccountEmail,
      },
    })
  );

  const permissionId = shareRes.data.id;
  if (!permissionId) {
    throw new Error(`Google Drive did not return permission ID for folder ${params.sourceFolderId}`);
  }

  sqlite
    .prepare(
      `INSERT OR IGNORE INTO transfer_job_shares (
        job_id, source_folder_id, target_account_id, permission_id, source_account_id, created_at
      ) VALUES (?, ?, ?, ?, NULL, unixepoch())`
    )
    .run(params.jobId, params.sourceFolderId, params.targetAccountId, permissionId);

  return permissionId;
}

async function copyExternalFileWithAclBackoff(params: {
  driveTarget: drive_v3.Drive;
  sourceDriveFileId: string;
  targetRemoteFolderId: string;
  destFileName: string;
  appProperties: Record<string, string>;
}): Promise<{ id: string; size: number | null; md5Checksum: string | null }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= ACL_PROPAGATION_BACKOFF_MS.length; attempt += 1) {
    try {
      const res = await withDriveRetry(() =>
        params.driveTarget.files.copy({
          fileId: params.sourceDriveFileId,
          supportsAllDrives: true,
          fields: 'id, name, size, md5Checksum',
          requestBody: {
            name: params.destFileName,
            parents: [params.targetRemoteFolderId],
            appProperties: params.appProperties,
          },
        })
      );
      const id = res.data.id;
      if (!id) {
        throw new Error('External Drive copy returned empty file ID');
      }
      const parsedSize = res.data.size !== undefined && res.data.size !== null ? Number(res.data.size) : null;
      return {
        id,
        size: parsedSize !== null && Number.isFinite(parsedSize) ? parsedSize : null,
        md5Checksum: res.data.md5Checksum ? res.data.md5Checksum.toLowerCase() : null,
      };
    } catch (err) {
      lastErr = err;
      if (getDriveErrorStatus(err) === 404 && attempt < ACL_PROPAGATION_BACKOFF_MS.length) {
        await sleepMs(ACL_PROPAGATION_BACKOFF_MS[attempt]);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Zero-copy Web Streams pipeline from external Drive source to target Drive resumable upload,
 * computing MD5 incrementally with < 50 MB RAM regardless of file size.
 */
async function streamExternalFileToTarget(params: {
  sourceAuth: AcquiredSourceDriveClient;
  sourceDriveFileId: string;
  targetAccountId: string;
  poolId: number;
  targetRemoteFolderId: string;
  destFileName: string;
  mimeType: string;
  sizeBytes: number;
  appProperties: Record<string, string>;
}): Promise<{ id: string; size: number | null; md5Checksum: string | null; streamedMd5: string; streamedBytes: number }> {
  const sourceTokenRes = await params.sourceAuth.client.getAccessToken();
  const sourceAccessToken = sourceTokenRes.token;
  if (!sourceAccessToken) {
    throw new Error('Failed to obtain source Drive access token for streaming import');
  }

  const targetAccessToken = await getAccessToken(params.targetAccountId);

  // Initiate target Drive resumable upload session.
  const initRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,md5Checksum',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${targetAccessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': params.mimeType,
        'X-Upload-Content-Length': String(params.sizeBytes),
      },
      body: JSON.stringify({
        name: params.destFileName,
        parents: [params.targetRemoteFolderId],
        appProperties: params.appProperties,
      }),
    }
  );

  if (!initRes.ok) {
    const errText = await initRes.text().catch(() => '');
    throw new Error(`Target Drive resumable init failed (${initRes.status}): ${errText}`);
  }
  const uploadLocation = initRes.headers.get('Location');
  if (!uploadLocation) {
    throw new Error('Target Drive did not return resumable upload Location header');
  }

  const md5Hasher = crypto.createHash('md5');
  let streamedBytes = 0;

  if (params.sizeBytes === 0) {
    const emptyRes = await fetch(uploadLocation, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${targetAccessToken}`,
        'Content-Length': '0',
        'Content-Type': params.mimeType,
      },
      body: Buffer.alloc(0),
    });
    if (!emptyRes.ok) {
      const errText = await emptyRes.text().catch(() => '');
      throw new Error(`Target Drive 0-byte upload failed (${emptyRes.status}): ${errText}`);
    }
    const driveData = (await emptyRes.json()) as { id: string; size?: string; md5Checksum?: string };
    return {
      id: driveData.id,
      size: driveData.size !== undefined ? Number(driveData.size) : 0,
      md5Checksum: driveData.md5Checksum ? driveData.md5Checksum.toLowerCase() : null,
      streamedMd5: md5Hasher.digest('hex').toLowerCase(),
      streamedBytes: 0,
    };
  }

  const sourceRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(params.sourceDriveFileId)}?alt=media&supportsAllDrives=true`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sourceAccessToken}`,
      },
    }
  );

  if (!sourceRes.ok || !sourceRes.body) {
    await sourceRes.body?.cancel().catch(() => {});
    throw new Error(`Source Drive download failed (${sourceRes.status}) for ${params.sourceDriveFileId}`);
  }

  const hashedStream = sourceRes.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        streamedBytes += chunk.byteLength;
        if (streamedBytes > params.sizeBytes) {
          controller.error(
            new UploadValidationError(
              `Source Drive stream exceeded expected size (${streamedBytes} > ${params.sizeBytes} bytes)`
            )
          );
          return;
        }
        md5Hasher.update(chunk);
        controller.enqueue(chunk);
      },
    })
  );

  const uploadInit: RequestInit & { duplex?: string } = {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${targetAccessToken}`,
      'Content-Length': String(params.sizeBytes),
      'Content-Type': params.mimeType,
    },
    duplex: 'half',
    body: hashedStream,
  };

  let uploadRes: Response;
  try {
    uploadRes = await fetch(uploadLocation, uploadInit);
  } catch (err) {
    await sourceRes.body.cancel().catch(() => {});
    if (streamedBytes > 0) {
      recordTransferSync(params.targetAccountId, 'upload', streamedBytes, Date.now(), params.poolId);
    }
    const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
    if (cause instanceof Error) {
      throw cause;
    }
    throw err;
  }

  if (!uploadRes.ok) {
    await sourceRes.body.cancel().catch(() => {});
    if (streamedBytes > 0) {
      recordTransferSync(params.targetAccountId, 'upload', streamedBytes, Date.now(), params.poolId);
    }
    const errText = await uploadRes.text().catch(() => '');
    throw new Error(`Target Drive streaming upload failed (${uploadRes.status}): ${errText}`);
  }

  const driveData = (await uploadRes.json()) as { id: string; size?: string; md5Checksum?: string };
  return {
    id: driveData.id,
    size: driveData.size !== undefined ? Number(driveData.size) : null,
    md5Checksum: driveData.md5Checksum ? driveData.md5Checksum.toLowerCase() : null,
    streamedMd5: md5Hasher.digest('hex').toLowerCase(),
    streamedBytes,
  };
}

function readImportJobResult(jobId: string, queued = false): ImportDriveJobResult {
  const row = sqlite
    .prepare(
      `SELECT id, status, pool_id as poolId, conflict_policy as conflictPolicy, mode,
              total_items as totalItems, completed_items as completedItems,
              failed_items as failedItems, skipped_items as skippedItems,
              total_bytes as totalBytes, transferred_bytes as transferredBytes,
              pause_reason as pauseReason, last_error as lastError, metadata_json as metadataJson
       FROM transfer_jobs
       WHERE id = ? AND kind = 'import_drive'
       LIMIT 1`
    )
    .get(jobId) as
    | {
        id: string;
        status: ImportDriveJobResult['status'];
        poolId: number | null;
        conflictPolicy: ImportDriveConflictMode;
        mode: ImportDriveMode | null;
        totalItems: number;
        completedItems: number;
        failedItems: number;
        skippedItems: number;
        totalBytes: number;
        transferredBytes: number;
        pauseReason: string | null;
        lastError: string | null;
        metadataJson: string | null;
      }
    | undefined;

  if (!row) {
    throw new ItemNotFoundError(`Import job '${jobId}' not found`);
  }

  let meta: Partial<ImportDriveJobMetadata> = {};
  if (row.metadataJson) {
    try {
      meta = JSON.parse(row.metadataJson) as Partial<ImportDriveJobMetadata>;
    } catch {
      meta = {};
    }
  }

  return {
    jobId: row.id,
    status: row.status,
    poolId: row.poolId ?? 1,
    sourceFolderId: meta.sourceFolderId ?? '',
    destPath: meta.destPath ?? '/',
    mode: row.mode ?? meta.mode ?? 'copy',
    conflictMode: row.conflictPolicy ?? meta.conflictMode ?? 'skip',
    totalItems: row.totalItems,
    completedItems: row.completedItems,
    failedItems: row.failedItems,
    skippedItems: row.skippedItems,
    totalBytes: row.totalBytes,
    transferredBytes: row.transferredBytes,
    pauseReason: row.pauseReason,
    lastError: row.lastError,
    queued,
  };
}

function unwrapErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) {
    if (!err.message || err.message === 'fetch failed') {
      return unwrapErrorMessage(cause);
    }
    if (!err.message.includes(cause.message)) {
      return `${err.message}: ${unwrapErrorMessage(cause)}`;
    }
  }
  return err.message;
}

function isDailyTransferCapError(err: unknown): boolean {
  if (!(err instanceof InsufficientStorageError)) {
    return false;
  }
  const msg = err.message.toLowerCase();
  return msg.includes('750 gb') || msg.includes('daily transfer quota');
}

async function executeImportDriveJobInternal(
  jobId: string,
  preAcquiredSourceAuth?: AcquiredSourceDriveClient
): Promise<ImportDriveJobResult> {
  const job = sqlite
    .prepare(
      `SELECT id, pool_id as poolId, conflict_policy as conflictPolicy, mode, metadata_json as metadataJson
       FROM transfer_jobs
       WHERE id = ? AND kind = 'import_drive'
       LIMIT 1`
    )
    .get(jobId) as
    | {
        id: string;
        poolId: number | null;
        conflictPolicy: ImportDriveConflictMode;
        mode: ImportDriveMode | null;
        metadataJson: string | null;
      }
    | undefined;

  if (!job) {
    throw new ItemNotFoundError(`Import job '${jobId}' not found`);
  }

  const meta = job.metadataJson
    ? (JSON.parse(job.metadataJson) as ImportDriveJobMetadata)
    : null;
  if (!meta) {
    throw new Error(`Import job '${jobId}' is missing metadata_json`);
  }

  const poolId = job.poolId ?? 1;
  const sourceAuth =
    preAcquiredSourceAuth ??
    (await acquireSourceOAuthClient({
      credPath: meta.sourceAuthPath,
      scopeMode: meta.sourceScopeMode,
      noBrowser: meta.noBrowser,
      homeDir: meta.homeDir,
    }));

  // Crash recovery: revoke any stale unrevoked shares from an interrupted previous run before starting.
  await revokeExternalImportJobShares(jobId, sourceAuth.drive);

  const accountEmailMap = new Map<string, string>();
  const allAccounts = sqlite.prepare('SELECT id, email FROM accounts').all() as Array<{ id: string; email: string }>;
  for (const acc of allAccounts) {
    accountEmailMap.set(acc.id, acc.email);
  }

  const pendingItems = sqlite
    .prepare(
      `SELECT id, source_drive_file_id as sourceDriveFileId, source_parent_id as shareScopeFolderId,
              virtual_path as destVirtualPath, file_name as fileName, mime_type as mimeType,
              size_bytes as sizeBytes, expected_hash as expectedHash, transfer_mode as transferMode
       FROM transfer_job_items
       WHERE job_id = ? AND status IN ('pending', 'running')
       ORDER BY rowid ASC`
    )
    .all(jobId) as Array<{
    id: string;
    sourceDriveFileId: string;
    shareScopeFolderId: string | null;
    destVirtualPath: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    expectedHash: string | null;
    transferMode: ImportDriveMode | null;
  }>;

  const streamFallbackFolders = new Set<string>();
  const touchedAccounts = new Set<string>();
  let pausedForDailyCap = false;
  let pauseMessage: string | null = null;
  let fatalError: string | null = null;
  let shareRevokeWarning: string | null = null;

  try {
    for (const item of pendingItems) {
      if (cancelledImportJobs.has(jobId)) {
        break;
      }

      // Check conflict policy dynamically in case target changed since scan.
      const existingActive = sqlite
        .prepare('SELECT id, account_id as accountId, drive_file_id as driveFileId, size_bytes as sizeBytes, hash FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0 LIMIT 1')
        .get(poolId, item.destVirtualPath) as
        | { id: string; accountId: string; driveFileId: string; sizeBytes: number; hash: string | null }
        | undefined;

      if (existingActive) {
        if (meta.conflictMode === 'skip') {
          sqlite.transaction(() => {
            sqlite
              .prepare(
                `UPDATE transfer_job_items
                 SET status = 'skipped', skip_reason = 'skipped_conflict', updated_at = unixepoch()
                 WHERE id = ?`
              )
              .run(item.id);
            incrementTransferJobProgress(jobId, { skippedDelta: 1 });
          }).immediate();
          continue;
        }
        if (meta.conflictMode === 'reject') {
          const msg = `Destination path already exists: ${item.destVirtualPath}`;
          fatalError = fatalError ?? msg;
          sqlite.transaction(() => {
            sqlite
              .prepare(
                `UPDATE transfer_job_items SET status = 'failed', last_error = ?, updated_at = unixepoch() WHERE id = ?`
              )
              .run(msg, item.id);
            incrementTransferJobProgress(jobId, { failedDelta: 1 });
          }).immediate();
          continue;
        }
      }

      let targetAccountId: string;
      try {
        const decision = await selectPlacementForFile(
          { virtualPath: item.destVirtualPath, sizeBytes: item.sizeBytes },
          undefined,
          Date.now(),
          undefined,
          poolId
        );
        targetAccountId = decision.accountId;
      } catch (placeErr) {
        if (isDailyTransferCapError(placeErr)) {
          pausedForDailyCap = true;
          pauseMessage =
            'Paused: 750 GB 24-hour rolling upload cap reached across eligible accounts. Resume later with `tsubasa job resume`.';
          break;
        }
        const msg = placeErr instanceof Error ? placeErr.message : String(placeErr);
        fatalError = fatalError ?? msg;
        sqlite.transaction(() => {
          sqlite
            .prepare(
              `UPDATE transfer_job_items SET status = 'failed', last_error = ?, updated_at = unixepoch() WHERE id = ?`
            )
            .run(msg, item.id);
          incrementTransferJobProgress(jobId, { failedDelta: 1 });
        }).immediate();
        continue;
      }

      const releaseCapacity = reserveAccountCapacity(targetAccountId, item.sizeBytes);
      sqlite
        .prepare(
          `UPDATE transfer_job_items
           SET status = 'running', target_account_id = ?, attempts = attempts + 1, updated_at = unixepoch()
           WHERE id = ?`
        )
        .run(targetAccountId, item.id);

      try {
        const driveTarget = getDriveClient(targetAccountId);
        const targetRootFolderId = await getAccountRootFolderId(targetAccountId);
        const destParentDir = path.posix.dirname(item.destVirtualPath);
        const destFileName = path.posix.basename(item.destVirtualPath);
        const targetRemoteFolderId = await ensureRemoteFolderHierarchy(
          driveTarget,
          targetRootFolderId,
          destParentDir
        );

        const fileId = randomUUID();
        const appProperties = buildTsubasaAppProperties({
          virtualPath: item.destVirtualPath,
          virtualId: fileId,
          checksum: item.expectedHash ?? undefined,
          includeChecksum: Boolean(item.expectedHash),
        });

        let useStream =
          meta.mode === 'stream' ||
          item.transferMode === 'stream' ||
          !item.shareScopeFolderId ||
          streamFallbackFolders.has(item.shareScopeFolderId);

        if (!useStream && item.shareScopeFolderId) {
          const targetEmail = accountEmailMap.get(targetAccountId);
          if (!targetEmail) {
            useStream = true;
          } else {
            try {
              await ensureExternalFolderShare({
                jobId,
                sourceDrive: sourceAuth.drive,
                sourceFolderId: item.shareScopeFolderId,
                targetAccountId,
                targetAccountEmail: targetEmail,
              });
            } catch (shareErr) {
              const status = getDriveErrorStatus(shareErr);
              if (status === 403 || status === 400) {
                // writersCanShare=false, non-owned Shared-with-me tree, or non-shareable folder: fall back to stream.
                streamFallbackFolders.add(item.shareScopeFolderId);
                useStream = true;
              } else {
                throw shareErr;
              }
            }
          }
        }

        let transferred: {
          id: string;
          size: number | null;
          md5Checksum: string | null;
          streamedMd5?: string;
          streamedBytes?: number;
        };

        if (useStream) {
          transferred = await streamExternalFileToTarget({
            sourceAuth,
            sourceDriveFileId: item.sourceDriveFileId,
            targetAccountId,
            poolId,
            targetRemoteFolderId,
            destFileName,
            mimeType: item.mimeType,
            sizeBytes: item.sizeBytes,
            appProperties,
          });
        } else {
          transferred = await copyExternalFileWithAclBackoff({
            driveTarget,
            sourceDriveFileId: item.sourceDriveFileId,
            targetRemoteFolderId,
            destFileName,
            appProperties,
          });
        }

        const expectedMd5 = normalizeMd5(item.expectedHash) ?? transferred.streamedMd5 ?? null;
        const actualSize = transferred.size ?? transferred.streamedBytes ?? null;

        if (
          (expectedMd5 && transferred.md5Checksum && transferred.md5Checksum !== expectedMd5) ||
          (actualSize !== null && actualSize !== item.sizeBytes)
        ) {
          const uploadedBytes = transferred.streamedBytes ?? actualSize ?? item.sizeBytes;
          if (uploadedBytes > 0) {
            recordTransferSync(targetAccountId, 'upload', uploadedBytes, Date.now(), poolId);
          }
          await deleteDriveFileWithOutboxFallback(driveTarget, {
            accountId: targetAccountId,
            poolId,
            fileId,
            driveFileId: transferred.id,
            contextLabel: 'import verification cleanup',
          });
          throw new Error(
            `Import verification failed for "${item.destVirtualPath}": expected md5=${expectedMd5} size=${item.sizeBytes}, got md5=${transferred.md5Checksum} size=${actualSize}`
          );
        }

        const resolvedHash = transferred.md5Checksum ?? expectedMd5;
        const destFolderId =
          destParentDir === '/' || destParentDir === '.' ? null : formatFolderId(poolId, destParentDir);
        ensureLocalParentFolders(item.destVirtualPath, poolId);

        sqlite.transaction(() => {
          displaceTrashedFileAtPath(poolId, item.destVirtualPath, { appendShortId: true });

          const oldActive = sqlite
            .prepare(
              'SELECT id, account_id as accountId, drive_file_id as driveFileId, size_bytes as sizeBytes FROM files WHERE pool_id = ? AND virtual_path = ? AND is_trashed = 0 LIMIT 1'
            )
            .get(poolId, item.destVirtualPath) as
            | { id: string; accountId: string; driveFileId: string; sizeBytes: number }
            | undefined;

          if (oldActive && oldActive.driveFileId !== transferred.id) {
            enqueueDriveOutbox([
              {
                accountId: oldActive.accountId,
                poolId,
                opType: 'file_delete',
                driveFileId: oldActive.driveFileId,
                payload: { fileId: oldActive.id, driveFileId: oldActive.driveFileId },
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
              item.destVirtualPath,
              destFileName,
              item.sizeBytes,
              item.mimeType,
              resolvedHash,
              targetAccountId,
              transferred.id,
              destFolderId
            );

          if (oldActive) {
            if (oldActive.accountId === targetAccountId) {
              sqlite
                .prepare(
                  'UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes + ?), updated_at = unixepoch() WHERE id = ?'
                )
                .run(item.sizeBytes - oldActive.sizeBytes, targetAccountId);
            } else {
              sqlite
                .prepare(
                  'UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes - ?), updated_at = unixepoch() WHERE id = ?'
                )
                .run(oldActive.sizeBytes, oldActive.accountId);
              sqlite
                .prepare(
                  'UPDATE accounts SET quota_used_bytes = quota_used_bytes + ?, updated_at = unixepoch() WHERE id = ?'
                )
                .run(item.sizeBytes, targetAccountId);
            }
          } else {
            sqlite
              .prepare(
                'UPDATE accounts SET quota_used_bytes = quota_used_bytes + ?, updated_at = unixepoch() WHERE id = ?'
              )
              .run(item.sizeBytes, targetAccountId);
          }

          recordTransferSync(targetAccountId, 'upload', item.sizeBytes, Date.now(), poolId);

          sqlite
            .prepare(
              `UPDATE transfer_job_items
               SET status = 'completed',
                   dest_drive_file_id = ?,
                   verified_hash = ?,
                   transferred_bytes = ?,
                   transfer_mode = ?,
                   last_error = NULL,
                   updated_at = unixepoch()
               WHERE id = ?`
            )
            .run(transferred.id, resolvedHash, item.sizeBytes, useStream ? 'stream' : 'copy', item.id);

          incrementTransferJobProgress(jobId, { completedDelta: 1, bytesDelta: item.sizeBytes });
        }).immediate();

        touchedAccounts.add(targetAccountId);
      } catch (err) {
        const msg = unwrapErrorMessage(err);
        fatalError = fatalError ?? msg;
        sqlite.transaction(() => {
          sqlite
            .prepare(
              `UPDATE transfer_job_items SET status = 'failed', last_error = ?, updated_at = unixepoch() WHERE id = ?`
            )
            .run(msg, item.id);
          incrementTransferJobProgress(jobId, { failedDelta: 1 });
        }).immediate();
      } finally {
        releaseCapacity();
      }
    }
  } finally {
    const revokeRes = await revokeExternalImportJobShares(jobId, sourceAuth.drive);
    if (revokeRes.failedCount > 0) {
      shareRevokeWarning = `${revokeRes.failedCount} temporary Drive share(s) could not be revoked.`;
    }
    bumpPoolRevision(poolId);
    invalidatePooledStorageOverview(poolId);
    for (const accId of touchedAccounts) {
      invalidateDiscrepancyCache(accId);
    }
  }

  const finalCounts = reconcileTransferJobCounters(jobId);

  if (cancelledImportJobs.has(jobId)) {
    cancelledImportJobs.delete(jobId);
    const cancelError = shareRevokeWarning ? `Cancelled, but ${shareRevokeWarning}` : null;
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `UPDATE transfer_job_items SET status = 'cancelled', updated_at = unixepoch()
           WHERE job_id = ? AND status IN ('pending', 'running')`
        )
        .run(jobId);
      sqlite
        .prepare(
          `UPDATE transfer_jobs SET status = 'cancelled', pause_reason = NULL, last_error = ?, updated_at = unixepoch() WHERE id = ?`
        )
        .run(cancelError, jobId);
    }).immediate();
  } else if (pausedForDailyCap) {
    const combinedPause = shareRevokeWarning ? `${pauseMessage} (${shareRevokeWarning})` : pauseMessage;
    sqlite
      .prepare(
        `UPDATE transfer_jobs
         SET status = 'paused', pause_reason = 'DAILY_TRANSFER_CAP', last_error = ?, updated_at = unixepoch()
         WHERE id = ?`
      )
      .run(combinedPause, jobId);
  } else if (finalCounts.failed > 0) {
    const errSummary = fatalError ?? `${finalCounts.failed} import item(s) failed`;
    const combinedErr = shareRevokeWarning ? `${errSummary} (${shareRevokeWarning})` : errSummary;
    sqlite
      .prepare(
        `UPDATE transfer_jobs SET status = 'failed', pause_reason = NULL, last_error = ?, updated_at = unixepoch() WHERE id = ?`
      )
      .run(combinedErr, jobId);
  } else {
    sqlite
      .prepare(
        `UPDATE transfer_jobs
         SET status = 'completed', pause_reason = NULL, last_error = ?, completed_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ?`
      )
      .run(shareRevokeWarning, jobId);
  }

  return readImportJobResult(jobId, false);
}

export async function startImportDrive(
  options: ImportDriveStartOptions
): Promise<ImportDriveJobResult> {
  const poolId = options.poolId ?? 1;
  if (isSharePoolId(poolId)) {
    throw new SharePoolReadOnlyError('Importing directly into Share Pool is disabled');
  }

  const poolExists = sqlite.prepare('SELECT 1 FROM pools WHERE id = ? LIMIT 1').get(poolId);
  if (!poolExists) {
    throw new ItemNotFoundError(`Target pool ${poolId} not found`);
  }

  const sourceFolderId = parseDriveFolderIdOrUrl(options.folderIdOrUrl);
  const destPath = normalizeVirtualPath(options.destPath || '/');
  const mode: ImportDriveMode = options.mode ?? 'copy';
  const conflictMode: ImportDriveConflictMode = options.conflictMode ?? 'skip';
  const scopeMode: SourceAuthScopeMode = mode === 'stream' ? 'drive.readonly' : 'drive';

  const sourceAuth = await acquireSourceOAuthClient({
    credPath: options.sourceAuthPath,
    scopeMode,
    noBrowser: options.noBrowser,
    homeDir: options.homeDir,
  });

  const isRootTarget = await detectIsRootFolder(sourceAuth.drive, sourceFolderId);
  const discovered = await scanExternalDriveTree({
    drive: sourceAuth.drive,
    sourceFolderId,
    isRootTarget,
    destBasePath: destPath,
    poolId,
    requestedMode: mode,
    conflictMode,
  });

  const jobId = randomUUID();
  const importable = discovered.filter((d) => !d.skipReason);
  const skippedCount = discovered.length - importable.length;
  const totalBytes = importable.reduce((sum, item) => sum + item.sizeBytes, 0);

  const meta: ImportDriveJobMetadata = {
    sourceFolderId,
    isRootTarget,
    destPath,
    sourceAuthPath: path.resolve(options.sourceAuthPath),
    sourceScopeMode: scopeMode,
    sourceEmail: sourceAuth.email,
    mode,
    conflictMode,
    homeDir: options.homeDir,
    noBrowser: options.noBrowser,
  };

  sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO transfer_jobs (
          id, kind, status, pool_id, conflict_policy, mode,
          total_items, completed_items, failed_items, skipped_items,
          total_bytes, transferred_bytes, metadata_json, created_at, updated_at
        ) VALUES (?, 'import_drive', 'running', ?, ?, ?, ?, 0, 0, ?, ?, 0, ?, unixepoch(), unixepoch())`
      )
      .run(
        jobId,
        poolId,
        conflictMode,
        mode,
        discovered.length,
        skippedCount,
        totalBytes,
        JSON.stringify(meta)
      );

    const insertItemStmt = sqlite.prepare(
      `INSERT INTO transfer_job_items (
        id, job_id, status, source_drive_file_id, source_parent_id,
        virtual_path, file_name, mime_type, size_bytes, transferred_bytes,
        expected_hash, transfer_mode, skip_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, unixepoch(), unixepoch())`
    );

    for (const item of discovered) {
      insertItemStmt.run(
        randomUUID(),
        jobId,
        item.skipReason ? 'skipped' : 'pending',
        item.id,
        item.shareScopeFolderId,
        item.destVirtualPath,
        item.name,
        item.mimeType,
        item.sizeBytes,
        item.md5Checksum,
        item.effectiveMode,
        item.skipReason
      );
    }
  }).immediate();

  const shouldWait = options.wait !== false;
  const runPromise = executeImportDriveJobInternal(jobId, sourceAuth).finally(() => {
    activeImportJobs.delete(jobId);
  });
  activeImportJobs.set(jobId, runPromise);

  if (shouldWait) {
    return runPromise;
  }

  void runPromise.catch((err) => {
    console.error(`Import Drive job ${jobId} failed:`, err);
  });

  return readImportJobResult(jobId, true);
}

export async function resumeImportDriveJob(
  jobId: string,
  wait = false
): Promise<ImportDriveJobResult> {
  const existing = activeImportJobs.get(jobId);
  if (existing) {
    return wait ? existing : readImportJobResult(jobId, true);
  }

  const row = sqlite
    .prepare(`SELECT id, status FROM transfer_jobs WHERE id = ? AND kind = 'import_drive' LIMIT 1`)
    .get(jobId) as { id: string; status: string } | undefined;

  if (!row) {
    throw new ItemNotFoundError(`Import job '${jobId}' not found`);
  }
  if (row.status === 'cancelled') {
    throw new UploadJobStateError(`Import job '${jobId}' was cancelled and cannot be resumed`);
  }
  if (row.status === 'completed') {
    return readImportJobResult(jobId, false);
  }

  cancelledImportJobs.delete(jobId);
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE transfer_job_items
         SET status = 'pending', last_error = NULL, updated_at = unixepoch()
         WHERE job_id = ? AND status IN ('failed', 'paused', 'running')`
      )
      .run(jobId);
    sqlite
      .prepare(
        `UPDATE transfer_jobs
         SET status = 'running', pause_reason = NULL, last_error = NULL, updated_at = unixepoch()
         WHERE id = ?`
      )
      .run(jobId);
    reconcileTransferJobCounters(jobId);
  }).immediate();

  const runPromise = executeImportDriveJobInternal(jobId).finally(() => {
    activeImportJobs.delete(jobId);
  });
  activeImportJobs.set(jobId, runPromise);

  if (wait) {
    return runPromise;
  }

  void runPromise.catch((err) => {
    console.error(`Resumed import Drive job ${jobId} failed:`, err);
  });

  return readImportJobResult(jobId, true);
}

export async function cancelImportDriveJob(jobId: string): Promise<ImportDriveJobResult> {
  const row = sqlite
    .prepare(
      `SELECT id, status, metadata_json as metadataJson
       FROM transfer_jobs
       WHERE id = ? AND kind = 'import_drive'
       LIMIT 1`
    )
    .get(jobId) as { id: string; status: string; metadataJson: string | null } | undefined;

  if (!row) {
    throw new ItemNotFoundError(`Import job '${jobId}' not found`);
  }

  cancelledImportJobs.add(jobId);

  const isRunningInProcess = activeImportJobs.has(jobId);
  let shareRevokeWarning: string | null = null;

  // When no in-process runner owns the live source Drive client, revoke unrevoked shares
  // strictly from cached disk tokens (never launching interactive OAuth on cancel).
  if (!isRunningInProcess) {
    const activeShareCountRow = sqlite
      .prepare('SELECT COUNT(*) as cnt FROM transfer_job_shares WHERE job_id = ? AND revoked_at IS NULL')
      .get(jobId) as { cnt: number } | undefined;
    const activeShareCount = Number(activeShareCountRow?.cnt ?? 0);

    if (activeShareCount > 0) {
      let meta: Partial<ImportDriveJobMetadata> = {};
      if (row.metadataJson) {
        try {
          meta = JSON.parse(row.metadataJson) as Partial<ImportDriveJobMetadata>;
        } catch {
          meta = {};
        }
      }

      const cached = tryLoadCachedSourceDriveNonInteractive(
        meta.sourceAuthPath,
        meta.sourceScopeMode ?? 'drive',
        meta.homeDir
      );
      const revokeRes = await revokeExternalImportJobShares(jobId, cached.drive);
      if (revokeRes.failedCount > 0) {
        const reasonSuffix = cached.reason ? `: ${cached.reason}` : '';
        shareRevokeWarning = `Cancelled, but ${revokeRes.failedCount} temporary Drive share(s) could not be revoked${reasonSuffix}.`;
      }
    }

    if (row.status !== 'completed') {
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
             SET status = 'cancelled', pause_reason = NULL, last_error = ?, updated_at = unixepoch()
             WHERE id = ?`
          )
          .run(shareRevokeWarning, jobId);
      }).immediate();
    } else if (shareRevokeWarning) {
      sqlite
        .prepare('UPDATE transfer_jobs SET last_error = ?, updated_at = unixepoch() WHERE id = ?')
        .run(shareRevokeWarning, jobId);
    }
  }

  return readImportJobResult(jobId, false);
}

export interface OrphanedJobRecoveryResult {
  recoveredJobs: number;
  revokedShares: number;
  failedShareRevocations: number;
}

/**
 * Recovers transfer jobs left in 'running' state after a hard server crash or restart
 * and revokes any unrevoked temporary Drive folder shares left in transfer_job_shares.
 */
export async function recoverOrphanedTransferJobsOnStartup(): Promise<OrphanedJobRecoveryResult> {
  authPool.ensureScanned();

  const orphanedJobs = sqlite
    .prepare(
      `SELECT id, kind, metadata_json as metadataJson
       FROM transfer_jobs
       WHERE status = 'running'
         AND kind IN ('account_evacuate', 'cross_pool_move', 'import_drive')`
    )
    .all() as Array<{ id: string; kind: string; metadataJson: string | null }>;

  const unrevokedShareJobRows = sqlite
    .prepare(
      `SELECT DISTINCT s.job_id as jobId, j.kind as kind, j.status as status, j.metadata_json as metadataJson, j.last_error as lastError
       FROM transfer_job_shares s
       LEFT JOIN transfer_jobs j ON j.id = s.job_id
       WHERE s.revoked_at IS NULL`
    )
    .all() as Array<{
    jobId: string;
    kind: string | null;
    status: string | null;
    metadataJson: string | null;
    lastError: string | null;
  }>;

  let revokedShares = 0;
  let failedShareRevocations = 0;
  const shareWarningByJob = new Map<string, string>();

  for (const row of unrevokedShareJobRows) {
    // 1. Revoke any internal pool-account shares (source_account_id IS NOT NULL).
    const internalRes = await revokeJobShares(row.jobId);
    revokedShares += internalRes.revokedCount;
    failedShareRevocations += internalRes.failedCount;

    let warningParts: string[] = [];
    if (internalRes.failedCount > 0) {
      warningParts.push(`${internalRes.failedCount} internal temporary share(s) could not be revoked`);
    }

    // 2. Revoke any external import_drive shares (source_account_id IS NULL) non-interactively.
    const remainingExternal = sqlite
      .prepare(
        `SELECT COUNT(*) as cnt
         FROM transfer_job_shares
         WHERE job_id = ? AND revoked_at IS NULL AND source_account_id IS NULL`
      )
      .get(row.jobId) as { cnt: number } | undefined;

    if (Number(remainingExternal?.cnt ?? 0) > 0) {
      let meta: Partial<ImportDriveJobMetadata> = {};
      if (row.metadataJson) {
        try {
          meta = JSON.parse(row.metadataJson) as Partial<ImportDriveJobMetadata>;
        } catch {
          meta = {};
        }
      }
      const cached = tryLoadCachedSourceDriveNonInteractive(
        meta.sourceAuthPath,
        meta.sourceScopeMode ?? 'drive',
        meta.homeDir
      );
      const extRes = await revokeExternalImportJobShares(row.jobId, cached.drive);
      revokedShares += extRes.revokedCount;
      failedShareRevocations += extRes.failedCount;
      if (extRes.failedCount > 0) {
        const reasonSuffix = cached.reason ? ` (${cached.reason})` : '';
        warningParts.push(
          `${extRes.failedCount} external temporary Drive share(s) could not be revoked${reasonSuffix}`
        );
      }
    }

    if (warningParts.length > 0) {
      shareWarningByJob.set(row.jobId, warningParts.join('; '));
    }
  }

  const orphanedJobIds = new Set(orphanedJobs.map((j) => j.id));

  for (const job of orphanedJobs) {
    const shareWarning = shareWarningByJob.get(job.id);
    const recoveryMessage = shareWarning
      ? `Paused after server restart recovery; resume with 'tsubasa job resume'. Warning: ${shareWarning}.`
      : "Paused after server restart recovery; resume with 'tsubasa job resume'.";

    sqlite.transaction(() => {
      sqlite
        .prepare(
          `UPDATE transfer_job_items
           SET status = 'pending', updated_at = unixepoch()
           WHERE job_id = ? AND status = 'running'`
        )
        .run(job.id);
      sqlite
        .prepare(
          `UPDATE transfer_jobs
           SET status = 'paused',
               pause_reason = 'SERVER_RESTART_RECOVERY',
               last_error = ?,
               updated_at = unixepoch()
           WHERE id = ?`
        )
        .run(recoveryMessage, job.id);
      reconcileTransferJobCounters(job.id);
    }).immediate();
  }

  for (const row of unrevokedShareJobRows) {
    if (orphanedJobIds.has(row.jobId)) {
      continue;
    }
    const shareWarning = shareWarningByJob.get(row.jobId);
    if (shareWarning && !row.lastError) {
      sqlite
        .prepare('UPDATE transfer_jobs SET last_error = ?, updated_at = unixepoch() WHERE id = ?')
        .run(`Startup recovery warning: ${shareWarning}.`, row.jobId);
    }
  }

  return {
    recoveredJobs: orphanedJobs.length,
    revokedShares,
    failedShareRevocations,
  };
}
