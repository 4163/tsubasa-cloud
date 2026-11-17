import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite, buildDirectoryPrefixBounds, bumpPoolRevision } from '../db/index.js';
import { accounts, files, folders, shareLinks } from '../db/schema.js';
import { eq, and, or, gte, lt } from 'drizzle-orm';
import { authPool } from './auth.js';
import {
  getDriveClient,
  getAccountRootFolderId,
  ensureSharePoolExistsInDb,
  switchAccountPool,
  markAccountQuotaDecreased,
  runBoundedConcurrency,
  withDriveRetry,
} from './client.js';
import { copyDriveFileCrossAccount } from './transfer.js';
import { ensureRemoteFolderHierarchy, normalizeVirtualPath, clearRemoteFolderCache } from './mirror.js';
import { ensureLocalParentFolders, ensureLocalFolderPath, formatFolderId } from './sync.js';
import { enqueueDriveOutbox, deleteRemoteFileIgnoreNotFound } from './outbox.js';
import {
  getEmptyAccountsAcrossAllPools,
  invalidatePooledStorageOverview,
  MAX_SINGLE_FILE_BYTES,
  recordTransferSync,
  type EmptyShareAccount,
} from '../storage/quota.js';
import {
  getEligibleAccounts,
  simulateBatchPlacement,
  InsufficientStorageError,
  type BatchPlacementPlan,
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

export interface ExecuteShareResult {
  sharePoolId: number;
  batchFolderName: string;
  totalBytes: number;
  fileCount: number;
  folderCount: number;
  links: ShareAccountLinkResult[];
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
    .prepare('SELECT virtual_path as virtualPath FROM files WHERE pool_id = ? AND folder_id IS NULL')
    .all(sharePoolId) as Array<{ virtualPath: string }>;
  const folderRows = sqlite
    .prepare('SELECT virtual_path as virtualPath FROM folders WHERE pool_id = ? AND parent_folder_id IS NULL')
    .all(sharePoolId) as Array<{ virtualPath: string }>;
  const shareLinkRows = sqlite
    .prepare('SELECT DISTINCT batch_folder_name as batchFolderName FROM share_links WHERE pool_id = ?')
    .all(sharePoolId) as Array<{ batchFolderName: string }>;

  for (const row of [...fileRows, ...folderRows]) {
    const topSeg = normalizeVirtualPath(row.virtualPath).split('/').filter(Boolean)[0];
    if (topSeg) occupied.add(topSeg);
  }
  for (const row of shareLinkRows) {
    if (row.batchFolderName) occupied.add(row.batchFolderName);
  }

  return occupied;
}

const inFlightBatchFolderNames = new Set<string>();

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
  while (occupied.has(candidate) || inFlightBatchFolderNames.has(candidate)) {
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

    const { lower, upper } = buildDirectoryPrefixBounds(sourceFolderPath);

    const matchingFolders = await db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.poolId, sourcePoolId),
          or(
            eq(folders.virtualPath, sourceFolderPath),
            and(gte(folders.virtualPath, lower), lt(folders.virtualPath, upper))
          )
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
          or(
            eq(files.virtualPath, sourceFolderPath),
            and(gte(files.virtualPath, lower), lt(files.virtualPath, upper))
          )
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

async function validateShareSelectionAgainstTargets(
  targets: ShareTargetsResolution,
  selectedAccountIds: string[]
): Promise<{
  validation: ShareValidationResult;
  plan?: BatchPlacementPlan;
  combinedCandidates: CandidateAccount[];
  uniqueSelectedIds: string[];
}> {
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
        validation: {
          valid: false,
          reason: `Account "${accountId}" is not empty or was not found`,
          totalAvailableHeadroomBytes: existingHeadroom,
          requiredBytes: targets.totalBytes,
        },
        combinedCandidates: [],
        uniqueSelectedIds,
      };
    }

    if (emptyAcc.isDisabled) {
      return {
        validation: {
          valid: false,
          reason: `Drive "${emptyAcc.email}" is disabled and cannot join the Share Pool`,
          totalAvailableHeadroomBytes: existingCandidates.reduce((s, c) => s + c.headroomBytes, 0),
          requiredBytes: targets.totalBytes,
        },
        combinedCandidates: [],
        uniqueSelectedIds,
      };
    }

    if (!emptyAcc.authorized) {
      return {
        validation: {
          valid: false,
          reason: `Drive "${emptyAcc.email}" is not authorized`,
          totalAvailableHeadroomBytes: existingCandidates.reduce((s, c) => s + c.headroomBytes, 0),
          requiredBytes: targets.totalBytes,
        },
        combinedCandidates: [],
        uniqueSelectedIds,
      };
    }

    if (emptyAcc.syncState === 'error') {
      return {
        validation: {
          valid: false,
          reason: `Drive "${emptyAcc.email}" is in an error sync state`,
          totalAvailableHeadroomBytes: existingCandidates.reduce((s, c) => s + c.headroomBytes, 0),
          requiredBytes: targets.totalBytes,
        },
        combinedCandidates: [],
        uniqueSelectedIds,
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
      validation: {
        valid: false,
        reason: 'No valid files or folders found to share',
        totalAvailableHeadroomBytes,
        requiredBytes: targets.totalBytes,
      },
      combinedCandidates,
      uniqueSelectedIds,
    };
  }

  if (targets.overCeilingFiles.length > 0) {
    return {
      validation: {
        valid: false,
        reason: `${targets.overCeilingFiles[0].name} exceeds the 14.25 GB single-account ceiling`,
        totalAvailableHeadroomBytes,
        requiredBytes: targets.totalBytes,
      },
      combinedCandidates,
      uniqueSelectedIds,
    };
  }

  if (targets.files.length === 0 && targets.folders.length > 0) {
    if (combinedCandidates.length === 0) {
      return {
        validation: {
          valid: false,
          reason: 'Select at least one empty drive to host the shared folder',
          totalAvailableHeadroomBytes,
          requiredBytes: 0,
        },
        combinedCandidates,
        uniqueSelectedIds,
      };
    }

    const best = [...combinedCandidates].sort((a, b) => b.headroomBytes - a.headroomBytes)[0];
    return {
      validation: {
        valid: true,
        totalAvailableHeadroomBytes,
        requiredBytes: 0,
        accountAllocations: {
          [best.id]: { filesCount: 0, bytesAllocated: 0 },
        },
      },
      combinedCandidates,
      uniqueSelectedIds,
    };
  }

  try {
    const plan = await simulateBatchPlacement(
      toPlacementItems(targets.files),
      combinedCandidates,
      targets.sharePoolId ?? undefined
    );
    return {
      validation: {
        valid: true,
        totalAvailableHeadroomBytes,
        requiredBytes: targets.totalBytes,
        accountAllocations: plan.accountAllocations,
      },
      plan,
      combinedCandidates,
      uniqueSelectedIds,
    };
  } catch (err) {
    return {
      validation: {
        valid: false,
        reason: err instanceof Error ? err.message : String(err),
        totalAvailableHeadroomBytes,
        requiredBytes: targets.totalBytes,
      },
      combinedCandidates,
      uniqueSelectedIds,
    };
  }
}

