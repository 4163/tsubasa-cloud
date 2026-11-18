import path from 'node:path';
import { db, sqlite, buildDirectoryPrefixBounds } from '../db/index.js';
import { files, folders } from '../db/schema.js';
import { eq, and, or, gte, lt } from 'drizzle-orm';
import { authPool } from './auth.js';
import { allocateUniqueVirtualPath } from './operationsDb.js';
import { normalizeVirtualPath } from '../virtualPath.js';
import {
  getEmptyAccountsAcrossAllPools,
  MAX_SINGLE_FILE_BYTES,
  type EmptyShareAccount,
} from '../storage/quota.js';
import {
  getEligibleAccounts,
  simulateBatchPlacement,
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

export interface SharePoolRow {
  id: number;
  name: string;
  driveFolderName: string;
}

async function loadEmptyAccountsWithAuthStatus(nowMs = Date.now()) {
  const authorizedIds = new Set(authPool.getAll().filter((r) => r.authorized).map((r) => r.config.accountId));
  return getEmptyAccountsAcrossAllPools(nowMs, authorizedIds);
}

export function findSharePoolRow(): SharePoolRow | null {
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
  const candidate = allocateUniqueVirtualPath({
    targetDir: '/',
    baseName: originalTopSegment,
    kind: isTopLevelSingleFile ? 'file' : 'folder',
    style: 'numbered',
    startCounter: 2,
    isTaken: (candidatePath) => occupiedTopSegments.has(candidatePath.slice(1)),
  }).slice(1);
  occupiedTopSegments.add(candidate);
  return candidate;
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

export const inFlightBatchFolderNames = new Set<string>();

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

export async function validateShareSelectionAgainstTargets(
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
