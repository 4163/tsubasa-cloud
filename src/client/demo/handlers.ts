import type { EmptyShareAccount } from '../../server/storage/quota.js';
import type {
  DiscrepancyReport,
  ExternalDiscrepancyItem,
  MoveConflictItem,
  PathConflictItem,
  PoolSummary,
  ShareExecuteResult,
  ShareInspectResponse,
  StoredShareLink,
} from '../types.js';
import { getItemNameError, getParentDir, normalizeVirtualPath } from '../utils/virtualPath.js';
import {
  extractParentFolderPaths,
  formatDemoFolderId,
  generateDemoId,
  getAllRecords,
  getDemoBaseName,
  getRecordByKey,
  joinDemoPath,
  loadDemoState,
  resetDemoDatabase,
  runStoreMutation,
  withDemoWriteLock,
  type DemoAccountRecord,
  type DemoDatabaseState,
  type DemoDiscrepancyRecord,
  type DemoFileRecord,
  type DemoFolderRecord,
  type DemoPoolRecord,
  type DemoShareLinkRecord,
  type DemoTransferLogRecord,
} from './db.js';
import {
  assertValidDemoFileSize,
  buildDemoFolderAffinityMap,
  DemoFileExceedsCeilingError,
  DemoInsufficientStorageError,
  getEligibleDemoCandidates,
  planDemoUploadBatchWithConflicts,
  selectDemoPlacementForFile,
  simulateDemoBatchPlacement,
  validateDemoTargetPlacement,
  type DemoCandidateAccount,
  type DemoPlacementItem,
  type DemoUploadPlacementRequestItem,
} from './placement.js';
import {
  buildEmptyAccountsAcrossAllPools,
  buildEmptyTransferStats,
  buildPooledStorageOverview,
  calculateHeadroom,
  calculateUsableLimit,
  computeTransferStatsByAccount,
  DEFAULT_ACCOUNT_QUOTA_BYTES,
  MAX_SINGLE_FILE_BYTES,
} from './quota.js';
import { DEMO_ROSTER } from './roster.js';

export const SHARE_POOL_RESERVE_ID = 1_000_000;
export const SHARE_POOL_FOLDER_NAME = '_Tsubasa~ Pool share';
export const SHARE_POOL_SLUG = 'share-pool';

export class DemoHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly payload?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    code?: string,
    payload?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'DemoHttpError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export interface DemoUploadParams {
  poolId: number;
  virtualPath: string;
  name?: string;
  sizeBytes: number;
  mimeType: string;
  lastModified?: number;
  accountId?: string;
  conflictMode: 'reject' | 'replace' | 'keep_both';
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}

export type DemoUploadResult =
  | { ok: true }
  | { ok: false; aborted: true }
  | { ok: false; aborted?: false; error: string };

export interface DemoAuthorizeResult {
  ok: boolean;
  accountId?: string;
  poolId?: number;
  conflictsCount?: number;
  error?: string;
}

export interface DemoMoveResult {
  id: string;
  kind: 'file' | 'folder';
  type?: 'file' | 'folder';
  oldPath: string;
  newPath: string;
  success: boolean;
  skipped?: boolean;
  error?: string;
}

export interface DemoCopyResult {
  id: string;
  kind: 'file' | 'folder';
  type?: 'file' | 'folder';
  sourcePath: string;
  destPath: string;
  success: boolean;
  error?: string;
}

export interface DemoRebalanceOperationResult {
  fileId: string;
  virtualPath: string;
  sourceAccountId: string;
  targetAccountId: string;
  newDriveFileId: string;
  bytesMoved: number;
}

export interface DemoBatchRebalanceResult {
  sourceAccountId: string;
  targetAccountId: string;
  totalFiles: number;
  totalBytesMoved: number;
  results: DemoRebalanceOperationResult[];
}

function isSharePoolRecord(pool: DemoPoolRecord | undefined, poolId: number): boolean {
  return Boolean(pool?.isSharePool) || poolId === SHARE_POOL_RESERVE_ID;
}

function assertNotSharePool(state: DemoDatabaseState, poolId: number, message: string): void {
  const pool = state.pools.find((p) => p.id === poolId);
  if (isSharePoolRecord(pool, poolId)) {
    throw new DemoHttpError(403, message, 'SHARE_POOL_READ_ONLY');
  }
}

function assertAccountNotInSharePool(
  state: DemoDatabaseState,
  accountId: string,
  message: string
): DemoAccountRecord {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) {
    throw new DemoHttpError(404, `Account ${accountId} not found`, 'NOT_FOUND');
  }
  assertNotSharePool(state, account.poolId, message);
  return account;
}

function validateNameOrThrow(rawName: string, label = 'Name'): string {
  const trimmed = rawName.trim();
  const err = getItemNameError(trimmed, label);
  if (err) {
    throw new DemoHttpError(400, err, 'VALIDATION_ERROR');
  }
  return trimmed;
}

function deriveUniqueSlug(name: string, existingSlugs: Set<string>, poolId: number): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `pool-${poolId}`;
  if (!existingSlugs.has(base)) return base;
  let counter = 2;
  while (existingSlugs.has(`${base}-${counter}`)) {
    counter += 1;
  }
  return `${base}-${counter}`;
}

function splitFileNameExtension(fileName: string): { stem: string; ext: string } {
  const dotIdx = fileName.lastIndexOf('.');
  if (dotIdx <= 0) {
    return { stem: fileName, ext: '' };
  }
  return {
    stem: fileName.slice(0, dotIdx),
    ext: fileName.slice(dotIdx),
  };
}

function allocateUniquePath(options: {
  targetDir: string;
  baseName: string;
  kind: 'file' | 'folder';
  style: 'numbered' | 'copy' | 'restored';
  isTaken: (candidatePath: string) => boolean;
  startCounter?: number;
  skipBase?: boolean;
}): string {
  const { targetDir, baseName, kind, style, isTaken, startCounter = 2, skipBase = false } = options;

  if (!skipBase) {
    const baseCandidate = joinDemoPath(targetDir, baseName);
    if (!isTaken(baseCandidate)) {
      return baseCandidate;
    }
  }

  const { stem, ext } = kind === 'file' ? splitFileNameExtension(baseName) : { stem: baseName, ext: '' };
  let counter = startCounter;

  for (let guard = 0; guard < 10_000; guard++) {
    let candidateName: string;
    if (style === 'copy') {
      candidateName = counter === startCounter ? `${stem} (copy)${ext}` : `${stem} (copy ${counter})${ext}`;
    } else if (style === 'restored') {
      candidateName =
        counter === 1 ? `${stem} (restored)${ext}` : `${stem} (restored ${counter})${ext}`;
    } else {
      candidateName = `${stem} (${counter})${ext}`;
    }

    const candidatePath = joinDemoPath(targetDir, candidateName);
    if (!isTaken(candidatePath)) {
      return candidatePath;
    }
    counter += 1;
  }

  return joinDemoPath(targetDir, `${stem} (${Date.now()})${ext}`);
}

function ensureFolderChainRecords(
  poolId: number,
  folderPath: string,
  existingByPath: Map<string, DemoFolderRecord>,
  nowIso: string
): DemoFolderRecord[] {
  const normalized = normalizeVirtualPath(folderPath);
  if (normalized === '/') return [];

  const created: DemoFolderRecord[] = [];
  const allPaths = [...extractParentFolderPaths(normalized), normalized];

  for (const pathItem of allPaths) {
    if (existingByPath.has(pathItem)) continue;
    const parentPath = getParentDir(pathItem);
    const record: DemoFolderRecord = {
      id: formatDemoFolderId(poolId, pathItem),
      poolId,
      virtualPath: pathItem,
      name: getDemoBaseName(pathItem),
      parentFolderId: parentPath === '/' ? null : formatDemoFolderId(poolId, parentPath),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    existingByPath.set(pathItem, record);
    created.push(record);
  }

  return created;
}

function isDescendantPath(candidatePath: string, ancestorPath: string): boolean {
  if (ancestorPath === '/') return candidatePath !== '/';
  return candidatePath.startsWith(`${ancestorPath}/`);
}

function compareDemoContentMatch(
  sizeA: number,
  hashA: string | null | undefined,
  sizeB: number,
  hashB: string | null | undefined
): 'identical' | 'different' | 'unverified' {
  if (sizeA !== sizeB) return 'different';
  const a = hashA?.trim().toLowerCase() || null;
  const b = hashB?.trim().toLowerCase() || null;
  if (sizeA === 0 && !a && !b) return 'identical';
  if (!a || !b) return 'unverified';
  return a === b ? 'identical' : 'different';
}

function toEpochSeconds(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

function projectClientFile(file: DemoFileRecord) {
  return {
    id: file.id,
    poolId: file.poolId,
    virtualPath: file.virtualPath,
    name: file.name,
    sizeBytes: file.sizeBytes,
    mimeType: file.mimeType,
    accountId: file.accountId,
    folderId: file.folderId,
    isTrashed: file.isTrashed,
    trashedAt: file.trashedAt,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

function projectClientFolder(folder: DemoFolderRecord) {
  return {
    id: folder.id,
    poolId: folder.poolId,
    virtualPath: folder.virtualPath,
    name: folder.name,
    parentFolderId: folder.parentFolderId,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
}

function computeCleanupOrphanShareLinkIds(
  poolId: number,
  files: DemoFileRecord[],
  folders: DemoFolderRecord[],
  shareLinks: DemoShareLinkRecord[]
): string[] {
  const poolFiles = files.filter((f) => f.poolId === poolId);
  const poolFolderPaths = new Set(folders.filter((f) => f.poolId === poolId).map((f) => f.virtualPath));
  const idsToDelete: string[] = [];

  for (const link of shareLinks) {
    if (link.poolId !== poolId) continue;
    const batchPath = `/${link.batchFolderName}`;
    const hasAccountFiles = poolFiles.some(
      (f) =>
        f.accountId === link.accountId &&
        (f.virtualPath === batchPath || f.virtualPath.startsWith(`${batchPath}/`))
    );
    const hasBatchFolder = poolFolderPaths.has(batchPath);
    const hasAnyBatchFiles = poolFiles.some(
      (f) => f.virtualPath === batchPath || f.virtualPath.startsWith(`${batchPath}/`)
    );

    if ((link.filesCount > 0 && !hasAccountFiles) || (!hasBatchFolder && !hasAnyBatchFiles)) {
      idsToDelete.push(link.id);
    }
  }

  return idsToDelete;
}

// --- Pools ---

export async function handleListPools(): Promise<{ pools: Array<PoolSummary & { slug: string; sortOrder: number }> }> {
  const state = await loadDemoState();

  const accCountByPool = new Map<number, number>();
  for (const acc of state.accounts) {
    accCountByPool.set(acc.poolId, (accCountByPool.get(acc.poolId) ?? 0) + 1);
  }

  const fileStatsByPool = new Map<number, { count: number; bytes: number }>();
  for (const file of state.files) {
    if (file.isTrashed) continue;
    const cur = fileStatsByPool.get(file.poolId) ?? { count: 0, bytes: 0 };
    cur.count += 1;
    cur.bytes += file.sizeBytes;
    fileStatsByPool.set(file.poolId, cur);
  }

  const sorted = [...state.pools].sort((a, b) => {
    if (a.isSharePool !== b.isSharePool) return a.isSharePool ? 1 : -1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id - b.id;
  });

  return {
    pools: sorted.map((pool) => {
      const fileStats = fileStatsByPool.get(pool.id) ?? { count: 0, bytes: 0 };
      return {
        id: pool.id,
        name: pool.name,
        slug: pool.slug,
        sortOrder: pool.sortOrder,
        driveFolderName: pool.driveFolderName,
        isSharePool: pool.isSharePool,
        accountCount: accCountByPool.get(pool.id) ?? 0,
        fileCount: fileStats.count,
        totalBytes: fileStats.bytes,
      };
    }),
  };
}

export async function handleCreatePool(input: { name?: string; slug?: string }) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    const existingIds = new Set(state.pools.map((p) => p.id));
    const existingSlugs = new Set(state.pools.map((p) => p.slug));

    let requestedSlug: string | undefined;
    if (input.slug !== undefined) {
      const cleaned = input.slug.trim().toLowerCase();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleaned)) {
        throw new DemoHttpError(400, 'Invalid pool slug format', 'VALIDATION_ERROR');
      }
      if (existingSlugs.has(cleaned)) {
        throw new DemoHttpError(409, `Pool slug '${cleaned}' is already in use`, 'ITEM_EXISTS');
      }
      requestedSlug = cleaned;
    }

    const maxStandardId = state.pools
      .filter((p) => !p.isSharePool)
      .reduce((max, p) => Math.max(max, p.id), 0);
    let nextId = Math.max(state.meta.nextPoolId, maxStandardId + 1);
    while (existingIds.has(nextId) || nextId === SHARE_POOL_RESERVE_ID) {
      nextId += 1;
    }

    const poolName = input.name?.trim() || `Pool ${nextId}`;
    const resolvedSlug = requestedSlug ?? deriveUniqueSlug(poolName, existingSlugs, nextId);
    const maxSort = state.pools
      .filter((p) => !p.isSharePool)
      .reduce((max, p) => Math.max(max, p.sortOrder), 0);
    const sortOrder = maxSort + 1;
    const driveFolderName = `_Tsubasa~ Pool ${nextId}`;
    const nowIso = new Date().toISOString();

    const poolRecord: DemoPoolRecord = {
      id: nextId,
      name: poolName,
      slug: resolvedSlug,
      sortOrder,
      driveFolderName,
      isSharePool: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const nextMeta = {
      ...state.meta,
      nextPoolId: nextId + 1,
    };

    await runStoreMutation(['pools', 'meta'], (tx) => {
      tx.objectStore('pools').put(poolRecord);
      tx.objectStore('meta').put(nextMeta);
    });

    return {
      id: poolRecord.id,
      name: poolRecord.name,
      slug: poolRecord.slug,
      sortOrder: poolRecord.sortOrder,
      driveFolderName: poolRecord.driveFolderName,
      isSharePool: false,
      accountCount: 0,
      fileCount: 0,
      totalBytes: 0,
    };
  });
}

export async function handleRenamePool(poolId: number, input: { name: string; slug?: string }) {
  return withDemoWriteLock(async () => {
    const trimmedName = input.name?.trim();
    if (!trimmedName) {
      throw new DemoHttpError(400, 'name (string) is required');
    }

    const state = await loadDemoState();
    const existing = state.pools.find((p) => p.id === poolId);
    if (!existing) {
      throw new DemoHttpError(404, `Pool ${poolId} not found`, 'NOT_FOUND');
    }
    if (existing.isSharePool) {
      throw new DemoHttpError(403, 'Share Pool cannot be renamed or modified', 'SHARE_POOL_PROTECTED');
    }

    let nextSlug = existing.slug;
    if (input.slug !== undefined) {
      const cleaned = input.slug.trim().toLowerCase();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleaned)) {
        throw new DemoHttpError(400, 'Invalid pool slug format', 'VALIDATION_ERROR');
      }
      if (state.pools.some((p) => p.id !== poolId && p.slug === cleaned)) {
        throw new DemoHttpError(409, `Pool slug '${cleaned}' is already in use`, 'ITEM_EXISTS');
      }
      nextSlug = cleaned;
    }

    const updated: DemoPoolRecord = {
      ...existing,
      name: trimmedName,
      slug: nextSlug,
      updatedAt: new Date().toISOString(),
    };

    await runStoreMutation(['pools'], (tx) => {
      tx.objectStore('pools').put(updated);
    });

    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      sortOrder: updated.sortOrder,
      driveFolderName: updated.driveFolderName,
      isSharePool: updated.isSharePool,
    };
  });
}

export async function handleDeletePool(poolId: number) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    const existing = state.pools.find((p) => p.id === poolId);
    if (!existing) {
      throw new DemoHttpError(404, `Pool ${poolId} not found`, 'NOT_FOUND');
    }
    if (existing.isSharePool) {
      throw new DemoHttpError(403, 'Share Pool cannot be deleted', 'SHARE_POOL_PROTECTED');
    }

    const standardPools = state.pools.filter((p) => !p.isSharePool);
    if (standardPools.length <= 1) {
      throw new DemoHttpError(409, 'Cannot delete the only remaining storage pool', 'LAST_POOL');
    }
    if (state.accounts.some((a) => a.poolId === poolId)) {
      throw new DemoHttpError(409, 'Cannot delete pool: pool contains accounts', 'POOL_NOT_EMPTY');
    }
    if (state.files.some((f) => f.poolId === poolId)) {
      throw new DemoHttpError(409, 'Cannot delete pool: pool contains files', 'POOL_NOT_EMPTY');
    }

    const folderIdsToDelete = state.folders.filter((f) => f.poolId === poolId).map((f) => f.id);

    await runStoreMutation(['pools', 'folders'], (tx) => {
      const foldersStore = tx.objectStore('folders');
      for (const id of folderIdsToDelete) {
        foldersStore.delete(id);
      }
      tx.objectStore('pools').delete(poolId);
    });

    return {
      success: true,
      id: poolId,
      name: existing.name,
    };
  });
}

// --- Storage & Placement ---

export async function handleStorageOverview(poolId: number) {
  const state = await loadDemoState();
  return buildPooledStorageOverview(poolId, state.accounts, state.files, state.transferLogs, Date.now());
}

