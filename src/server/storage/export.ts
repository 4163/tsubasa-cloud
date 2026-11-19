import { createHash } from 'node:crypto';
import { sqlite, buildDirectoryPrefixBounds } from '../db/index.js';
import { normalizeVirtualPath } from '../virtualPath.js';
import {
  calculateHeadroom,
  calculateUsableLimit,
  getPooledStorageOverview,
  getTransferStatsByAccountMap,
} from './quota.js';

export const EXPORT_SCHEMA_VERSION = 1;

export type ExportPreset = 'minimal' | 'standard' | 'full';
export type ExportTrashedMode = 'exclude' | 'include' | 'only';
export type ExportEntityName =
  | 'pools'
  | 'accounts'
  | 'folders'
  | 'files'
  | 'transferLogs'
  | 'shareLinks'
  | 'outbox'
  | 'transferJobs';

export const ALL_EXPORT_ENTITIES: readonly ExportEntityName[] = [
  'pools',
  'accounts',
  'folders',
  'files',
  'transferLogs',
  'shareLinks',
  'outbox',
  'transferJobs',
];

const BASE_ENTITIES: readonly ExportEntityName[] = ['pools', 'accounts', 'folders', 'files'];
const VALID_ENTITY_SET = new Set<string>(ALL_EXPORT_ENTITIES);
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export interface ExportOptions {
  preset?: ExportPreset;
  include?: readonly ExportEntityName[];
  pool?: string | number;
  account?: string;
  path?: string;
  trashed?: ExportTrashedMode;
  showEmails?: boolean;
}

export class ExportValidationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ExportValidationError';
    this.code = code;
    this.status = status;
  }
}

export function isExportEntityName(value: string): value is ExportEntityName {
  return VALID_ENTITY_SET.has(value);
}

function toAccountRef(accountId: string): string {
  const normalized = accountId.trim().toLowerCase();
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `acc_${digest.slice(0, 8)}`;
}

function maskLocalPart(local: string): string {
  if (local.length <= 1) return '*';
  if (local.length === 2) return `${local[0]}*`;
  return `${local[0]}***${local[local.length - 1]}`;
}

function maskDomainLabel(label: string): string {
  if (label.length <= 1) return '*';
  return `${label[0]}***`;
}

function maskEmail(email: string): string {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return email;
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  const maskedLocal = maskLocalPart(local);
  const labels = domain.split('.');
  if (labels.length <= 1) {
    return `${maskedLocal}@${maskDomainLabel(domain)}`;
  }
  const [firstLabel = '', ...rest] = labels;
  return `${maskedLocal}@${maskDomainLabel(firstLabel)}.${rest.join('.')}`;
}

function scrubEmails(text: string | null, redacted: boolean): string | null {
  if (text === null || !redacted) return text;
  return text.replace(EMAIL_PATTERN, (match) => maskEmail(match));
}

function secondsToMs(sec: number | null | undefined): number | null {
  if (sec === null || sec === undefined) return null;
  return Math.trunc(Number(sec)) * 1000;
}

interface ResolvedExportPlan {
  preset: ExportPreset;
  entities: ExportEntityName[];
  redacted: boolean;
  poolId: number | null;
  accountId: string | null;
  pathPrefix: string | null;
  trashed: ExportTrashedMode;
  exportedAt: number;
}

function resolveEntities(preset: ExportPreset, include?: readonly ExportEntityName[]): ExportEntityName[] {
  if (include && include.length > 0) {
    const selected = new Set<ExportEntityName>();
    for (const item of include) {
      if (!isExportEntityName(item)) {
        throw new ExportValidationError(
          'VALIDATION_ERROR',
          `Unknown export entity '${String(item)}'. Allowed: ${ALL_EXPORT_ENTITIES.join(', ')}`
        );
      }
      selected.add(item);
    }
    return ALL_EXPORT_ENTITIES.filter((e) => selected.has(e));
  }
  if (preset === 'full') {
    return [...ALL_EXPORT_ENTITIES];
  }
  return [...BASE_ENTITIES];
}

