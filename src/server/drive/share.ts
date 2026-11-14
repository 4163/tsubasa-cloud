import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite } from '../db/index.js';
import { accounts, files, folders, shareLinks } from '../db/schema.js';
import { eq, and, or, sql } from 'drizzle-orm';
import { authPool } from './auth.js';
import {
  getDriveClient,
  getAccountRootFolderId,
  ensureSharePoolExistsInDb,
  switchAccountPool,
  markAccountQuotaDecreased,
  refreshAccountLiveQuota,
} from './client.js';
import { copyDriveFileCrossAccount, deleteDriveFileIgnoreNotFound } from './transfer.js';
import { ensureRemoteFolderHierarchy, normalizeVirtualPath, clearRemoteFolderCache } from './mirror.js';
import { ensureLocalFolderHierarchy, formatFolderId, insertFolderRecord } from './sync.js';
import {
  getEmptyAccountsAcrossAllPools,
  MAX_SINGLE_FILE_BYTES,
  recordTransfer,
  type EmptyShareAccount,
} from '../storage/quota.js';
import {
  getEligibleAccounts,
  planBatchPlacement,
  simulateBatchPlacement,
  FileExceedsCeilingError,
  InsufficientStorageError,
  type CandidateAccount,
  type PlacementItem,
} from '../storage/placement.js';

export class ShareValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareValidationError';
  }
}

export class SharePoolNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SharePoolNotFoundError';
  }
}

export interface ShareTargetInput {
  kind: 'file' | 'folder';
  id: string;
}

export interface ResolvedShareFile {
  id: string;
  name: string;
  sourceVirtualPath: string;
  targetVirtualPath: string;
  sizeBytes: number;
  mimeType: string;
  hash: string | null;
  accountId: string;
  driveFileId: string;
}

export interface ResolvedShareFolder {
  id: string;
  name: string;
  sourceVirtualPath: string;
  targetVirtualPath: string;
}

export interface OverCeilingShareFile {
  id: string;
  name: string;
  virtualPath: string;
  sizeBytes: number;
}

export interface ResolvedShareTopLevelItem {
  kind: 'file' | 'folder';
  id: string;
  name: string;
  sourceVirtualPath: string;
  targetVirtualPath: string;
}

export interface ShareTargetsResolution {
  sourcePoolId: number;
  sharePoolId: number | null;
  batchFolderName: string;
  topLevelItems: ResolvedShareTopLevelItem[];
  files: ResolvedShareFile[];
  folders: ResolvedShareFolder[];
  totalBytes: number;
  fileCount: number;
  folderCount: number;
  overCeilingFiles: OverCeilingShareFile[];
}

export interface ShareInspectPlan {
  sourcePoolId: number;
  sharePoolExists: boolean;
  sharePoolId: number | null;
  sharePoolFitsWithoutExpansion: boolean;
  existingSharePoolAccountCount: number;
  existingSharePoolHeadroomBytes: number;
  shortfallBytes: number;
  fitReason: string | null;
  totalBytes: number;
  fileCount: number;
  folderCount: number;
  topLevelItems: ResolvedShareTopLevelItem[];
  overCeilingFiles: OverCeilingShareFile[];
  emptyAccounts: EmptyShareAccount[];
}

export interface ShareValidationResult {
  valid: boolean;
  reason?: string;
  totalAvailableHeadroomBytes: number;
  requiredBytes: number;
  accountAllocations?: Record<string, { filesCount: number; bytesAllocated: number }>;
}

export interface ExecuteShareParams {
  sourcePoolId: number;
  items: ShareTargetInput[];
  selectedAccountIds: string[];
  recipientEmails: string[];
  emailMessage?: string;
}

export interface ShareAccountLinkResult {
  accountId: string;
  accountEmail: string;
  accountDisplayName: string;
  rootFolderId: string;
  webViewLink: string | null;
  filesCount: number;
  bytesAllocated: number;
}

async function loadEmptyAccountsWithAuthStatus(nowMs = Date.now()) {
  const authorizedIds = new Set(authPool.getAll().filter((r) => r.authorized).map((r) => r.config.accountId));
  return getEmptyAccountsAcrossAllPools(nowMs, authorizedIds);
}

export interface ShareEmailDeliveryResult {
  accountId: string;
  accountEmail: string;
  email: string;
  success: boolean;
  error?: string;
}

export interface ExecuteShareResult {
  sharePoolId: number;
  batchFolderName: string;
  totalBytes: number;
  fileCount: number;
  folderCount: number;
  links: ShareAccountLinkResult[];
  emailDeliveries: ShareEmailDeliveryResult[];
}

export interface ClearSharePoolResult {
  sharePoolId: number;
  filesRemoved: number;
  foldersRemoved: number;
  bytesReclaimed: number;
  warnings: string[];
}

interface SharePoolRow {
  id: number;
  name: string;
  driveFolderName: string;
}

function findSharePoolRow(): SharePoolRow | null {
  const row = sqlite
    .prepare('SELECT id, name, drive_folder_name as driveFolderName FROM pools WHERE is_share_pool = 1 LIMIT 1')
    .get() as SharePoolRow | undefined;
  return row ?? null;
}

