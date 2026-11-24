import fs from 'node:fs';
import path from 'node:path';
import {
  emitSuccess,
  formatTimestamp,
  readFlagValue,
  readStdinLines,
  requireConfirmation,
  resolvePoolArg,
  type CliContext,
  type PoolInfo,
} from '../context.js';
import { CliError, EXIT_CODES } from '../lib/errors.js';
import { formatBytes, renderTable } from '../lib/format.js';
import { maskEmail, scrubEmailsInString, toAccountRef } from '../lib/redact.js';
import { resolveAccountArg } from './accounts.js';

type TrashedFileRow = {
  id: string;
  poolId: number;
  virtualPath: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  accountId: string;
  trashedAt: number | null;
};

type OutboxEntryRow = {
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

interface OutboxListResponse {
  entries: OutboxEntryRow[];
  summary: {
    counts: {
      pending: number;
      processing: number;
      failed: number;
      dead: number;
    };
  };
}

interface StoredShareLink {
  batchFolderName: string;
  accountId: string;
  accountEmail: string;
  accountDisplayName: string;
  driveFolderId: string;
  webViewLink: string;
  filesCount: number;
  bytesAllocated: number;
}

interface LocalAuditResponse {
  ok: boolean;
  integrity: { ok: boolean; messages: string[] };
  orphanFolderFiles: Array<{ id: string; poolId: number; virtualPath: string; folderId: string }>;
  orphanAccountFiles: Array<{ id: string; poolId: number; virtualPath: string; accountId: string }>;
  accountQuotaChecks: Array<{
    accountId: string;
    email: string;
    poolId: number;
    quotaLimitBytes: number;
    quotaUsedBytes: number;
    usableLimitBytes: number;
    indexedBytes: number;
    driftBytes: number;
    overCeilingBytes: number;
    isOverCeiling: boolean;
  }>;
  overCeilingAccounts: Array<{ accountId: string; overCeilingBytes: number }>;
  outbox: {
    counts: { pending: number; processing: number; failed: number; dead: number };
  };
}

interface DupesResponse {
  by: 'hash' | 'name-size';
  poolId: number | null;
  groupCount: number;
  duplicateFileCount: number;
  wastedBytes: number;
  groups: Array<{
    key: string;
    hash: string | null;
    name: string | null;
    sizeBytes: number;
    count: number;
    wastedBytes: number;
    files: Array<{
      id: string;
      poolId: number;
      virtualPath: string;
      name: string;
      sizeBytes: number;
      accountId: string;
    }>;
  }>;
}

const VALID_OUTBOX_STATUSES = new Set(['pending', 'processing', 'failed', 'dead']);
const COLD_SYNC_HYDRATION_CONCURRENCY = 4;

interface SyncAccountSummary {
  accountId: string;
  authorized: boolean;
  poolId: number;
}

interface HydratedAccountResult {
  accountId: string;
  email: string;
  poolId: number;
  rootFolderId: string;
}

interface ColdSyncAccountError {
  accountRef: string;
  accountId: string;
  error: string;
}

async function hydrateAccountsBounded(
  ctx: CliContext,
  accountsToHydrate: readonly SyncAccountSummary[]
): Promise<{
  hydrated: HydratedAccountResult[];
  errors: ColdSyncAccountError[];
}> {
  const results: Array<{ ok: true; data: HydratedAccountResult } | { ok: false; error: ColdSyncAccountError }> =
    new Array(accountsToHydrate.length);
  let nextIndex = 0;

  const workerCount = Math.min(COLD_SYNC_HYDRATION_CONCURRENCY, accountsToHydrate.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < accountsToHydrate.length) {
        const index = nextIndex;
        nextIndex += 1;
        const acc = accountsToHydrate[index];
        try {
          // Omit ?poolId so hydrateAccount discovers each account's actual Drive pool folder
          // without retargeting empty non-Pool-1 folders to Pool 1.
          const data = await ctx.transport.requestJson<HydratedAccountResult>(
            `/api/accounts/hydrate/${encodeURIComponent(acc.accountId)}`,
            { method: 'POST' }
          );
          results[index] = { ok: true, data };
        } catch (err) {
          results[index] = {
            ok: false,
            error: {
              accountRef: toAccountRef(acc.accountId),
              accountId: acc.accountId,
              error: err instanceof Error ? err.message : String(err),
            },
          };
        }
      }
    })
  );

  const hydrated: HydratedAccountResult[] = [];
  const errors: ColdSyncAccountError[] = [];
  const seenAccountIds = new Set<string>();

  for (const entry of results) {
    if (!entry) continue;
    if (!entry.ok) {
      errors.push(entry.error);
      continue;
    }
    if (seenAccountIds.has(entry.data.accountId)) {
      continue;
    }
    seenAccountIds.add(entry.data.accountId);
    hydrated.push(entry.data);
  }

  return { hydrated, errors };
}