export async function handleAccountTransferStats(accountId: string) {
  const logs = await getAllRecords<DemoTransferLogRecord>('transferLogs');
  const map = computeTransferStatsByAccount([accountId], logs, Date.now());
  return map.get(accountId) ?? buildEmptyTransferStats(accountId);
}

export async function handlePlacementFile(input: {
  virtualPath: string;
  sizeBytes: number;
  poolId?: number;
}) {
  const state = await loadDemoState();
  const poolId = input.poolId ?? 1;
  return selectDemoPlacementForFile(
    { virtualPath: input.virtualPath, sizeBytes: input.sizeBytes },
    poolId,
    state.accounts,
    state.files,
    state.transferLogs,
    Date.now()
  );
}

export async function handlePlacementBatch(input: {
  items: DemoUploadPlacementRequestItem[];
  poolId?: number;
}) {
  const state = await loadDemoState();
  const poolId = input.poolId ?? 1;
  return planDemoUploadBatchWithConflicts(
    input.items,
    poolId,
    state.accounts,
    state.files,
    state.transferLogs,
    Date.now()
  );
}

// --- Accounts & Modified OAuth ---

export async function handleGetAccounts(poolId?: number) {
  const state = await loadDemoState();
  const accountsWithFiles = new Set(state.files.map((f) => f.accountId));

  const list = state.accounts.map((acc) => ({
    accountId: acc.id,
    clientId: acc.clientId,
    authorized: acc.authorized,
    sourceFile: acc.sourceFile,
    isDisabled: acc.isDisabled,
    mtimeMs: acc.mtimeMs,
    poolId: acc.poolId,
    canSwitchPool: !accountsWithFiles.has(acc.id),
    _email: acc.email,
  }));

  list.sort((a, b) => {
    if (!a.authorized && b.authorized) return -1;
    if (a.authorized && !b.authorized) return 1;

    if (!a.authorized && !b.authorized) {
      if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return a.accountId.localeCompare(b.accountId);
    }

    const emailA = (a._email || a.accountId).toLowerCase();
    const emailB = (b._email || b.accountId).toLowerCase();
    return emailA.localeCompare(emailB, undefined, { numeric: true, sensitivity: 'base' });
  });

  const filtered = poolId !== undefined ? list.filter((item) => item.poolId === poolId) : list;
  return {
    accounts: filtered.map(({ _email: _, ...rest }) => rest),
  };
}

export async function handleImportOAuth(input: {
  filename: string;
  content: string;
  poolId?: number;
}) {
  return withDemoWriteLock(async () => {
    const filename = input.filename.trim();
    if (!filename.toLowerCase().endsWith('.json')) {
      throw new DemoHttpError(400, 'Please select a .json OAuth credential file.', 'VALIDATION_ERROR');
    }

    const state = await loadDemoState();
    const poolId = input.poolId ?? 1;
    assertNotSharePool(state, poolId, 'Adding drives directly to Share Pool is disabled');

    const stem = filename.replace(/\.json$/i, '').trim() || 'oauth-drive';
    const shortRand = Math.random().toString(36).slice(2, 7);
    const accountId = `oauth-${Date.now().toString(36)}-${shortRand}`;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const record: DemoAccountRecord = {
      id: accountId,
      email: stem,
      displayName: stem,
      avatarUrl: null,
      poolId,
      quotaLimitBytes: 0,
      quotaUsedBytes: 0,
      syncState: 'idle',
      isDisabled: false,
      authorized: false,
      sourceFile: filename,
      clientId: `demo-client-${shortRand}.apps.googleusercontent.com`,
      mtimeMs: nowMs,
      rootFolderId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await runStoreMutation(['accounts'], (tx) => {
      tx.objectStore('accounts').put(record);
    });

    return {
      success: true,
      accountId,
      authorized: false,
      poolId,
      filesIndexed: 0,
      conflictsCount: 0,
    };
  });
}

export function handleGetAuthUrl(accountId: string): { url: string } {
  const encodedState = encodeURIComponent(accountId);
  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?client_id=tsubasa-demo.apps.googleusercontent.com&redirect_uri=http%3A%2F%2Flocalhost%2Fapi%2Fauth%2Fcallback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive&access_type=offline&state=${encodedState}`,
  };
}

export async function authorizeDemoAccount(accountId: string): Promise<DemoAuthorizeResult> {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    const existing = state.accounts.find((a) => a.id === accountId);
    if (!existing) {
      return { ok: false, error: `Account ${accountId} not found` };
    }
    if (existing.authorized) {
      return {
        ok: true,
        accountId: existing.id,
        poolId: existing.poolId,
        conflictsCount: 0,
      };
    }

    const usedLower = new Set(state.meta.usedPersonaEmails.map((e) => e.toLowerCase()));
    let nextUsedEmails = [...state.meta.usedPersonaEmails];
    let unusedPersonas = DEMO_ROSTER.filter((p) => !usedLower.has(p.email.toLowerCase()));

    // Refill the 14-persona pool once every persona has been drawn.
    if (unusedPersonas.length === 0) {
      nextUsedEmails = [];
      unusedPersonas = [...DEMO_ROSTER];
    }

    const existingAccountIds = new Set(state.accounts.map((a) => a.id.toLowerCase()));
    const existingAccountEmails = new Set(state.accounts.map((a) => a.email.toLowerCase()));
    const nonMountedCandidates = unusedPersonas.filter(
      (p) => !existingAccountEmails.has(p.email.toLowerCase())
    );
    const drawPool = nonMountedCandidates.length > 0 ? nonMountedCandidates : unusedPersonas;
    const picked = drawPool[Math.floor(Math.random() * drawPool.length)];

    nextUsedEmails.push(picked.email);

    let canonicalId = picked.email;
    if (existingAccountIds.has(canonicalId.toLowerCase())) {
      let suffix = 2;
      while (existingAccountIds.has(`${picked.email}#${suffix}`.toLowerCase())) {
        suffix += 1;
      }
      canonicalId = `${picked.email}#${suffix}`;
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const authorizedRecord: DemoAccountRecord = {
      id: canonicalId,
      email: picked.email,
      displayName: picked.displayName,
      avatarUrl: picked.avatarUrl,
      poolId: existing.poolId,
      quotaLimitBytes: DEFAULT_ACCOUNT_QUOTA_BYTES,
      quotaUsedBytes: 0,
      syncState: 'idle',
      isDisabled: false,
      authorized: true,
      sourceFile: existing.sourceFile,
      clientId: existing.clientId,
      mtimeMs: nowMs,
      rootFolderId: `demo-root-${canonicalId}`,
      createdAt: existing.createdAt ?? nowIso,
      updatedAt: nowIso,
    };

    const nextMeta = {
      ...state.meta,
      usedPersonaEmails: nextUsedEmails,
    };

    await runStoreMutation(['accounts', 'meta'], (tx) => {
      const accountsStore = tx.objectStore('accounts');
      accountsStore.delete(existing.id);
      accountsStore.put(authorizedRecord);
      tx.objectStore('meta').put(nextMeta);
    });

    return {
      ok: true,
      accountId: authorizedRecord.id,
      poolId: authorizedRecord.poolId,
      conflictsCount: 0,
    };
  });
}

export async function handleSetAccountDisabled(accountId: string, isDisabled: boolean) {
  return withDemoWriteLock(async () => {
    const account = await getRecordByKey<DemoAccountRecord>('accounts', accountId);
    if (!account) {
      throw new DemoHttpError(404, `Account ${accountId} not found`, 'NOT_FOUND');
    }

    const updated: DemoAccountRecord = {
      ...account,
      isDisabled,
      updatedAt: new Date().toISOString(),
    };
    await runStoreMutation(['accounts'], (tx) => {
      tx.objectStore('accounts').put(updated);
    });
    return { success: true, accountId };
  });
}

export async function handleSwitchAccountPool(accountId: string, targetPoolId: number) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    const account = state.accounts.find((a) => a.id === accountId);
    if (!account) {
      throw new DemoHttpError(404, `Account ${accountId} not found`, 'NOT_FOUND');
    }

    const nowIso = new Date().toISOString();
    let createdSharePool: DemoPoolRecord | null = null;
    const targetPool = state.pools.find((p) => p.id === targetPoolId);

    if (!targetPool) {
      if (targetPoolId === SHARE_POOL_RESERVE_ID) {
        createdSharePool = {
          id: SHARE_POOL_RESERVE_ID,
          name: 'Share Pool',
          slug: SHARE_POOL_SLUG,
          sortOrder: SHARE_POOL_RESERVE_ID,
          driveFolderName: SHARE_POOL_FOLDER_NAME,
          isSharePool: true,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
      } else {
        throw new DemoHttpError(404, `Target storage pool ${targetPoolId} does not exist`, 'NOT_FOUND');
      }
    }

    const hasFiles = state.files.some((f) => f.accountId === accountId);
    if (hasFiles) {
      throw new DemoHttpError(
        409,
        'Cannot switch pool: this account already has files linked to its current pool.',
        'ACCOUNT_POOL_LOCKED'
      );
    }

    const updatedAccount: DemoAccountRecord = {
      ...account,
      poolId: targetPoolId,
      updatedAt: nowIso,
    };

    const shareLinkIdsToDelete = state.shareLinks
      .filter((link) => link.accountId === accountId)
      .map((link) => link.id);

    await runStoreMutation(['accounts', 'pools', 'shareLinks'], (tx) => {
      if (createdSharePool) {
        tx.objectStore('pools').put(createdSharePool);
      }
      tx.objectStore('accounts').put(updatedAccount);
      const linksStore = tx.objectStore('shareLinks');
      for (const linkId of shareLinkIdsToDelete) {
        linksStore.delete(linkId);
      }
    });

    return {
      accountId,
      poolId: targetPoolId,
      rootFolderId: updatedAccount.rootFolderId,
    };
  });
}

export async function handleRemoveAccount(accountId: string) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    const account = state.accounts.find((a) => a.id === accountId);
    if (!account) {
      throw new DemoHttpError(404, `Account ${accountId} not found`, 'NOT_FOUND');
    }

    const accountFiles = state.files.filter((f) => f.accountId === accountId);
    const shareLinkIdsToDelete = state.shareLinks
      .filter((l) => l.accountId === accountId)
      .map((l) => l.id);

    if (accountFiles.length === 0) {
      await runStoreMutation(['accounts', 'discrepancies', 'shareLinks'], (tx) => {
        tx.objectStore('accounts').delete(accountId);
        tx.objectStore('discrepancies').delete(accountId);
        const linksStore = tx.objectStore('shareLinks');
        for (const id of shareLinkIdsToDelete) linksStore.delete(id);
      });

      return {
        sourceAccountId: accountId,
        filesMoved: 0,
        bytesMoved: 0,
        transfers: [],
        removed: true,
        queued: false,
        jobId: null,
      };
    }

    const otherCandidates = getEligibleDemoCandidates(
      account.poolId,
      state.accounts.filter((a) => a.id !== accountId),
      state.transferLogs,
      Date.now()
    );

    if (otherCandidates.length === 0) {
      throw new DemoInsufficientStorageError(
        'No other active drives are available in this pool to evacuate files before removal.'
      );
    }

    const affinityMap =
      otherCandidates.length > 1
        ? buildDemoFolderAffinityMap(
            account.poolId,
            state.files.filter((f) => f.accountId !== accountId)
          )
        : undefined;

    const placementPlan = simulateDemoBatchPlacement(
      accountFiles.map((f) => ({ virtualPath: f.virtualPath, sizeBytes: f.sizeBytes })),
      otherCandidates,
      affinityMap
    );

    const decisionByPath = new Map<string, string>();
    for (const dec of placementPlan.decisions) {
      decisionByPath.set(dec.virtualPath, dec.accountId);
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const updatedAccounts = new Map<string, DemoAccountRecord>();
    const updatedFiles: DemoFileRecord[] = [];
    const newLogs: DemoTransferLogRecord[] = [];
    let bytesMoved = 0;

    for (const file of accountFiles) {
      const targetId = decisionByPath.get(normalizeVirtualPath(file.virtualPath));
      if (!targetId) {
        throw new DemoInsufficientStorageError(
          `Not enough headroom to evacuate "${file.name}" to another drive in this pool.`
        );
      }

      const targetAcc =
        updatedAccounts.get(targetId) ?? state.accounts.find((a) => a.id === targetId);
      if (!targetAcc) {
        throw new DemoHttpError(500, `Target account ${targetId} not found`);
      }

      const nextTarget: DemoAccountRecord = {
        ...targetAcc,
        quotaUsedBytes: targetAcc.quotaUsedBytes + file.sizeBytes,
        updatedAt: nowIso,
      };
      updatedAccounts.set(targetId, nextTarget);

      updatedFiles.push({
        ...file,
        accountId: targetId,
        driveFileId: generateDemoId('demo-drv'),
        updatedAt: nowIso,
      });

      if (file.sizeBytes > 0) {
        newLogs.push({
          id: generateDemoId('tx'),
          accountId: targetId,
          transferType: 'upload',
          byteCount: file.sizeBytes,
          timestamp: nowMs,
        });
      }
      bytesMoved += file.sizeBytes;
    }

    await runStoreMutation(['accounts', 'files', 'transferLogs', 'discrepancies', 'shareLinks'], (tx) => {
      const accountsStore = tx.objectStore('accounts');
      const filesStore = tx.objectStore('files');
      const logsStore = tx.objectStore('transferLogs');
      const linksStore = tx.objectStore('shareLinks');

      for (const acc of updatedAccounts.values()) {
        accountsStore.put(acc);
      }
      for (const file of updatedFiles) {
        filesStore.put(file);
      }
      for (const log of newLogs) {
        logsStore.put(log);
      }
      accountsStore.delete(accountId);
      tx.objectStore('discrepancies').delete(accountId);
      for (const linkId of shareLinkIdsToDelete) {
        linksStore.delete(linkId);
      }
    });

    return {
      sourceAccountId: accountId,
      filesMoved: updatedFiles.length,
      bytesMoved,
      transfers: [],
      removed: true,
      queued: false,
      jobId: null,
    };
  });
}

// --- Files & Folders ---

export async function handleListFiles(poolId: number, folderPath = '/', mode: 'tree' | 'dir' = 'tree') {
  const state = await loadDemoState();
  const normPath = normalizeVirtualPath(folderPath);

  if (mode === 'dir') {
    const targetFolderId = normPath === '/' ? null : formatDemoFolderId(poolId, normPath);
    const matchingFiles = state.files
      .filter((f) => f.poolId === poolId && !f.isTrashed && f.folderId === targetFolderId)
      .map(projectClientFile);
    const matchingFolders = state.folders
      .filter((f) => f.poolId === poolId && f.parentFolderId === targetFolderId)
      .map(projectClientFolder);

    return {
      currentPath: normPath,
      folders: matchingFolders,
      files: matchingFiles,
    };
  }

  return {
    currentPath: normPath,
    folders: state.folders.filter((f) => f.poolId === poolId).map(projectClientFolder),
    files: state.files.filter((f) => f.poolId === poolId && !f.isTrashed).map(projectClientFile),
  };
}

export async function handleListFolders(poolId: number) {
  const state = await loadDemoState();
  return {
    folders: state.folders.filter((f) => f.poolId === poolId).map(projectClientFolder),
  };
}

export async function handleCreateFolder(input: {
  virtualPath: string;
  name: string;
  poolId?: number;
}) {
  return withDemoWriteLock(async () => {
    const poolId = input.poolId ?? 1;
    const state = await loadDemoState();
    assertNotSharePool(state, poolId, 'Creating folders directly in Share Pool is disabled');

    const trimmedName = validateNameOrThrow(input.name, 'Folder name');
    const normalizedPath = normalizeVirtualPath(input.virtualPath);
    if (normalizedPath === '/') {
      throw new DemoHttpError(400, 'Invalid folder path');
    }
    for (const seg of normalizedPath.split('/').filter(Boolean)) {
      validateNameOrThrow(seg, 'Folder name');
    }
    if (getDemoBaseName(normalizedPath) !== trimmedName) {
      throw new DemoHttpError(400, 'Folder name does not match the basename of virtualPath');
    }

    const poolFolders = state.folders.filter((f) => f.poolId === poolId);
    if (poolFolders.some((f) => f.virtualPath === normalizedPath)) {
      throw new DemoHttpError(
        409,
        `A folder named "${trimmedName}" already exists in this directory`,
        'FOLDER_EXISTS'
      );
    }
    if (
      state.files.some(
        (f) => f.poolId === poolId && !f.isTrashed && f.virtualPath === normalizedPath
      )
    ) {
      throw new DemoHttpError(
        409,
        `A file named "${trimmedName}" already exists in this directory`,
        'ITEM_EXISTS'
      );
    }

    const existingByPath = new Map(poolFolders.map((f) => [f.virtualPath, f]));
    const created = ensureFolderChainRecords(
      poolId,
      normalizedPath,
      existingByPath,
      new Date().toISOString()
    );

    await runStoreMutation(['folders'], (tx) => {
      const store = tx.objectStore('folders');
      for (const folder of created) {
        store.put(folder);
      }
    });

    return {
      id: formatDemoFolderId(poolId, normalizedPath),
      poolId,
      virtualPath: normalizedPath,
      name: trimmedName,
    };
  });
}