function resolvePoolFilter(rawPool?: string | number): number | null {
  if (rawPool === undefined || rawPool === null || String(rawPool).trim() === '') {
    return null;
  }
  const selector = String(rawPool).trim();
  if (/^\d+$/.test(selector)) {
    const id = Number(selector);
    const row = sqlite.prepare('SELECT id FROM pools WHERE id = ? LIMIT 1').get(id) as
      | { id: number }
      | undefined;
    if (row) return row.id;
  }
  const bySlug = sqlite
    .prepare('SELECT id FROM pools WHERE LOWER(slug) = LOWER(?) LIMIT 1')
    .get(selector) as { id: number } | undefined;
  if (bySlug) return bySlug.id;

  throw new ExportValidationError('POOL_NOT_FOUND', `Pool '${selector}' not found`, 404);
}

function resolveAccountFilter(rawAccount?: string): string | null {
  if (!rawAccount || !rawAccount.trim()) {
    return null;
  }
  const query = rawAccount.trim().toLowerCase();
  const rows = sqlite
    .prepare('SELECT id, email FROM accounts ORDER BY id ASC')
    .all() as Array<{ id: string; email: string }>;

  for (const row of rows) {
    if (toAccountRef(row.id) === query) {
      return row.id;
    }
  }
  for (const row of rows) {
    if (row.id.toLowerCase() === query || row.email.toLowerCase() === query) {
      return row.id;
    }
  }

  const prefixMatches = rows.filter((row) => row.email.toLowerCase().startsWith(query));
  if (prefixMatches.length === 1) {
    return prefixMatches[0].id;
  }
  if (prefixMatches.length > 1) {
    const candidates = prefixMatches
      .map((r) => `${toAccountRef(r.id)} (${maskEmail(r.email)})`)
      .join(', ');
    throw new ExportValidationError(
      'AMBIGUOUS_ACCOUNT_SELECTOR',
      `Ambiguous account filter '${rawAccount}' matches: ${candidates}`,
      400
    );
  }

  throw new ExportValidationError('ACCOUNT_NOT_FOUND', `Account '${rawAccount}' not found`, 404);
}

function resolvePlan(options: ExportOptions): ResolvedExportPlan {
  const preset: ExportPreset = options.preset ?? 'standard';
  if (preset !== 'minimal' && preset !== 'standard' && preset !== 'full') {
    throw new ExportValidationError(
      'VALIDATION_ERROR',
      `Invalid preset '${String(preset)}'. Expected minimal, standard, or full.`
    );
  }
  const trashed: ExportTrashedMode = options.trashed ?? 'exclude';
  if (trashed !== 'exclude' && trashed !== 'include' && trashed !== 'only') {
    throw new ExportValidationError(
      'VALIDATION_ERROR',
      `Invalid trashed mode '${String(trashed)}'. Expected exclude, include, or only.`
    );
  }

  const entities = resolveEntities(preset, options.include);
  const poolId = resolvePoolFilter(options.pool);
  const accountId = resolveAccountFilter(options.account);
  const pathPrefix = options.path?.trim() ? normalizeVirtualPath(options.path) : null;

  return {
    preset,
    entities,
    redacted: options.showEmails !== true,
    poolId,
    accountId,
    pathPrefix,
    trashed,
    exportedAt: Date.now(),
  };
}

async function loadPoolsForExport(plan: ResolvedExportPlan): Promise<Record<string, unknown>[]> {
  const rows = (
    plan.poolId !== null
      ? sqlite
          .prepare(
            `SELECT id, name, slug, sort_order as sortOrder, drive_folder_name as driveFolderName,
                    is_share_pool as isSharePool, created_at as createdAt, updated_at as updatedAt
             FROM pools WHERE id = ?
             ORDER BY is_share_pool ASC, sort_order ASC, id ASC`
          )
          .all(plan.poolId)
      : sqlite
          .prepare(
            `SELECT id, name, slug, sort_order as sortOrder, drive_folder_name as driveFolderName,
                    is_share_pool as isSharePool, created_at as createdAt, updated_at as updatedAt
             FROM pools
             ORDER BY is_share_pool ASC, sort_order ASC, id ASC`
          )
          .all()
  ) as Array<{
    id: number;
    name: string;
    slug: string;
    sortOrder: number;
    driveFolderName: string;
    isSharePool: number;
    createdAt: number;
    updatedAt: number;
  }>;

  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const overview = await getPooledStorageOverview(row.id, plan.exportedAt);
    if (plan.preset === 'minimal') {
      out.push({
        id: row.id,
        name: row.name,
        slug: row.slug,
        sortOrder: row.sortOrder,
        isSharePool: Boolean(row.isSharePool),
        totalAccounts: overview.totalAccounts,
        totalHeadroomBytes: overview.totalHeadroomBytes,
        totalTsubasaUsedBytes: overview.totalTsubasaUsedBytes,
      });
    } else {
      out.push({
        id: row.id,
        name: row.name,
        slug: row.slug,
        sortOrder: row.sortOrder,
        driveFolderName: row.driveFolderName,
        isSharePool: Boolean(row.isSharePool),
        totalAccounts: overview.totalAccounts,
        totalLimitBytes: overview.totalLimitBytes,
        totalUsedBytes: overview.totalUsedBytes,
        totalHeadroomBytes: overview.totalHeadroomBytes,
        totalTsubasaUsedBytes: overview.totalTsubasaUsedBytes,
        uploadedBytes24h: overview.clusterTransfer?.totalUploadedBytes24h ?? 0,
        remainingUploadBytes24h: overview.clusterTransfer?.totalRemainingUploadBytes24h ?? 0,
        createdAt: secondsToMs(row.createdAt),
        updatedAt: secondsToMs(row.updatedAt),
      });
    }
  }
  return out;
}