function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function computeLowestCommonParentDir(paths: string[]): string {
  if (paths.length === 0) return '/';

  const segmentLists = paths.map((p) => {
    const parent = path.posix.dirname(normalizeVirtualPath(p));
    return parent === '/' || parent === '.' ? [] : parent.split('/').filter(Boolean);
  });

  const first = segmentLists[0];
  let commonLen = first.length;

  for (let i = 1; i < segmentLists.length; i++) {
    const current = segmentLists[i];
    commonLen = Math.min(commonLen, current.length);
    for (let j = 0; j < commonLen; j++) {
      if (first[j] !== current[j]) {
        commonLen = j;
        break;
      }
    }
  }

  if (commonLen === 0) return '/';
  return `/${first.slice(0, commonLen).join('/')}`;
}

function stripParentPrefix(virtualPath: string, lcpDir: string): string {
  const normalized = normalizeVirtualPath(virtualPath);
  if (lcpDir === '/') return normalized;
  if (normalized.startsWith(`${lcpDir}/`)) {
    return normalized.slice(lcpDir.length);
  }
  return normalized;
}

function allocateUniqueTopSegment(
  originalTopSegment: string,
  isTopLevelSingleFile: boolean,
  occupiedTopSegments: Set<string>
): string {
  if (!occupiedTopSegments.has(originalTopSegment)) {
    occupiedTopSegments.add(originalTopSegment);
    return originalTopSegment;
  }

  const ext = isTopLevelSingleFile ? path.posix.extname(originalTopSegment) : '';
  const stem = ext ? originalTopSegment.slice(0, -ext.length) : originalTopSegment;

  let counter = 2;
  while (true) {
    const candidate = isTopLevelSingleFile ? `${stem} (${counter})${ext}` : `${originalTopSegment} (${counter})`;
    if (!occupiedTopSegments.has(candidate)) {
      occupiedTopSegments.add(candidate);
      return candidate;
    }
    counter++;
  }
}