export async function validateShareSelection(
  sourcePoolId: number,
  items: ShareTargetInput[],
  selectedAccountIds: string[]
): Promise<ShareValidationResult> {
  const targets = await resolveShareTargets(sourcePoolId, items);
  const { validation } = await validateShareSelectionAgainstTargets(targets, selectedAccountIds);
  return validation;
}

async function ensureShareBatchPermissionsAndLinks(params: {
  batchFolderName: string;
  participatingAccountIds: string[];
  allocations: Record<string, { filesCount: number; bytesAllocated: number }>;
}): Promise<ShareAccountLinkResult[]> {
  const { batchFolderName, participatingAccountIds, allocations } = params;
  const batchVirtualPath = `/${batchFolderName}`;

  const links: ShareAccountLinkResult[] = new Array(participatingAccountIds.length);

  await runBoundedConcurrency(
    participatingAccountIds.map((accountId, index) => ({ accountId, index })),
    4,
    async ({ accountId, index }) => {
      const drive = getDriveClient(accountId);
      const accountRootFolderId = await getAccountRootFolderId(accountId);
      const batchFolderId = await ensureRemoteFolderHierarchy(drive, accountRootFolderId, batchVirtualPath);
      const accountRecord = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
      });
      const accountEmail = accountRecord?.email ?? accountId;
      const accountDisplayName = accountRecord?.displayName ?? accountEmail;

      const permListRes = await withDriveRetry(() =>
        drive.permissions.list({
          fileId: batchFolderId,
          fields: 'permissions(id, type, role)',
          supportsAllDrives: false,
        })
      );

      const hasAnyoneReader = (permListRes.data.permissions || []).some(
        (p) => p.type === 'anyone' && p.role === 'reader'
      );

      if (!hasAnyoneReader) {
        await withDriveRetry(() =>
          drive.permissions.create({
            fileId: batchFolderId,
            requestBody: {
              role: 'reader',
              type: 'anyone',
            },
            supportsAllDrives: false,
          })
        );
      }

      const folderRes = await withDriveRetry(() =>
        drive.files.get({
          fileId: batchFolderId,
          fields: 'id, name, webViewLink',
          supportsAllDrives: false,
        })
      );
      const webViewLink =
        folderRes.data.webViewLink || `https://drive.google.com/drive/folders/${encodeURIComponent(batchFolderId)}`;

      const alloc = allocations[accountId] ?? { filesCount: 0, bytesAllocated: 0 };
      links[index] = {
        accountId,
        accountEmail,
        accountDisplayName,
        rootFolderId: batchFolderId,
        webViewLink,
        filesCount: alloc.filesCount,
        bytesAllocated: alloc.bytesAllocated,
      };
    }
  );

  return links;
}