export async function handleDeleteFolder(query: {
  virtualPath?: string;
  path?: string;
  id?: string;
  poolId: number;
}) {
  return withDemoWriteLock(async () => {
    const { poolId } = query;
    const state = await loadDemoState();
    const rawPath = query.virtualPath || query.path;

    let normPath: string;
    if (rawPath) {
      normPath = normalizeVirtualPath(rawPath);
    } else if (query.id) {
      const found = state.folders.find((f) => f.id === query.id && f.poolId === poolId);
      if (!found) {
        throw new DemoHttpError(404, 'Folder not found', 'NOT_FOUND');
      }
      normPath = found.virtualPath;
    } else {
      throw new DemoHttpError(400, 'virtualPath query parameter required');
    }

    if (normPath === '/') {
      throw new DemoHttpError(400, 'Cannot delete root folder');
    }

    const folderId = formatDemoFolderId(poolId, normPath);
    const nowIso = new Date().toISOString();

    const filesToTrash: DemoFileRecord[] = [];
    for (const f of state.files) {
      if (
        f.poolId === poolId &&
        !f.isTrashed &&
        (isDescendantPath(f.virtualPath, normPath) || f.folderId === folderId)
      ) {
        filesToTrash.push({
          ...f,
          isTrashed: true,
          trashedAt: nowIso,
          updatedAt: nowIso,
        });
      }
    }

    const foldersToDelete = state.folders.filter(
      (f) => f.poolId === poolId && (f.virtualPath === normPath || isDescendantPath(f.virtualPath, normPath))
    );

    const remainingFilesInSubtree = state.files.some(
      (f) =>
        f.poolId === poolId &&
        (isDescendantPath(f.virtualPath, normPath) || f.folderId === folderId)
    );
    const shareLinksToDelete = !remainingFilesInSubtree
      ? state.shareLinks
          .filter((l) => l.poolId === poolId && `/${l.batchFolderName}` === normPath)
          .map((l) => l.id)
      : [];

    // Soft-delete keeps account.quotaUsedBytes unchanged (quota reclaims only on permanent purge).
    await runStoreMutation(['files', 'folders', 'shareLinks'], (tx) => {
      const filesStore = tx.objectStore('files');
      const foldersStore = tx.objectStore('folders');
      const linksStore = tx.objectStore('shareLinks');
      for (const f of filesToTrash) {
        filesStore.put(f);
      }
      for (const folder of foldersToDelete) {
        foldersStore.delete(folder.id);
      }
      for (const linkId of shareLinksToDelete) {
        linksStore.delete(linkId);
      }
    });

    return {
      success: true,
      virtualPath: normPath,
      trashedCount: filesToTrash.length,
    };
  });
}

// --- Items CRUD (Rename, Move, Copy) ---

export async function handleRenameItem(input: {
  kind: 'file' | 'folder';
  id: string;
  name: string;
  poolId?: number;
}) {
  return withDemoWriteLock(async () => {
    const poolId = input.poolId ?? 1;
    const state = await loadDemoState();
    assertNotSharePool(state, poolId, 'Renaming items inside Share Pool is disabled');

    const newName = validateNameOrThrow(input.name);
    const nowIso = new Date().toISOString();

    if (input.kind === 'file') {
      const file = state.files.find(
        (f) => f.poolId === poolId && (f.id === input.id || f.virtualPath === input.id)
      );
      if (!file) {
        throw new DemoHttpError(404, `File not found: ${input.id}`, 'NOT_FOUND');
      }

      const parentDir = getParentDir(file.virtualPath);
      const newVirtualPath = joinDemoPath(parentDir, newName);
      if (newVirtualPath === file.virtualPath) {
        return { success: true, oldPath: file.virtualPath, newPath: newVirtualPath };
      }

      const collidingFile = state.files.find(
        (f) => f.poolId === poolId && !f.isTrashed && f.virtualPath === newVirtualPath && f.id !== file.id
      );
      if (collidingFile) {
        throw new DemoHttpError(409, `A file named "${newName}" already exists in this folder`, 'ITEM_EXISTS');
      }

      const collidingFolder = state.folders.find(
        (f) => f.poolId === poolId && f.virtualPath === newVirtualPath
      );
      if (collidingFolder) {
        throw new DemoHttpError(409, `A folder named "${newName}" already exists in this directory`, 'ITEM_EXISTS');
      }

      const displacedTrashed = state.files
        .filter((f) => f.poolId === poolId && f.isTrashed && f.virtualPath === newVirtualPath && f.id !== file.id)
        .map((f) => ({
          ...f,
          virtualPath: `${f.virtualPath}.trashed-${Date.now()}-${f.id.slice(0, 6)}`,
          updatedAt: nowIso,
        }));

      const updatedFile: DemoFileRecord = {
        ...file,
        name: newName,
        virtualPath: newVirtualPath,
        folderId: parentDir === '/' ? null : formatDemoFolderId(poolId, parentDir),
        updatedAt: nowIso,
      };

      await runStoreMutation(['files'], (tx) => {
        const store = tx.objectStore('files');
        for (const d of displacedTrashed) store.put(d);
        store.put(updatedFile);
      });

      return { success: true, oldPath: file.virtualPath, newPath: newVirtualPath };
    }

    const folder = state.folders.find(
      (f) => f.poolId === poolId && (f.id === input.id || f.virtualPath === input.id)
    );
    if (!folder) {
      throw new DemoHttpError(404, `Folder not found: ${input.id}`, 'NOT_FOUND');
    }

    const oldFolderPath = folder.virtualPath;
    const parentDir = getParentDir(oldFolderPath);
    const newFolderPath = joinDemoPath(parentDir, newName);
    if (newFolderPath === oldFolderPath) {
      return { success: true, oldPath: oldFolderPath, newPath: newFolderPath };
    }

    if (state.folders.some((f) => f.poolId === poolId && f.virtualPath === newFolderPath && f.id !== folder.id)) {
      throw new DemoHttpError(409, `A folder named "${newName}" already exists in this directory`, 'ITEM_EXISTS');
    }
    if (state.files.some((f) => f.poolId === poolId && !f.isTrashed && f.virtualPath === newFolderPath)) {
      throw new DemoHttpError(409, `A file named "${newName}" already exists in this directory`, 'ITEM_EXISTS');
    }

    const oldFolderId = folder.id;
    const descendantFolders = state.folders.filter(
      (f) => f.poolId === poolId && isDescendantPath(f.virtualPath, oldFolderPath)
    );
    const descendantFiles = state.files.filter(
      (f) => f.poolId === poolId && (isDescendantPath(f.virtualPath, oldFolderPath) || f.folderId === oldFolderId)
    );

    const foldersToDeleteIds = [folder.id, ...descendantFolders.map((f) => f.id)];
    const newFolderRecord: DemoFolderRecord = {
      id: formatDemoFolderId(poolId, newFolderPath),
      poolId,
      virtualPath: newFolderPath,
      name: newName,
      parentFolderId: parentDir === '/' ? null : formatDemoFolderId(poolId, parentDir),
      createdAt: folder.createdAt,
      updatedAt: nowIso,
    };

    const updatedSubFolders: DemoFolderRecord[] = descendantFolders.map((sub) => {
      const subNewPath = normalizeVirtualPath(newFolderPath + sub.virtualPath.slice(oldFolderPath.length));
      const subParent = getParentDir(subNewPath);
      return {
        ...sub,
        id: formatDemoFolderId(poolId, subNewPath),
        virtualPath: subNewPath,
        parentFolderId: subParent === '/' ? null : formatDemoFolderId(poolId, subParent),
        updatedAt: nowIso,
      };
    });

    const updatedFiles: DemoFileRecord[] = descendantFiles.map((f) => {
      const fileNewPath = f.virtualPath.startsWith(`${oldFolderPath}/`)
        ? normalizeVirtualPath(newFolderPath + f.virtualPath.slice(oldFolderPath.length))
        : joinDemoPath(newFolderPath, f.name);
      const fileParent = getParentDir(fileNewPath);
      return {
        ...f,
        virtualPath: fileNewPath,
        folderId: fileParent === '/' ? null : formatDemoFolderId(poolId, fileParent),
        updatedAt: nowIso,
      };
    });

    await runStoreMutation(['folders', 'files'], (tx) => {
      const foldersStore = tx.objectStore('folders');
      const filesStore = tx.objectStore('files');
      for (const id of foldersToDeleteIds) foldersStore.delete(id);
      foldersStore.put(newFolderRecord);
      for (const sf of updatedSubFolders) foldersStore.put(sf);
      for (const uf of updatedFiles) filesStore.put(uf);
    });

    return { success: true, oldPath: oldFolderPath, newPath: newFolderPath };
  });
}

export async function handleMoveItems(input: {
  items: Array<{ kind: 'file' | 'folder'; id: string }>;
  targetFolderPath: string;
  poolId?: number;
  conflictMode?: 'reject' | 'skip' | 'keep_both' | 'overwrite';
}): Promise<DemoMoveResult[]> {
  return withDemoWriteLock(async () => {
    const poolId = input.poolId ?? 1;
    const conflictMode = input.conflictMode ?? 'reject';
    const state = await loadDemoState();
    assertNotSharePool(state, poolId, 'Moving items inside Share Pool is disabled');

    const destFolder = normalizeVirtualPath(input.targetFolderPath);
    if (
      destFolder !== '/' &&
      state.files.some((f) => f.poolId === poolId && !f.isTrashed && f.virtualPath === destFolder)
    ) {
      throw new DemoHttpError(409, `A file already exists at "${destFolder}"`, 'ITEM_EXISTS');
    }

    const poolFiles = state.files.filter((f) => f.poolId === poolId);
    const poolFolders = state.folders.filter((f) => f.poolId === poolId);

    const activeFileByPath = new Map<string, DemoFileRecord>();
    for (const f of poolFiles) {
      if (!f.isTrashed) activeFileByPath.set(f.virtualPath, f);
    }
    const folderByPath = new Map<string, DemoFolderRecord>(poolFolders.map((f) => [f.virtualPath, f]));

    type Resolved =
      | { kind: 'file'; file: DemoFileRecord }
      | { kind: 'folder'; folder: DemoFolderRecord }
      | { kind: 'missing'; id: string; resolvedKind: 'file' | 'folder' };

    const resolved: Resolved[] = [];
    const seenIds = new Set<string>();
    const selectedFolderPaths: string[] = [];
    const selectedFileIds = new Set<string>();

    for (const item of input.items) {
      if (item.kind === 'file') {
        const file = poolFiles.find((f) => f.id === item.id || f.virtualPath === item.id);
        if (!file) {
          resolved.push({ kind: 'missing', id: item.id, resolvedKind: 'file' });
          continue;
        }
        if (seenIds.has(file.id)) continue;
        seenIds.add(file.id);
        selectedFileIds.add(file.id);
        resolved.push({ kind: 'file', file });
      } else {
        const folder = poolFolders.find((f) => f.id === item.id || f.virtualPath === item.id);
        if (!folder) {
          resolved.push({ kind: 'missing', id: item.id, resolvedKind: 'folder' });
          continue;
        }
        if (seenIds.has(folder.id)) continue;
        seenIds.add(folder.id);
        selectedFolderPaths.push(folder.virtualPath);
        resolved.push({ kind: 'folder', folder });
      }
    }

    // Prune items already covered by a selected ancestor folder.
    const pruned = resolved.filter((entry) => {
      if (entry.kind === 'missing') return true;
      const itemPath = entry.kind === 'file' ? entry.file.virtualPath : entry.folder.virtualPath;
      return !selectedFolderPaths.some((anc) => anc !== itemPath && isDescendantPath(itemPath, anc));
    });

    const results: DemoMoveResult[] = [];
    const conflicts: MoveConflictItem[] = [];
    let cleanCount = 0;

    const claimedFilePaths = new Set<string>();
    const claimedSourceByPath = new Map<string, DemoFileRecord>();
    const claimedFolderPaths = new Set<string>();
    const overwriteTargets = new Map<string, DemoFileRecord>();
    const fileMutations = new Map<string, DemoFileRecord>();
    const folderDeletes = new Set<string>();
    const folderUpserts = new Map<string, DemoFolderRecord>();

    const nowIso = new Date().toISOString();

    const isPathTakenForKeepBoth = (candidate: string): boolean =>
      claimedFilePaths.has(candidate) ||
      claimedFolderPaths.has(candidate) ||
      activeFileByPath.has(candidate) ||
      folderByPath.has(candidate);

    const planSingleFile = (
      source: DemoFileRecord,
      targetDir: string
    ): { status: 'noop' | 'move' | 'skip' | 'conflict' | 'error'; destPath?: string; error?: string } => {
      const desiredPath = joinDemoPath(targetDir, source.name);
      if (desiredPath === source.virtualPath && !source.isTrashed) {
        claimedFilePaths.add(desiredPath);
        claimedSourceByPath.set(desiredPath, source);
        return { status: 'noop', destPath: desiredPath };
      }

      if (claimedFolderPaths.has(desiredPath) || folderByPath.has(desiredPath)) {
        return {
          status: 'error',
          destPath: desiredPath,
          error: `A folder named "${source.name}" already exists in the destination folder`,
        };
      }

      const existingActive = activeFileByPath.get(desiredPath);
      const isExistingCollision = Boolean(existingActive && existingActive.id !== source.id);
      const isBatchCollision = claimedFilePaths.has(desiredPath);

      if (!isExistingCollision && !isBatchCollision) {
        claimedFilePaths.add(desiredPath);
        claimedSourceByPath.set(desiredPath, source);
        cleanCount += 1;
        const parentDir = getParentDir(desiredPath);
        fileMutations.set(source.id, {
          ...source,
          name: getDemoBaseName(desiredPath),
          virtualPath: desiredPath,
          folderId: parentDir === '/' ? null : formatDemoFolderId(poolId, parentDir),
          isTrashed: false,
          trashedAt: null,
          updatedAt: nowIso,
        });
        return { status: 'move', destPath: desiredPath };
      }

      if (conflictMode === 'reject') {
        const preExisting =
          !isBatchCollision && existingActive && existingActive.id !== source.id
            ? existingActive
            : undefined;
        const compareTarget = preExisting ?? claimedSourceByPath.get(desiredPath);
        conflicts.push({
          sourceFileId: source.id,
          sourcePath: source.virtualPath,
          sourceName: source.name,
          sourceSizeBytes: source.sizeBytes,
          sourceUpdatedAt: toEpochSeconds(source.updatedAt),
          destPath: desiredPath,
          ...(preExisting ? { existingFileId: preExisting.id } : {}),
          ...(compareTarget
            ? {
                existingSizeBytes: compareTarget.sizeBytes,
                existingUpdatedAt: toEpochSeconds(compareTarget.updatedAt),
              }
            : {}),
          contentMatch: compareTarget
            ? compareDemoContentMatch(
                source.sizeBytes,
                source.hash,
                compareTarget.sizeBytes,
                compareTarget.hash
              )
            : 'unverified',
          canOverwrite: Boolean(preExisting && !selectedFileIds.has(preExisting.id)),
        });
        return { status: 'conflict', destPath: desiredPath };
      }

      if (conflictMode === 'skip') {
        return { status: 'skip', destPath: source.virtualPath };
      }

      if (
        conflictMode === 'overwrite' &&
        existingActive &&
        existingActive.id !== source.id &&
        !selectedFileIds.has(existingActive.id) &&
        !claimedFilePaths.has(desiredPath)
      ) {
        overwriteTargets.set(existingActive.id, existingActive);
        claimedFilePaths.add(desiredPath);
        const parentDir = getParentDir(desiredPath);
        fileMutations.set(source.id, {
          ...source,
          name: getDemoBaseName(desiredPath),
          virtualPath: desiredPath,
          folderId: parentDir === '/' ? null : formatDemoFolderId(poolId, parentDir),
          isTrashed: false,
          trashedAt: null,
          updatedAt: nowIso,
        });
        return { status: 'move', destPath: desiredPath };
      }

      const keepBothPath = allocateUniquePath({
        targetDir,
        baseName: source.name,
        kind: 'file',
        style: 'numbered',
        startCounter: 2,
        skipBase: true,
        isTaken: isPathTakenForKeepBoth,
      });
      claimedFilePaths.add(keepBothPath);
      const parentDir = getParentDir(keepBothPath);
      fileMutations.set(source.id, {
        ...source,
        name: getDemoBaseName(keepBothPath),
        virtualPath: keepBothPath,
        folderId: parentDir === '/' ? null : formatDemoFolderId(poolId, parentDir),
        isTrashed: false,
        trashedAt: null,
        updatedAt: nowIso,
      });
      return { status: 'move', destPath: keepBothPath };
    };

    const foldersToEnsure = new Set<string>();
    if (destFolder !== '/') foldersToEnsure.add(destFolder);

    for (const entry of pruned) {
      if (entry.kind === 'missing') {
        results.push({
          id: entry.id,
          kind: entry.resolvedKind,
          type: entry.resolvedKind,
          oldPath: entry.id,
          newPath: '',
          success: false,
          error: entry.resolvedKind === 'folder' ? 'Folder not found' : 'File not found',
        });
        continue;
      }

      if (entry.kind === 'file') {
        const res = planSingleFile(entry.file, destFolder);
        if (res.status === 'noop' || res.status === 'move') {
          results.push({
            id: entry.file.id,
            kind: 'file',
            type: 'file',
            oldPath: entry.file.virtualPath,
            newPath: res.destPath ?? entry.file.virtualPath,
            success: true,
          });
        } else if (res.status === 'skip') {
          results.push({
            id: entry.file.id,
            kind: 'file',
            type: 'file',
            oldPath: entry.file.virtualPath,
            newPath: entry.file.virtualPath,
            success: true,
            skipped: true,
          });
        } else if (res.status === 'error') {
          results.push({
            id: entry.file.id,
            kind: 'file',
            type: 'file',
            oldPath: entry.file.virtualPath,
            newPath: res.destPath ?? '',
            success: false,
            error: res.error,
          });
        }
        continue;
      }

      const folder = entry.folder;
      const oldFolderPath = folder.virtualPath;
      if (destFolder === oldFolderPath || isDescendantPath(destFolder, oldFolderPath)) {
        results.push({
          id: folder.id,
          kind: 'folder',
          type: 'folder',
          oldPath: oldFolderPath,
          newPath: '',
          success: false,
          error: 'Cannot move a folder into itself or a subfolder',
        });
        continue;
      }

      const newFolderPath = joinDemoPath(destFolder, folder.name);
      if (newFolderPath === oldFolderPath) {
        results.push({
          id: folder.id,
          kind: 'folder',
          type: 'folder',
          oldPath: oldFolderPath,
          newPath: newFolderPath,
          success: true,
        });
        continue;
      }

      if (activeFileByPath.has(newFolderPath) || claimedFilePaths.has(newFolderPath)) {
        results.push({
          id: folder.id,
          kind: 'folder',
          type: 'folder',
          oldPath: oldFolderPath,
          newPath: newFolderPath,
          success: false,
          error: `A file named "${folder.name}" already exists in the destination folder`,
        });
        continue;
      }

      const descendantFolders = poolFolders.filter((f) => isDescendantPath(f.virtualPath, oldFolderPath));
      const descendantFiles = poolFiles.filter(
        (f) => isDescendantPath(f.virtualPath, oldFolderPath) || f.folderId === folder.id
      );

      let subTypeError: string | null = null;
      for (const sub of descendantFolders) {
        const subDest = normalizeVirtualPath(newFolderPath + sub.virtualPath.slice(oldFolderPath.length));
        if (activeFileByPath.has(subDest) || claimedFilePaths.has(subDest)) {
          subTypeError = `A file named "${sub.name}" already exists at "${subDest}"`;
          break;
        }
      }
      if (subTypeError) {
        results.push({
          id: folder.id,
          kind: 'folder',
          type: 'folder',
          oldPath: oldFolderPath,
          newPath: newFolderPath,
          success: false,
          error: subTypeError,
        });
        continue;
      }

      claimedFolderPaths.add(newFolderPath);
      foldersToEnsure.add(newFolderPath);
      for (const sub of descendantFolders) {
        const subDest = normalizeVirtualPath(newFolderPath + sub.virtualPath.slice(oldFolderPath.length));
        claimedFolderPaths.add(subDest);
        foldersToEnsure.add(subDest);
      }

      let folderConflictHit = false;
      let folderFileError: string | null = null;
      let skippedInFolder = 0;

      for (const df of descendantFiles) {
        const rel = df.virtualPath.startsWith(`${oldFolderPath}/`)
          ? df.virtualPath.slice(oldFolderPath.length)
          : `/${df.name}`;
        const targetPath = normalizeVirtualPath(newFolderPath + rel);
        const targetDir = getParentDir(targetPath);

        if (df.isTrashed) {
          fileMutations.set(df.id, {
            ...df,
            virtualPath: targetPath,
            folderId: targetDir === '/' ? null : formatDemoFolderId(poolId, targetDir),
            updatedAt: nowIso,
          });
          continue;
        }

        const fileRes = planSingleFile(df, targetDir);
        if (fileRes.status === 'conflict') {
          folderConflictHit = true;
        } else if (fileRes.status === 'error') {
          folderFileError = folderFileError ?? (fileRes.error || 'Move conflict');
        } else if (fileRes.status === 'skip') {
          skippedInFolder += 1;
        }
      }

      if (folderFileError) {
        results.push({
          id: folder.id,
          kind: 'folder',
          type: 'folder',
          oldPath: oldFolderPath,
          newPath: newFolderPath,
          success: false,
          error: folderFileError,
        });
        continue;
      }

      if (folderConflictHit) {
        results.push({
          id: folder.id,
          kind: 'folder',
          type: 'folder',
          oldPath: oldFolderPath,
          newPath: newFolderPath,
          success: false,
          error: 'Destination has conflicting files',
        });
        continue;
      }

      if (skippedInFolder === 0) {
        folderDeletes.add(folder.id);
        for (const sub of descendantFolders) {
          folderDeletes.add(sub.id);
        }
      }

      cleanCount += 1;
      results.push({
        id: folder.id,
        kind: 'folder',
        type: 'folder',
        oldPath: oldFolderPath,
        newPath: newFolderPath,
        success: true,
      });
    }

    if (conflictMode === 'reject' && conflicts.length > 0) {
      throw new DemoHttpError(
        409,
        conflicts.length === 1
          ? `"${conflicts[0].sourceName}" already exists in the destination folder`
          : `${conflicts.length} files already exist in the destination folder`,
        'MOVE_CONFLICT',
        { conflicts, cleanCount }
      );
    }

    if (fileMutations.size > 0 || folderDeletes.size > 0 || overwriteTargets.size > 0) {
      const existingFolderMap = new Map(poolFolders.map((f) => [f.virtualPath, f]));
      for (const pathToEnsure of foldersToEnsure) {
        for (const created of ensureFolderChainRecords(poolId, pathToEnsure, existingFolderMap, nowIso)) {
          folderUpserts.set(created.id, created);
        }
      }

      // Overwritten destination files are permanently deleted and their quota is reclaimed.
      const quotaReclaimByAccount = new Map<string, number>();
      for (const target of overwriteTargets.values()) {
        quotaReclaimByAccount.set(
          target.accountId,
          (quotaReclaimByAccount.get(target.accountId) ?? 0) + target.sizeBytes
        );
      }

      const updatedAccounts: DemoAccountRecord[] = [];
      for (const [accId, reclaimed] of quotaReclaimByAccount) {
        const acc = state.accounts.find((a) => a.id === accId);
        if (acc) {
          updatedAccounts.push({
            ...acc,
            quotaUsedBytes: Math.max(0, acc.quotaUsedBytes - reclaimed),
            updatedAt: nowIso,
          });
        }
      }

      await runStoreMutation(['files', 'folders', 'accounts'], (tx) => {
        const filesStore = tx.objectStore('files');
        const foldersStore = tx.objectStore('folders');
        const accountsStore = tx.objectStore('accounts');

        for (const target of overwriteTargets.values()) {
          filesStore.delete(target.id);
        }
        for (const id of folderDeletes) {
          if (!folderUpserts.has(id)) {
            foldersStore.delete(id);
          }
        }
        for (const f of folderUpserts.values()) {
          foldersStore.put(f);
        }
        for (const f of fileMutations.values()) {
          filesStore.put(f);
        }
        for (const acc of updatedAccounts) {
          accountsStore.put(acc);
        }
      });
    }

    return results;
  });
}