async function loadAccountsForExport(plan: ResolvedExportPlan): Promise<Record<string, unknown>[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (plan.poolId !== null) {
    conditions.push('pool_id = ?');
    params.push(plan.poolId);
  }
  if (plan.accountId !== null) {
    conditions.push('id = ?');
    params.push(plan.accountId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = sqlite
    .prepare(
      `SELECT id, email, display_name as displayName, pool_id as poolId,
              quota_limit_bytes as quotaLimitBytes, quota_used_bytes as quotaUsedBytes,
              sync_state as syncState, is_disabled as isDisabled,
              created_at as createdAt, updated_at as updatedAt
       FROM accounts
       ${where}
       ORDER BY pool_id ASC, id ASC`
    )
    .all(...params) as Array<{
    id: string;
    email: string;
    displayName: string;
    poolId: number;
    quotaLimitBytes: number;
    quotaUsedBytes: number;
    syncState: string;
    isDisabled: number;
    createdAt: number;
    updatedAt: number;
  }>;

  const statsMap = await getTransferStatsByAccountMap(
    rows.map((r) => r.id),
    plan.exportedAt
  );

  return rows.map((row) => {
    const accountRef = toAccountRef(row.id);
    const id = plan.redacted ? maskEmail(row.id) : row.id;
    const email = plan.redacted ? maskEmail(row.email) : row.email;
    const usableLimitBytes = calculateUsableLimit(row.quotaLimitBytes);
    const headroomBytes = calculateHeadroom(row.quotaLimitBytes, row.quotaUsedBytes);
    const transferStats = statsMap.get(row.id);

    if (plan.preset === 'minimal') {
      return {
        accountRef,
        id,
        email,
        poolId: row.poolId,
        quotaUsedBytes: row.quotaUsedBytes,
        headroomBytes,
        syncState: row.syncState,
        isDisabled: Boolean(row.isDisabled),
      };
    }

    return {
      accountRef,
      id,
      email,
      displayName: row.displayName,
      poolId: row.poolId,
      quotaLimitBytes: row.quotaLimitBytes,
      quotaUsedBytes: row.quotaUsedBytes,
      usableLimitBytes,
      headroomBytes,
      uploadedBytes24h: transferStats?.uploadedBytes24h ?? 0,
      remainingUploadBytes24h: transferStats?.remainingUploadBytes24h ?? 0,
      downloadedBytes24h: transferStats?.downloadedBytes24h ?? 0,
      syncState: row.syncState,
      isDisabled: Boolean(row.isDisabled),
      createdAt: secondsToMs(row.createdAt),
      updatedAt: secondsToMs(row.updatedAt),
    };
  });
}

function* iterateFolders(plan: ResolvedExportPlan): Generator<Record<string, unknown>> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (plan.poolId !== null) {
    conditions.push('pool_id = ?');
    params.push(plan.poolId);
  }
  if (plan.pathPrefix !== null && plan.pathPrefix !== '/') {
    const { lower, upper } = buildDirectoryPrefixBounds(plan.pathPrefix);
    conditions.push('(virtual_path = ? OR (virtual_path >= ? AND virtual_path < ?))');
    params.push(plan.pathPrefix, lower, upper);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const stmt = sqlite.prepare(
    `SELECT id, pool_id as poolId, virtual_path as virtualPath, name,
            parent_folder_id as parentFolderId, created_at as createdAt, updated_at as updatedAt
     FROM folders
     ${where}
     ORDER BY pool_id ASC, virtual_path ASC, id ASC`
  );

  for (const raw of stmt.iterate(...params)) {
    const row = raw as {
      id: string;
      poolId: number;
      virtualPath: string;
      name: string;
      parentFolderId: string | null;
      createdAt: number;
      updatedAt: number;
    };
    if (plan.preset === 'minimal') {
      yield {
        id: row.id,
        poolId: row.poolId,
        virtualPath: row.virtualPath,
        name: row.name,
      };
    } else {
      yield {
        id: row.id,
        poolId: row.poolId,
        virtualPath: row.virtualPath,
        name: row.name,
        parentFolderId: row.parentFolderId,
        createdAt: secondsToMs(row.createdAt),
        updatedAt: secondsToMs(row.updatedAt),
      };
    }
  }
}

function* iterateFiles(plan: ResolvedExportPlan): Generator<Record<string, unknown>> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (plan.poolId !== null) {
    conditions.push('pool_id = ?');
    params.push(plan.poolId);
  }
  if (plan.accountId !== null) {
    conditions.push('account_id = ?');
    params.push(plan.accountId);
  }
  if (plan.trashed === 'exclude') {
    conditions.push('is_trashed = 0');
  } else if (plan.trashed === 'only') {
    conditions.push('is_trashed = 1');
  }
  if (plan.pathPrefix !== null && plan.pathPrefix !== '/') {
    const { lower, upper } = buildDirectoryPrefixBounds(plan.pathPrefix);
    conditions.push('(virtual_path = ? OR (virtual_path >= ? AND virtual_path < ?))');
    params.push(plan.pathPrefix, lower, upper);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // files.updatedAt reflects local SQLite index time because Drive modifiedTime is not synced.
  const stmt = sqlite.prepare(
    `SELECT id, pool_id as poolId, virtual_path as virtualPath, name,
            size_bytes as sizeBytes, mime_type as mimeType, hash,
            account_id as accountId, drive_file_id as driveFileId, folder_id as folderId,
            is_trashed as isTrashed, trashed_at as trashedAt,
            created_at as createdAt, updated_at as updatedAt
     FROM files
     ${where}
     ORDER BY pool_id ASC, virtual_path ASC, id ASC`
  );

  for (const raw of stmt.iterate(...params)) {
    const row = raw as {
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
    };
    const accountRef = toAccountRef(row.accountId);
    const accountId = plan.redacted ? maskEmail(row.accountId) : row.accountId;

    if (plan.preset === 'minimal') {
      yield {
        id: row.id,
        poolId: row.poolId,
        virtualPath: row.virtualPath,
        name: row.name,
        sizeBytes: row.sizeBytes,
        hash: row.hash,
        accountRef,
        accountId,
        isTrashed: Boolean(row.isTrashed),
      };
    } else {
      yield {
        id: row.id,
        poolId: row.poolId,
        virtualPath: row.virtualPath,
        name: row.name,
        sizeBytes: row.sizeBytes,
        mimeType: row.mimeType,
        hash: row.hash,
        accountRef,
        accountId,
        driveFileId: row.driveFileId,
        folderId: row.folderId,
        isTrashed: Boolean(row.isTrashed),
        trashedAt: secondsToMs(row.trashedAt),
        createdAt: secondsToMs(row.createdAt),
        updatedAt: secondsToMs(row.updatedAt),
      };
    }
  }
}

function* iterateTransferLogs(plan: ResolvedExportPlan): Generator<Record<string, unknown>> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (plan.accountId !== null) {
    conditions.push('t.account_id = ?');
    params.push(plan.accountId);
  }
  if (plan.poolId !== null) {
    conditions.push('a.pool_id = ?');
    params.push(plan.poolId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const stmt = sqlite.prepare(
    `SELECT t.id, t.account_id as accountId, t.transfer_type as transferType,
            t.byte_count as byteCount, t.timestamp
     FROM transfer_logs t
     LEFT JOIN accounts a ON a.id = t.account_id
     ${where}
     ORDER BY t.timestamp ASC, t.id ASC`
  );

  for (const raw of stmt.iterate(...params)) {
    const row = raw as {
      id: string;
      accountId: string;
      transferType: string;
      byteCount: number;
      timestamp: number;
    };
    yield {
      id: row.id,
      accountRef: toAccountRef(row.accountId),
      accountId: plan.redacted ? maskEmail(row.accountId) : row.accountId,
      transferType: row.transferType,
      byteCount: row.byteCount,
      timestamp: Number(row.timestamp),
    };
  }
}

function* iterateShareLinks(plan: ResolvedExportPlan): Generator<Record<string, unknown>> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (plan.poolId !== null) {
    conditions.push('pool_id = ?');
    params.push(plan.poolId);
  }
  if (plan.accountId !== null) {
    conditions.push('account_id = ?');
    params.push(plan.accountId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const stmt = sqlite.prepare(
    `SELECT id, pool_id as poolId, batch_folder_name as batchFolderName,
            account_id as accountId, drive_folder_id as driveFolderId,
            web_view_link as webViewLink, files_count as filesCount,
            bytes_allocated as bytesAllocated, created_at as createdAt
     FROM share_links
     ${where}
     ORDER BY pool_id ASC, batch_folder_name ASC, account_id ASC, id ASC`
  );

  for (const raw of stmt.iterate(...params)) {
    const row = raw as {
      id: string;
      poolId: number;
      batchFolderName: string;
      accountId: string;
      driveFolderId: string;
      webViewLink: string;
      filesCount: number;
      bytesAllocated: number;
      createdAt: number;
    };
    yield {
      id: row.id,
      poolId: row.poolId,
      batchFolderName: row.batchFolderName,
      accountRef: toAccountRef(row.accountId),
      accountId: plan.redacted ? maskEmail(row.accountId) : row.accountId,
      driveFolderId: row.driveFolderId,
      webViewLink: row.webViewLink,
      filesCount: row.filesCount,
      bytesAllocated: row.bytesAllocated,
      createdAt: secondsToMs(row.createdAt),
    };
  }
}

function* iterateOutbox(plan: ResolvedExportPlan): Generator<Record<string, unknown>> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (plan.poolId !== null) {
    conditions.push('pool_id = ?');
    params.push(plan.poolId);
  }
  if (plan.accountId !== null) {
    conditions.push('account_id = ?');
    params.push(plan.accountId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const stmt = sqlite.prepare(
    `SELECT id, account_id as accountId, pool_id as poolId, op_type as opType,
            drive_file_id as driveFileId, status, attempts, next_retry_at as nextRetryAt,
            last_error as lastError, created_at as createdAt, updated_at as updatedAt
     FROM drive_outbox
     ${where}
     ORDER BY created_at ASC, id ASC`
  );

  for (const raw of stmt.iterate(...params)) {
    const row = raw as {
      id: string;
      accountId: string;
      poolId: number | null;
      opType: string;
      driveFileId: string | null;
      status: string;
      attempts: number;
      nextRetryAt: number;
      lastError: string | null;
      createdAt: number;
      updatedAt: number;
    };
    yield {
      id: row.id,
      accountRef: toAccountRef(row.accountId),
      accountId: plan.redacted ? maskEmail(row.accountId) : row.accountId,
      poolId: row.poolId,
      opType: row.opType,
      driveFileId: row.driveFileId,
      status: row.status,
      attempts: row.attempts,
      nextRetryAt: Number(row.nextRetryAt),
      lastError: scrubEmails(row.lastError, plan.redacted),
      createdAt: secondsToMs(row.createdAt),
      updatedAt: secondsToMs(row.updatedAt),
    };
  }
}

function* iterateTransferJobs(plan: ResolvedExportPlan): Generator<Record<string, unknown>> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (plan.poolId !== null) {
    conditions.push('(pool_id = ? OR source_pool_id = ?)');
    params.push(plan.poolId, plan.poolId);
  }
  if (plan.accountId !== null) {
    conditions.push('account_id = ?');
    params.push(plan.accountId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const stmt = sqlite.prepare(
    `SELECT id, kind, status, pool_id as poolId, source_pool_id as sourcePoolId,
            account_id as accountId, conflict_policy as conflictPolicy, mode,
            total_items as totalItems, completed_items as completedItems,
            failed_items as failedItems, skipped_items as skippedItems,
            total_bytes as totalBytes, transferred_bytes as transferredBytes,
            pause_reason as pauseReason, last_error as lastError,
            created_at as createdAt, updated_at as updatedAt, completed_at as completedAt
     FROM transfer_jobs
     ${where}
     ORDER BY created_at ASC, id ASC`
  );

  for (const raw of stmt.iterate(...params)) {
    const row = raw as {
      id: string;
      kind: string;
      status: string;
      poolId: number | null;
      sourcePoolId: number | null;
      accountId: string | null;
      conflictPolicy: string;
      mode: string | null;
      totalItems: number;
      completedItems: number;
      failedItems: number;
      skippedItems: number;
      totalBytes: number;
      transferredBytes: number;
      pauseReason: string | null;
      lastError: string | null;
      createdAt: number;
      updatedAt: number;
      completedAt: number | null;
    };
    yield {
      id: row.id,
      kind: row.kind,
      status: row.status,
      poolId: row.poolId,
      sourcePoolId: row.sourcePoolId,
      accountRef: row.accountId ? toAccountRef(row.accountId) : null,
      accountId: row.accountId
        ? plan.redacted
          ? maskEmail(row.accountId)
          : row.accountId
        : null,
      conflictPolicy: row.conflictPolicy,
      mode: row.mode,
      totalItems: row.totalItems,
      completedItems: row.completedItems,
      failedItems: row.failedItems,
      skippedItems: row.skippedItems,
      totalBytes: row.totalBytes,
      transferredBytes: row.transferredBytes,
      pauseReason: scrubEmails(row.pauseReason, plan.redacted),
      lastError: scrubEmails(row.lastError, plan.redacted),
      createdAt: secondsToMs(row.createdAt),
      updatedAt: secondsToMs(row.updatedAt),
      completedAt: secondsToMs(row.completedAt),
    };
  }
}

function buildMetaRecord(plan: ResolvedExportPlan): Record<string, unknown> {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: plan.exportedAt,
    redacted: plan.redacted,
    preset: plan.preset,
    entities: plan.entities,
    filters: {
      poolId: plan.poolId,
      accountRef: plan.accountId ? toAccountRef(plan.accountId) : null,
      path: plan.pathPrefix,
      trashed: plan.trashed,
    },
  };
}

export async function* iterateExportJsonl(options: ExportOptions = {}): AsyncGenerator<string> {
  const plan = resolvePlan(options);
  yield `${JSON.stringify({ _type: 'meta', ...buildMetaRecord(plan) })}\n`;

  for (const entity of plan.entities) {
    if (entity === 'pools') {
      const pools = await loadPoolsForExport(plan);
      for (const record of pools) {
        yield `${JSON.stringify({ _type: 'pools', ...record })}\n`;
      }
      continue;
    }
    if (entity === 'accounts') {
      const accounts = await loadAccountsForExport(plan);
      for (const record of accounts) {
        yield `${JSON.stringify({ _type: 'accounts', ...record })}\n`;
      }
      continue;
    }

    const iterator =
      entity === 'folders'
        ? iterateFolders(plan)
        : entity === 'files'
          ? iterateFiles(plan)
          : entity === 'transferLogs'
            ? iterateTransferLogs(plan)
            : entity === 'shareLinks'
              ? iterateShareLinks(plan)
              : entity === 'outbox'
                ? iterateOutbox(plan)
                : iterateTransferJobs(plan);

    for (const record of iterator) {
      yield `${JSON.stringify({ _type: entity, ...record })}\n`;
    }
  }
}

export async function buildCanonicalExport(
  options: ExportOptions = {}
): Promise<Record<string, unknown>> {
  const plan = resolvePlan(options);
  const payload: Record<string, unknown> = buildMetaRecord(plan);

  for (const entity of plan.entities) {
    if (entity === 'pools') {
      payload.pools = await loadPoolsForExport(plan);
    } else if (entity === 'accounts') {
      payload.accounts = await loadAccountsForExport(plan);
    } else if (entity === 'folders') {
      payload.folders = Array.from(iterateFolders(plan));
    } else if (entity === 'files') {
      payload.files = Array.from(iterateFiles(plan));
    } else if (entity === 'transferLogs') {
      payload.transferLogs = Array.from(iterateTransferLogs(plan));
    } else if (entity === 'shareLinks') {
      payload.shareLinks = Array.from(iterateShareLinks(plan));
    } else if (entity === 'outbox') {
      payload.outbox = Array.from(iterateOutbox(plan));
    } else if (entity === 'transferJobs') {
      payload.transferJobs = Array.from(iterateTransferJobs(plan));
    }
  }

  return payload;
}