function loadOccupiedTopSegments(sharePoolId: number | null): Set<string> {
  const occupied = new Set<string>();
  if (sharePoolId === null) return occupied;

  const fileRows = sqlite
    .prepare('SELECT virtual_path as virtualPath FROM files WHERE pool_id = ?')
    .all(sharePoolId) as Array<{ virtualPath: string }>;
  const folderRows = sqlite
    .prepare('SELECT virtual_path as virtualPath FROM folders WHERE pool_id = ?')
    .all(sharePoolId) as Array<{ virtualPath: string }>;

  for (const row of [...fileRows, ...folderRows]) {
    const topSeg = normalizeVirtualPath(row.virtualPath).split('/').filter(Boolean)[0];
    if (topSeg) occupied.add(topSeg);
  }

  return occupied;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function generateShareBatchFolderName(sharePoolId: number | null): string {
  const now = new Date();
  const yyyy = String(now.getFullYear()).padStart(4, '0');
  const mm = pad2(now.getMonth() + 1);
  const dd = pad2(now.getDate());
  const hh = pad2(now.getHours());
  const min = pad2(now.getMinutes());
  const ss = pad2(now.getSeconds());
  const ms = String(now.getMilliseconds()).padStart(3, '0');

  let candidate = `${yyyy}${mm}${dd}${hh}${min}${ss}${ms}`;
  const occupied = loadOccupiedTopSegments(sharePoolId);
  while (occupied.has(candidate)) {
    candidate = (BigInt(candidate) + 1n).toString();
  }
  return candidate;
}

function isStrictDescendant(candidatePath: string, folderPath: string): boolean {
  return folderPath === '/'
    ? candidatePath !== '/'
    : candidatePath.startsWith(`${folderPath}/`);
}

export async function resolveShareTargets(
  sourcePoolId: number,
  items: ShareTargetInput[],
  batchFolderName?: string
): Promise<ShareTargetsResolution> {
  const sharePoolRow = findSharePoolRow();
  const sharePoolId = sharePoolRow?.id ?? null;
  const effectiveBatchName = batchFolderName ?? generateShareBatchFolderName(sharePoolId);

  const selectedFilesById = new Map<string, typeof files.$inferSelect>();
  const selectedFoldersByPath = new Map<string, typeof folders.$inferSelect>();

  for (const item of items) {
    if (!item?.id) continue;

    if (item.kind === 'file') {
      const file = await db.query.files.findFirst({
        where: and(
          eq(files.poolId, sourcePoolId),
          eq(files.isTrashed, false),
          or(eq(files.id, item.id), eq(files.virtualPath, item.id))
        ),
      });
      if (file) {
        selectedFilesById.set(file.id, file);
      }
      continue;
    }

    if (item.kind === 'folder') {
      const folder = await db.query.folders.findFirst({
        where: and(
          eq(folders.poolId, sourcePoolId),
          or(eq(folders.id, item.id), eq(folders.virtualPath, item.id))
        ),
      });
      if (folder) {
        selectedFoldersByPath.set(normalizeVirtualPath(folder.virtualPath), folder);
      }
    }
  }

  const allSelectedFolderPaths = Array.from(selectedFoldersByPath.keys());

  const topLevelFolders = Array.from(selectedFoldersByPath.values()).filter((folder) => {
    const folderPath = normalizeVirtualPath(folder.virtualPath);
    return !allSelectedFolderPaths.some(
      (otherPath) => otherPath !== folderPath && isStrictDescendant(folderPath, otherPath)
    );
  });

  const topLevelFiles = Array.from(selectedFilesById.values()).filter((file) => {
    const filePath = normalizeVirtualPath(file.virtualPath);
    return !allSelectedFolderPaths.some((folderPath) => isStrictDescendant(filePath, folderPath));
  });

  if (topLevelFolders.length === 0 && topLevelFiles.length === 0) {
    return {
      sourcePoolId,
      sharePoolId,
      batchFolderName: effectiveBatchName,
      topLevelItems: [],
      files: [],
      folders: [],
      totalBytes: 0,
      fileCount: 0,
      folderCount: 0,
      overCeilingFiles: [],
    };
  }

  const topLevelPaths = [
    ...topLevelFolders.map((f) => normalizeVirtualPath(f.virtualPath)),
    ...topLevelFiles.map((f) => normalizeVirtualPath(f.virtualPath)),
  ];
  const lcpDir = computeLowestCommonParentDir(topLevelPaths);
  const batchOccupiedSegments = new Set<string>();

  const resolvedTopLevelItems: ResolvedShareTopLevelItem[] = [];
  const resolvedFilesById = new Map<string, ResolvedShareFile>();
  const resolvedFoldersBySourcePath = new Map<string, ResolvedShareFolder>();

  const buildRemapper = (sourcePath: string, isSingleFile: boolean) => {
    const stripped = stripParentPrefix(sourcePath, lcpDir);
    const segments = stripped.split('/').filter(Boolean);
    const originalTopSeg = segments[0] ?? path.posix.basename(stripped);
    const resolvedTopSeg = allocateUniqueTopSegment(
      originalTopSeg,
      isSingleFile && segments.length === 1,
      batchOccupiedSegments
    );

    return (candidateSourcePath: string): string => {
      const rel = stripParentPrefix(candidateSourcePath, lcpDir);
      const rest = rel.slice(1 + originalTopSeg.length);
      return normalizeVirtualPath(`/${effectiveBatchName}/${resolvedTopSeg}${rest}`);
    };
  };

  for (const file of topLevelFiles) {
    const sourcePath = normalizeVirtualPath(file.virtualPath);
    const remapPath = buildRemapper(sourcePath, true);
    const targetVirtualPath = remapPath(sourcePath);

    resolvedTopLevelItems.push({
      kind: 'file',
      id: file.id,
      name: path.posix.basename(targetVirtualPath),
      sourceVirtualPath: sourcePath,
      targetVirtualPath,
    });

    resolvedFilesById.set(file.id, {
      id: file.id,
      name: path.posix.basename(targetVirtualPath),
      sourceVirtualPath: sourcePath,
      targetVirtualPath,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
      hash: file.hash,
      accountId: file.accountId,
      driveFileId: file.driveFileId,
    });
  }

  for (const folder of topLevelFolders) {
    const sourceFolderPath = normalizeVirtualPath(folder.virtualPath);
    const remapPath = buildRemapper(sourceFolderPath, false);
    const targetFolderPath = remapPath(sourceFolderPath);

    resolvedTopLevelItems.push({
      kind: 'folder',
      id: folder.id,
      name: path.posix.basename(targetFolderPath),
      sourceVirtualPath: sourceFolderPath,
      targetVirtualPath: targetFolderPath,
    });

    const prefix = sourceFolderPath === '/' ? '/' : `${sourceFolderPath}/`;
    const escapedPrefix = escapeLikePrefix(prefix);

    const matchingFolders = await db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.poolId, sourcePoolId),
          sql`(${folders.virtualPath} = ${sourceFolderPath} OR ${folders.virtualPath} LIKE ${escapedPrefix + '%'} ESCAPE '\\')`
        )
      );

    for (const subFolder of matchingFolders) {
      const subPath = normalizeVirtualPath(subFolder.virtualPath);
      if (subPath !== sourceFolderPath && !isStrictDescendant(subPath, sourceFolderPath)) {
        continue;
      }
      if (!resolvedFoldersBySourcePath.has(subPath)) {
        const mappedPath = remapPath(subPath);
        resolvedFoldersBySourcePath.set(subPath, {
          id: subFolder.id,
          name: path.posix.basename(mappedPath),
          sourceVirtualPath: subPath,
          targetVirtualPath: mappedPath,
        });
      }
    }

    const matchingFiles = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.poolId, sourcePoolId),
          eq(files.isTrashed, false),
          sql`(${files.virtualPath} = ${sourceFolderPath} OR ${files.virtualPath} LIKE ${escapedPrefix + '%'} ESCAPE '\\')`
        )
      );

    for (const subFile of matchingFiles) {
      const subPath = normalizeVirtualPath(subFile.virtualPath);
      if (subPath !== sourceFolderPath && !isStrictDescendant(subPath, sourceFolderPath)) {
        continue;
      }
      if (!resolvedFilesById.has(subFile.id)) {
        const mappedPath = remapPath(subPath);
        resolvedFilesById.set(subFile.id, {
          id: subFile.id,
          name: path.posix.basename(mappedPath),
          sourceVirtualPath: subPath,
          targetVirtualPath: mappedPath,
          sizeBytes: subFile.sizeBytes,
          mimeType: subFile.mimeType,
          hash: subFile.hash,
          accountId: subFile.accountId,
          driveFileId: subFile.driveFileId,
        });
      }
    }
  }

  const resolvedFiles = Array.from(resolvedFilesById.values());
  const resolvedFolders = Array.from(resolvedFoldersBySourcePath.values()).sort(
    (a, b) => a.targetVirtualPath.length - b.targetVirtualPath.length
  );

  let totalBytes = 0;
  const overCeilingFiles: OverCeilingShareFile[] = [];

  for (const f of resolvedFiles) {
    totalBytes += f.sizeBytes;
    if (f.sizeBytes > MAX_SINGLE_FILE_BYTES) {
      overCeilingFiles.push({
        id: f.id,
        name: f.name,
        virtualPath: f.sourceVirtualPath,
        sizeBytes: f.sizeBytes,
      });
    }
  }

  return {
    sourcePoolId,
    sharePoolId,
    batchFolderName: effectiveBatchName,
    topLevelItems: resolvedTopLevelItems,
    files: resolvedFiles,
    folders: resolvedFolders,
    totalBytes,
    fileCount: resolvedFiles.length,
    folderCount: resolvedFolders.length,
    overCeilingFiles,
  };
}