export async function handleCopyItems(input: {
  items: Array<{ kind: 'file' | 'folder'; id: string }>;
  targetFolderPath: string;
  poolId?: number;
}): Promise<DemoCopyResult[]> {
  return withDemoWriteLock(async () => {
    const poolId = input.poolId ?? 1;
    const state = await loadDemoState();
    assertNotSharePool(state, poolId, 'Copying items inside Share Pool is disabled');

    const destFolder = normalizeVirtualPath(input.targetFolderPath);
    const poolFiles = state.files.filter((f) => f.poolId === poolId);
    const poolFolders = state.folders.filter((f) => f.poolId === poolId);

    if (
      destFolder !== '/' &&
      poolFiles.some((f) => !f.isTrashed && f.virtualPath === destFolder)
    ) {
      throw new DemoHttpError(409, `A file already exists at "${destFolder}"`, 'ITEM_EXISTS');
    }

    const occupiedFilePaths = new Set(poolFiles.filter((f) => !f.isTrashed).map((f) => f.virtualPath));
    const occupiedFolderPaths = new Set(poolFolders.map((f) => f.virtualPath));
    const occupiedAny = (p: string) => occupiedFilePaths.has(p) || occupiedFolderPaths.has(p);

    const results: DemoCopyResult[] = [];
    const foldersToEnsure: string[] = destFolder !== '/' ? [destFolder] : [];

    interface CopyTask {
      resultIndex: number;
      isTopLevelFile: boolean;
      source: DemoFileRecord;
      destVirtualPath: string;
    }

    const tasks: CopyTask[] = [];
    const seenIds = new Set<string>();
    const selectedFolderPaths: string[] = [];

    for (const item of input.items) {
      if (item.kind === 'folder') {
        const f = poolFolders.find((x) => x.id === item.id || x.virtualPath === item.id);
        if (f) selectedFolderPaths.push(f.virtualPath);
      }
    }

    for (const item of input.items) {
      if (item.kind === 'file') {
        const file = poolFiles.find((f) => f.id === item.id || f.virtualPath === item.id);
        if (!file) {
          results.push({
            id: item.id,
            kind: 'file',
            type: 'file',
            sourcePath: item.id,
            destPath: '',
            success: false,
            error: 'File not found',
          });
          continue;
        }
        if (
          seenIds.has(file.id) ||
          selectedFolderPaths.some((anc) => isDescendantPath(file.virtualPath, anc))
        ) {
          continue;
        }
        seenIds.add(file.id);

        const destPath = allocateUniquePath({
          targetDir: destFolder,
          baseName: file.name,
          kind: 'file',
          style: 'copy',
          isTaken: occupiedAny,
        });
        occupiedFilePaths.add(destPath);

        const resultIndex = results.length;
        results.push({
          id: file.id,
          kind: 'file',
          type: 'file',
          sourcePath: file.virtualPath,
          destPath,
          success: false,
        });
        tasks.push({ resultIndex, isTopLevelFile: true, source: file, destVirtualPath: destPath });
      } else {
        const folder = poolFolders.find((f) => f.id === item.id || f.virtualPath === item.id);
        if (!folder) {
          results.push({
            id: item.id,
            kind: 'folder',
            type: 'folder',
            sourcePath: item.id,
            destPath: '',
            success: false,
            error: 'Folder not found',
          });
          continue;
        }
        if (
          seenIds.has(folder.id) ||
          selectedFolderPaths.some(
            (anc) => anc !== folder.virtualPath && isDescendantPath(folder.virtualPath, anc)
          )
        ) {
          continue;
        }
        seenIds.add(folder.id);

        const destFolderPath = allocateUniquePath({
          targetDir: destFolder,
          baseName: folder.name,
          kind: 'folder',
          style: 'copy',
          isTaken: occupiedAny,
        });
        occupiedFolderPaths.add(destFolderPath);
        foldersToEnsure.push(destFolderPath);

        const subFolders = poolFolders.filter((sf) => isDescendantPath(sf.virtualPath, folder.virtualPath));
        for (const sf of subFolders) {
          const destSub = normalizeVirtualPath(destFolderPath + sf.virtualPath.slice(folder.virtualPath.length));
          occupiedFolderPaths.add(destSub);
          foldersToEnsure.push(destSub);
        }

        const resultIndex = results.length;
        results.push({
          id: destFolderPath,
          kind: 'folder',
          type: 'folder',
          sourcePath: folder.virtualPath,
          destPath: destFolderPath,
          success: true,
        });

        const subFiles = poolFiles.filter(
          (f) =>
            !f.isTrashed &&
            (isDescendantPath(f.virtualPath, folder.virtualPath) || f.folderId === folder.id)
        );
        for (const sf of subFiles) {
          const rel = sf.virtualPath.startsWith(`${folder.virtualPath}/`)
            ? sf.virtualPath.slice(folder.virtualPath.length)
            : `/${sf.name}`;
          const destFilePath = normalizeVirtualPath(destFolderPath + rel);
          occupiedFilePaths.add(destFilePath);
          tasks.push({
            resultIndex,
            isTopLevelFile: false,
            source: sf,
            destVirtualPath: destFilePath,
          });
        }
      }
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const existingFolderMap = new Map(poolFolders.map((f) => [f.virtualPath, f]));
    const newFolders: DemoFolderRecord[] = [];
    for (const fp of foldersToEnsure) {
      newFolders.push(...ensureFolderChainRecords(poolId, fp, existingFolderMap, nowIso));
    }

    const newFiles: DemoFileRecord[] = [];
    const newLogs: DemoTransferLogRecord[] = [];
    const addedBytesByAccount = new Map<string, number>();

    if (tasks.length > 0) {
      const candidates = getEligibleDemoCandidates(poolId, state.accounts, state.transferLogs, nowMs);
      const affinityMap =
        candidates.length > 1 ? buildDemoFolderAffinityMap(poolId, state.files) : undefined;

      const plan = simulateDemoBatchPlacement(
        tasks.map((t) => ({ virtualPath: t.destVirtualPath, sizeBytes: t.source.sizeBytes })),
        candidates,
        affinityMap
      );

      const decisionByPath = new Map(plan.decisions.map((d) => [d.virtualPath, d.accountId]));

      for (const task of tasks) {
        const targetAccId = decisionByPath.get(task.destVirtualPath);
        if (!targetAccId) {
          results[task.resultIndex].success = false;
          results[task.resultIndex].error = 'Insufficient storage headroom';
          continue;
        }

        const newFileId = generateDemoId('file');
        const parentDir = getParentDir(task.destVirtualPath);
        newFiles.push({
          id: newFileId,
          poolId,
          virtualPath: task.destVirtualPath,
          name: getDemoBaseName(task.destVirtualPath),
          sizeBytes: task.source.sizeBytes,
          mimeType: task.source.mimeType,
          hash: task.source.hash,
          accountId: targetAccId,
          driveFileId: generateDemoId('demo-drv'),
          folderId: parentDir === '/' ? null : formatDemoFolderId(poolId, parentDir),
          isTrashed: false,
          trashedAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
          contentText: task.source.contentText,
        });

        addedBytesByAccount.set(
          targetAccId,
          (addedBytesByAccount.get(targetAccId) ?? 0) + task.source.sizeBytes
        );
        if (task.source.sizeBytes > 0) {
          newLogs.push({
            id: generateDemoId('tx'),
            accountId: targetAccId,
            transferType: 'upload',
            byteCount: task.source.sizeBytes,
            timestamp: nowMs,
          });
        }

        if (task.isTopLevelFile) {
          results[task.resultIndex].id = newFileId;
          results[task.resultIndex].success = true;
        }
      }
    }

    const updatedAccounts: DemoAccountRecord[] = [];
    for (const [accId, addedBytes] of addedBytesByAccount) {
      const acc = state.accounts.find((a) => a.id === accId);
      if (acc) {
        updatedAccounts.push({
          ...acc,
          quotaUsedBytes: acc.quotaUsedBytes + addedBytes,
          updatedAt: nowIso,
        });
      }
    }

    if (newFolders.length > 0 || newFiles.length > 0) {
      await runStoreMutation(['folders', 'files', 'accounts', 'transferLogs'], (tx) => {
        const foldersStore = tx.objectStore('folders');
        const filesStore = tx.objectStore('files');
        const accountsStore = tx.objectStore('accounts');
        const logsStore = tx.objectStore('transferLogs');
        for (const f of newFolders) foldersStore.put(f);
        for (const f of newFiles) filesStore.put(f);
        for (const a of updatedAccounts) accountsStore.put(a);
        for (const l of newLogs) logsStore.put(l);
      });
    }

    return results;
  });
}

// --- Trash & Permanent Purge ---

export async function handleListTrash(poolId: number) {
  const state = await loadDemoState();
  return {
    files: state.files.filter((f) => f.poolId === poolId && f.isTrashed).map(projectClientFile),
  };
}

export async function handleTrashFile(fileId: string) {
  return withDemoWriteLock(async () => {
    const file = await getRecordByKey<DemoFileRecord>('files', fileId);
    if (!file) {
      throw new DemoHttpError(404, `File ${fileId} not found`, 'NOT_FOUND');
    }
    if (file.isTrashed) {
      return projectClientFile(file);
    }

    const nowIso = new Date().toISOString();
    const updated: DemoFileRecord = {
      ...file,
      isTrashed: true,
      trashedAt: nowIso,
      updatedAt: nowIso,
    };

    // Soft-delete leaves account.quotaUsedBytes unchanged.
    await runStoreMutation(['files'], (tx) => {
      tx.objectStore('files').put(updated);
    });

    return projectClientFile(updated);
  });
}

export async function handleRestoreFile(fileId: string) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    const file = state.files.find((f) => f.id === fileId);
    if (!file) {
      throw new DemoHttpError(404, `File ${fileId} not found`, 'NOT_FOUND');
    }

    const strippedPath = file.virtualPath.replace(/\.trashed-\d+(?:-[a-zA-Z0-9]+)?$/, '');
    const activePaths = new Set(
      state.files
        .filter((f) => f.poolId === file.poolId && !f.isTrashed && f.id !== file.id)
        .map((f) => f.virtualPath)
    );
    const folderPaths = new Set(
      state.folders.filter((f) => f.poolId === file.poolId).map((f) => f.virtualPath)
    );

    const restoredPath = allocateUniquePath({
      targetDir: getParentDir(strippedPath),
      baseName: getDemoBaseName(strippedPath),
      kind: 'file',
      style: 'restored',
      startCounter: 1,
      isTaken: (p) => activePaths.has(p) || folderPaths.has(p),
    });

    const parentDir = getParentDir(restoredPath);
    const nowIso = new Date().toISOString();
    const existingFolders = new Map(
      state.folders.filter((f) => f.poolId === file.poolId).map((f) => [f.virtualPath, f])
    );
    const createdFolders =
      parentDir !== '/'
        ? ensureFolderChainRecords(file.poolId, parentDir, existingFolders, nowIso)
        : [];

    const updatedFile: DemoFileRecord = {
      ...file,
      virtualPath: restoredPath,
      name: getDemoBaseName(restoredPath),
      folderId: parentDir === '/' ? null : formatDemoFolderId(file.poolId, parentDir),
      isTrashed: false,
      trashedAt: null,
      updatedAt: nowIso,
    };

    await runStoreMutation(['files', 'folders'], (tx) => {
      const foldersStore = tx.objectStore('folders');
      for (const folder of createdFolders) foldersStore.put(folder);
      tx.objectStore('files').put(updatedFile);
    });

    return projectClientFile(updatedFile);
  });
}