export async function handleTrash(ctx: CliContext, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa trash <list|restore|purge>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (subcommand === 'list') {
    if (rest.length > 0) {
      throw new CliError('USAGE_ERROR', `Unexpected argument '${rest[0]}' for trash list.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    const pool = await resolvePoolArg(ctx);
    const res = await ctx.transport.requestJson<{ files: TrashedFileRow[] }>(
      `/api/trash?poolId=${pool.id}`
    );
    const files = res.files ?? [];
    const table = renderTable(
      files,
      [
        { key: 'id', header: 'ID' },
        { key: 'virtualPath', header: 'PATH' },
        { key: 'sizeBytes', header: 'SIZE', align: 'right', format: (f) => formatBytes(f.sizeBytes) },
        {
          key: 'accountId',
          header: 'ACCOUNT',
          format: (f) =>
            `${toAccountRef(f.accountId)} (${ctx.flags.showEmails ? f.accountId : maskEmail(f.accountId)})`,
        },
        { key: 'trashedAt', header: 'TRASHED', format: (f) => formatTimestamp(f.trashedAt) },
      ],
      { emptyMessage: `Trash is empty in pool '${pool.slug}'.` }
    );
    emitSuccess(ctx, { poolId: pool.id, poolSlug: pool.slug, files }, table);
    return;
  }

  if (subcommand === 'restore') {
    let useStdin = false;
    const positionals: string[] = [];
    for (const token of rest) {
      if (token === '--stdin') {
        useStdin = true;
        continue;
      }
      if (token.startsWith('-')) {
        throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for trash restore.`, {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      positionals.push(token);
    }
    const stdinLines = useStdin ? await readStdinLines() : [];
    const ids = [...positionals, ...stdinLines];
    if (ids.length === 0) {
      throw new CliError('USAGE_ERROR', 'Usage: tsubasa trash restore <ids...>', {
        exitCode: EXIT_CODES.USAGE,
      });
    }

    if (ctx.flags.dryRun) {
      emitSuccess(
        ctx,
        { dryRun: true, action: 'trash restore', ids },
        `[dry-run] restore ${ids.length} trashed file(s)`
      );
      return;
    }

    const restored: unknown[] = [];
    for (const id of ids) {
      const item = await ctx.transport.requestJson(`/api/files/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
      });
      restored.push(item);
    }
    emitSuccess(ctx, { restored }, `Restored ${restored.length} file(s).`);
    return;
  }

  if (subcommand === 'purge') {
    if (rest.length > 0) {
      throw new CliError('USAGE_ERROR', `Unexpected argument '${rest[0]}' for trash purge.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    const pool = await resolvePoolArg(ctx);

    if (ctx.flags.dryRun) {
      const res = await ctx.transport.requestJson<{ files: TrashedFileRow[] }>(
        `/api/trash?poolId=${pool.id}`
      );
      const files = res.files ?? [];
      const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
      emitSuccess(
        ctx,
        {
          dryRun: true,
          action: 'trash purge',
          poolId: pool.id,
          poolSlug: pool.slug,
          filesToPurge: files.length,
          bytesToReclaim: totalBytes,
        },
        `[dry-run] purge ${files.length} trashed file(s) (${formatBytes(totalBytes)}) from pool '${pool.slug}'`
      );
      return;
    }

    await requireConfirmation(
      ctx,
      `permanently purge all trashed files in pool '${pool.slug}' (id=${pool.id})`
    );
    const report = await ctx.transport.requestJson<{ filesPurged: number; bytesReclaimed: number }>(
      `/api/trash/empty?poolId=${pool.id}`,
      { method: 'DELETE' }
    );
    emitSuccess(
      ctx,
      { poolId: pool.id, poolSlug: pool.slug, ...report },
      `Purged ${report.filesPurged} file(s), reclaimed ${formatBytes(report.bytesReclaimed)}.`
    );
    return;
  }

  throw new CliError(
    'USAGE_ERROR',
    `Unknown trash subcommand '${subcommand}'. Expected list, restore, or purge.`,
    { exitCode: EXIT_CODES.USAGE }
  );
}

export async function handleSync(ctx: CliContext, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'delta' && subcommand !== 'cold') {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa sync <delta|cold> [account]', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  let accountFlagSelector: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--account') {
      accountFlagSelector = readFlagValue(rest, i, '--account').trim();
      i += 1;
      continue;
    }
    if (token.startsWith('--account=')) {
      const value = token.slice('--account='.length).trim();
      if (!value) {
        throw new CliError('USAGE_ERROR', 'Flag --account requires a non-empty value.', {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      accountFlagSelector = value;
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for sync ${subcommand}.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }
  if (positionals.length > 1 || (positionals.length === 1 && accountFlagSelector)) {
    throw new CliError('USAGE_ERROR', `Usage: tsubasa sync ${subcommand} [account]`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const accountSelector = accountFlagSelector ?? positionals[0];
  if (accountSelector) {
    const acc = await resolveAccountArg(ctx, accountSelector);
    const masked = ctx.flags.showEmails ? acc.email : maskEmail(acc.email);

    if (ctx.flags.dryRun) {
      emitSuccess(
        ctx,
        {
          dryRun: true,
          mode: subcommand,
          accountRef: acc.accountRef,
          accountId: acc.accountId,
        },
        `[dry-run] sync ${subcommand} for ${acc.accountRef} (${masked})`
      );
      return;
    }

    if (subcommand === 'cold') {
      if (!acc.authorized) {
        throw new CliError(
          'AUTH_ERROR',
          `Account ${acc.accountRef} (${masked}) is not authorized.`,
          { exitCode: EXIT_CODES.AUTH_UPSTREAM }
        );
      }
      const hydrated = await ctx.transport.requestJson<HydratedAccountResult>(
        `/api/accounts/hydrate/${encodeURIComponent(acc.accountId)}`,
        { method: 'POST' }
      );
      const canonicalRef = toAccountRef(hydrated.accountId);
      const canonicalMasked = ctx.flags.showEmails ? hydrated.email : maskEmail(hydrated.email);
      const report = await ctx.transport.requestJson<Record<string, unknown>>(
        `/api/sync/${encodeURIComponent(hydrated.accountId)}/cold`,
        { method: 'POST' }
      );
      emitSuccess(
        ctx,
        { mode: 'cold', accountRef: canonicalRef, accountId: hydrated.accountId, report },
        `Completed cold sync for ${canonicalRef} (${canonicalMasked}).`
      );
      return;
    }

    const report = await ctx.transport.requestJson<Record<string, unknown>>(
      `/api/sync/${encodeURIComponent(acc.accountId)}`,
      { method: 'POST' }
    );
    emitSuccess(
      ctx,
      { mode: 'delta', accountRef: acc.accountRef, accountId: acc.accountId, report },
      `Completed delta sync for ${acc.accountRef} (${masked}).`
    );
    return;
  }

  if (subcommand === 'delta') {
    const pool = await resolvePoolArg(ctx);
    if (pool.isSharePool) {
      throw new CliError(
        'SHARE_POOL_READ_ONLY',
        `Sync delta is disabled on Share Pool '${pool.slug}'.`,
        { exitCode: EXIT_CODES.CONFLICT }
      );
    }

    if (ctx.flags.dryRun) {
      emitSuccess(
        ctx,
        { dryRun: true, mode: 'delta', poolId: pool.id, poolSlug: pool.slug },
        `[dry-run] sync delta for pool '${pool.slug}' (id=${pool.id})`
      );
      return;
    }

    const report = await ctx.transport.requestJson<{
      hydrated: string[];
      synced: string[];
      errors: Array<{ accountId: string; error: string }>;
    }>(`/api/sync/all?poolId=${pool.id}`, { method: 'POST' });

    const hydrated = (report.hydrated ?? []).map((id) =>
      ctx.flags.showEmails ? id : maskEmail(id)
    );
    const synced = (report.synced ?? []).map((id) =>
      ctx.flags.showEmails ? id : maskEmail(id)
    );
    const hydratedRefs = (report.hydrated ?? []).map((id) => toAccountRef(id));
    const syncedRefs = (report.synced ?? []).map((id) => toAccountRef(id));
    const errors = (report.errors ?? []).map((entry) => ({
      accountRef: toAccountRef(entry.accountId),
      accountId: entry.accountId,
      error: entry.error,
    }));

    emitSuccess(
      ctx,
      {
        mode: 'delta',
        poolId: pool.id,
        poolSlug: pool.slug,
        hydrated,
        hydratedRefs,
        synced,
        syncedRefs,
        errors,
      },
      `Delta sync for pool '${pool.slug}': synced ${synced.length} account(s), errors=${errors.length}.`
    );
    return;
  }

  if (ctx.flags.dryRun) {
    const pool = await resolvePoolArg(ctx);
    if (pool.isSharePool) {
      throw new CliError(
        'SHARE_POOL_READ_ONLY',
        `Sync cold is disabled on Share Pool '${pool.slug}'.`,
        { exitCode: EXIT_CODES.CONFLICT }
      );
    }
    const accountsRes = await ctx.transport.requestJson<{ accounts: SyncAccountSummary[] }>(
      `/api/accounts?poolId=${pool.id}`
    );
    const authorizedAccounts = (accountsRes.accounts ?? []).filter((a) => a.authorized);
    emitSuccess(
      ctx,
      {
        dryRun: true,
        mode: 'cold',
        poolId: pool.id,
        poolSlug: pool.slug,
        accounts: authorizedAccounts.map((a) => ({
          accountRef: toAccountRef(a.accountId),
          accountId: a.accountId,
        })),
      },
      `[dry-run] sync cold for ${authorizedAccounts.length} authorized account(s) in pool '${pool.slug}'`
    );
    return;
  }

  const hasExplicitPoolSelector = Boolean(
    ctx.flags.pool?.trim() || process.env.TSUBASA_POOL?.trim()
  );
  const initialPoolsRes = await ctx.transport.requestJson<{ pools: PoolInfo[] }>('/api/pools');
  const initialPools = initialPoolsRes.pools ?? [];
  const isColdDb = initialPools.every((p) => p.accountCount === 0);

  if (!hasExplicitPoolSelector && isColdDb) {
    const allAccountsRes = await ctx.transport.requestJson<{ accounts: SyncAccountSummary[] }>(
      '/api/accounts'
    );
    const authorizedAccounts = (allAccountsRes.accounts ?? []).filter((a) => a.authorized);
    const { hydrated, errors } = await hydrateAccountsBounded(ctx, authorizedAccounts);

    const postPoolsRes = await ctx.transport.requestJson<{ pools: PoolInfo[] }>('/api/pools');
    const postPools = postPoolsRes.pools ?? [];
    const standardPools = postPools.filter((p) => !p.isSharePool);
    const standardPoolById = new Map(standardPools.map((p) => [p.id, p]));
    const targets = hydrated.filter((acc) => standardPoolById.has(acc.poolId));

    const poolStats = new Map<
      number,
      { poolId: number; poolSlug: string; completed: number; errors: number }
    >();
    for (const pool of standardPools) {
      if (targets.some((acc) => acc.poolId === pool.id)) {
        poolStats.set(pool.id, { poolId: pool.id, poolSlug: pool.slug, completed: 0, errors: 0 });
      }
    }

    const reports: Array<{ accountRef: string; accountId: string; report: unknown }> = [];
    for (const acc of targets) {
      const stat = poolStats.get(acc.poolId)!;
      try {
        const report = await ctx.transport.requestJson(
          `/api/sync/${encodeURIComponent(acc.accountId)}/cold`,
          { method: 'POST' }
        );
        reports.push({
          accountRef: toAccountRef(acc.accountId),
          accountId: acc.accountId,
          report,
        });
        stat.completed += 1;
      } catch (err) {
        errors.push({
          accountRef: toAccountRef(acc.accountId),
          accountId: acc.accountId,
          error: err instanceof Error ? err.message : String(err),
        });
        stat.errors += 1;
      }
    }

    const recoveredPools = Array.from(poolStats.values());
    if (recoveredPools.length > 1) {
      const primary = recoveredPools[0];
      emitSuccess(
        ctx,
        {
          mode: 'cold',
          poolId: primary.poolId,
          poolSlug: primary.poolSlug,
          pools: recoveredPools,
          reports,
          errors,
        },
        `Cold sync across ${recoveredPools.length} pool(s) (${recoveredPools.map((p) => p.poolSlug).join(', ')}): completed ${reports.length} account(s), errors=${errors.length}.`
      );
      return;
    }

    const targetPool =
      recoveredPools.length === 1
        ? standardPoolById.get(recoveredPools[0].poolId)!
        : await resolvePoolArg(ctx);
    emitSuccess(
      ctx,
      { mode: 'cold', poolId: targetPool.id, poolSlug: targetPool.slug, reports, errors },
      `Cold sync for pool '${targetPool.slug}': completed ${reports.length} account(s), errors=${errors.length}.`
    );
    return;
  }

  let hydratedAll: HydratedAccountResult[] | null = null;
  let hydrationErrors: ColdSyncAccountError[] = [];
  let pool: PoolInfo;

  if (hasExplicitPoolSelector && isColdDb) {
    const allAccountsRes = await ctx.transport.requestJson<{ accounts: SyncAccountSummary[] }>(
      '/api/accounts'
    );
    const authorizedAll = (allAccountsRes.accounts ?? []).filter((a) => a.authorized);
    const hydratedRes = await hydrateAccountsBounded(ctx, authorizedAll);
    hydratedAll = hydratedRes.hydrated;
    hydrationErrors = hydratedRes.errors;
    pool = await resolvePoolArg(ctx);
  } else {
    try {
      pool = await resolvePoolArg(ctx);
    } catch (err) {
      if (hasExplicitPoolSelector && err instanceof CliError && err.code === 'POOL_NOT_FOUND') {
        const allAccountsRes = await ctx.transport.requestJson<{ accounts: SyncAccountSummary[] }>(
          '/api/accounts'
        );
        const authorizedAll = (allAccountsRes.accounts ?? []).filter((a) => a.authorized);
        const hydratedRes = await hydrateAccountsBounded(ctx, authorizedAll);
        hydratedAll = hydratedRes.hydrated;
        hydrationErrors = hydratedRes.errors;
        pool = await resolvePoolArg(ctx);
      } else {
        throw err;
      }
    }
  }

  if (pool.isSharePool) {
    throw new CliError(
      'SHARE_POOL_READ_ONLY',
      `Sync cold is disabled on Share Pool '${pool.slug}'.`,
      { exitCode: EXIT_CODES.CONFLICT }
    );
  }

  let targets: HydratedAccountResult[];
  if (hydratedAll !== null) {
    targets = hydratedAll.filter((acc) => acc.poolId === pool.id);
  } else {
    const accountsRes = await ctx.transport.requestJson<{ accounts: SyncAccountSummary[] }>(
      `/api/accounts?poolId=${pool.id}`
    );
    const authorizedPoolAccounts = (accountsRes.accounts ?? []).filter((a) => a.authorized);
    const hydratedRes = await hydrateAccountsBounded(ctx, authorizedPoolAccounts);
    hydrationErrors = hydratedRes.errors;
    targets = hydratedRes.hydrated.filter((acc) => acc.poolId === pool.id);
  }

  const reports: Array<{ accountRef: string; accountId: string; report: unknown }> = [];
  const errors: ColdSyncAccountError[] = [...hydrationErrors];

  for (const acc of targets) {
    try {
      const report = await ctx.transport.requestJson(
        `/api/sync/${encodeURIComponent(acc.accountId)}/cold`,
        { method: 'POST' }
      );
      reports.push({
        accountRef: toAccountRef(acc.accountId),
        accountId: acc.accountId,
        report,
      });
    } catch (err) {
      errors.push({
        accountRef: toAccountRef(acc.accountId),
        accountId: acc.accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  emitSuccess(
    ctx,
    { mode: 'cold', poolId: pool.id, poolSlug: pool.slug, reports, errors },
    `Cold sync for pool '${pool.slug}': completed ${reports.length} account(s), errors=${errors.length}.`
  );
}

export async function handleOutbox(ctx: CliContext, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa outbox <list|retry|drop>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (subcommand === 'list') {
    let status: string | undefined;
    let accountSelector: string | undefined;
    let limit: number | undefined;

    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (token === '--status') {
        status = readFlagValue(rest, i, '--status').trim().toLowerCase();
        i += 1;
        continue;
      }
      if (token.startsWith('--status=')) {
        status = token.slice('--status='.length).trim().toLowerCase();
        continue;
      }
      if (token === '--account') {
        accountSelector = readFlagValue(rest, i, '--account');
        i += 1;
        continue;
      }
      if (token.startsWith('--account=')) {
        accountSelector = token.slice('--account='.length).trim();
        continue;
      }
      if (token === '--limit') {
        const raw = Number(readFlagValue(rest, i, '--limit'));
        if (!Number.isInteger(raw) || raw <= 0 || raw > 1000) {
          throw new CliError('VALIDATION_ERROR', 'Flag --limit must be an integer between 1 and 1000.', {
            exitCode: EXIT_CODES.USAGE,
          });
        }
        limit = raw;
        i += 1;
        continue;
      }
      if (token.startsWith('--limit=')) {
        const raw = Number(token.slice('--limit='.length));
        if (!Number.isInteger(raw) || raw <= 0 || raw > 1000) {
          throw new CliError('VALIDATION_ERROR', 'Flag --limit must be an integer between 1 and 1000.', {
            exitCode: EXIT_CODES.USAGE,
          });
        }
        limit = raw;
        continue;
      }
      throw new CliError('USAGE_ERROR', `Unknown argument '${token}' for outbox list.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }

    if (status && !VALID_OUTBOX_STATUSES.has(status)) {
      throw new CliError(
        'VALIDATION_ERROR',
        "Flag --status must be 'pending', 'processing', 'failed', or 'dead'.",
        { exitCode: EXIT_CODES.USAGE }
      );
    }

    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (accountSelector) {
      const acc = await resolveAccountArg(ctx, accountSelector);
      params.set('accountId', acc.accountId);
    }
    if (limit !== undefined) params.set('limit', String(limit));

    const qs = params.toString();
    const res = await ctx.transport.requestJson<OutboxListResponse>(
      `/api/sync/outbox${qs ? `?${qs}` : ''}`
    );

    const entries = res.entries ?? [];
    const counts = res.summary.counts;
    const header = `Outbox: pending=${counts.pending} processing=${counts.processing} failed=${counts.failed} dead=${counts.dead}`;
    const table = renderTable(
      entries,
      [
        { key: 'id', header: 'ID' },
        { key: 'status', header: 'STATUS' },
        { key: 'opType', header: 'OP' },
        {
          key: 'accountId',
          header: 'ACCOUNT',
          format: (r) => toAccountRef(r.accountId),
        },
        { key: 'attempts', header: 'TRIES', align: 'right' },
        {
          key: 'lastError',
          header: 'LAST ERROR',
          format: (r) => {
            if (!r.lastError) return '-';
            return ctx.flags.showEmails ? r.lastError : scrubEmailsInString(r.lastError);
          },
        },
      ],
      { emptyMessage: 'No outbox entries match the filter.' }
    );

    emitSuccess(ctx, res, `${header}\n${table}`);
    return;
  }

  if (subcommand === 'retry') {
    let accountSelector: string | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (token === '--account') {
        accountSelector = readFlagValue(rest, i, '--account');
        i += 1;
        continue;
      }
      if (token.startsWith('--account=')) {
        accountSelector = token.slice('--account='.length).trim();
        continue;
      }
      throw new CliError('USAGE_ERROR', `Unknown argument '${token}' for outbox retry.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }

    const account = accountSelector ? await resolveAccountArg(ctx, accountSelector) : null;
    if (ctx.flags.dryRun) {
      emitSuccess(
        ctx,
        {
          dryRun: true,
          action: 'outbox retry',
          accountRef: account?.accountRef ?? null,
          accountId: account?.accountId ?? null,
        },
        `[dry-run] retry outbox entries${account ? ` for ${account.accountRef}` : ''}`
      );
      return;
    }

    const res = await ctx.transport.requestJson<Record<string, unknown>>('/api/sync/outbox/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(account ? { accountId: account.accountId } : {}),
    });

    emitSuccess(ctx, res, `Queued outbox retry${account ? ` for ${account.accountRef}` : ''}.`);
    return;
  }

  if (subcommand === 'drop') {
    let force = false;
    let accountSelector: string | undefined;
    const positionals: string[] = [];

    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (token === '--force') {
        force = true;
        continue;
      }
      if (token === '--account') {
        accountSelector = readFlagValue(rest, i, '--account');
        i += 1;
        continue;
      }
      if (token.startsWith('--account=')) {
        accountSelector = token.slice('--account='.length).trim();
        continue;
      }
      if (token.startsWith('-')) {
        throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for outbox drop.`, {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      positionals.push(token);
    }

    if (positionals.length > 1) {
      throw new CliError('USAGE_ERROR', 'Usage: tsubasa outbox drop [id] [--force]', {
        exitCode: EXIT_CODES.USAGE,
      });
    }

    const entryId = positionals[0];
    if (entryId && accountSelector) {
      throw new CliError('USAGE_ERROR', 'Cannot combine an explicit entry [id] with --account.', {
        exitCode: EXIT_CODES.USAGE,
      });
    }

    const account = accountSelector ? await resolveAccountArg(ctx, accountSelector) : null;

    if (ctx.flags.dryRun) {
      const listRes = await ctx.transport.requestJson<OutboxListResponse>('/api/sync/outbox?limit=1000');
      const entries = listRes.entries ?? [];
      if (entryId) {
        const match = entries.find((e) => e.id === entryId);
        if (!match) {
          throw new CliError('NOT_FOUND', `Outbox entry '${entryId}' not found.`, {
            exitCode: EXIT_CODES.NOT_FOUND,
          });
        }
        const isPending = match.status === 'pending' || match.status === 'processing';
        emitSuccess(
          ctx,
          {
            dryRun: true,
            action: 'outbox drop',
            id: entryId,
            status: match.status,
            force,
            blocked: isPending && !force,
          },
          `[dry-run] drop outbox entry ${entryId} (status=${match.status})${isPending && !force ? ' [requires --force]' : ''}`
        );
        return;
      }

      const targetStatuses = new Set(force ? ['dead', 'failed', 'pending'] : ['dead', 'failed']);
      const matching = entries.filter(
        (e) => targetStatuses.has(e.status) && (!account || e.accountId === account.accountId)
      );
      emitSuccess(
        ctx,
        {
          dryRun: true,
          action: 'outbox drop',
          force,
          accountId: account?.accountId ?? null,
          wouldDropCount: matching.length,
        },
        `[dry-run] drop ${matching.length} outbox entry(s) (${Array.from(targetStatuses).join(', ')})`
      );
      return;
    }

    const targetLabel = entryId
      ? `drop outbox entry '${entryId}'${force ? ' (with --force)' : ''}`
      : `drop ${force ? 'dead, failed, and pending' : 'dead and failed'} outbox entries${account ? ` for ${account.accountRef}` : ''}`;
    await requireConfirmation(ctx, targetLabel);

    if (entryId) {
      const qs = force ? '?force=true' : '';
      const res = await ctx.transport.requestJson<{
        deleted: boolean;
        id: string;
        status: string;
        warning: string | null;
      }>(`/api/sync/outbox/${encodeURIComponent(entryId)}${qs}`, {
        method: 'DELETE',
      });
      if (res.warning && !ctx.flags.json) {
        ctx.stderr.write(`Warning: ${res.warning}\n`);
      }
      emitSuccess(ctx, res, `Dropped outbox entry ${res.id} (status=${res.status}).`);
      return;
    }

    const params = new URLSearchParams();
    if (force) params.set('force', 'true');
    if (account) params.set('accountId', account.accountId);
    const qs = params.toString();

    const res = await ctx.transport.requestJson<{
      deletedCount: number;
      droppedPendingCount: number;
      warning: string | null;
    }>(`/api/sync/outbox${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
    if (res.warning && !ctx.flags.json) {
      ctx.stderr.write(`Warning: ${res.warning}\n`);
    }
    emitSuccess(
      ctx,
      res,
      `Dropped ${res.deletedCount} outbox entry(s)${res.droppedPendingCount > 0 ? ` (${res.droppedPendingCount} pending)` : ''}.`
    );
    return;
  }

  throw new CliError(
    'USAGE_ERROR',
    `Unknown outbox subcommand '${subcommand}'. Expected list, retry, or drop.`,
    { exitCode: EXIT_CODES.USAGE }
  );
}

export async function handleShare(ctx: CliContext, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa share <list|clear>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (subcommand === 'list') {
    if (rest.length > 0) {
      throw new CliError('USAGE_ERROR', `Unexpected argument '${rest[0]}' for share list.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }

    const pool = ctx.flags.pool ? await resolvePoolArg(ctx) : null;
    const qs = pool ? `?poolId=${pool.id}` : '';
    const res = await ctx.transport.requestJson<{ links: StoredShareLink[] }>(
      `/api/share/links${qs}`
    );

    const links = (res.links ?? []).map((link) => {
      const accountRef = toAccountRef(link.accountId);
      if (ctx.flags.showEmails) {
        return { accountRef, ...link };
      }
      return {
        accountRef,
        ...link,
        accountEmail: maskEmail(link.accountEmail),
        accountDisplayName: scrubEmailsInString(link.accountDisplayName),
      };
    });

    const table = renderTable(
      links,
      [
        { key: 'batchFolderName', header: 'BATCH' },
        { key: 'accountRef', header: 'REF' },
        { key: 'accountEmail', header: 'EMAIL' },
        { key: 'filesCount', header: 'FILES', align: 'right' },
        { key: 'bytesAllocated', header: 'SIZE', align: 'right', format: (r) => formatBytes(r.bytesAllocated) },
        { key: 'webViewLink', header: 'LINK' },
      ],
      { emptyMessage: 'No active Share Pool links found.' }
    );

    emitSuccess(ctx, { links }, table);
    return;
  }

  if (subcommand === 'clear') {
    if (rest.length > 0) {
      throw new CliError('USAGE_ERROR', `Unexpected argument '${rest[0]}' for share clear.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }

    const poolsRes = await ctx.transport.requestJson<{ pools: PoolInfo[] }>('/api/pools');
    const sharePool = (poolsRes.pools ?? []).find((p) => p.isSharePool);
    if (!sharePool) {
      throw new CliError('POOL_NOT_FOUND', 'Share Pool does not exist.', {
        exitCode: EXIT_CODES.NOT_FOUND,
      });
    }

    if (ctx.flags.dryRun) {
      emitSuccess(
        ctx,
        {
          dryRun: true,
          action: 'share clear',
          sharePoolId: sharePool.id,
          filesCount: sharePool.fileCount,
          totalBytes: sharePool.totalBytes,
        },
        `[dry-run] clear Share Pool (id=${sharePool.id}, files=${sharePool.fileCount}, size=${formatBytes(sharePool.totalBytes)})`
      );
      return;
    }

    await requireConfirmation(
      ctx,
      `clear all items and links from Share Pool (id=${sharePool.id})`
    );

    const res = await ctx.transport.requestJson<{
      sharePoolId: number;
      filesRemoved: number;
      foldersRemoved: number;
      bytesReclaimed: number;
      warnings: string[];
    }>(`/api/pools/${sharePool.id}/clear-share`, { method: 'POST' });

    if (res.warnings?.length && !ctx.flags.json) {
      for (const warning of res.warnings) {
        ctx.stderr.write(`Warning: ${ctx.flags.showEmails ? warning : scrubEmailsInString(warning)}\n`);
      }
    }

    emitSuccess(
      ctx,
      res,
      `Cleared Share Pool: removed ${res.filesRemoved} file(s), ${res.foldersRemoved} folder(s), reclaimed ${formatBytes(res.bytesReclaimed)}.`
    );
    return;
  }

  throw new CliError(
    'USAGE_ERROR',
    `Unknown share subcommand '${subcommand}'. Expected list or clear.`,
    { exitCode: EXIT_CODES.USAGE }
  );
}

export async function handleAudit(ctx: CliContext, args: string[]): Promise<void> {
  let remote = false;
  let refresh = false;
  let accountSelector: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--local') {
      remote = false;
      continue;
    }
    if (token === '--remote') {
      remote = true;
      continue;
    }
    if (token === '--refresh') {
      refresh = true;
      continue;
    }
    if (token === '--account') {
      accountSelector = readFlagValue(args, i, '--account');
      i += 1;
      continue;
    }
    if (token.startsWith('--account=')) {
      accountSelector = token.slice('--account='.length).trim();
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for audit.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    if (!accountSelector) {
      accountSelector = token;
      continue;
    }
    throw new CliError('USAGE_ERROR', `Unexpected argument '${token}' for audit.`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (!remote) {
    if (accountSelector || refresh) {
      throw new CliError(
        'USAGE_ERROR',
        'Flags --refresh and account selector require --remote on audit.',
        { exitCode: EXIT_CODES.USAGE }
      );
    }

    const audit = await ctx.transport.requestJson<LocalAuditResponse>('/api/sync/audit/local');
    const lines = [
      `Local Audit: ${audit.ok ? 'OK' : 'ISSUES FOUND'}`,
      `SQLite Integrity: ${audit.integrity.ok ? 'ok' : audit.integrity.messages.join('; ')}`,
      `Orphan Folder Files: ${audit.orphanFolderFiles.length}`,
      `Orphan Account Files: ${audit.orphanAccountFiles.length}`,
      `Over-Ceiling Accounts: ${audit.overCeilingAccounts.length}`,
      `Outbox: pending=${audit.outbox.counts.pending} failed=${audit.outbox.counts.failed} dead=${audit.outbox.counts.dead}`,
    ];

    if (audit.accountQuotaChecks.length > 0) {
      lines.push('');
      lines.push(
        renderTable(audit.accountQuotaChecks, [
          { key: 'accountId', header: 'REF', format: (r) => toAccountRef(r.accountId) },
          {
            key: 'email',
            header: 'EMAIL',
            format: (r) => (ctx.flags.showEmails ? r.email : maskEmail(r.email)),
          },
          { key: 'poolId', header: 'POOL', align: 'right' },
          { key: 'quotaUsedBytes', header: 'QUOTA USED', align: 'right', format: (r) => formatBytes(r.quotaUsedBytes) },
          { key: 'indexedBytes', header: 'INDEXED', align: 'right', format: (r) => formatBytes(r.indexedBytes) },
          { key: 'driftBytes', header: 'DRIFT', align: 'right', format: (r) => formatBytes(r.driftBytes) },
          { key: 'isOverCeiling', header: 'OVER CEILING', format: (r) => (r.isOverCeiling ? 'YES' : 'no') },
        ])
      );
    }

    emitSuccess(ctx, { mode: 'local', ...audit }, lines.join('\n'));
    return;
  }

  const poolsRes = await ctx.transport.requestJson<{ pools: PoolInfo[] }>('/api/pools');
  const sharePoolIds = new Set((poolsRes.pools ?? []).filter((p) => p.isSharePool).map((p) => p.id));

  let targetAccounts: Array<{ accountId: string; accountRef: string }>;
  if (accountSelector) {
    const acc = await resolveAccountArg(ctx, accountSelector);
    if (sharePoolIds.has(acc.poolId)) {
      throw new CliError(
        'SHARE_POOL_READ_ONLY',
        'Remote discrepancy scan is disabled for Share Pool accounts.',
        { exitCode: EXIT_CODES.CONFLICT }
      );
    }
    targetAccounts = [{ accountId: acc.accountId, accountRef: acc.accountRef }];
  } else {
    const scopedPool = ctx.flags.pool ? await resolvePoolArg(ctx) : null;
    if (scopedPool?.isSharePool) {
      throw new CliError(
        'SHARE_POOL_READ_ONLY',
        'Remote discrepancy scan is disabled on Share Pool.',
        { exitCode: EXIT_CODES.CONFLICT }
      );
    }
    const accRes = await ctx.transport.requestJson<{
      accounts: Array<{ accountId: string; authorized: boolean; poolId: number }>;
    }>(scopedPool ? `/api/accounts?poolId=${scopedPool.id}` : '/api/accounts');
    targetAccounts = (accRes.accounts ?? [])
      .filter((a) => a.authorized && !sharePoolIds.has(a.poolId))
      .map((a) => ({ accountId: a.accountId, accountRef: toAccountRef(a.accountId) }));
  }

  const reports: Array<{ accountRef: string; accountId: string; report: Record<string, unknown> }> = [];
  for (const target of targetAccounts) {
    const qs = refresh ? '?refresh=1' : '';
    const report = await ctx.transport.requestJson<Record<string, unknown>>(
      `/api/sync/external-changes/${encodeURIComponent(target.accountId)}${qs}`
    );
    reports.push({
      accountRef: target.accountRef,
      accountId: target.accountId,
      report,
    });
  }

  const summaryRows = reports.map((r) => ({
    accountRef: r.accountRef,
    email: ctx.flags.showEmails ? r.accountId : maskEmail(r.accountId),
    scannedCount: typeof r.report.scannedFiles === 'number' ? r.report.scannedFiles : 0,
    missingCount: Array.isArray(r.report.missingRemote) ? r.report.missingRemote.length : 0,
    unindexedCount: Array.isArray(r.report.unindexed) ? r.report.unindexed.length : 0,
    modifiedCount: Array.isArray(r.report.modified) ? r.report.modified.length : 0,
    overCeilingCount: Array.isArray(r.report.overCeiling) ? r.report.overCeiling.length : 0,
    conflictCount: Array.isArray(r.report.conflicts) ? r.report.conflicts.length : 0,
  }));

  const table = renderTable(
    summaryRows,
    [
      { key: 'accountRef', header: 'REF' },
      { key: 'email', header: 'EMAIL' },
      { key: 'scannedCount', header: 'SCANNED', align: 'right' },
      { key: 'missingCount', header: 'MISSING', align: 'right' },
      { key: 'unindexedCount', header: 'UNINDEXED', align: 'right' },
      { key: 'modifiedCount', header: 'MODIFIED', align: 'right' },
      { key: 'overCeilingCount', header: 'OVER CEILING', align: 'right' },
      { key: 'conflictCount', header: 'CONFLICTS', align: 'right' },
    ],
    { emptyMessage: 'No authorized standard-pool accounts to scan.' }
  );

  emitSuccess(ctx, { mode: 'remote', accounts: reports }, table);
}

export async function handleDupes(ctx: CliContext, args: string[]): Promise<void> {
  let by: 'hash' | 'name-size' = 'hash';

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--by') {
      const val = readFlagValue(args, i, '--by').toLowerCase();
      if (val !== 'hash' && val !== 'name-size') {
        throw new CliError('VALIDATION_ERROR', "Flag --by must be 'hash' or 'name-size'.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      by = val;
      i += 1;
      continue;
    }
    if (token.startsWith('--by=')) {
      const val = token.slice('--by='.length).toLowerCase();
      if (val !== 'hash' && val !== 'name-size') {
        throw new CliError('VALIDATION_ERROR', "Flag --by must be 'hash' or 'name-size'.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      by = val;
      continue;
    }
    throw new CliError('USAGE_ERROR', `Unknown argument '${token}' for dupes.`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const pool = ctx.flags.pool ? await resolvePoolArg(ctx) : null;
  const params = new URLSearchParams({ by });
  if (pool) {
    params.set('poolId', String(pool.id));
  }

  const res = await ctx.transport.requestJson<DupesResponse>(`/api/files/dupes?${params.toString()}`);
  const header = `Duplicate groups (${res.by}): ${res.groupCount} | Files: ${res.duplicateFileCount} | Reclaimable: ${formatBytes(res.wastedBytes)}`;
  const table = renderTable(
    res.groups ?? [],
    [
      { key: 'key', header: 'KEY' },
      { key: 'count', header: 'COPIES', align: 'right' },
      { key: 'sizeBytes', header: 'EACH', align: 'right', format: (g) => formatBytes(g.sizeBytes) },
      { key: 'wastedBytes', header: 'WASTED', align: 'right', format: (g) => formatBytes(g.wastedBytes) },
      {
        key: 'files',
        header: 'PATHS',
        format: (g) => g.files.map((f) => f.virtualPath).join(', '),
      },
    ],
    { emptyMessage: 'No duplicates found.' }
  );

  emitSuccess(ctx, res, `${header}\n${table}`);
}

export async function handleDb(ctx: CliContext, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'backup') {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa db backup <dest>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (ctx.flags.server?.trim() || process.env.TSUBASA_API_URL?.trim()) {
    throw new CliError(
      'USAGE_ERROR',
      'db backup cannot run against a remote --server target; run it locally on the database host.',
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  const positionals: string[] = [];
  for (const token of rest) {
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for db backup.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  if (positionals.length !== 1 || !positionals[0].trim()) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa db backup <dest>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const destPath = path.resolve(process.cwd(), positionals[0]);
  const sourceDbPath = path.resolve(ctx.transport.dbPath);

  if (destPath === sourceDbPath) {
    throw new CliError(
      'USAGE_ERROR',
      'Backup destination cannot be the active SQLite database file.',
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  if (!fs.existsSync(sourceDbPath)) {
    throw new CliError('NOT_FOUND', `Source database not found at ${sourceDbPath}.`, {
      exitCode: EXIT_CODES.NOT_FOUND,
    });
  }

  if (ctx.flags.dryRun) {
    emitSuccess(
      ctx,
      { dryRun: true, action: 'db backup', sourceDbPath, destPath },
      `[dry-run] backup SQLite database to ${destPath}`
    );
    return;
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const { sqlite } = await import('../../server/db/index.js');
  try {
    await sqlite.backup(destPath);
  } finally {
    if (ctx.transport.mode !== 'local') {
      sqlite.close();
    }
  }

  const stats = fs.statSync(destPath);
  emitSuccess(
    ctx,
    { ok: true, sourceDbPath, destPath, sizeBytes: stats.size },
    `Backed up SQLite database to ${destPath} (${formatBytes(stats.size)}).`
  );
}