function toPlacementItems(resolvedFiles: ResolvedShareFile[]): PlacementItem[] {
  return resolvedFiles.map((f) => ({
    virtualPath: f.targetVirtualPath,
    sizeBytes: f.sizeBytes,
  }));
}

export async function inspectSharePlan(
  sourcePoolId: number,
  items: ShareTargetInput[]
): Promise<ShareInspectPlan> {
  const targets = await resolveShareTargets(sourcePoolId, items);

  const refreshRows = (
    targets.sharePoolId !== null
      ? sqlite
          .prepare(
            `SELECT id FROM accounts
             WHERE pool_id = ?
                OR NOT EXISTS (SELECT 1 FROM files WHERE files.account_id = accounts.id)`
          )
          .all(targets.sharePoolId)
      : sqlite
          .prepare(
            `SELECT id FROM accounts
             WHERE NOT EXISTS (SELECT 1 FROM files WHERE files.account_id = accounts.id)`
          )
          .all()
  ) as Array<{ id: string }>;

  const authorizedRefreshIds = refreshRows
    .map((row) => row.id)
    .filter((id) => Boolean(authPool.getRecord(id)?.authorized));

  if (authorizedRefreshIds.length > 0) {
    await Promise.all(
      authorizedRefreshIds.map((id) => refreshAccountLiveQuota(id).catch(() => null))
    );
  }

  const emptyAccounts = await loadEmptyAccountsWithAuthStatus();

  let sharePoolFitsWithoutExpansion = false;
  let existingSharePoolAccountCount = 0;
  let existingSharePoolHeadroomBytes = 0;
  let fitReason: string | null = null;

  if (targets.sharePoolId !== null) {
    const existingCandidates = await getEligibleAccounts(targets.sharePoolId);
    existingSharePoolAccountCount = existingCandidates.length;
    existingSharePoolHeadroomBytes = existingCandidates.reduce((sum, c) => sum + c.headroomBytes, 0);

    if (targets.overCeilingFiles.length > 0) {
      fitReason = `${targets.overCeilingFiles.length} file(s) exceed the 14.25 GB single-account ceiling`;
    } else if (targets.files.length === 0 && targets.folders.length > 0) {
      sharePoolFitsWithoutExpansion = existingCandidates.length >= 1;
      if (!sharePoolFitsWithoutExpansion) {
        fitReason = 'Share Pool has no active accounts to host the empty folder';
      }
    } else if (targets.files.length > 0) {
      try {
        await simulateBatchPlacement(toPlacementItems(targets.files), existingCandidates, targets.sharePoolId);
        sharePoolFitsWithoutExpansion = true;
      } catch (err) {
        sharePoolFitsWithoutExpansion = false;
        fitReason = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const shortfallBytes = Math.max(0, targets.totalBytes - existingSharePoolHeadroomBytes);

  return {
    sourcePoolId,
    sharePoolExists: targets.sharePoolId !== null,
    sharePoolId: targets.sharePoolId,
    sharePoolFitsWithoutExpansion,
    existingSharePoolAccountCount,
    existingSharePoolHeadroomBytes,
    shortfallBytes,
    fitReason,
    totalBytes: targets.totalBytes,
    fileCount: targets.fileCount,
    folderCount: targets.folderCount,
    topLevelItems: targets.topLevelItems,
    overCeilingFiles: targets.overCeilingFiles,
    emptyAccounts,
  };
}

export async function validateShareSelection(
  sourcePoolId: number,
  items: ShareTargetInput[],
  selectedAccountIds: string[]
): Promise<ShareValidationResult> {
  const targets = await resolveShareTargets(sourcePoolId, items);
  const uniqueSelectedIds = Array.from(new Set(selectedAccountIds.filter(Boolean)));

  const emptyAccounts = await loadEmptyAccountsWithAuthStatus();
  const emptyById = new Map(emptyAccounts.map((acc) => [acc.id, acc]));

  const existingCandidates =
    targets.sharePoolId !== null ? await getEligibleAccounts(targets.sharePoolId) : [];

  const combinedMap = new Map<string, CandidateAccount>();
  for (const existing of existingCandidates) {
    combinedMap.set(existing.id, existing);
  }

  for (const accountId of uniqueSelectedIds) {
    const emptyAcc = emptyById.get(accountId);
    if (!emptyAcc) {
      const existingHeadroom = existingCandidates.reduce((s, c) => s + c.headroomBytes, 0);
      return {
        valid: false,
        reason: `Account "${accountId}" is not empty or was not found`,
        totalAvailableHeadroomBytes: existingHeadroom,
        requiredBytes: targets.totalBytes,
      };
    }

    if (emptyAcc.isDisabled) {
      return {
        valid: false,
        reason: `Drive "${emptyAcc.email}" is disabled and cannot join the Share Pool`,
        totalAvailableHeadroomBytes: existingCandidates.reduce((s, c) => s + c.headroomBytes, 0),
        requiredBytes: targets.totalBytes,
      };
    }

    if (!emptyAcc.authorized) {
      return {
        valid: false,
        reason: `Drive "${emptyAcc.email}" is not authorized`,
        totalAvailableHeadroomBytes: existingCandidates.reduce((s, c) => s + c.headroomBytes, 0),
        requiredBytes: targets.totalBytes,
      };
    }

    if (emptyAcc.syncState === 'error') {
      return {
        valid: false,
        reason: `Drive "${emptyAcc.email}" is in an error sync state`,
        totalAvailableHeadroomBytes: existingCandidates.reduce((s, c) => s + c.headroomBytes, 0),
        requiredBytes: targets.totalBytes,
      };
    }

    if (!combinedMap.has(emptyAcc.id)) {
      combinedMap.set(emptyAcc.id, {
        id: emptyAcc.id,
        email: emptyAcc.email,
        headroomBytes: emptyAcc.headroomBytes,
        transferStats: emptyAcc.transferStats,
      });
    }
  }

  const combinedCandidates = Array.from(combinedMap.values());
  const totalAvailableHeadroomBytes = combinedCandidates.reduce((sum, c) => sum + c.headroomBytes, 0);

  if (targets.files.length === 0 && targets.folders.length === 0) {
    return {
      valid: false,
      reason: 'No valid files or folders found to share',
      totalAvailableHeadroomBytes,
      requiredBytes: targets.totalBytes,
    };
  }

  if (targets.overCeilingFiles.length > 0) {
    return {
      valid: false,
      reason: `${targets.overCeilingFiles[0].name} exceeds the 14.25 GB single-account ceiling`,
      totalAvailableHeadroomBytes,
      requiredBytes: targets.totalBytes,
    };
  }

  if (targets.files.length === 0 && targets.folders.length > 0) {
    if (combinedCandidates.length === 0) {
      return {
        valid: false,
        reason: 'Select at least one empty drive to host the shared folder',
        totalAvailableHeadroomBytes,
        requiredBytes: 0,
      };
    }

    const best = [...combinedCandidates].sort((a, b) => b.headroomBytes - a.headroomBytes)[0];
    return {
      valid: true,
      totalAvailableHeadroomBytes,
      requiredBytes: 0,
      accountAllocations: {
        [best.id]: { filesCount: 0, bytesAllocated: 0 },
      },
    };
  }

  try {
    const plan = await simulateBatchPlacement(
      toPlacementItems(targets.files),
      combinedCandidates,
      targets.sharePoolId ?? undefined
    );
    return {
      valid: true,
      totalAvailableHeadroomBytes,
      requiredBytes: targets.totalBytes,
      accountAllocations: plan.accountAllocations,
    };
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : String(err),
      totalAvailableHeadroomBytes,
      requiredBytes: targets.totalBytes,
    };
  }
}

function normalizeRecipientEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of emails) {
    const email = raw.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(email);
  }

  return normalized;
}