export async function handlePurgeFile(fileId: string) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    const file = state.files.find((f) => f.id === fileId);
    if (!file) {
      throw new DemoHttpError(404, `File ${fileId} not found`, 'NOT_FOUND');
    }

    const account = state.accounts.find((a) => a.id === file.accountId);
    const nowIso = new Date().toISOString();
    const updatedAccount: DemoAccountRecord | null = account
      ? {
          ...account,
          quotaUsedBytes: Math.max(0, account.quotaUsedBytes - file.sizeBytes),
          updatedAt: nowIso,
        }
      : null;

    const remainingFiles = state.files.filter((f) => f.id !== fileId);
    const orphanLinkIds = computeCleanupOrphanShareLinkIds(
      file.poolId,
      remainingFiles,
      state.folders,
      state.shareLinks
    );

    await runStoreMutation(['files', 'accounts', 'shareLinks'], (tx) => {
      tx.objectStore('files').delete(fileId);
      if (updatedAccount) {
        tx.objectStore('accounts').put(updatedAccount);
      }
      const linksStore = tx.objectStore('shareLinks');
      for (const id of orphanLinkIds) linksStore.delete(id);
    });

    return projectClientFile(file);
  });
}

export async function handleEmptyTrash(poolId: number) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    const trashed = state.files.filter((f) => f.poolId === poolId && f.isTrashed);
    if (trashed.length === 0) {
      return { filesPurged: 0, bytesReclaimed: 0 };
    }

    const bytesByAccount = new Map<string, number>();
    let bytesReclaimed = 0;
    const trashedIds = new Set<string>();
    for (const f of trashed) {
      trashedIds.add(f.id);
      bytesReclaimed += f.sizeBytes;
      bytesByAccount.set(f.accountId, (bytesByAccount.get(f.accountId) ?? 0) + f.sizeBytes);
    }

    const nowIso = new Date().toISOString();
    const updatedAccounts: DemoAccountRecord[] = [];
    for (const [accId, bytes] of bytesByAccount) {
      const acc = state.accounts.find((a) => a.id === accId);
      if (acc) {
        updatedAccounts.push({
          ...acc,
          quotaUsedBytes: Math.max(0, acc.quotaUsedBytes - bytes),
          updatedAt: nowIso,
        });
      }
    }

    const remainingFiles = state.files.filter((f) => !trashedIds.has(f.id));
    const orphanLinkIds = computeCleanupOrphanShareLinkIds(
      poolId,
      remainingFiles,
      state.folders,
      state.shareLinks
    );

    await runStoreMutation(['files', 'accounts', 'shareLinks'], (tx) => {
      const filesStore = tx.objectStore('files');
      const accountsStore = tx.objectStore('accounts');
      const linksStore = tx.objectStore('shareLinks');
      for (const id of trashedIds) filesStore.delete(id);
      for (const acc of updatedAccounts) accountsStore.put(acc);
      for (const id of orphanLinkIds) linksStore.delete(id);
    });

    return {
      filesPurged: trashed.length,
      bytesReclaimed,
    };
  });
}

// --- Sync, External Changes & Rebalance ---

export async function handleSyncAll(poolId: number) {
  const state = await loadDemoState();
  assertNotSharePool(state, poolId, 'Fetching Drive changes is disabled on Share Pool');

  const authorizedIds = state.accounts
    .filter((a) => a.poolId === poolId && a.authorized)
    .map((a) => a.id);

  return {
    hydrated: authorizedIds,
    synced: authorizedIds,
    errors: [] as Array<{ accountId: string; error: string }>,
  };
}

export async function handleGetExternalChanges(accountId: string): Promise<DiscrepancyReport> {
  const state = await loadDemoState();
  const account = assertAccountNotInSharePool(
    state,
    accountId,
    'External change resolution is disabled for Share Pool accounts'
  );
  const pool = state.pools.find((p) => p.id === account.poolId);
  const poolFolderName = pool?.driveFolderName ?? `_Tsubasa~ Pool ${account.poolId}`;
  const stored = state.discrepancies.find((d) => d.accountId === accountId);

  if (stored) {
    return {
      ...stored,
      poolFolderName,
    };
  }

  const activeCount = state.files.filter((f) => f.accountId === accountId && !f.isTrashed).length;
  return {
    accountId,
    poolFolderName,
    scannedFiles: activeCount,
    conflicts: [],
    unindexed: [],
    modified: [],
    overCeiling: [],
    missingRemote: [],
  };
}

function stripDriveIdFromDiscrepancy(
  report: DemoDiscrepancyRecord,
  driveFileId: string
): DemoDiscrepancyRecord {
  return {
    ...report,
    conflicts: report.conflicts.filter((c) => c.driveFileId !== driveFileId),
    unindexed: report.unindexed.filter((u) => u.driveFileId !== driveFileId),
    modified: report.modified.filter((m) => m.driveFileId !== driveFileId),
    overCeiling: report.overCeiling.filter((o) => o.driveFileId !== driveFileId),
    missingRemote: report.missingRemote.filter((m) => m.driveFileId !== driveFileId),
  };
}

export async function handleAcceptExternalFile(input: {
  accountId: string;
  driveFileId: string;
  targetVirtualPath?: string;
  name?: string;
  sizeBytes?: number;
  mimeType?: string;
  hash?: string | null;
}) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    const account = assertAccountNotInSharePool(
      state,
      input.accountId,
      'External change resolution is disabled for Share Pool accounts'
    );

    const disc = state.discrepancies.find((d) => d.accountId === account.id);
    const matchedItem: ExternalDiscrepancyItem | undefined =
      disc?.unindexed.find((i) => i.driveFileId === input.driveFileId) ??
      disc?.modified.find((i) => i.driveFileId === input.driveFileId);

    const virtualPath = normalizeVirtualPath(
      input.targetVirtualPath ?? matchedItem?.virtualPath ?? `/${input.name ?? input.driveFileId}`
    );
    const sizeBytes = input.sizeBytes ?? matchedItem?.sizeBytes ?? 0;
    assertValidDemoFileSize(sizeBytes);

    const fileName = getDemoBaseName(virtualPath);
    const mimeType = input.mimeType ?? matchedItem?.mimeType ?? 'application/octet-stream';
    const hash = input.hash !== undefined ? input.hash : (matchedItem?.hash ?? null);
    const nowIso = new Date().toISOString();

    const activeOccupant = state.files.find(
      (f) =>
        f.poolId === account.poolId &&
        !f.isTrashed &&
        f.virtualPath === virtualPath &&
        (f.accountId !== account.id || f.driveFileId !== input.driveFileId)
    );
    if (activeOccupant) {
      throw new DemoHttpError(409, `An active file already exists at "${virtualPath}"`, 'ITEM_EXISTS');
    }

    const existingByDrive = state.files.find(
      (f) => f.accountId === account.id && f.driveFileId === input.driveFileId
    );
    const parentDir = getParentDir(virtualPath);
    const existingFolders = new Map(
      state.folders.filter((f) => f.poolId === account.poolId).map((f) => [f.virtualPath, f])
    );
    const createdFolders =
      parentDir !== '/'
        ? ensureFolderChainRecords(account.poolId, parentDir, existingFolders, nowIso)
        : [];

    const committedFile: DemoFileRecord = {
      id: existingByDrive?.id ?? generateDemoId('file'),
      poolId: account.poolId,
      virtualPath,
      name: fileName,
      sizeBytes,
      mimeType,
      hash,
      accountId: account.id,
      driveFileId: input.driveFileId,
      folderId: parentDir === '/' ? null : formatDemoFolderId(account.poolId, parentDir),
      isTrashed: false,
      trashedAt: null,
      createdAt: existingByDrive?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };

    const nextDisc = disc ? stripDriveIdFromDiscrepancy(disc, input.driveFileId) : null;
    const sizeDelta = sizeBytes - (existingByDrive?.sizeBytes ?? 0);
    const updatedAccount: DemoAccountRecord | null =
      sizeDelta !== 0
        ? {
            ...account,
            quotaUsedBytes: Math.min(
              account.quotaLimitBytes,
              Math.max(0, account.quotaUsedBytes + sizeDelta)
            ),
            updatedAt: nowIso,
          }
        : null;

    await runStoreMutation(['files', 'folders', 'accounts', 'discrepancies'], (tx) => {
      const foldersStore = tx.objectStore('folders');
      for (const folder of createdFolders) foldersStore.put(folder);
      tx.objectStore('files').put(committedFile);
      if (updatedAccount) tx.objectStore('accounts').put(updatedAccount);
      if (nextDisc) {
        tx.objectStore('discrepancies').put(nextDisc);
      }
    });

    return projectClientFile(committedFile);
  });
}

export async function handleAcceptAllExternalFiles(input: {
  accountId: string;
  items?: Array<{
    driveFileId: string;
    virtualPath: string;
    sizeBytes: number;
    mimeType?: string;
    hash?: string | null;
  }>;
}) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    const account = assertAccountNotInSharePool(
      state,
      input.accountId,
      'External change resolution is disabled for Share Pool accounts'
    );

    const disc = state.discrepancies.find((d) => d.accountId === account.id);
    const items =
      input.items && input.items.length > 0
        ? input.items.map((it) => ({
            driveFileId: it.driveFileId,
            virtualPath: it.virtualPath,
            sizeBytes: it.sizeBytes,
            mimeType: it.mimeType || 'application/octet-stream',
            hash: it.hash ?? null,
          }))
        : disc
          ? [...disc.unindexed, ...disc.modified]
          : [];

    if (items.length === 0) {
      return { acceptedCount: 0 };
    }

    for (const item of items) {
      assertValidDemoFileSize(item.sizeBytes);
    }

    const nowIso = new Date().toISOString();
    const existingFolders = new Map(
      state.folders.filter((f) => f.poolId === account.poolId).map((f) => [f.virtualPath, f])
    );
    const createdFolders: DemoFolderRecord[] = [];
    const committedFiles: DemoFileRecord[] = [];
    const acceptedIds = new Set<string>();

    let totalDelta = 0;

    for (const item of items) {
      const virtualPath = normalizeVirtualPath(item.virtualPath);
      const existingByDrive = state.files.find(
        (f) => f.accountId === account.id && f.driveFileId === item.driveFileId
      );
      totalDelta += item.sizeBytes - (existingByDrive?.sizeBytes ?? 0);
      const parentDir = getParentDir(virtualPath);
      if (parentDir !== '/') {
        createdFolders.push(...ensureFolderChainRecords(account.poolId, parentDir, existingFolders, nowIso));
      }

      committedFiles.push({
        id: existingByDrive?.id ?? generateDemoId('file'),
        poolId: account.poolId,
        virtualPath,
        name: getDemoBaseName(virtualPath),
        sizeBytes: item.sizeBytes,
        mimeType: item.mimeType,
        hash: item.hash,
        accountId: account.id,
        driveFileId: item.driveFileId,
        folderId: parentDir === '/' ? null : formatDemoFolderId(account.poolId, parentDir),
        isTrashed: false,
        trashedAt: null,
        createdAt: existingByDrive?.createdAt ?? nowIso,
        updatedAt: nowIso,
      });
      acceptedIds.add(item.driveFileId);
    }

    const nextDisc = disc
      ? {
          ...disc,
          unindexed: disc.unindexed.filter((i) => !acceptedIds.has(i.driveFileId)),
          modified: disc.modified.filter((i) => !acceptedIds.has(i.driveFileId)),
          conflicts: disc.conflicts.filter((i) => !acceptedIds.has(i.driveFileId)),
          overCeiling: disc.overCeiling.filter((i) => !acceptedIds.has(i.driveFileId)),
          missingRemote: disc.missingRemote.filter((i) => !acceptedIds.has(i.driveFileId)),
        }
      : null;

    const updatedAccount: DemoAccountRecord | null =
      totalDelta !== 0
        ? {
            ...account,
            quotaUsedBytes: Math.min(
              account.quotaLimitBytes,
              Math.max(0, account.quotaUsedBytes + totalDelta)
            ),
            updatedAt: nowIso,
          }
        : null;

    await runStoreMutation(['files', 'folders', 'accounts', 'discrepancies'], (tx) => {
      const foldersStore = tx.objectStore('folders');
      const filesStore = tx.objectStore('files');
      for (const folder of createdFolders) foldersStore.put(folder);
      for (const file of committedFiles) filesStore.put(file);
      if (updatedAccount) tx.objectStore('accounts').put(updatedAccount);
      if (nextDisc) tx.objectStore('discrepancies').put(nextDisc);
    });

    return { acceptedCount: committedFiles.length };
  });
}

export async function handleEjectAllExternalFiles(accountId: string) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    assertAccountNotInSharePool(
      state,
      accountId,
      'External change resolution is disabled for Share Pool accounts'
    );

    const disc = state.discrepancies.find((d) => d.accountId === accountId);
    if (!disc) {
      return { ejectedCount: 0, failedCount: 0 };
    }

    const targets = [...disc.unindexed, ...disc.modified];
    const targetDriveIds = new Set(targets.map((i) => i.driveFileId));
    const fileIdsToRemove = state.files
      .filter((f) => f.accountId === accountId && targetDriveIds.has(f.driveFileId))
      .map((f) => f.id);

    const nextDisc: DemoDiscrepancyRecord = {
      ...disc,
      unindexed: [],
      modified: [],
    };

    await runStoreMutation(['files', 'discrepancies'], (tx) => {
      const filesStore = tx.objectStore('files');
      for (const id of fileIdsToRemove) filesStore.delete(id);
      tx.objectStore('discrepancies').put(nextDisc);
    });

    return { ejectedCount: targets.length, failedCount: 0 };
  });
}

export async function handleMoveToRoot(accountId: string, driveFileId: string) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    assertAccountNotInSharePool(
      state,
      accountId,
      'External change resolution is disabled for Share Pool accounts'
    );

    const disc = state.discrepancies.find((d) => d.accountId === accountId);
    const matchingFileIds = state.files
      .filter((f) => f.accountId === accountId && f.driveFileId === driveFileId)
      .map((f) => f.id);
    const nextDisc = disc ? stripDriveIdFromDiscrepancy(disc, driveFileId) : null;

    // Ejecting an overCeiling or external file to Drive root never double-counts into tsubasaUsedBytes
    // or alters quotaUsedBytes (file stays on Drive root, outside _Tsubasa~ Pool N).
    await runStoreMutation(['files', 'discrepancies'], (tx) => {
      const filesStore = tx.objectStore('files');
      for (const id of matchingFileIds) filesStore.delete(id);
      if (nextDisc) tx.objectStore('discrepancies').put(nextDisc);
    });

    return { success: true, accountId, driveFileId };
  });
}

export async function handleRemoveMissing(accountId: string, driveFileId: string) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    const account = assertAccountNotInSharePool(
      state,
      accountId,
      'External change resolution is disabled for Share Pool accounts'
    );

    const disc = state.discrepancies.find((d) => d.accountId === accountId);
    const matchingFiles = state.files.filter(
      (f) => f.accountId === accountId && f.driveFileId === driveFileId
    );
    const removedBytes = matchingFiles.reduce((sum, f) => sum + f.sizeBytes, 0);
    const nextDisc = disc ? stripDriveIdFromDiscrepancy(disc, driveFileId) : null;
    const updatedAccount: DemoAccountRecord | null =
      removedBytes > 0
        ? {
            ...account,
            quotaUsedBytes: Math.max(0, account.quotaUsedBytes - removedBytes),
            updatedAt: new Date().toISOString(),
          }
        : null;

    await runStoreMutation(['files', 'accounts', 'discrepancies'], (tx) => {
      const filesStore = tx.objectStore('files');
      for (const f of matchingFiles) filesStore.delete(f.id);
      if (updatedAccount) tx.objectStore('accounts').put(updatedAccount);
      if (nextDisc) tx.objectStore('discrepancies').put(nextDisc);
    });

    return { success: true, accountId, driveFileId };
  });
}

