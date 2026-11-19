import {
  emitSuccess,
  readFlagValue,
  requireConfirmation,
  resolvePoolArg,
  type CliContext,
  type PoolInfo,
} from '../context.js';
import { CliError, EXIT_CODES } from '../lib/errors.js';
import { formatBytes, renderTable } from '../lib/format.js';
import { maskEmail, scrubEmailsInString, toAccountRef } from '../lib/redact.js';
import { resolveAccountSelector, type AccountCandidate } from '../lib/selectors.js';

interface AccountListItem {
  accountId: string;
  clientId: string;
  authorized: boolean;
  sourceFile: string;
  isDisabled: boolean;
  mtimeMs: number;
  poolId: number;
  canSwitchPool: boolean;
}

interface ResolvedAccount extends AccountListItem, AccountCandidate {
  id: string;
  email: string;
  accountRef: string;
}

interface StorageAccountSummary {
  id: string;
  email: string;
  displayName: string;
  poolId: number;
  canSwitchPool: boolean;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  usableLimitBytes: number;
  headroomBytes: number;
  tsubasaUsedBytes: number;
  syncState: string;
  isDisabled: boolean;
  transferStats?: AccountTransferStats;
}

interface PooledStorageOverview {
  poolId: number;
  accounts: StorageAccountSummary[];
}

interface AccountTransferStats {
  accountId: string;
  uploadedBytes24h: number;
  remainingUploadBytes24h: number;
  dailyUploadLimitBytes: number;
  isUploadRateLimited: boolean;
  downloadedBytes24h: number;
  activeTransferCount24h: number;
}

interface QuotaRefreshResponse {
  accountId: string;
  email: string;
  poolId: number;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  usableLimitBytes: number;
  headroomBytes: number;
  syncState: string;
}

async function fetchAccountCandidates(
  ctx: CliContext,
  poolId?: number
): Promise<ResolvedAccount[]> {
  const path = poolId !== undefined ? `/api/accounts?poolId=${poolId}` : '/api/accounts';
  const res = await ctx.transport.requestJson<{ accounts: AccountListItem[] }>(path);
  return (res.accounts ?? []).map((acc) => ({
    ...acc,
    id: acc.accountId,
    email: acc.accountId,
    accountRef: toAccountRef(acc.accountId),
  }));
}

export async function resolveAccountArg(
  ctx: CliContext,
  selector: string,
  poolId?: number
): Promise<ResolvedAccount> {
  const candidates = await fetchAccountCandidates(ctx, poolId);
  const matched = resolveAccountSelector(selector, candidates);
  if (!matched) {
    throw new CliError('ACCOUNT_NOT_FOUND', `Account '${selector}' not found.`, {
      exitCode: EXIT_CODES.NOT_FOUND,
      hint: 'Run `tsubasa account list` to see available accountRef values and accounts.',
    });
  }
  return matched;
}

async function fetchStorageByAccount(
  ctx: CliContext,
  poolIds: readonly number[]
): Promise<Map<string, StorageAccountSummary>> {
  const uniqueIds = Array.from(new Set(poolIds));
  const overviews = await Promise.all(
    uniqueIds.map((pid) =>
      ctx.transport.requestJson<PooledStorageOverview>(`/api/storage/overview?poolId=${pid}`)
    )
  );
  const map = new Map<string, StorageAccountSummary>();
  for (const ov of overviews) {
    for (const acc of ov.accounts ?? []) {
      map.set(acc.id, acc);
    }
  }
  return map;
}