function ensureLocalFolderTreeExact(folderPath: string, poolId: number): void {
  const normalized = normalizeVirtualPath(folderPath);
  if (normalized === '/') return;
  ensureLocalFolderHierarchy(normalized, poolId);
  insertFolderRecord(normalized, poolId);
}

async function ensureShareBatchPermissionsAndLinks(params: {
  batchFolderName: string;
  participatingAccountIds: string[];
  allocations: Record<string, { filesCount: number; bytesAllocated: number }>;
  recipientEmails: string[];
  emailMessage?: string;
}): Promise<{
  links: ShareAccountLinkResult[];
  emailDeliveries: ShareEmailDeliveryResult[];
}> {
  const { batchFolderName, participatingAccountIds, allocations, recipientEmails, emailMessage } = params;
  const trimmedMessage = emailMessage?.trim() || undefined;
  const batchVirtualPath = `/${batchFolderName}`;

  const links: ShareAccountLinkResult[] = [];
  const emailDeliveries: ShareEmailDeliveryResult[] = [];

  for (const accountId of participatingAccountIds) {
    const drive = getDriveClient(accountId);
    const accountRootFolderId = await getAccountRootFolderId(accountId);
    const batchFolderId = await ensureRemoteFolderHierarchy(drive, accountRootFolderId, batchVirtualPath);
    const accountRecord = await db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
    });
    const accountEmail = accountRecord?.email ?? accountId;
    const accountDisplayName = accountRecord?.displayName ?? accountEmail;

    const permListRes = await drive.permissions.list({
      fileId: batchFolderId,
      fields: 'permissions(id, type, role)',
      supportsAllDrives: false,
    });

    const hasAnyoneReader = (permListRes.data.permissions || []).some(
      (p) => p.type === 'anyone' && p.role === 'reader'
    );

    if (!hasAnyoneReader) {
      await drive.permissions.create({
        fileId: batchFolderId,
        requestBody: {
          role: 'reader',
          type: 'anyone',
        },
        supportsAllDrives: false,
      });
    }

    const folderRes = await drive.files.get({
      fileId: batchFolderId,
      fields: 'id, name, webViewLink',
      supportsAllDrives: false,
    });
    const webViewLink = folderRes.data.webViewLink || null;

    const alloc = allocations[accountId] ?? { filesCount: 0, bytesAllocated: 0 };
    links.push({
      accountId,
      accountEmail,
      accountDisplayName,
      rootFolderId: batchFolderId,
      webViewLink,
      filesCount: alloc.filesCount,
      bytesAllocated: alloc.bytesAllocated,
    });

    for (const email of recipientEmails) {
      try {
        await drive.permissions.create({
          fileId: batchFolderId,
          sendNotificationEmail: true,
          ...(trimmedMessage ? { emailMessage: trimmedMessage } : {}),
          requestBody: {
            role: 'reader',
            type: 'user',
            emailAddress: email,
          },
          supportsAllDrives: false,
        });

        emailDeliveries.push({
          accountId,
          accountEmail,
          email,
          success: true,
        });
      } catch (err) {
        emailDeliveries.push({
          accountId,
          accountEmail,
          email,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { links, emailDeliveries };
}

export async function executeShare(params: ExecuteShareParams): Promise<ExecuteShareResult> {
  const recipientEmails = normalizeRecipientEmails(params.recipientEmails);

  const validation = await validateShareSelection(
    params.sourcePoolId,
    params.items,
    params.selectedAccountIds
  );

  if (!validation.valid) {
    throw new ShareValidationError(validation.reason || 'Selected drives cannot fit the share payload');
  }

  const sharePoolId = ensureSharePoolExistsInDb();
  const batchFolderName = generateShareBatchFolderName(sharePoolId);

  const uniqueSelectedIds = Array.from(new Set(params.selectedAccountIds.filter(Boolean)));
  for (const accountId of uniqueSelectedIds) {
    const accountRecord = await db.query.accounts.findFirst({
      where: eq(accounts.id, accountId),
    });
    if (!accountRecord || accountRecord.poolId !== sharePoolId) {
      await switchAccountPool(accountId, sharePoolId);
    }
  }

  const targets = await resolveShareTargets(params.sourcePoolId, params.items, batchFolderName);
  if (targets.files.length === 0 && targets.folders.length === 0) {
    throw new ShareValidationError('No valid files or folders found to share');
  }
  if (targets.overCeilingFiles.length > 0) {
    throw new FileExceedsCeilingError(targets.overCeilingFiles[0].sizeBytes);
  }

  const participatingAccountIds = new Set<string>();
  const accountAllocations: Record<string, { filesCount: number; bytesAllocated: number }> = {};

  if (targets.files.length === 0 && targets.folders.length > 0) {
    const candidates = await getEligibleAccounts(sharePoolId);
    if (candidates.length === 0) {
      throw new InsufficientStorageError('No active accounts available in Share Pool');
    }

    const bestAccount = [...candidates].sort((a, b) => b.headroomBytes - a.headroomBytes)[0];
    const drive = getDriveClient(bestAccount.id);
    const rootFolderId = await getAccountRootFolderId(bestAccount.id);

    for (const folder of targets.folders) {
      await ensureRemoteFolderHierarchy(drive, rootFolderId, folder.targetVirtualPath);
      ensureLocalFolderTreeExact(folder.targetVirtualPath, sharePoolId);
    }

    participatingAccountIds.add(bestAccount.id);
    accountAllocations[bestAccount.id] = { filesCount: 0, bytesAllocated: 0 };
  } else {
    const fileByTargetPath = new Map(targets.files.map((f) => [f.targetVirtualPath, f]));
    const plan = await planBatchPlacement(toPlacementItems(targets.files), Date.now(), sharePoolId);

    Object.assign(accountAllocations, plan.accountAllocations);

    const accountCache = new Map<string, { email: string; rootFolderId: string }>();
    const getTargetAccountInfo = async (accountId: string) => {
      const cached = accountCache.get(accountId);
      if (cached) return cached;

      const acc = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
      });
      if (!acc) {
        throw new Error(`Target account ${accountId} not registered`);
      }
      const rootFolderId = await getAccountRootFolderId(accountId);
      const info = { email: acc.email, rootFolderId };
      accountCache.set(accountId, info);
      return info;
    };

    const createdLocalFolderPaths = new Set<string>();

    for (const decision of plan.decisions) {
      const sourceFile = fileByTargetPath.get(decision.virtualPath);
      if (!sourceFile) {
        throw new Error(`Missing source file mapping for ${decision.virtualPath}`);
      }

      participatingAccountIds.add(decision.accountId);
      const targetInfo = await getTargetAccountInfo(decision.accountId);
      const driveTarget = getDriveClient(decision.accountId);
      const parentDir = path.posix.dirname(decision.virtualPath);
      const targetRemoteFolderId = await ensureRemoteFolderHierarchy(
        driveTarget,
        targetInfo.rootFolderId,
        parentDir
      );

      const newFileId = randomUUID();
      const destFileName = path.posix.basename(decision.virtualPath);
      const appProperties = {
        tsubasa_managed: 'true',
        tsubasa_virtual_path: decision.virtualPath,
        tsubasa_virtual_id: newFileId,
        tsubasa_checksum: sourceFile.hash || '',
      };

      const newDriveFileId = await copyDriveFileCrossAccount({
        sourceAccountId: sourceFile.accountId,
        sourceDriveFileId: sourceFile.driveFileId,
        targetAccountId: decision.accountId,
        targetAccountEmail: targetInfo.email,
        targetRemoteFolderId,
        destFileName,
        appProperties,
      });

      ensureLocalFolderHierarchy(decision.virtualPath, sharePoolId);
      if (parentDir !== '/' && parentDir !== '.') {
        createdLocalFolderPaths.add(parentDir);
      }

      const folderId =
        parentDir === '/' || parentDir === '.' ? null : formatFolderId(sharePoolId, parentDir);

      await db.insert(files).values({
        id: newFileId,
        poolId: sharePoolId,
        virtualPath: decision.virtualPath,
        name: destFileName,
        sizeBytes: decision.sizeBytes,
        mimeType: sourceFile.mimeType,
        hash: sourceFile.hash,
        accountId: decision.accountId,
        driveFileId: newDriveFileId,
        folderId,
        isTrashed: false,
      });

      await db
        .update(accounts)
        .set({
          quotaUsedBytes: sql`${accounts.quotaUsedBytes} + ${decision.sizeBytes}`,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, decision.accountId));

      await recordTransfer(decision.accountId, 'upload', decision.sizeBytes);
    }

    if (targets.folders.length > 0) {
      const candidates = await getEligibleAccounts(sharePoolId);
      const participatingList = Array.from(participatingAccountIds);
      const fallbackAccountId =
        candidates
          .filter((c) => participatingAccountIds.has(c.id))
          .sort((a, b) => b.headroomBytes - a.headroomBytes)[0]?.id ?? participatingList[0];

      if (fallbackAccountId) {
        const drive = getDriveClient(fallbackAccountId);
        const rootFolderId = await getAccountRootFolderId(fallbackAccountId);
        for (const folder of targets.folders) {
          if (!createdLocalFolderPaths.has(folder.targetVirtualPath)) {
            await ensureRemoteFolderHierarchy(drive, rootFolderId, folder.targetVirtualPath);
          }
          ensureLocalFolderTreeExact(folder.targetVirtualPath, sharePoolId);
        }
      }
    }
  }

  ensureLocalFolderTreeExact(`/${batchFolderName}`, sharePoolId);

  const { links, emailDeliveries } = await ensureShareBatchPermissionsAndLinks({
    batchFolderName,
    participatingAccountIds: Array.from(participatingAccountIds),
    allocations: accountAllocations,
    recipientEmails,
    emailMessage: params.emailMessage,
  });

  for (const link of links) {
    if (!link.webViewLink) continue;
    await db
      .insert(shareLinks)
      .values({
        id: randomUUID(),
        poolId: sharePoolId,
        batchFolderName,
        accountId: link.accountId,
        driveFolderId: link.rootFolderId,
        webViewLink: link.webViewLink,
        filesCount: link.filesCount,
        bytesAllocated: link.bytesAllocated,
      })
      .onConflictDoUpdate({
        target: [shareLinks.poolId, shareLinks.batchFolderName, shareLinks.accountId],
        set: {
          driveFolderId: link.rootFolderId,
          webViewLink: link.webViewLink,
          filesCount: link.filesCount,
          bytesAllocated: link.bytesAllocated,
        },
      });
  }

  return {
    sharePoolId,
    batchFolderName,
    totalBytes: targets.totalBytes,
    fileCount: targets.fileCount,
    folderCount: targets.folderCount,
    links,
    emailDeliveries,
  };
}

export async function clearSharePool(sharePoolId: number): Promise<ClearSharePoolResult> {
  const poolRow = sqlite
    .prepare('SELECT id, is_share_pool as isSharePool FROM pools WHERE id = ?')
    .get(sharePoolId) as { id: number; isSharePool: number } | undefined;

  if (!poolRow) {
    throw new SharePoolNotFoundError(`Pool ${sharePoolId} not found`);
  }
  if (!poolRow.isSharePool) {
    throw new ShareValidationError(`Pool ${sharePoolId} is not the Share Pool`);
  }

  const poolAccounts = await db
    .select()
    .from(accounts)
    .where(eq(accounts.poolId, sharePoolId));

  const warnings: string[] = [];
  const deletedDriveAccountIds = new Set<string>();

  for (const acc of poolAccounts) {
    const isAuthorized = Boolean(authPool.getRecord(acc.id)?.authorized);
    if (!isAuthorized || !acc.rootFolderId) continue;

    try {
      const drive = getDriveClient(acc.id);
      let pageToken: string | undefined = undefined;

      do {
        const listRes: any = await drive.files.list({
          q: `'${acc.rootFolderId}' in parents`,
          fields: 'nextPageToken, files(id, name)',
          pageSize: 100,
          pageToken,
          spaces: 'drive',
          supportsAllDrives: false,
        });

        for (const item of listRes.data.files || []) {
          if (item.id) {
            await deleteDriveFileIgnoreNotFound(acc.id, item.id);
            deletedDriveAccountIds.add(acc.id);
          }
        }

        pageToken = listRes.data.nextPageToken || undefined;
      } while (pageToken);
    } catch (err) {
      const msg = `Drive clear warning for ${acc.email}: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(msg);
      warnings.push(msg);
    }
  }

  clearRemoteFolderCache();

  const summary = sqlite.transaction(() => {
    const fileStats = sqlite
      .prepare('SELECT COUNT(*) as cnt, COALESCE(SUM(size_bytes), 0) as totalBytes FROM files WHERE pool_id = ?')
      .get(sharePoolId) as { cnt: number; totalBytes: number };
    const folderStats = sqlite
      .prepare('SELECT COUNT(*) as cnt FROM folders WHERE pool_id = ?')
      .get(sharePoolId) as { cnt: number };

    const bytesByAccount = sqlite
      .prepare('SELECT account_id as accountId, COALESCE(SUM(size_bytes), 0) as bytes FROM files WHERE pool_id = ? GROUP BY account_id')
      .all(sharePoolId) as Array<{ accountId: string; bytes: number }>;

    sqlite.prepare('DELETE FROM files WHERE pool_id = ?').run(sharePoolId);
    sqlite.prepare('DELETE FROM folders WHERE pool_id = ?').run(sharePoolId);
    sqlite.prepare('DELETE FROM share_links WHERE pool_id = ?').run(sharePoolId);

    const updateQuotaStmt = sqlite.prepare(
      'UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes - ?), updated_at = unixepoch() WHERE id = ?'
    );
    for (const row of bytesByAccount) {
      updateQuotaStmt.run(row.bytes, row.accountId);
    }

    return {
      filesRemoved: Number(fileStats?.cnt ?? 0),
      foldersRemoved: Number(folderStats?.cnt ?? 0),
      bytesReclaimed: Number(fileStats?.totalBytes ?? 0),
      affectedAccountIds: bytesByAccount.map((row) => row.accountId),
    };
  })();

  for (const accountId of summary.affectedAccountIds) {
    deletedDriveAccountIds.add(accountId);
  }
  for (const accountId of deletedDriveAccountIds) {
    markAccountQuotaDecreased(accountId);
  }

  return {
    sharePoolId,
    filesRemoved: summary.filesRemoved,
    foldersRemoved: summary.foldersRemoved,
    bytesReclaimed: summary.bytesReclaimed,
    warnings,
  };
}

export interface StoredShareLink {
  batchFolderName: string;
  accountId: string;
  accountEmail: string;
  accountDisplayName: string;
  driveFolderId: string;
  webViewLink: string;
  filesCount: number;
  bytesAllocated: number;
}

export function listSharePoolLinks(poolId?: number): StoredShareLink[] {
  const resolvedPoolId = poolId ?? findSharePoolRow()?.id;
  if (resolvedPoolId === undefined) return [];

  return sqlite
    .prepare(
      `SELECT
         sl.batch_folder_name as batchFolderName,
         sl.account_id as accountId,
         a.email as accountEmail,
         a.display_name as accountDisplayName,
         sl.drive_folder_id as driveFolderId,
         sl.web_view_link as webViewLink,
         sl.files_count as filesCount,
         sl.bytes_allocated as bytesAllocated
       FROM share_links sl
       INNER JOIN accounts a ON a.id = sl.account_id
       WHERE sl.pool_id = ?
       ORDER BY sl.batch_folder_name DESC, a.email ASC`
    )
    .all(resolvedPoolId) as StoredShareLink[];
}