export async function executeShare(params: ExecuteShareParams): Promise<ExecuteShareResult> {
  const sharePoolId = ensureSharePoolExistsInDb();

  let batchFolderName: string;
  do {
    batchFolderName = generateShareBatchFolderName(sharePoolId);
  } while (inFlightBatchFolderNames.has(batchFolderName));
  inFlightBatchFolderNames.add(batchFolderName);

  try {
    const targets = await resolveShareTargets(params.sourcePoolId, params.items, batchFolderName);

    const { validation, plan, combinedCandidates, uniqueSelectedIds } =
      await validateShareSelectionAgainstTargets(targets, params.selectedAccountIds);

    if (!validation.valid) {
      throw new ShareValidationError(validation.reason || 'Selected drives cannot fit the share payload');
    }

    const accountsToSwitch: string[] = [];
    if (uniqueSelectedIds.length > 0) {
      const checkPoolStmt = sqlite.prepare('SELECT pool_id as poolId FROM accounts WHERE id = ?');
      for (const accountId of uniqueSelectedIds) {
        const row = checkPoolStmt.get(accountId) as { poolId: number | null } | undefined;
        if (!row || row.poolId !== sharePoolId) {
          accountsToSwitch.push(accountId);
        }
      }
    }

    await runBoundedConcurrency(accountsToSwitch, 4, async (accountId) => {
      await switchAccountPool(accountId, sharePoolId);
    });

    const participatingAccountIds = new Set<string>();
    const accountAllocations: Record<string, { filesCount: number; bytesAllocated: number }> = {};

    interface CopiedShareFile {
      newFileId: string;
      virtualPath: string;
      destFileName: string;
      parentDir: string;
      sizeBytes: number;
      mimeType: string;
      hash: string | null;
      accountId: string;
      newDriveFileId: string;
    }

    const copiedFiles: CopiedShareFile[] = [];
    const bytesByAccount = new Map<string, number>();
    const createdBatchFolderIds = new Map<string, { rootFolderId: string; batchFolderId: string }>();
    let links: ShareAccountLinkResult[];

    try {
      if (targets.files.length === 0 && targets.folders.length > 0) {
        if (combinedCandidates.length === 0) {
          throw new InsufficientStorageError('No active accounts available in Share Pool');
        }

        const bestAccount = [...combinedCandidates].sort((a, b) => b.headroomBytes - a.headroomBytes)[0];
        const drive = getDriveClient(bestAccount.id);
        const rootFolderId = await getAccountRootFolderId(bestAccount.id);
        const batchFolderId = await ensureRemoteFolderHierarchy(drive, rootFolderId, `/${batchFolderName}`);
        createdBatchFolderIds.set(bestAccount.id, { rootFolderId, batchFolderId });

        await runBoundedConcurrency(targets.folders, 4, async (folder) => {
          await ensureRemoteFolderHierarchy(drive, rootFolderId, folder.targetVirtualPath);
        });

        participatingAccountIds.add(bestAccount.id);
        accountAllocations[bestAccount.id] = { filesCount: 0, bytesAllocated: 0 };
      } else if (plan) {
        const fileByTargetPath = new Map(targets.files.map((f) => [f.targetVirtualPath, f]));
        Object.assign(accountAllocations, plan.accountAllocations);

        const uniqueDirPairs = new Map<string, { accountId: string; parentDir: string }>();
        for (const decision of plan.decisions) {
          participatingAccountIds.add(decision.accountId);
          const parentDir = path.posix.dirname(decision.virtualPath);
          const dirKey = `${decision.accountId}\0${parentDir}`;
          if (!uniqueDirPairs.has(dirKey)) {
            uniqueDirPairs.set(dirKey, { accountId: decision.accountId, parentDir });
          }
        }

        const accountInfoMap = new Map<string, { email: string; rootFolderId: string }>();
        await runBoundedConcurrency(Array.from(participatingAccountIds), 4, async (accountId) => {
          const acc = await db.query.accounts.findFirst({
            where: eq(accounts.id, accountId),
          });
          if (!acc) {
            throw new Error(`Target account ${accountId} not registered`);
          }
          const rootFolderId = await getAccountRootFolderId(accountId);
          accountInfoMap.set(accountId, { email: acc.email, rootFolderId });
        });

        await runBoundedConcurrency(Array.from(accountInfoMap.entries()), 4, async ([accountId, info]) => {
          const driveTarget = getDriveClient(accountId);
          const batchFolderId = await ensureRemoteFolderHierarchy(
            driveTarget,
            info.rootFolderId,
            `/${batchFolderName}`
          );
          createdBatchFolderIds.set(accountId, { rootFolderId: info.rootFolderId, batchFolderId });
        });

        const remoteFolderIdByDirKey = new Map<string, string>();
        await runBoundedConcurrency(Array.from(uniqueDirPairs.entries()), 4, async ([dirKey, pair]) => {
          const targetInfo = accountInfoMap.get(pair.accountId)!;
          const driveTarget = getDriveClient(pair.accountId);
          const folderId = await ensureRemoteFolderHierarchy(
            driveTarget,
            targetInfo.rootFolderId,
            pair.parentDir
          );
          remoteFolderIdByDirKey.set(dirKey, folderId);
        });

        const createdParentDirs = new Set<string>();
        const resultsSlot = new Array<CopiedShareFile>(plan.decisions.length);

        await runBoundedConcurrency(
          plan.decisions.map((decision, index) => ({ decision, index })),
          6,
          async ({ decision, index }) => {
            const sourceFile = fileByTargetPath.get(decision.virtualPath);
            if (!sourceFile) {
              throw new Error(`Missing source file mapping for ${decision.virtualPath}`);
            }

            const targetInfo = accountInfoMap.get(decision.accountId)!;
            const parentDir = path.posix.dirname(decision.virtualPath);
            const targetRemoteFolderId = remoteFolderIdByDirKey.get(`${decision.accountId}\0${parentDir}`)!;

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

            if (parentDir !== '/' && parentDir !== '.') {
              createdParentDirs.add(parentDir);
            }

            resultsSlot[index] = {
              newFileId,
              virtualPath: decision.virtualPath,
              destFileName,
              parentDir,
              sizeBytes: decision.sizeBytes,
              mimeType: sourceFile.mimeType,
              hash: sourceFile.hash,
              accountId: decision.accountId,
              newDriveFileId,
            };
          }
        );

        copiedFiles.push(...resultsSlot);

        if (targets.folders.length > 0) {
          const missingFolders = targets.folders.filter((f) => !createdParentDirs.has(f.targetVirtualPath));
          if (missingFolders.length > 0) {
            const participatingList = Array.from(participatingAccountIds);
            const fallbackAccountId =
              combinedCandidates
                .filter((c) => participatingAccountIds.has(c.id))
                .sort((a, b) => b.headroomBytes - a.headroomBytes)[0]?.id ?? participatingList[0];

            if (fallbackAccountId) {
              const drive = getDriveClient(fallbackAccountId);
              const rootFolderId =
                accountInfoMap.get(fallbackAccountId)?.rootFolderId ??
                (await getAccountRootFolderId(fallbackAccountId));
              if (!createdBatchFolderIds.has(fallbackAccountId)) {
                const batchFolderId = await ensureRemoteFolderHierarchy(drive, rootFolderId, `/${batchFolderName}`);
                createdBatchFolderIds.set(fallbackAccountId, { rootFolderId, batchFolderId });
              }
              await runBoundedConcurrency(missingFolders, 4, async (folder) => {
                await ensureRemoteFolderHierarchy(drive, rootFolderId, folder.targetVirtualPath);
              });
            }
          }
        }
      }

      links = await ensureShareBatchPermissionsAndLinks({
        batchFolderName,
        participatingAccountIds: Array.from(participatingAccountIds),
        allocations: accountAllocations,
      });

      const transferTimestamp = Date.now();
      sqlite.transaction(() => {
        ensureLocalFolderPath(`/${batchFolderName}`, sharePoolId);

        const insertFileStmt = sqlite.prepare(
          `INSERT INTO files (id, pool_id, virtual_path, name, size_bytes, mime_type, hash, account_id, drive_file_id, folder_id, is_trashed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
        );

        for (const item of copiedFiles) {
          ensureLocalParentFolders(item.virtualPath, sharePoolId);
          const folderId =
            item.parentDir === '/' || item.parentDir === '.' ? null : formatFolderId(sharePoolId, item.parentDir);

          insertFileStmt.run(
            item.newFileId,
            sharePoolId,
            item.virtualPath,
            item.destFileName,
            item.sizeBytes,
            item.mimeType,
            item.hash,
            item.accountId,
            item.newDriveFileId,
            folderId
          );

          bytesByAccount.set(item.accountId, (bytesByAccount.get(item.accountId) ?? 0) + item.sizeBytes);
        }

        const updateQuotaStmt = sqlite.prepare(
          'UPDATE accounts SET quota_used_bytes = quota_used_bytes + ?, updated_at = unixepoch() WHERE id = ?'
        );
        for (const [accountId, bytes] of bytesByAccount.entries()) {
          updateQuotaStmt.run(bytes, accountId);
          recordTransferSync(accountId, 'upload', bytes, transferTimestamp, sharePoolId);
        }

        for (const folder of targets.folders) {
          ensureLocalFolderPath(folder.targetVirtualPath, sharePoolId);
        }

        const upsertLinkStmt = sqlite.prepare(
          `INSERT INTO share_links (id, pool_id, batch_folder_name, account_id, drive_folder_id, web_view_link, files_count, bytes_allocated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(pool_id, batch_folder_name, account_id) DO UPDATE SET
             drive_folder_id = excluded.drive_folder_id,
             web_view_link = excluded.web_view_link,
             files_count = excluded.files_count,
             bytes_allocated = excluded.bytes_allocated`
        );

        for (const link of links) {
          if (!link.webViewLink) continue;
          upsertLinkStmt.run(
            randomUUID(),
            sharePoolId,
            batchFolderName,
            link.accountId,
            link.rootFolderId,
            link.webViewLink,
            link.filesCount,
            link.bytesAllocated
          );
        }
      }).immediate();
    } catch (err) {
      for (const [accountId, info] of createdBatchFolderIds.entries()) {
        try {
          const drive = getDriveClient(accountId);
          await deleteRemoteFileIgnoreNotFound(drive, info.batchFolderId);
          clearRemoteFolderCache(info.rootFolderId);
        } catch (cleanupErr) {
          console.warn(
            `Best-effort share batch cleanup failed for account ${accountId}:`,
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          );
        }
      }
      throw err;
    }

    invalidatePooledStorageOverview(sharePoolId);
    bumpPoolRevision(sharePoolId);

    return {
      sharePoolId,
      batchFolderName,
      totalBytes: targets.totalBytes,
      fileCount: targets.fileCount,
      folderCount: targets.folderCount,
      links,
    };
  } finally {
    inFlightBatchFolderNames.delete(batchFolderName);
  }
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

    const shareLinkRows = sqlite
      .prepare(
        'SELECT account_id as accountId, drive_folder_id as driveFolderId, batch_folder_name as batchFolderName FROM share_links WHERE pool_id = ?'
      )
      .all(sharePoolId) as Array<{ accountId: string; driveFolderId: string; batchFolderName: string }>;
    const topFolderRows = sqlite
      .prepare('SELECT name, virtual_path as virtualPath FROM folders WHERE pool_id = ? AND parent_folder_id IS NULL')
      .all(sharePoolId) as Array<{ name: string; virtualPath: string }>;
    const topFileRows = sqlite
      .prepare('SELECT account_id as accountId, name, virtual_path as virtualPath FROM files WHERE pool_id = ? AND folder_id IS NULL')
      .all(sharePoolId) as Array<{ accountId: string; name: string; virtualPath: string }>;

    const folderIdsByAccount = new Map<string, Set<string>>();
    const folderNamesByAccount = new Map<string, Set<string>>();
    const poolWideTopNames = new Set<string>();

    for (const row of shareLinkRows) {
      if (row.driveFolderId) {
        let ids = folderIdsByAccount.get(row.accountId);
        if (!ids) {
          ids = new Set<string>();
          folderIdsByAccount.set(row.accountId, ids);
        }
        ids.add(row.driveFolderId);
      }
      if (row.batchFolderName) {
        let names = folderNamesByAccount.get(row.accountId);
        if (!names) {
          names = new Set<string>();
          folderNamesByAccount.set(row.accountId, names);
        }
        names.add(row.batchFolderName);
      }
    }

    for (const row of topFolderRows) {
      const topName = row.name || normalizeVirtualPath(row.virtualPath).split('/').filter(Boolean)[0];
      if (topName) {
        poolWideTopNames.add(topName);
      }
    }

    for (const row of topFileRows) {
      const topName = row.name || normalizeVirtualPath(row.virtualPath).split('/').filter(Boolean)[0];
      if (topName) {
        let names = folderNamesByAccount.get(row.accountId);
        if (!names) {
          names = new Set<string>();
          folderNamesByAccount.set(row.accountId, names);
        }
        names.add(topName);
      }
    }

    const outboxEntries: Array<{
      accountId: string;
      poolId: number;
      opType: 'clear_share_account';
      payload: {
        sharePoolId: number;
        rootFolderId: string | null;
        batchFolderIds: string[];
        batchFolderNames: string[];
      };
    }> = [];

    for (const acc of poolAccounts) {
      const isAuthorized = Boolean(authPool.getRecord(acc.id)?.authorized);
      if (!isAuthorized) {
        warnings.push(
          `Skipped remote Drive cleanup for unauthorized account ${acc.email || acc.id}; local index entries were removed.`
        );
        continue;
      }
      if (!acc.rootFolderId) {
        warnings.push(
          `Skipped remote Drive cleanup for account ${acc.email || acc.id} without a root folder; local index entries were removed.`
        );
        continue;
      }

      const batchFolderIds = Array.from(folderIdsByAccount.get(acc.id) ?? []);
      const batchFolderNames = Array.from(
        new Set([...(folderNamesByAccount.get(acc.id) ?? []), ...poolWideTopNames])
      );

      if (batchFolderIds.length === 0 && batchFolderNames.length === 0) {
        continue;
      }

      outboxEntries.push({
        accountId: acc.id,
        poolId: sharePoolId,
        opType: 'clear_share_account' as const,
        payload: {
          sharePoolId,
          rootFolderId: acc.rootFolderId,
          batchFolderIds,
          batchFolderNames,
        },
      });
    }

    sqlite.prepare('DELETE FROM files WHERE pool_id = ?').run(sharePoolId);
    sqlite.prepare('DELETE FROM folders WHERE pool_id = ?').run(sharePoolId);
    sqlite.prepare('DELETE FROM share_links WHERE pool_id = ?').run(sharePoolId);

    const updateQuotaStmt = sqlite.prepare(
      'UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes - ?), updated_at = unixepoch() WHERE id = ?'
    );
    for (const row of bytesByAccount) {
      updateQuotaStmt.run(row.bytes, row.accountId);
    }

    if (outboxEntries.length > 0) {
      enqueueDriveOutbox(outboxEntries);
    }

    return {
      filesRemoved: Number(fileStats?.cnt ?? 0),
      foldersRemoved: Number(folderStats?.cnt ?? 0),
      bytesReclaimed: Number(fileStats?.totalBytes ?? 0),
      affectedAccountIds: bytesByAccount.map((row) => row.accountId),
      enqueuedAccountIds: outboxEntries.map((entry) => entry.accountId),
    };
  }).immediate();

  for (const acc of poolAccounts) {
    if (acc.rootFolderId) {
      clearRemoteFolderCache(acc.rootFolderId);
    }
  }

  const affectedAccounts = new Set<string>(summary.affectedAccountIds);
  for (const accountId of summary.enqueuedAccountIds) {
    affectedAccounts.add(accountId);
  }
  for (const accountId of affectedAccounts) {
    markAccountQuotaDecreased(accountId);
  }

  invalidatePooledStorageOverview(sharePoolId);
  bumpPoolRevision(sharePoolId);

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