export async function handleResolveConflict(input: {
  accountId: string;
  driveFileId: string;
  resolution: 'keep_both' | 'deduplicate' | 'replace_existing' | 'eject';
  targetVirtualPath?: string;
}) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    const account = assertAccountNotInSharePool(
      state,
      input.accountId,
      'Conflict resolution is disabled for Share Pool accounts'
    );

    const disc = state.discrepancies.find((d) => d.accountId === account.id);
    const conflict: PathConflictItem | undefined = disc?.conflicts.find(
      (c) => c.driveFileId === input.driveFileId
    );
    const nextDisc = disc ? stripDriveIdFromDiscrepancy(disc, input.driveFileId) : null;

    if (!conflict) {
      if (nextDisc) {
        await runStoreMutation(['discrepancies'], (tx) => {
          tx.objectStore('discrepancies').put(nextDisc);
        });
      }
      return { success: true, resolution: input.resolution };
    }

    const nowIso = new Date().toISOString();
    const activePaths = new Set(
      state.files.filter((f) => f.poolId === account.poolId && !f.isTrashed).map((f) => f.virtualPath)
    );
    const existingFolders = new Map(
      state.folders.filter((f) => f.poolId === account.poolId).map((f) => [f.virtualPath, f])
    );

    if (input.resolution === 'eject' || input.resolution === 'deduplicate') {
      await runStoreMutation(['discrepancies'], (tx) => {
        if (nextDisc) tx.objectStore('discrepancies').put(nextDisc);
      });
      return { success: true, resolution: input.resolution };
    }

    if (input.resolution === 'keep_both') {
      const basePath = normalizeVirtualPath(input.targetVirtualPath ?? conflict.virtualPath);
      const uniquePath = allocateUniquePath({
        targetDir: getParentDir(basePath),
        baseName: getDemoBaseName(basePath),
        kind: 'file',
        style: 'numbered',
        startCounter: 2,
        skipBase: true,
        isTaken: (p) => activePaths.has(p) || existingFolders.has(p),
      });
      const parentDir = getParentDir(uniquePath);
      const createdFolders =
        parentDir !== '/'
          ? ensureFolderChainRecords(account.poolId, parentDir, existingFolders, nowIso)
          : [];

      const newFile: DemoFileRecord = {
        id: generateDemoId('file'),
        poolId: account.poolId,
        virtualPath: uniquePath,
        name: getDemoBaseName(uniquePath),
        sizeBytes: conflict.sizeBytes,
        mimeType: conflict.mimeType,
        hash: conflict.hash,
        accountId: account.id,
        driveFileId: conflict.driveFileId,
        folderId: parentDir === '/' ? null : formatDemoFolderId(account.poolId, parentDir),
        isTrashed: false,
        trashedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      await runStoreMutation(['files', 'folders', 'discrepancies'], (tx) => {
        const foldersStore = tx.objectStore('folders');
        for (const f of createdFolders) foldersStore.put(f);
        tx.objectStore('files').put(newFile);
        if (nextDisc) tx.objectStore('discrepancies').put(nextDisc);
      });

      return { success: true, resolution: input.resolution, virtualPath: uniquePath };
    }

    // replace_existing
    const targetPath = normalizeVirtualPath(input.targetVirtualPath ?? conflict.virtualPath);
    const parentDir = getParentDir(targetPath);
    const createdFolders =
      parentDir !== '/'
        ? ensureFolderChainRecords(account.poolId, parentDir, existingFolders, nowIso)
        : [];
    const replaced = state.files.find((f) => f.id === conflict.existingFile.fileId);

    const newFile: DemoFileRecord = {
      id: generateDemoId('file'),
      poolId: account.poolId,
      virtualPath: targetPath,
      name: getDemoBaseName(targetPath),
      sizeBytes: conflict.sizeBytes,
      mimeType: conflict.mimeType,
      hash: conflict.hash,
      accountId: account.id,
      driveFileId: conflict.driveFileId,
      folderId: parentDir === '/' ? null : formatDemoFolderId(account.poolId, parentDir),
      isTrashed: false,
      trashedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await runStoreMutation(['files', 'folders', 'discrepancies'], (tx) => {
      const filesStore = tx.objectStore('files');
      const foldersStore = tx.objectStore('folders');
      if (replaced) filesStore.delete(replaced.id);
      for (const f of createdFolders) foldersStore.put(f);
      filesStore.put(newFile);
      if (nextDisc) tx.objectStore('discrepancies').put(nextDisc);
    });

    return { success: true, resolution: input.resolution, virtualPath: targetPath };
  });
}

export async function handleResolveConflictsBatch(input: {
  accountId: string;
  items: Array<{ driveFileId: string; targetVirtualPath?: string }>;
  resolution: 'keep_both' | 'deduplicate';
}) {
  const results: Array<{ driveFileId: string; success: boolean; error?: string }> = [];
  let failedCount = 0;

  for (const item of input.items) {
    try {
      await handleResolveConflict({
        accountId: input.accountId,
        driveFileId: item.driveFileId,
        resolution: input.resolution,
        targetVirtualPath: item.targetVirtualPath,
      });
      results.push({ driveFileId: item.driveFileId, success: true });
    } catch (err) {
      failedCount += 1;
      results.push({
        driveFileId: item.driveFileId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    resolvedCount: results.length - failedCount,
    failedCount,
    results,
  };
}

function executeRebalanceFilesInState(
  state: DemoDatabaseState,
  fileIds: string[],
  targetAccountId: string
): {
  batchResult: DemoBatchRebalanceResult;
  updatedFiles: DemoFileRecord[];
  updatedSource: DemoAccountRecord;
  updatedTarget: DemoAccountRecord;
  newLogs: DemoTransferLogRecord[];
} {
  const uniqueIds = Array.from(new Set(fileIds));
  const batchFiles: DemoFileRecord[] = [];
  for (const id of uniqueIds) {
    const f = state.files.find((x) => x.id === id);
    if (!f) {
      throw new DemoHttpError(400, `File ${id} not found`, 'VALIDATION_ERROR');
    }
    batchFiles.push(f);
  }

  const sourceAccountId = batchFiles[0].accountId;
  if (batchFiles.some((f) => f.accountId !== sourceAccountId)) {
    throw new DemoHttpError(
      400,
      'All files in a single batch rebalance must belong to the same source account',
      'VALIDATION_ERROR'
    );
  }
  if (sourceAccountId === targetAccountId) {
    throw new DemoHttpError(400, 'Target account must be different from source account', 'VALIDATION_ERROR');
  }

  const sourceAccount = state.accounts.find((a) => a.id === sourceAccountId);
  if (!sourceAccount) {
    throw new DemoHttpError(400, `Source account ${sourceAccountId} not registered`, 'VALIDATION_ERROR');
  }
  assertNotSharePool(state, sourceAccount.poolId, 'Moving Share Pool files between accounts is disabled');

  const targetAccount = state.accounts.find((a) => a.id === targetAccountId);
  if (!targetAccount || !targetAccount.authorized) {
    throw new DemoHttpError(400, `Target account ${targetAccountId} not registered`, 'VALIDATION_ERROR');
  }
  if (targetAccount.poolId !== sourceAccount.poolId) {
    throw new DemoHttpError(400, 'Cannot rebalance files across different storage pools', 'VALIDATION_ERROR');
  }
  if (targetAccount.isDisabled) {
    throw new DemoHttpError(400, `Target account ${targetAccountId} is disabled`, 'VALIDATION_ERROR');
  }

  const totalBytes = batchFiles.reduce((sum, f) => sum + f.sizeBytes, 0);
  const targetHeadroom = calculateHeadroom(targetAccount.quotaLimitBytes, targetAccount.quotaUsedBytes);
  if (targetHeadroom < totalBytes) {
    throw new DemoInsufficientStorageError(
      `Target account ${targetAccount.email} does not have enough headroom for batch of ${totalBytes} bytes`
    );
  }

  const nowMs = Date.now();
  const statsMap = computeTransferStatsByAccount([targetAccountId], state.transferLogs, nowMs);
  const targetStats = statsMap.get(targetAccountId) ?? buildEmptyTransferStats(targetAccountId);
  if (targetStats.remainingUploadBytes24h < totalBytes) {
    throw new DemoInsufficientStorageError(
      `Target account ${targetAccount.email} has insufficient Google 750 GB daily transfer quota`
    );
  }

  const nowIso = new Date(nowMs).toISOString();
  const results: DemoRebalanceOperationResult[] = [];
  const updatedFiles: DemoFileRecord[] = [];
  const newLogs: DemoTransferLogRecord[] = [];

  for (const file of batchFiles) {
    const newDriveFileId = generateDemoId('demo-drv');
    updatedFiles.push({
      ...file,
      accountId: targetAccountId,
      driveFileId: newDriveFileId,
      updatedAt: nowIso,
    });
    if (file.sizeBytes > 0) {
      newLogs.push({
        id: generateDemoId('tx'),
        accountId: targetAccountId,
        transferType: 'upload',
        byteCount: file.sizeBytes,
        timestamp: nowMs,
      });
    }
    results.push({
      fileId: file.id,
      virtualPath: file.virtualPath,
      sourceAccountId,
      targetAccountId,
      newDriveFileId,
      bytesMoved: file.sizeBytes,
    });
  }

  const updatedSource: DemoAccountRecord = {
    ...sourceAccount,
    quotaUsedBytes: Math.max(0, sourceAccount.quotaUsedBytes - totalBytes),
    updatedAt: nowIso,
  };
  const updatedTarget: DemoAccountRecord = {
    ...targetAccount,
    quotaUsedBytes: targetAccount.quotaUsedBytes + totalBytes,
    updatedAt: nowIso,
  };

  return {
    batchResult: {
      sourceAccountId,
      targetAccountId,
      totalFiles: results.length,
      totalBytesMoved: totalBytes,
      results,
    },
    updatedFiles,
    updatedSource,
    updatedTarget,
    newLogs,
  };
}

export async function handleRebalanceFile(fileId: string, targetAccountId: string) {
  const batch = await handleRebalanceBatch([fileId], targetAccountId);
  return batch.results[0];
}

export async function handleRebalanceBatch(fileIds: string[], targetAccountId: string) {
  return withDemoWriteLock(async () => {
    if (fileIds.length === 0) {
      throw new DemoHttpError(400, 'fileIds must be a non-empty array', 'VALIDATION_ERROR');
    }
    const state = await loadDemoState();
    const { batchResult, updatedFiles, updatedSource, updatedTarget, newLogs } =
      executeRebalanceFilesInState(state, fileIds, targetAccountId);

    await runStoreMutation(['files', 'accounts', 'transferLogs'], (tx) => {
      const filesStore = tx.objectStore('files');
      const accountsStore = tx.objectStore('accounts');
      const logsStore = tx.objectStore('transferLogs');
      for (const f of updatedFiles) filesStore.put(f);
      accountsStore.put(updatedSource);
      accountsStore.put(updatedTarget);
      for (const log of newLogs) logsStore.put(log);
    });

    return batchResult;
  });
}

export async function handleAutoRebalance(sourceAccountId: string) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    const sourceAccount = assertAccountNotInSharePool(
      state,
      sourceAccountId,
      'Auto-rebalance is disabled for Share Pool accounts'
    );

    const usable = calculateUsableLimit(sourceAccount.quotaLimitBytes);
    if (sourceAccount.quotaUsedBytes <= usable) {
      return { results: [] as DemoRebalanceOperationResult[] };
    }

    const excessBytes = sourceAccount.quotaUsedBytes - usable;
    const candidateFiles = state.files
      .filter((f) => f.accountId === sourceAccountId)
      .sort((a, b) => b.sizeBytes - a.sizeBytes);

    if (candidateFiles.length === 0) {
      return { results: [] as DemoRebalanceOperationResult[] };
    }

    const nowMs = Date.now();
    const targetCandidates = state.accounts.filter(
      (a) =>
        a.poolId === sourceAccount.poolId &&
        a.id !== sourceAccountId &&
        a.authorized &&
        !a.isDisabled &&
        a.syncState !== 'error'
    );

    const statsMap = computeTransferStatsByAccount(
      targetCandidates.map((c) => c.id),
      state.transferLogs,
      nowMs
    );
    const targetStates = targetCandidates.map((c) => ({
      id: c.id,
      headroomBytes: calculateHeadroom(c.quotaLimitBytes, c.quotaUsedBytes),
      remainingDailyBytes: (statsMap.get(c.id) ?? buildEmptyTransferStats(c.id)).remainingUploadBytes24h,
    }));

    let remainingExcess = excessBytes;
    const groupedByTarget = new Map<string, string[]>();

    for (const file of candidateFiles) {
      if (remainingExcess <= 0) break;
      const eligible = targetStates.filter(
        (t) => t.headroomBytes >= file.sizeBytes && t.remainingDailyBytes >= file.sizeBytes
      );
      if (eligible.length === 0) continue;

      eligible.sort((a, b) => b.headroomBytes - a.headroomBytes);
      const chosen = eligible[0];

      const list = groupedByTarget.get(chosen.id) ?? [];
      list.push(file.id);
      groupedByTarget.set(chosen.id, list);

      remainingExcess -= file.sizeBytes;
      chosen.headroomBytes -= file.sizeBytes;
      chosen.remainingDailyBytes -= file.sizeBytes;
    }

    if (groupedByTarget.size === 0) {
      return { results: [] as DemoRebalanceOperationResult[] };
    }

    const nowIso = new Date(nowMs).toISOString();
    const allResults: DemoRebalanceOperationResult[] = [];
    const mutatedFiles: DemoFileRecord[] = [];
    const mutatedAccounts = new Map<string, DemoAccountRecord>([[sourceAccount.id, { ...sourceAccount }]]);
    const newLogs: DemoTransferLogRecord[] = [];

    for (const [targetId, fileIds] of groupedByTarget) {
      const targetAcc = state.accounts.find((a) => a.id === targetId);
      if (!targetAcc) continue;
      const runningTarget = mutatedAccounts.get(targetId) ?? { ...targetAcc };
      const runningSource = mutatedAccounts.get(sourceAccount.id)!;

      for (const fileId of fileIds) {
        const file = state.files.find((f) => f.id === fileId);
        if (!file) continue;

        const newDriveFileId = generateDemoId('demo-drv');
        mutatedFiles.push({
          ...file,
          accountId: targetId,
          driveFileId: newDriveFileId,
          updatedAt: nowIso,
        });
        runningSource.quotaUsedBytes = Math.max(0, runningSource.quotaUsedBytes - file.sizeBytes);
        runningSource.updatedAt = nowIso;
        runningTarget.quotaUsedBytes += file.sizeBytes;
        runningTarget.updatedAt = nowIso;

        if (file.sizeBytes > 0) {
          newLogs.push({
            id: generateDemoId('tx'),
            accountId: targetId,
            transferType: 'upload',
            byteCount: file.sizeBytes,
            timestamp: nowMs,
          });
        }
        allResults.push({
          fileId: file.id,
          virtualPath: file.virtualPath,
          sourceAccountId,
          targetAccountId: targetId,
          newDriveFileId,
          bytesMoved: file.sizeBytes,
        });
      }

      mutatedAccounts.set(targetId, runningTarget);
    }

    await runStoreMutation(['files', 'accounts', 'transferLogs'], (tx) => {
      const filesStore = tx.objectStore('files');
      const accountsStore = tx.objectStore('accounts');
      const logsStore = tx.objectStore('transferLogs');
      for (const f of mutatedFiles) filesStore.put(f);
      for (const a of mutatedAccounts.values()) accountsStore.put(a);
      for (const l of newLogs) logsStore.put(l);
    });

    return { results: allResults };
  });
}

// --- Public Sharing & Share Pool ---