export async function handleAccountList(ctx: CliContext, args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new CliError('USAGE_ERROR', `Unexpected argument '${args[0]}' for account list.`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const scopedPool = ctx.flags.pool ? await resolvePoolArg(ctx) : null;
  const [accounts, poolsRes] = await Promise.all([
    fetchAccountCandidates(ctx, scopedPool?.id),
    ctx.transport.requestJson<{ pools: PoolInfo[] }>('/api/pools'),
  ]);

  const poolById = new Map((poolsRes.pools ?? []).map((p) => [p.id, p]));
  const storageMap = await fetchStorageByAccount(
    ctx,
    accounts.map((a) => a.poolId)
  );

  const enriched = accounts.map((acc) => {
    const st = storageMap.get(acc.accountId);
    const pool = poolById.get(acc.poolId);
    return {
      accountRef: acc.accountRef,
      accountId: acc.accountId,
      email: st?.email ?? acc.email,
      poolId: acc.poolId,
      poolSlug: pool?.slug ?? String(acc.poolId),
      authorized: acc.authorized,
      isDisabled: acc.isDisabled,
      canSwitchPool: acc.canSwitchPool,
      syncState: st?.syncState ?? (acc.authorized ? 'unhydrated' : 'unauthorized'),
      quotaLimitBytes: st?.quotaLimitBytes ?? 0,
      quotaUsedBytes: st?.quotaUsedBytes ?? 0,
      usableLimitBytes: st?.usableLimitBytes ?? 0,
      headroomBytes: st?.headroomBytes ?? 0,
      tsubasaUsedBytes: st?.tsubasaUsedBytes ?? 0,
    };
  });

  const table = renderTable(
    enriched,
    [
      { key: 'accountRef', header: 'REF' },
      {
        key: 'email',
        header: 'EMAIL',
        format: (r) => (ctx.flags.showEmails ? r.email : maskEmail(r.email)),
      },
      { key: 'poolSlug', header: 'POOL' },
      {
        key: 'authorized',
        header: 'AUTH',
        format: (r) => (r.authorized ? 'yes' : 'no'),
      },
      {
        key: 'syncState',
        header: 'STATUS',
        format: (r) => (r.isDisabled ? 'disabled' : r.syncState),
      },
      {
        key: 'quotaUsedBytes',
        header: 'USED',
        align: 'right',
        format: (r) => formatBytes(r.quotaUsedBytes),
      },
      {
        key: 'headroomBytes',
        header: 'HEADROOM',
        align: 'right',
        format: (r) => formatBytes(r.headroomBytes),
      },
      {
        key: 'canSwitchPool',
        header: 'EMPTY',
        format: (r) => (r.canSwitchPool ? 'yes' : 'no'),
      },
    ],
    { emptyMessage: 'No accounts found.' }
  );

  emitSuccess(ctx, { accounts: enriched }, table);
}

export async function handleAccountShow(ctx: CliContext, args: string[]): Promise<void> {
  const positionals: string[] = [];
  for (const token of args) {
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for account show.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa account show <account>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const acc = await resolveAccountArg(ctx, positionals[0]);
  const [poolsRes, storageMap, transferStats] = await Promise.all([
    ctx.transport.requestJson<{ pools: PoolInfo[] }>('/api/pools'),
    fetchStorageByAccount(ctx, [acc.poolId]),
    ctx.transport.requestJson<AccountTransferStats>(
      `/api/storage/transfer-stats/${encodeURIComponent(acc.accountId)}`
    ),
  ]);

  const st = storageMap.get(acc.accountId);
  const pool = (poolsRes.pools ?? []).find((p) => p.id === acc.poolId);
  const payload = {
    accountRef: acc.accountRef,
    accountId: acc.accountId,
    email: st?.email ?? acc.email,
    displayName: st?.displayName ?? null,
    poolId: acc.poolId,
    poolSlug: pool?.slug ?? null,
    authorized: acc.authorized,
    isDisabled: acc.isDisabled,
    canSwitchPool: acc.canSwitchPool,
    sourceFile: acc.sourceFile,
    syncState: st?.syncState ?? (acc.authorized ? 'unhydrated' : 'unauthorized'),
    quotaLimitBytes: st?.quotaLimitBytes ?? 0,
    quotaUsedBytes: st?.quotaUsedBytes ?? 0,
    usableLimitBytes: st?.usableLimitBytes ?? 0,
    headroomBytes: st?.headroomBytes ?? 0,
    tsubasaUsedBytes: st?.tsubasaUsedBytes ?? 0,
    transferStats: st?.transferStats ?? transferStats,
  };

  const displayEmail = ctx.flags.showEmails ? payload.email : maskEmail(payload.email);
  const stats = payload.transferStats;
  const lines = [
    `Account Ref:    ${payload.accountRef}`,
    `Email:          ${displayEmail}`,
    `Pool:           ${pool ? `${pool.slug} (id=${pool.id})` : `id=${acc.poolId}`}`,
    `Authorized:     ${payload.authorized ? 'yes' : 'no'}`,
    `Enabled:        ${payload.isDisabled ? 'no (disabled)' : 'yes'}`,
    `Sync State:     ${payload.syncState}`,
    `Empty (Switch): ${payload.canSwitchPool ? 'yes' : 'no'}`,
    `Quota Used:     ${formatBytes(payload.quotaUsedBytes)} / ${formatBytes(payload.quotaLimitBytes)}`,
    `Usable Limit:   ${formatBytes(payload.usableLimitBytes)} (750 MB reserve)`,
    `Headroom:       ${formatBytes(payload.headroomBytes)}`,
    `Tsubasa Used:   ${formatBytes(payload.tsubasaUsedBytes)}`,
    `24h Uploaded:   ${formatBytes(stats.uploadedBytes24h)} / ${formatBytes(stats.dailyUploadLimitBytes)}`,
    `24h Remaining:  ${formatBytes(stats.remainingUploadBytes24h)}`,
  ];

  emitSuccess(ctx, payload, lines.join('\n'));
}

export async function handleAccountQuota(ctx: CliContext, args: string[]): Promise<void> {
  let refresh = false;
  const positionals: string[] = [];

  for (const token of args) {
    if (token === '--refresh') {
      refresh = true;
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for account quota.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  if (positionals.length > 1) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa account quota [account] [--refresh]', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const scopedPool = ctx.flags.pool ? await resolvePoolArg(ctx) : null;
  const targets =
    positionals.length === 1
      ? [await resolveAccountArg(ctx, positionals[0], scopedPool?.id)]
      : await fetchAccountCandidates(ctx, scopedPool?.id);

  if (refresh && ctx.flags.dryRun) {
    emitSuccess(
      ctx,
      {
        dryRun: true,
        action: 'account quota refresh',
        accounts: targets.map((a) => ({
          accountRef: a.accountRef,
          accountId: a.accountId,
          authorized: a.authorized,
        })),
      },
      `[dry-run] refresh live quota for ${targets.length} account(s)`
    );
    return;
  }

  let rows: Array<{
    accountRef: string;
    accountId: string;
    email: string;
    poolId: number;
    quotaLimitBytes: number;
    quotaUsedBytes: number;
    usableLimitBytes: number;
    headroomBytes: number;
    syncState: string;
    refreshed: boolean;
  }> = [];

  if (refresh) {
    for (const acc of targets) {
      const refreshed = await ctx.transport.requestJson<QuotaRefreshResponse>(
        `/api/accounts/${encodeURIComponent(acc.accountId)}/quota/refresh`,
        { method: 'POST' }
      );
      rows.push({
        accountRef: toAccountRef(refreshed.accountId),
        accountId: refreshed.accountId,
        email: refreshed.email,
        poolId: refreshed.poolId,
        quotaLimitBytes: refreshed.quotaLimitBytes,
        quotaUsedBytes: refreshed.quotaUsedBytes,
        usableLimitBytes: refreshed.usableLimitBytes,
        headroomBytes: refreshed.headroomBytes,
        syncState: refreshed.syncState,
        refreshed: true,
      });
    }
  } else {
    const storageMap = await fetchStorageByAccount(
      ctx,
      targets.map((a) => a.poolId)
    );
    rows = targets.map((acc) => {
      const st = storageMap.get(acc.accountId);
      return {
        accountRef: acc.accountRef,
        accountId: acc.accountId,
        email: st?.email ?? acc.email,
        poolId: acc.poolId,
        quotaLimitBytes: st?.quotaLimitBytes ?? 0,
        quotaUsedBytes: st?.quotaUsedBytes ?? 0,
        usableLimitBytes: st?.usableLimitBytes ?? 0,
        headroomBytes: st?.headroomBytes ?? 0,
        syncState: st?.syncState ?? (acc.authorized ? 'unhydrated' : 'unauthorized'),
        refreshed: false,
      };
    });
  }

  const table = renderTable(
    rows,
    [
      { key: 'accountRef', header: 'REF' },
      {
        key: 'email',
        header: 'EMAIL',
        format: (r) => (ctx.flags.showEmails ? r.email : maskEmail(r.email)),
      },
      { key: 'poolId', header: 'POOL', align: 'right' },
      { key: 'quotaUsedBytes', header: 'USED', align: 'right', format: (r) => formatBytes(r.quotaUsedBytes) },
      { key: 'usableLimitBytes', header: 'USABLE', align: 'right', format: (r) => formatBytes(r.usableLimitBytes) },
      { key: 'quotaLimitBytes', header: 'LIMIT', align: 'right', format: (r) => formatBytes(r.quotaLimitBytes) },
      { key: 'headroomBytes', header: 'HEADROOM', align: 'right', format: (r) => formatBytes(r.headroomBytes) },
      { key: 'syncState', header: 'SYNC' },
    ],
    { emptyMessage: 'No accounts found.' }
  );

  const payload = rows.length === 1 && positionals.length === 1 ? rows[0] : { accounts: rows };
  emitSuccess(ctx, payload, table);
}

async function toggleAccountEnabled(
  ctx: CliContext,
  args: string[],
  enable: boolean
): Promise<void> {
  const actionName = enable ? 'enable' : 'disable';
  const positionals: string[] = [];
  for (const token of args) {
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for account ${actionName}.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw new CliError('USAGE_ERROR', `Usage: tsubasa account ${actionName} <account>`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const acc = await resolveAccountArg(ctx, positionals[0]);
  const masked = ctx.flags.showEmails ? acc.email : maskEmail(acc.email);

  if (ctx.flags.dryRun) {
    emitSuccess(
      ctx,
      {
        dryRun: true,
        action: `account ${actionName}`,
        accountRef: acc.accountRef,
        accountId: acc.accountId,
        currentlyDisabled: acc.isDisabled,
      },
      `[dry-run] ${actionName} account ${acc.accountRef} (${masked})`
    );
    return;
  }

  const res = await ctx.transport.requestJson<Record<string, unknown>>(
    `/api/accounts/${encodeURIComponent(acc.accountId)}/${actionName}`,
    { method: 'POST' }
  );

  emitSuccess(
    ctx,
    { accountRef: acc.accountRef, accountId: acc.accountId, ...res },
    `${enable ? 'Enabled' : 'Disabled'} account ${acc.accountRef} (${masked}).`
  );
}

export async function handleAccountEnable(ctx: CliContext, args: string[]): Promise<void> {
  return toggleAccountEnabled(ctx, args, true);
}

export async function handleAccountDisable(ctx: CliContext, args: string[]): Promise<void> {
  return toggleAccountEnabled(ctx, args, false);
}

interface EvacuateResponse {
  jobId: string;
  status: string;
  sourceAccountId: string;
  poolId: number;
  totalItems: number;
  filesMoved: number;
  failedItems: number;
  totalBytes: number;
  bytesMoved: number;
  removed: boolean;
  queued: boolean;
  lastError: string | null;
}

interface RemoveAccountResponse {
  sourceAccountId: string;
  filesMoved: number;
  bytesMoved: number;
  transfers: unknown[];
  removed: boolean;
  queued: boolean;
  jobId?: string;
  filesQueued?: number;
}

export async function handleAccountEvacuate(ctx: CliContext, args: string[]): Promise<void> {
  let wait = false;
  let explicitDetach = false;
  const positionals: string[] = [];

  for (const token of args) {
    if (token === '--wait') {
      wait = true;
      explicitDetach = false;
      continue;
    }
    if (token === '--detach') {
      wait = false;
      explicitDetach = true;
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for account evacuate.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  if (ctx.transport.mode === 'local' && explicitDetach) {
    throw new CliError('USAGE_ERROR', 'Cannot use --detach in standalone --local mode.', {
      exitCode: EXIT_CODES.USAGE,
      hint: 'Start the Tsubasa server for detached background jobs, or omit --detach.',
    });
  }
  if (ctx.transport.mode === 'local') {
    wait = true;
  }

  if (positionals.length !== 1) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa account evacuate <account> [--wait]', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const acc = await resolveAccountArg(ctx, positionals[0]);
  const masked = ctx.flags.showEmails ? acc.email : maskEmail(acc.email);

  if (ctx.flags.dryRun) {
    emitSuccess(
      ctx,
      {
        dryRun: true,
        action: 'account evacuate',
        accountRef: acc.accountRef,
        accountId: acc.accountId,
        poolId: acc.poolId,
        wait,
        canSwitchPool: acc.canSwitchPool,
      },
      `[dry-run] evacuate account ${acc.accountRef} (${masked}) in pool ${acc.poolId}`
    );
    return;
  }

  const res = await ctx.transport.requestJson<EvacuateResponse>(
    `/api/accounts/${encodeURIComponent(acc.accountId)}/evacuate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wait, removeAfter: false }),
    }
  );

  const payload = {
    accountRef: acc.accountRef,
    ...res,
    sourceAccountId: ctx.flags.showEmails ? res.sourceAccountId : maskEmail(res.sourceAccountId),
    lastError:
      res.lastError && !ctx.flags.showEmails
        ? scrubEmailsInString(res.lastError)
        : res.lastError,
  };

  emitSuccess(
    ctx,
    payload,
    `Evacuation job ${res.jobId} (${res.status}) for ${acc.accountRef} (${masked}): moved ${res.filesMoved}/${res.totalItems} file(s), ${formatBytes(res.bytesMoved)}${res.queued ? ' [queued]' : ''}.`
  );
}

export async function handleAccountRemove(ctx: CliContext, args: string[]): Promise<void> {
  let evacuate = false;
  let wait = false;
  let explicitDetach = false;
  const positionals: string[] = [];

  for (const token of args) {
    if (token === '--evacuate') {
      evacuate = true;
      continue;
    }
    if (token === '--wait') {
      wait = true;
      explicitDetach = false;
      continue;
    }
    if (token === '--detach') {
      wait = false;
      explicitDetach = true;
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for account remove.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  if (ctx.transport.mode === 'local' && explicitDetach) {
    throw new CliError('USAGE_ERROR', 'Cannot use --detach in standalone --local mode.', {
      exitCode: EXIT_CODES.USAGE,
      hint: 'Start the Tsubasa server for detached background jobs, or omit --detach.',
    });
  }
  if (ctx.transport.mode === 'local') {
    wait = true;
  }

  if (positionals.length !== 1) {
    throw new CliError(
      'USAGE_ERROR',
      'Usage: tsubasa account remove <account> [--evacuate] [--yes] [--wait]',
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  const acc = await resolveAccountArg(ctx, positionals[0]);
  const masked = ctx.flags.showEmails ? acc.email : maskEmail(acc.email);

  if (!acc.canSwitchPool && !evacuate) {
    throw new CliError(
      'USAGE_ERROR',
      `Account ${acc.accountRef} (${masked}) still holds files; pass --evacuate --yes to evacuate and remove it.`,
      {
        exitCode: EXIT_CODES.USAGE,
        hint: 'Run `tsubasa account remove <account> --evacuate --yes` or evacuate files first.',
      }
    );
  }

  if (ctx.flags.dryRun) {
    emitSuccess(
      ctx,
      {
        dryRun: true,
        action: 'account remove',
        accountRef: acc.accountRef,
        accountId: acc.accountId,
        poolId: acc.poolId,
        requiresEvacuation: !acc.canSwitchPool,
        evacuate,
        wait,
      },
      `[dry-run] remove account ${acc.accountRef} (${masked})${!acc.canSwitchPool ? ' (with evacuation)' : ''}`
    );
    return;
  }

  await requireConfirmation(
    ctx,
    `remove account ${acc.accountRef} (${masked})${!acc.canSwitchPool ? ' after evacuating its files' : ''}`
  );

  const res = await ctx.transport.requestJson<RemoveAccountResponse>(
    `/api/accounts/${encodeURIComponent(acc.accountId)}${wait ? '?wait=true' : ''}`,
    { method: 'DELETE' }
  );

  const payload = {
    accountRef: acc.accountRef,
    ...res,
    sourceAccountId: ctx.flags.showEmails ? res.sourceAccountId : maskEmail(res.sourceAccountId),
  };

  if (res.queued) {
    emitSuccess(
      ctx,
      payload,
      `Queued evacuation & removal for ${acc.accountRef} (${masked}), jobId=${res.jobId ?? '-'}, filesQueued=${res.filesQueued ?? 0}.`
    );
    return;
  }

  emitSuccess(
    ctx,
    payload,
    `Removed account ${acc.accountRef} (${masked})${res.filesMoved > 0 ? ` (moved ${res.filesMoved} file(s), ${formatBytes(res.bytesMoved)})` : ''}.`
  );
}

export async function handleAccountMovePool(ctx: CliContext, args: string[]): Promise<void> {
  let targetPoolSelector: string | undefined;
  let evacuate = false;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--to') {
      targetPoolSelector = readFlagValue(args, i, '--to');
      i += 1;
      continue;
    }
    if (token.startsWith('--to=')) {
      targetPoolSelector = token.slice('--to='.length).trim();
      continue;
    }
    if (token === '--evacuate') {
      evacuate = true;
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for account move-pool.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  if (positionals.length !== 1 || !targetPoolSelector) {
    throw new CliError(
      'USAGE_ERROR',
      'Usage: tsubasa account move-pool <account> --to <pool> [--evacuate]',
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  const [acc, targetPool] = await Promise.all([
    resolveAccountArg(ctx, positionals[0]),
    resolvePoolArg(ctx, targetPoolSelector),
  ]);
  const masked = ctx.flags.showEmails ? acc.email : maskEmail(acc.email);

  if (ctx.flags.dryRun) {
    const canMove = (acc.canSwitchPool || evacuate) && !targetPool.isSharePool;
    const blockedReason =
      !acc.canSwitchPool && !evacuate
        ? 'Account holds indexed files; pass --evacuate or evacuate files first.'
        : targetPool.isSharePool
          ? 'Cannot move an account directly into Share Pool.'
          : null;
    emitSuccess(
      ctx,
      {
        dryRun: true,
        action: 'account move-pool',
        accountRef: acc.accountRef,
        accountId: acc.accountId,
        fromPoolId: acc.poolId,
        toPoolId: targetPool.id,
        toPoolSlug: targetPool.slug,
        evacuate,
        willEvacuateFirst: evacuate && !acc.canSwitchPool,
        canMove,
        blockedReason,
      },
      `[dry-run] move account ${acc.accountRef} (${masked}) from pool ${acc.poolId} to ${targetPool.slug} (id=${targetPool.id})${evacuate && !acc.canSwitchPool ? ' [evacuate first]' : ''}${blockedReason ? ` [blocked: ${blockedReason}]` : ''}`
    );
    return;
  }

  if (targetPool.isSharePool) {
    throw new CliError(
      'SHARE_POOL_READ_ONLY',
      'Cannot move an account directly into Share Pool.',
      { exitCode: EXIT_CODES.CONFLICT }
    );
  }

  let evacuation: EvacuateResponse | null = null;
  if (evacuate && !acc.canSwitchPool) {
    evacuation = await ctx.transport.requestJson<EvacuateResponse>(
      `/api/accounts/${encodeURIComponent(acc.accountId)}/evacuate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wait: true, removeAfter: false }),
      }
    );
    if (evacuation.status !== 'completed' || evacuation.failedItems > 0) {
      throw new CliError(
        'RUNTIME_ERROR',
        `Evacuation job ${evacuation.jobId} ended with status '${evacuation.status}' (failed=${evacuation.failedItems}); aborting pool move.`,
        { exitCode: EXIT_CODES.RUNTIME }
      );
    }
  }

  const res = await ctx.transport.requestJson<Record<string, unknown>>(
    `/api/accounts/${encodeURIComponent(acc.accountId)}/pool`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ poolId: targetPool.id }),
    }
  );

  emitSuccess(
    ctx,
    {
      accountRef: acc.accountRef,
      accountId: acc.accountId,
      toPoolSlug: targetPool.slug,
      ...(evacuation
        ? {
            evacuation: {
              ...evacuation,
              sourceAccountId: ctx.flags.showEmails
                ? evacuation.sourceAccountId
                : maskEmail(evacuation.sourceAccountId),
            },
          }
        : {}),
      ...res,
    },
    `Moved account ${acc.accountRef} (${masked}) to pool "${targetPool.name}" (${targetPool.slug}, id=${targetPool.id})${evacuation ? ` after evacuating ${evacuation.filesMoved} file(s)` : ''}.`
  );
}

export async function handleAccount(ctx: CliContext, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    throw new CliError(
      'USAGE_ERROR',
      'Usage: tsubasa account <list|show|quota|enable|disable|evacuate|move-pool|remove>',
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  switch (subcommand) {
    case 'list':
      return handleAccountList(ctx, rest);
    case 'show':
      return handleAccountShow(ctx, rest);
    case 'quota':
      return handleAccountQuota(ctx, rest);
    case 'enable':
      return handleAccountEnable(ctx, rest);
    case 'disable':
      return handleAccountDisable(ctx, rest);
    case 'evacuate':
      return handleAccountEvacuate(ctx, rest);
    case 'move-pool':
      return handleAccountMovePool(ctx, rest);
    case 'remove':
      return handleAccountRemove(ctx, rest);
    default:
      throw new CliError(
        'USAGE_ERROR',
        `Unknown account subcommand '${subcommand}'. Expected list, show, quota, enable, disable, evacuate, move-pool, or remove.`,
        { exitCode: EXIT_CODES.USAGE }
      );
  }
}