interface ResolvedShareTargets {
  sourcePoolId: number;
  sharePoolId: number | null;
  batchFolderName: string;
  topLevelItems: Array<{
    kind: 'file' | 'folder';
    id: string;
    name: string;
    sourceVirtualPath: string;
    targetVirtualPath: string;
  }>;
  files: Array<{
    id: string;
    name: string;
    sourceVirtualPath: string;
    targetVirtualPath: string;
    sizeBytes: number;
    mimeType: string;
    hash: string | null;
    accountId: string;
    driveFileId: string;
    contentText?: string;
  }>;
  folders: Array<{
    id: string;
    name: string;
    sourceVirtualPath: string;
    targetVirtualPath: string;
  }>;
  totalBytes: number;
  fileCount: number;
  folderCount: number;
  overCeilingFiles: Array<{ id: string; name: string; virtualPath: string; sizeBytes: number }>;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function generateShareBatchName(state: DemoDatabaseState, sharePoolId: number | null): string {
  const occupied = new Set<string>();
  if (sharePoolId !== null) {
    for (const f of state.files) {
      if (f.poolId === sharePoolId && f.folderId === null) {
        const seg = normalizeVirtualPath(f.virtualPath).split('/').filter(Boolean)[0];
        if (seg) occupied.add(seg);
      }
    }
    for (const f of state.folders) {
      if (f.poolId === sharePoolId && f.parentFolderId === null) {
        const seg = normalizeVirtualPath(f.virtualPath).split('/').filter(Boolean)[0];
        if (seg) occupied.add(seg);
      }
    }
    for (const link of state.shareLinks) {
      if (link.poolId === sharePoolId) occupied.add(link.batchFolderName);
    }
  }

  const now = new Date();
  let candidate =
    `${String(now.getFullYear()).padStart(4, '0')}` +
    `${pad2(now.getMonth() + 1)}` +
    `${pad2(now.getDate())}` +
    `${pad2(now.getHours())}` +
    `${pad2(now.getMinutes())}` +
    `${pad2(now.getSeconds())}` +
    `${String(now.getMilliseconds()).padStart(3, '0')}`;

  let guard = 0;
  while (occupied.has(candidate) && guard < 10_000) {
    candidate = String(Number(candidate) + 1);
    guard += 1;
  }
  return candidate;
}

function computeLowestCommonParentDir(paths: string[]): string {
  if (paths.length === 0) return '/';
  const lists = paths.map((p) => {
    const parent = getParentDir(normalizeVirtualPath(p));
    return parent === '/' ? [] : parent.split('/').filter(Boolean);
  });

  const first = lists[0];
  let commonLen = first.length;
  for (let i = 1; i < lists.length; i++) {
    const cur = lists[i];
    commonLen = Math.min(commonLen, cur.length);
    for (let j = 0; j < commonLen; j++) {
      if (first[j] !== cur[j]) {
        commonLen = j;
        break;
      }
    }
  }
  return commonLen === 0 ? '/' : `/${first.slice(0, commonLen).join('/')}`;
}

function stripLcpPrefix(virtualPath: string, lcpDir: string): string {
  const norm = normalizeVirtualPath(virtualPath);
  if (lcpDir === '/') return norm;
  return norm.startsWith(`${lcpDir}/`) ? norm.slice(lcpDir.length) : norm;
}

function resolveDemoShareTargets(
  state: DemoDatabaseState,
  sourcePoolId: number,
  items: Array<{ kind: 'file' | 'folder'; id: string }>,
  batchFolderName?: string
): ResolvedShareTargets {
  const sharePool = state.pools.find((p) => p.isSharePool);
  const sharePoolId = sharePool?.id ?? null;
  const effectiveBatchName = batchFolderName ?? generateShareBatchName(state, sharePoolId);

  const selectedFiles = new Map<string, DemoFileRecord>();
  const selectedFolders = new Map<string, DemoFolderRecord>();

  for (const item of items) {
    if (item.kind === 'file') {
      const f = state.files.find(
        (x) =>
          x.poolId === sourcePoolId && !x.isTrashed && (x.id === item.id || x.virtualPath === item.id)
      );
      if (f) selectedFiles.set(f.id, f);
    } else {
      const folder = state.folders.find(
        (x) => x.poolId === sourcePoolId && (x.id === item.id || x.virtualPath === item.id)
      );
      if (folder) selectedFolders.set(normalizeVirtualPath(folder.virtualPath), folder);
    }
  }

  const allSelectedFolderPaths = Array.from(selectedFolders.keys());
  const topLevelFolders = Array.from(selectedFolders.values()).filter((folder) => {
    const p = normalizeVirtualPath(folder.virtualPath);
    return !allSelectedFolderPaths.some((other) => other !== p && isDescendantPath(p, other));
  });
  const topLevelFiles = Array.from(selectedFiles.values()).filter((file) => {
    const p = normalizeVirtualPath(file.virtualPath);
    return !allSelectedFolderPaths.some((folderPath) => isDescendantPath(p, folderPath));
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

  const lcpDir = computeLowestCommonParentDir([
    ...topLevelFolders.map((f) => f.virtualPath),
    ...topLevelFiles.map((f) => f.virtualPath),
  ]);
  const occupiedTopSegments = new Set<string>();

  const buildRemapper = (sourcePath: string, isSingleFile: boolean) => {
    const stripped = stripLcpPrefix(sourcePath, lcpDir);
    const segments = stripped.split('/').filter(Boolean);
    const originalTopSeg = segments[0] ?? getDemoBaseName(stripped);
    const resolvedTopSeg = allocateUniquePath({
      targetDir: '/',
      baseName: originalTopSeg,
      kind: isSingleFile && segments.length === 1 ? 'file' : 'folder',
      style: 'numbered',
      startCounter: 2,
      isTaken: (p) => occupiedTopSegments.has(p.slice(1)),
    }).slice(1);
    occupiedTopSegments.add(resolvedTopSeg);

    return (candidateSourcePath: string): string => {
      const rel = stripLcpPrefix(candidateSourcePath, lcpDir);
      const rest = rel.slice(1 + originalTopSeg.length);
      return normalizeVirtualPath(`/${effectiveBatchName}/${resolvedTopSeg}${rest}`);
    };
  };

  const resolvedTopLevelItems: ResolvedShareTargets['topLevelItems'] = [];
  const resolvedFilesById = new Map<string, ResolvedShareTargets['files'][number]>();
  const resolvedFoldersByPath = new Map<string, ResolvedShareTargets['folders'][number]>();

  for (const file of topLevelFiles) {
    const sourcePath = normalizeVirtualPath(file.virtualPath);
    const remap = buildRemapper(sourcePath, true);
    const targetVirtualPath = remap(sourcePath);

    resolvedTopLevelItems.push({
      kind: 'file',
      id: file.id,
      name: getDemoBaseName(targetVirtualPath),
      sourceVirtualPath: sourcePath,
      targetVirtualPath,
    });
    resolvedFilesById.set(file.id, {
      id: file.id,
      name: getDemoBaseName(targetVirtualPath),
      sourceVirtualPath: sourcePath,
      targetVirtualPath,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
      hash: file.hash,
      accountId: file.accountId,
      driveFileId: file.driveFileId,
      contentText: file.contentText,
    });
  }

  for (const folder of topLevelFolders) {
    const sourceFolderPath = normalizeVirtualPath(folder.virtualPath);
    const remap = buildRemapper(sourceFolderPath, false);
    const targetFolderPath = remap(sourceFolderPath);

    resolvedTopLevelItems.push({
      kind: 'folder',
      id: folder.id,
      name: getDemoBaseName(targetFolderPath),
      sourceVirtualPath: sourceFolderPath,
      targetVirtualPath: targetFolderPath,
    });

    for (const subFolder of state.folders) {
      if (subFolder.poolId !== sourcePoolId) continue;
      const subPath = normalizeVirtualPath(subFolder.virtualPath);
      if (subPath !== sourceFolderPath && !isDescendantPath(subPath, sourceFolderPath)) continue;
      if (!resolvedFoldersByPath.has(subPath)) {
        const mapped = remap(subPath);
        resolvedFoldersByPath.set(subPath, {
          id: subFolder.id,
          name: getDemoBaseName(mapped),
          sourceVirtualPath: subPath,
          targetVirtualPath: mapped,
        });
      }
    }

    for (const subFile of state.files) {
      if (subFile.poolId !== sourcePoolId || subFile.isTrashed) continue;
      const subPath = normalizeVirtualPath(subFile.virtualPath);
      if (subPath !== sourceFolderPath && !isDescendantPath(subPath, sourceFolderPath)) continue;
      if (!resolvedFilesById.has(subFile.id)) {
        const mapped = remap(subPath);
        resolvedFilesById.set(subFile.id, {
          id: subFile.id,
          name: getDemoBaseName(mapped),
          sourceVirtualPath: subPath,
          targetVirtualPath: mapped,
          sizeBytes: subFile.sizeBytes,
          mimeType: subFile.mimeType,
          hash: subFile.hash,
          accountId: subFile.accountId,
          driveFileId: subFile.driveFileId,
          contentText: subFile.contentText,
        });
      }
    }
  }

  const resolvedFiles = Array.from(resolvedFilesById.values());
  const resolvedFolders = Array.from(resolvedFoldersByPath.values()).sort(
    (a, b) => a.targetVirtualPath.length - b.targetVirtualPath.length
  );

  let totalBytes = 0;
  const overCeilingFiles: ResolvedShareTargets['overCeilingFiles'] = [];
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

function validateShareAgainstTargets(
  state: DemoDatabaseState,
  targets: ResolvedShareTargets,
  selectedAccountIds: string[],
  nowMs = Date.now()
) {
  const uniqueSelectedIds = Array.from(new Set(selectedAccountIds.filter(Boolean)));
  const emptyAccounts = buildEmptyAccountsAcrossAllPools(
    state.pools,
    state.accounts,
    state.files,
    state.transferLogs,
    nowMs
  );
  const emptyById = new Map<string, EmptyShareAccount>(emptyAccounts.map((a) => [a.id, a]));

  const existingCandidates =
    targets.sharePoolId !== null
      ? getEligibleDemoCandidates(targets.sharePoolId, state.accounts, state.transferLogs, nowMs)
      : [];

  const combinedMap = new Map<string, DemoCandidateAccount>(existingCandidates.map((c) => [c.id, c]));

  for (const accId of uniqueSelectedIds) {
    const emptyAcc = emptyById.get(accId);
    const existingHeadroom = existingCandidates.reduce((s, c) => s + c.headroomBytes, 0);
    if (!emptyAcc) {
      return {
        validation: {
          valid: false,
          reason: `Account "${accId}" is not empty or was not found`,
          totalAvailableHeadroomBytes: existingHeadroom,
          requiredBytes: targets.totalBytes,
        },
        combinedCandidates: [] as DemoCandidateAccount[],
        uniqueSelectedIds,
      };
    }
    if (emptyAcc.isDisabled) {
      return {
        validation: {
          valid: false,
          reason: `Drive "${emptyAcc.email}" is disabled and cannot join the Share Pool`,
          totalAvailableHeadroomBytes: existingHeadroom,
          requiredBytes: targets.totalBytes,
        },
        combinedCandidates: [] as DemoCandidateAccount[],
        uniqueSelectedIds,
      };
    }
    if (!emptyAcc.authorized) {
      return {
        validation: {
          valid: false,
          reason: `Drive "${emptyAcc.email}" is not authorized`,
          totalAvailableHeadroomBytes: existingHeadroom,
          requiredBytes: targets.totalBytes,
        },
        combinedCandidates: [] as DemoCandidateAccount[],
        uniqueSelectedIds,
      };
    }
    if (emptyAcc.syncState === 'error') {
      return {
        validation: {
          valid: false,
          reason: `Drive "${emptyAcc.email}" is in an error sync state`,
          totalAvailableHeadroomBytes: existingHeadroom,
          requiredBytes: targets.totalBytes,
        },
        combinedCandidates: [] as DemoCandidateAccount[],
        uniqueSelectedIds,
      };
    }

    if (!combinedMap.has(emptyAcc.id)) {
      combinedMap.set(emptyAcc.id, {
        id: emptyAcc.id,
        email: emptyAcc.email,
        headroomBytes: emptyAcc.headroomBytes,
        transferStats: emptyAcc.transferStats,
        isOverCeiling: false,
      });
    }
  }

  const combinedCandidates = Array.from(combinedMap.values());
  const totalAvailableHeadroomBytes = combinedCandidates.reduce((s, c) => s + c.headroomBytes, 0);

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
        accountAllocations: { [best.id]: { filesCount: 0, bytesAllocated: 0 } },
      },
      combinedCandidates,
      uniqueSelectedIds,
    };
  }

  try {
    const affinityMap =
      targets.sharePoolId !== null && combinedCandidates.length > 1
        ? buildDemoFolderAffinityMap(targets.sharePoolId, state.files)
        : undefined;
    const plan = simulateDemoBatchPlacement(
      targets.files.map((f): DemoPlacementItem => ({
        virtualPath: f.targetVirtualPath,
        sizeBytes: f.sizeBytes,
      })),
      combinedCandidates,
      affinityMap
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

export async function handleShareInspect(
  sourcePoolId: number,
  items: Array<{ kind: 'file' | 'folder'; id: string }>
): Promise<ShareInspectResponse> {
  const state = await loadDemoState();
  assertNotSharePool(state, sourcePoolId, 'Items inside Share Pool cannot be shared again');

  const nowMs = Date.now();
  const targets = resolveDemoShareTargets(state, sourcePoolId, items);
  const emptyAccounts = buildEmptyAccountsAcrossAllPools(
    state.pools,
    state.accounts,
    state.files,
    state.transferLogs,
    nowMs
  );

  let sharePoolFitsWithoutExpansion = false;
  let existingSharePoolAccountCount = 0;
  let existingSharePoolHeadroomBytes = 0;
  let fitReason: string | null = null;

  if (targets.sharePoolId !== null) {
    const existingCandidates = getEligibleDemoCandidates(
      targets.sharePoolId,
      state.accounts,
      state.transferLogs,
      nowMs
    );
    existingSharePoolAccountCount = existingCandidates.length;
    existingSharePoolHeadroomBytes = existingCandidates.reduce((s, c) => s + c.headroomBytes, 0);

    if (targets.overCeilingFiles.length > 0) {
      fitReason = `${targets.overCeilingFiles.length} file(s) exceed the 14.25 GB single-account ceiling`;
    } else if (targets.files.length === 0 && targets.folders.length > 0) {
      sharePoolFitsWithoutExpansion = existingCandidates.length >= 1;
      if (!sharePoolFitsWithoutExpansion) {
        fitReason = 'Share Pool has no active accounts to host the empty folder';
      }
    } else if (targets.files.length > 0) {
      try {
        const affinityMap =
          existingCandidates.length > 1
            ? buildDemoFolderAffinityMap(targets.sharePoolId, state.files)
            : undefined;
        simulateDemoBatchPlacement(
          targets.files.map((f) => ({ virtualPath: f.targetVirtualPath, sizeBytes: f.sizeBytes })),
          existingCandidates,
          affinityMap
        );
        sharePoolFitsWithoutExpansion = true;
      } catch (err) {
        sharePoolFitsWithoutExpansion = false;
        fitReason = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return {
    sourcePoolId,
    sharePoolExists: targets.sharePoolId !== null,
    sharePoolId: targets.sharePoolId,
    sharePoolFitsWithoutExpansion,
    existingSharePoolAccountCount,
    existingSharePoolHeadroomBytes,
    shortfallBytes: Math.max(0, targets.totalBytes - existingSharePoolHeadroomBytes),
    fitReason,
    totalBytes: targets.totalBytes,
    fileCount: targets.fileCount,
    folderCount: targets.folderCount,
    topLevelItems: targets.topLevelItems,
    overCeilingFiles: targets.overCeilingFiles,
    emptyAccounts,
  };
}

export async function handleShareValidate(
  sourcePoolId: number,
  items: Array<{ kind: 'file' | 'folder'; id: string }>,
  selectedAccountIds: string[]
) {
  const state = await loadDemoState();
  assertNotSharePool(state, sourcePoolId, 'Items inside Share Pool cannot be shared again');
  const targets = resolveDemoShareTargets(state, sourcePoolId, items);
  const { validation } = validateShareAgainstTargets(state, targets, selectedAccountIds, Date.now());
  return validation;
}

export async function handleShareExecute(input: {
  sourcePoolId: number;
  items: Array<{ kind: 'file' | 'folder'; id: string }>;
  selectedAccountIds: string[];
}): Promise<ShareExecuteResult> {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    assertNotSharePool(state, input.sourcePoolId, 'Items inside Share Pool cannot be shared again');

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    let sharePool = state.pools.find((p) => p.isSharePool);
    let createdSharePool: DemoPoolRecord | null = null;
    if (!sharePool) {
      createdSharePool = {
        id: SHARE_POOL_RESERVE_ID,
        name: 'Share Pool',
        slug: SHARE_POOL_SLUG,
        sortOrder: SHARE_POOL_RESERVE_ID,
        driveFolderName: SHARE_POOL_FOLDER_NAME,
        isSharePool: true,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      sharePool = createdSharePool;
    }

    const sharePoolId = sharePool.id;
    const batchFolderName = generateShareBatchName(state, sharePoolId);
    const targets = resolveDemoShareTargets(state, input.sourcePoolId, input.items, batchFolderName);
    const { validation, plan, combinedCandidates, uniqueSelectedIds } =
      validateShareAgainstTargets(state, targets, input.selectedAccountIds, nowMs);

    if (!validation.valid) {
      throw new DemoHttpError(
        400,
        validation.reason || 'Selected drives cannot fit the share payload',
        'VALIDATION_ERROR'
      );
    }

    const accountMap = new Map<string, DemoAccountRecord>(state.accounts.map((a) => [a.id, { ...a }]));
    const updatedAccountIds = new Set<string>();

    for (const accId of uniqueSelectedIds) {
      const acc = accountMap.get(accId);
      if (acc && acc.poolId !== sharePoolId) {
        acc.poolId = sharePoolId;
        acc.updatedAt = nowIso;
        updatedAccountIds.add(accId);
      }
    }

    const participatingIds = new Set<string>();
    const accountAllocations: Record<string, { filesCount: number; bytesAllocated: number }> = {};
    const newFiles: DemoFileRecord[] = [];
    const newLogs: DemoTransferLogRecord[] = [];

    const existingShareFolders = new Map(
      state.folders.filter((f) => f.poolId === sharePoolId).map((f) => [f.virtualPath, f])
    );
    const createdFolders: DemoFolderRecord[] = [
      ...ensureFolderChainRecords(sharePoolId, `/${batchFolderName}`, existingShareFolders, nowIso),
    ];

    if (targets.files.length === 0 && targets.folders.length > 0) {
      if (combinedCandidates.length === 0) {
        throw new DemoInsufficientStorageError('No active accounts available in Share Pool');
      }
      const best = [...combinedCandidates].sort((a, b) => b.headroomBytes - a.headroomBytes)[0];
      participatingIds.add(best.id);
      accountAllocations[best.id] = { filesCount: 0, bytesAllocated: 0 };
    } else if (plan) {
      Object.assign(accountAllocations, plan.accountAllocations);
      const fileByTargetPath = new Map(targets.files.map((f) => [f.targetVirtualPath, f]));

      for (const dec of plan.decisions) {
        const src = fileByTargetPath.get(dec.virtualPath);
        if (!src) continue;

        participatingIds.add(dec.accountId);
        const parentDir = getParentDir(dec.virtualPath);
        if (parentDir !== '/') {
          createdFolders.push(
            ...ensureFolderChainRecords(sharePoolId, parentDir, existingShareFolders, nowIso)
          );
        }

        newFiles.push({
          id: generateDemoId('file'),
          poolId: sharePoolId,
          virtualPath: dec.virtualPath,
          name: getDemoBaseName(dec.virtualPath),
          sizeBytes: dec.sizeBytes,
          mimeType: src.mimeType,
          hash: src.hash,
          accountId: dec.accountId,
          driveFileId: generateDemoId('demo-drv'),
          folderId: parentDir === '/' ? null : formatDemoFolderId(sharePoolId, parentDir),
          isTrashed: false,
          trashedAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
          contentText: src.contentText,
        });

        const targetAcc = accountMap.get(dec.accountId);
        if (targetAcc) {
          targetAcc.quotaUsedBytes += dec.sizeBytes;
          targetAcc.updatedAt = nowIso;
          updatedAccountIds.add(dec.accountId);
        }

        if (dec.sizeBytes > 0) {
          newLogs.push({
            id: generateDemoId('tx'),
            accountId: dec.accountId,
            transferType: 'upload',
            byteCount: dec.sizeBytes,
            timestamp: nowMs,
          });
        }
      }
    }

    for (const folder of targets.folders) {
      createdFolders.push(
        ...ensureFolderChainRecords(sharePoolId, folder.targetVirtualPath, existingShareFolders, nowIso)
      );
    }

    const links: ShareExecuteResult['links'] = [];
    const newShareLinkRecords: DemoShareLinkRecord[] = [];
    let linkSeq = 1;

    for (const accountId of participatingIds) {
      const acc = accountMap.get(accountId);
      const alloc = accountAllocations[accountId] ?? { filesCount: 0, bytesAllocated: 0 };
      const driveFolderId = `demo-share-${batchFolderName}-${linkSeq++}`;
      const webViewLink = `https://drive.google.com/drive/folders/${driveFolderId}`;

      links.push({
        accountId,
        accountEmail: acc?.email ?? accountId,
        accountDisplayName: acc?.displayName ?? accountId,
        rootFolderId: driveFolderId,
        webViewLink,
        filesCount: alloc.filesCount,
        bytesAllocated: alloc.bytesAllocated,
      });

      newShareLinkRecords.push({
        id: generateDemoId('slink'),
        poolId: sharePoolId,
        batchFolderName,
        accountId,
        driveFolderId,
        webViewLink,
        filesCount: alloc.filesCount,
        bytesAllocated: alloc.bytesAllocated,
      });
    }

    await runStoreMutation(['pools', 'accounts', 'folders', 'files', 'transferLogs', 'shareLinks'], (tx) => {
      if (createdSharePool) {
        tx.objectStore('pools').put(createdSharePool);
      }
      const accountsStore = tx.objectStore('accounts');
      for (const accId of updatedAccountIds) {
        const acc = accountMap.get(accId);
        if (acc) accountsStore.put(acc);
      }
      const foldersStore = tx.objectStore('folders');
      for (const folder of createdFolders) foldersStore.put(folder);
      const filesStore = tx.objectStore('files');
      for (const file of newFiles) filesStore.put(file);
      const logsStore = tx.objectStore('transferLogs');
      for (const log of newLogs) logsStore.put(log);
      const linksStore = tx.objectStore('shareLinks');
      for (const link of newShareLinkRecords) linksStore.put(link);
    });

    return {
      sharePoolId,
      batchFolderName,
      totalBytes: targets.totalBytes,
      fileCount: targets.fileCount,
      folderCount: targets.folderCount,
      links,
    };
  });
}

export async function handleListShareLinks(poolId?: number): Promise<{ links: StoredShareLink[] }> {
  const state = await loadDemoState();
  const resolvedPoolId = poolId ?? state.pools.find((p) => p.isSharePool)?.id;
  if (resolvedPoolId === undefined) {
    return { links: [] };
  }

  const accountMap = new Map(state.accounts.map((a) => [a.id, a]));
  const poolFolderPaths = new Set(
    state.folders.filter((f) => f.poolId === resolvedPoolId).map((f) => f.virtualPath)
  );
  const activeFiles = state.files.filter((f) => f.poolId === resolvedPoolId && !f.isTrashed);

  const results: StoredShareLink[] = [];
  for (const link of state.shareLinks) {
    if (link.poolId !== resolvedPoolId) continue;
    const acc = accountMap.get(link.accountId);
    if (!acc) continue;
    const batchPath = `/${link.batchFolderName}`;
    if (!poolFolderPaths.has(batchPath)) continue;

    if (link.filesCount === 0) {
      results.push({
        batchFolderName: link.batchFolderName,
        accountId: link.accountId,
        accountEmail: acc.email,
        accountDisplayName: acc.displayName,
        driveFolderId: link.driveFolderId,
        webViewLink: link.webViewLink,
        filesCount: 0,
        bytesAllocated: 0,
      });
      continue;
    }

    const matching = activeFiles.filter(
      (f) =>
        f.accountId === link.accountId &&
        (f.virtualPath === batchPath || f.virtualPath.startsWith(`${batchPath}/`))
    );
    if (matching.length === 0) continue;

    results.push({
      batchFolderName: link.batchFolderName,
      accountId: link.accountId,
      accountEmail: acc.email,
      accountDisplayName: acc.displayName,
      driveFolderId: link.driveFolderId,
      webViewLink: link.webViewLink,
      filesCount: matching.length,
      bytesAllocated: matching.reduce((s, f) => s + f.sizeBytes, 0),
    });
  }

  results.sort((a, b) => {
    if (a.batchFolderName !== b.batchFolderName) {
      return b.batchFolderName.localeCompare(a.batchFolderName);
    }
    return a.accountEmail.localeCompare(b.accountEmail);
  });

  return { links: results };
}

export async function handleClearSharePool(sharePoolId: number) {
  return withDemoWriteLock(async () => {
    const state = await loadDemoState();
    const pool = state.pools.find((p) => p.id === sharePoolId);
    if (!pool) {
      throw new DemoHttpError(404, `Pool ${sharePoolId} not found`, 'NOT_FOUND');
    }
    if (!pool.isSharePool) {
      throw new DemoHttpError(400, `Pool ${sharePoolId} is not the Share Pool`, 'VALIDATION_ERROR');
    }

    const poolFiles = state.files.filter((f) => f.poolId === sharePoolId);
    const poolFolders = state.folders.filter((f) => f.poolId === sharePoolId);
    const poolLinks = state.shareLinks.filter((l) => l.poolId === sharePoolId);

    const bytesByAccount = new Map<string, number>();
    let bytesReclaimed = 0;
    for (const f of poolFiles) {
      bytesReclaimed += f.sizeBytes;
      bytesByAccount.set(f.accountId, (bytesByAccount.get(f.accountId) ?? 0) + f.sizeBytes);
    }

    const nowIso = new Date().toISOString();
    const updatedAccounts: DemoAccountRecord[] = [];
    for (const [accId, bytes] of bytesByAccount) {
      const acc = state.accounts.find((a) => a.id === accId);
      if (acc) {
        updatedAccounts.push({
          ...acc,
          quotaUsedBytes: Math.max(0, acc.quotaUsedBytes - bytes),
          updatedAt: nowIso,
        });
      }
    }

    await runStoreMutation(['files', 'folders', 'shareLinks', 'accounts'], (tx) => {
      const filesStore = tx.objectStore('files');
      const foldersStore = tx.objectStore('folders');
      const linksStore = tx.objectStore('shareLinks');
      const accountsStore = tx.objectStore('accounts');

      for (const f of poolFiles) filesStore.delete(f.id);
      for (const f of poolFolders) foldersStore.delete(f.id);
      for (const l of poolLinks) linksStore.delete(l.id);
      for (const acc of updatedAccounts) accountsStore.put(acc);
    });

    return {
      sharePoolId,
      filesRemoved: poolFiles.length,
      foldersRemoved: poolFolders.length,
      bytesReclaimed,
      warnings: [] as string[],
    };
  });
}

// --- Simulated Metadata-Only Upload & Download Transfer Logging ---

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runDemoUpload(params: DemoUploadParams): Promise<DemoUploadResult> {
  if (params.signal?.aborted) {
    return { ok: false, aborted: true };
  }

  try {
    assertValidDemoFileSize(params.sizeBytes);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const normPath = normalizeVirtualPath(params.virtualPath);
  if (normPath === '/') {
    return { ok: false, error: 'Invalid virtualPath: cannot upload to root directory' };
  }

  // Pre-flight check before simulating progress so errors surface immediately.
  try {
    const state = await loadDemoState();
    assertNotSharePool(state, params.poolId, 'Uploading directly to Share Pool is disabled');

    const existing = state.files.find(
      (f) => f.poolId === params.poolId && !f.isTrashed && f.virtualPath === normPath
    );
    if (existing && params.conflictMode === 'reject') {
      return { ok: false, error: `A file already exists at "${normPath}"` };
    }

    if (params.accountId) {
      validateDemoTargetPlacement(
        params.accountId,
        params.sizeBytes,
        params.poolId,
        state.accounts,
        state.transferLogs,
        Date.now()
      );
    } else {
      selectDemoPlacementForFile(
        { virtualPath: normPath, sizeBytes: params.sizeBytes },
        params.poolId,
        state.accounts,
        state.files,
        state.transferLogs,
        Date.now()
      );
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Simulate smooth progress steps without reading any file bytes.
  const totalBytes = Math.max(0, params.sizeBytes);
  const steps = totalBytes === 0 ? 1 : Math.min(8, Math.max(3, Math.ceil(Math.log10(totalBytes + 10) - 2)));
  const stepDelayMs = totalBytes === 0 ? 40 : 75;

  for (let step = 1; step < steps; step++) {
    const ok = await sleepWithAbort(stepDelayMs, params.signal);
    if (!ok) {
      return { ok: false, aborted: true };
    }
    const loaded = Math.min(totalBytes, Math.round((totalBytes * step) / steps));
    params.onProgress?.(loaded, totalBytes);
  }

  const finalWaitOk = await sleepWithAbort(stepDelayMs, params.signal);
  if (!finalWaitOk) {
    return { ok: false, aborted: true };
  }

  try {
    await withDemoWriteLock(async () => {
      if (params.signal?.aborted) {
        throw new Error('__DEMO_ABORTED__');
      }

      const state = await loadDemoState();
      assertNotSharePool(state, params.poolId, 'Uploading directly to Share Pool is disabled');

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const updatedIso =
        typeof params.lastModified === 'number' && Number.isFinite(params.lastModified) && params.lastModified > 0
          ? new Date(params.lastModified).toISOString()
          : nowIso;

      const activeByPath = new Map(
        state.files
          .filter((f) => f.poolId === params.poolId && !f.isTrashed)
          .map((f) => [f.virtualPath, f])
      );
      const existingFolders = new Map(
        state.folders.filter((f) => f.poolId === params.poolId).map((f) => [f.virtualPath, f])
      );

      let finalPath = normPath;
      let replacedFile: DemoFileRecord | null = null;
      const existing = activeByPath.get(normPath);

      if (existing) {
        if (params.conflictMode === 'reject') {
          throw new DemoHttpError(409, `A file already exists at "${normPath}"`, 'ITEM_EXISTS');
        }
        if (params.conflictMode === 'replace') {
          replacedFile = existing;
        } else {
          finalPath = allocateUniquePath({
            targetDir: getParentDir(normPath),
            baseName: getDemoBaseName(normPath),
            kind: 'file',
            style: 'numbered',
            startCounter: 2,
            skipBase: true,
            isTaken: (p) => activeByPath.has(p) || existingFolders.has(p),
          });
        }
      }

      // Compute post-replace accounts view so replacing a file frees its quota before validation.
      const effectiveAccounts = state.accounts.map((acc) =>
        replacedFile && acc.id === replacedFile.accountId
          ? { ...acc, quotaUsedBytes: Math.max(0, acc.quotaUsedBytes - replacedFile.sizeBytes) }
          : acc
      );

      let targetAccountId: string;
      if (params.accountId) {
        validateDemoTargetPlacement(
          params.accountId,
          params.sizeBytes,
          params.poolId,
          effectiveAccounts,
          state.transferLogs,
          nowMs
        );
        targetAccountId = params.accountId;
      } else {
        const decision = selectDemoPlacementForFile(
          { virtualPath: finalPath, sizeBytes: params.sizeBytes },
          params.poolId,
          effectiveAccounts,
          state.files,
          state.transferLogs,
          nowMs
        );
        targetAccountId = decision.accountId;
      }

      const parentDir = getParentDir(finalPath);
      const createdFolders =
        parentDir !== '/'
          ? ensureFolderChainRecords(params.poolId, parentDir, existingFolders, nowIso)
          : [];

      const newFile: DemoFileRecord = {
        id: generateDemoId('file'),
        poolId: params.poolId,
        virtualPath: finalPath,
        name: getDemoBaseName(finalPath),
        sizeBytes: params.sizeBytes,
        mimeType: params.mimeType || 'application/octet-stream',
        hash: null,
        accountId: targetAccountId,
        driveFileId: generateDemoId('demo-drv'),
        folderId: parentDir === '/' ? null : formatDemoFolderId(params.poolId, parentDir),
        isTrashed: false,
        trashedAt: null,
        createdAt: nowIso,
        updatedAt: updatedIso,
      };

      const mutatedAccounts = new Map<string, DemoAccountRecord>();
      if (replacedFile) {
        const prevAcc = state.accounts.find((a) => a.id === replacedFile!.accountId);
        if (prevAcc) {
          mutatedAccounts.set(prevAcc.id, {
            ...prevAcc,
            quotaUsedBytes: Math.max(0, prevAcc.quotaUsedBytes - replacedFile.sizeBytes),
            updatedAt: nowIso,
          });
        }
      }

      const targetBase =
        mutatedAccounts.get(targetAccountId) ?? state.accounts.find((a) => a.id === targetAccountId);
      if (targetBase) {
        mutatedAccounts.set(targetAccountId, {
          ...targetBase,
          quotaUsedBytes: targetBase.quotaUsedBytes + params.sizeBytes,
          updatedAt: nowIso,
        });
      }

      const logRecord: DemoTransferLogRecord | null =
        params.sizeBytes > 0
          ? {
              id: generateDemoId('tx'),
              accountId: targetAccountId,
              transferType: 'upload',
              byteCount: params.sizeBytes,
              timestamp: nowMs,
            }
          : null;

      await runStoreMutation(['files', 'folders', 'accounts', 'transferLogs'], (tx) => {
        const filesStore = tx.objectStore('files');
        const foldersStore = tx.objectStore('folders');
        const accountsStore = tx.objectStore('accounts');
        if (replacedFile) filesStore.delete(replacedFile.id);
        for (const folder of createdFolders) foldersStore.put(folder);
        filesStore.put(newFile);
        for (const acc of mutatedAccounts.values()) accountsStore.put(acc);
        if (logRecord) tx.objectStore('transferLogs').put(logRecord);
      });
    });

    params.onProgress?.(totalBytes, totalBytes);
    return { ok: true };
  } catch (err) {
    if (err instanceof Error && err.message === '__DEMO_ABORTED__') {
      return { ok: false, aborted: true };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function recordDemoDownload(fileId: string): Promise<void> {
  await withDemoWriteLock(async () => {
    const file = await getRecordByKey<DemoFileRecord>('files', fileId);
    if (!file || file.sizeBytes <= 0) return;

    const logRecord: DemoTransferLogRecord = {
      id: generateDemoId('tx'),
      accountId: file.accountId,
      transferType: 'download',
      byteCount: file.sizeBytes,
      timestamp: Date.now(),
    };
    await runStoreMutation(['transferLogs'], (tx) => {
      tx.objectStore('transferLogs').put(logRecord);
    });
  });
}

export async function resetDemoState(): Promise<void> {
  await resetDemoDatabase();
}

export function mapDemoErrorToHttp(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof DemoHttpError) {
    return {
      status: err.status,
      body: {
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
        ...(err.payload ?? {}),
      },
    };
  }
  if (err instanceof DemoFileExceedsCeilingError) {
    return {
      status: err.status,
      body: { error: err.message, code: err.code },
    };
  }
  if (err instanceof DemoInsufficientStorageError) {
    return {
      status: err.status,
      body: { error: err.message, code: err.code },
    };
  }
  return {
    status: 500,
    body: { error: err instanceof Error ? err.message : String(err) },
  };
}
