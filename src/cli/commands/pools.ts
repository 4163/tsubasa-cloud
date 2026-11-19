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
import { maskEmail, toAccountRef } from '../lib/redact.js';
import { slugifyPoolName, validatePoolSlug } from '../lib/selectors.js';
import { resolveAccountArg } from './accounts.js';

interface PoolOverviewAccount {
  id: string;
  email: string;
  displayName: string;
  poolId: number;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  usableLimitBytes: number;
  headroomBytes: number;
  tsubasaUsedBytes: number;
  syncState: string;
  isDisabled: boolean;
}

interface PoolStorageOverview {
  poolId: number;
  totalAccounts: number;
  totalLimitBytes: number;
  totalUsedBytes: number;
  totalHeadroomBytes: number;
  totalTsubasaUsedBytes: number;
  accounts: PoolOverviewAccount[];
}

function assertValidSlug(rawSlug: string): string {
  const checked = validatePoolSlug(rawSlug);
  if (!checked.ok) {
    throw new CliError('INVALID_POOL_SLUG', checked.error, {
      exitCode: EXIT_CODES.USAGE,
    });
  }
  return checked.slug;
}

export async function handlePoolList(ctx: CliContext, args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new CliError('USAGE_ERROR', `Unexpected argument '${args[0]}' for pool list.`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const res = await ctx.transport.requestJson<{ pools: PoolInfo[] }>('/api/pools');
  const pools = res.pools ?? [];

  const table = renderTable(
    pools.map((p) => ({ ...p })),
    [
      { key: 'id', header: 'ID', align: 'right' },
      { key: 'slug', header: 'SLUG' },
      { key: 'name', header: 'NAME' },
      { key: 'sortOrder', header: 'ORDER', align: 'right' },
      { key: 'accountCount', header: 'ACCOUNTS', align: 'right' },
      { key: 'fileCount', header: 'FILES', align: 'right' },
      {
        key: 'totalBytes',
        header: 'USED',
        align: 'right',
        format: (p) => formatBytes(p.totalBytes),
      },
      {
        key: 'isSharePool',
        header: 'TYPE',
        format: (p) => (p.isSharePool ? 'share' : 'standard'),
      },
    ],
    { emptyMessage: 'No storage pools found.' }
  );

  emitSuccess(ctx, { pools }, table);
}

export async function handlePoolShow(ctx: CliContext, args: string[]): Promise<void> {
  const positionals: string[] = [];
  for (const token of args) {
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for pool show.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }
  if (positionals.length > 1) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa pool show <id|slug>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const selector = positionals[0] ?? ctx.flags.pool;
  if (!selector) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa pool show <id|slug>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const pool = await resolvePoolArg(ctx, selector);
  const overview = await ctx.transport.requestJson<PoolStorageOverview>(
    `/api/storage/overview?poolId=${pool.id}`
  );

  const accounts = (overview.accounts ?? []).map((acc) => ({
    ...acc,
    accountRef: toAccountRef(acc.id),
  }));

  const lines = [
    `Pool:         ${pool.name} (${pool.slug}, id=${pool.id})`,
    `Type:         ${pool.isSharePool ? 'share' : 'standard'}`,
    `Sort Order:   ${pool.sortOrder}`,
    `Drive Folder: ${pool.driveFolderName}`,
    `Accounts:     ${pool.accountCount}`,
    `Files:        ${pool.fileCount}`,
    `Capacity:     ${formatBytes(overview.totalUsedBytes)} / ${formatBytes(overview.totalLimitBytes)} used (${formatBytes(overview.totalHeadroomBytes)} headroom)`,
  ];

  if (accounts.length > 0) {
    lines.push('');
    lines.push(
      renderTable(accounts, [
        { key: 'accountRef', header: 'REF' },
        {
          key: 'email',
          header: 'EMAIL',
          format: (a) => (ctx.flags.showEmails ? a.email : maskEmail(a.email)),
        },
        { key: 'syncState', header: 'SYNC' },
        {
          key: 'isDisabled',
          header: 'ENABLED',
          format: (a) => (a.isDisabled ? 'no' : 'yes'),
        },
        {
          key: 'quotaUsedBytes',
          header: 'USED',
          align: 'right',
          format: (a) => formatBytes(a.quotaUsedBytes),
        },
        {
          key: 'headroomBytes',
          header: 'HEADROOM',
          align: 'right',
          format: (a) => formatBytes(a.headroomBytes),
        },
      ])
    );
  }

  emitSuccess(ctx, { pool, overview: { ...overview, accounts } }, lines.join('\n'));
}

export async function handlePoolCreate(ctx: CliContext, args: string[]): Promise<void> {
  let slug: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--slug') {
      slug = assertValidSlug(readFlagValue(args, i, '--slug'));
      i += 1;
      continue;
    }
    if (token.startsWith('--slug=')) {
      slug = assertValidSlug(token.slice('--slug='.length));
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for pool create.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  if (positionals.length !== 1 || !positionals[0].trim()) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa pool create <name> [--slug <slug>]', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const name = positionals[0].trim();

  if (ctx.flags.dryRun) {
    const res = await ctx.transport.requestJson<{ pools: PoolInfo[] }>('/api/pools');
    const existingSlugs = (res.pools ?? []).map((p) => p.slug);
    const previewSlug = slug ?? slugifyPoolName(name, existingSlugs);
    const slugConflict = slug ? existingSlugs.some((s) => s.toLowerCase() === slug.toLowerCase()) : false;
    emitSuccess(
      ctx,
      {
        dryRun: true,
        action: 'pool create',
        name,
        slug: previewSlug,
        slugConflict,
      },
      `[dry-run] create pool "${name}" with slug "${previewSlug}"${slugConflict ? ' (slug already in use)' : ''}`
    );
    return;
  }

  const created = await ctx.transport.requestJson<PoolInfo>('/api/pools', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...(slug !== undefined ? { slug } : {}) }),
  });

  emitSuccess(
    ctx,
    { pool: created },
    `Created pool "${created.name}" (${created.slug}, id=${created.id}).`
  );
}

export async function handlePoolRename(ctx: CliContext, args: string[]): Promise<void> {
  let newSlug: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--slug') {
      newSlug = assertValidSlug(readFlagValue(args, i, '--slug'));
      i += 1;
      continue;
    }
    if (token.startsWith('--slug=')) {
      newSlug = assertValidSlug(token.slice('--slug='.length));
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for pool rename.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  if (positionals.length !== 2 || !positionals[1].trim()) {
    throw new CliError(
      'USAGE_ERROR',
      'Usage: tsubasa pool rename <id|slug> <newName> [--slug <newSlug>]',
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  const selector = positionals[0];
  const newName = positionals[1].trim();
  const pool = await resolvePoolArg(ctx, selector);

  if (ctx.flags.dryRun) {
    emitSuccess(
      ctx,
      {
        dryRun: true,
        action: 'pool rename',
        poolId: pool.id,
        oldName: pool.name,
        newName,
        oldSlug: pool.slug,
        newSlug: newSlug ?? pool.slug,
      },
      `[dry-run] rename pool ${pool.slug} (id=${pool.id}): "${pool.name}" -> "${newName}" (slug: ${newSlug ?? pool.slug})`
    );
    return;
  }

  const updated = await ctx.transport.requestJson<PoolInfo>(`/api/pools/${pool.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: newName,
      ...(newSlug !== undefined ? { slug: newSlug } : {}),
    }),
  });

  emitSuccess(
    ctx,
    { pool: updated },
    `Renamed pool id=${updated.id} to "${updated.name}" (slug: ${updated.slug}).`
  );
}

export async function handlePoolDelete(ctx: CliContext, args: string[]): Promise<void> {
  const positionals: string[] = [];
  for (const token of args) {
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for pool delete.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }
  if (positionals.length > 1) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa pool delete <id|slug>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const selector = positionals[0] ?? ctx.flags.pool;
  if (!selector) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa pool delete <id|slug>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const pool = await resolvePoolArg(ctx, selector);

  if (ctx.flags.dryRun) {
    const allRes = await ctx.transport.requestJson<{ pools: PoolInfo[] }>('/api/pools');
    const standardCount = (allRes.pools ?? []).filter((p) => !p.isSharePool).length;
    let blockedReason: string | null = null;
    if (pool.isSharePool) {
      blockedReason = 'Share Pool cannot be deleted';
    } else if (standardCount <= 1) {
      blockedReason = 'Cannot delete the only remaining storage pool';
    } else if (pool.accountCount > 0) {
      blockedReason = 'Pool still contains accounts';
    } else if (pool.fileCount > 0) {
      blockedReason = 'Pool still contains files';
    }

    emitSuccess(
      ctx,
      {
        dryRun: true,
        action: 'pool delete',
        pool,
        canDelete: blockedReason === null,
        blockedReason,
      },
      `[dry-run] delete pool "${pool.name}" (${pool.slug}, id=${pool.id})${blockedReason ? ` [blocked: ${blockedReason}]` : ''}`
    );
    return;
  }

  await requireConfirmation(
    ctx,
    `delete pool "${pool.name}" (${pool.slug}, id=${pool.id})`
  );

  const deleted = await ctx.transport.requestJson<{
    success: boolean;
    id: number;
    name: string;
  }>(`/api/pools/${pool.id}`, {
    method: 'DELETE',
  });

  emitSuccess(ctx, deleted, `Deleted pool "${deleted.name}" (id=${deleted.id}).`);
}

export async function handlePoolReorder(ctx: CliContext, args: string[]): Promise<void> {
  const selectors: string[] = [];
  for (const token of args) {
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for pool reorder.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    selectors.push(token);
  }

  if (selectors.length === 0) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa pool reorder <slugs...>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (ctx.flags.dryRun) {
    const res = await ctx.transport.requestJson<{ pools: PoolInfo[] }>('/api/pools');
    const pools = res.pools ?? [];
    const standardPools = pools.filter((p) => !p.isSharePool);
    const resolved: PoolInfo[] = [];
    const seen = new Set<number>();

    for (const sel of selectors) {
      const matched = await resolvePoolArg(ctx, sel);
      if (matched.isSharePool) {
        throw new CliError('SHARE_POOL_READ_ONLY', 'Share Pool cannot be reordered.', {
          exitCode: EXIT_CODES.CONFLICT,
        });
      }
      if (seen.has(matched.id)) {
        throw new CliError('VALIDATION_ERROR', `Duplicate pool '${sel}' in reorder list.`, {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      seen.add(matched.id);
      resolved.push(matched);
    }

    if (resolved.length !== standardPools.length) {
      const missing = standardPools.filter((p) => !seen.has(p.id)).map((p) => p.slug);
      throw new CliError(
        'VALIDATION_ERROR',
        `Reorder list must include every standard pool. Missing: ${missing.join(', ')}`,
        { exitCode: EXIT_CODES.USAGE }
      );
    }

    const preview = resolved.map((p, idx) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      sortOrder: idx + 1,
    }));
    emitSuccess(
      ctx,
      { dryRun: true, action: 'pool reorder', order: preview },
      `[dry-run] pool reorder: ${preview.map((p) => `${p.sortOrder}:${p.slug}`).join(', ')}`
    );
    return;
  }

  const res = await ctx.transport.requestJson<{ pools: PoolInfo[] }>('/api/pools/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: selectors }),
  });

  const table = renderTable(
    (res.pools ?? []).map((p) => ({ ...p })),
    [
    { key: 'sortOrder', header: 'ORDER', align: 'right' },
    { key: 'id', header: 'ID', align: 'right' },
    { key: 'slug', header: 'SLUG' },
    { key: 'name', header: 'NAME' },
    {
      key: 'isSharePool',
      header: 'TYPE',
      format: (p) => (p.isSharePool ? 'share' : 'standard'),
    },
  ]);

  emitSuccess(ctx, res, table);
}

interface PoolRebalanceResponse {
  poolId: number;
  dryRun: boolean;
  overCeilingAccounts: Array<{
    accountId: string;
    excessBytes: number;
    candidateFilesCount: number;
    candidateBytesTotal: number;
  }>;
  filesMoved: number;
  bytesMoved: number;
  transfers: Array<{
    fileId: string;
    virtualPath: string;
    sourceAccountId: string;
    targetAccountId: string;
    newDriveFileId: string;
    bytesMoved: number;
  }>;
}

export async function handlePoolRebalance(ctx: CliContext, args: string[]): Promise<void> {
  let accountSelector: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
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
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for pool rebalance.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  if (positionals.length > 1) {
    throw new CliError(
      'USAGE_ERROR',
      'Usage: tsubasa pool rebalance [pool] [--account <account>]',
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  const pool = await resolvePoolArg(ctx, positionals[0]);
  if (pool.isSharePool) {
    throw new CliError(
      'SHARE_POOL_READ_ONLY',
      'Share Pool cannot be rebalanced.',
      { exitCode: EXIT_CODES.CONFLICT }
    );
  }

  let accountId: string | undefined;
  if (accountSelector) {
    const acc = await resolveAccountArg(ctx, accountSelector);
    if (acc.poolId !== pool.id) {
      throw new CliError(
        'VALIDATION_ERROR',
        `Account ${acc.accountRef} belongs to pool ${acc.poolId}, not pool '${pool.slug}' (${pool.id}).`,
        { exitCode: EXIT_CODES.USAGE }
      );
    }
    accountId = acc.accountId;
  }

  const res = await ctx.transport.requestJson<PoolRebalanceResponse>(
    `/api/pools/${pool.id}/rebalance`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(accountId !== undefined ? { accountId } : {}),
        dryRun: ctx.flags.dryRun,
      }),
    }
  );

  const overCeilingAccounts = (res.overCeilingAccounts ?? []).map((entry) => ({
    ...entry,
    accountRef: toAccountRef(entry.accountId),
  }));

  const transfers = (res.transfers ?? []).map((tr) => ({
    ...tr,
    sourceAccountRef: toAccountRef(tr.sourceAccountId),
    targetAccountRef: toAccountRef(tr.targetAccountId),
    sourceAccountId: ctx.flags.showEmails ? tr.sourceAccountId : maskEmail(tr.sourceAccountId),
    targetAccountId: ctx.flags.showEmails ? tr.targetAccountId : maskEmail(tr.targetAccountId),
  }));

  const payload = {
    poolId: res.poolId,
    poolSlug: pool.slug,
    dryRun: res.dryRun,
    overCeilingAccounts,
    filesMoved: res.filesMoved,
    bytesMoved: res.bytesMoved,
    transfers,
  };

  const prefix = res.dryRun ? '[dry-run] ' : '';
  const lines: string[] = [
    `${prefix}Pool rebalance (${pool.slug}, id=${pool.id}): over-ceiling accounts=${overCeilingAccounts.length}, filesMoved=${res.filesMoved}, bytesMoved=${formatBytes(res.bytesMoved)}`,
  ];

  if (overCeilingAccounts.length > 0) {
    lines.push('');
    lines.push(
      renderTable(overCeilingAccounts, [
        { key: 'accountRef', header: 'REF' },
        {
          key: 'accountId',
          header: 'ACCOUNT',
          format: (r) => (ctx.flags.showEmails ? r.accountId : maskEmail(r.accountId)),
        },
        { key: 'excessBytes', header: 'EXCESS', align: 'right', format: (r) => formatBytes(r.excessBytes) },
        { key: 'candidateFilesCount', header: 'CANDIDATES', align: 'right' },
        { key: 'candidateBytesTotal', header: 'CANDIDATE BYTES', align: 'right', format: (r) => formatBytes(r.candidateBytesTotal) },
      ])
    );
  }

  if (transfers.length > 0) {
    lines.push('');
    lines.push(
      renderTable(transfers, [
        { key: 'virtualPath', header: 'PATH' },
        { key: 'sourceAccountRef', header: 'FROM' },
        { key: 'targetAccountRef', header: 'TO' },
        { key: 'bytesMoved', header: 'BYTES', align: 'right', format: (r) => formatBytes(r.bytesMoved) },
      ])
    );
  }

  emitSuccess(ctx, payload, lines.join('\n'));
}

export async function handlePool(ctx: CliContext, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    throw new CliError(
      'USAGE_ERROR',
      'Usage: tsubasa pool <list|show|create|rename|delete|reorder|rebalance>',
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  switch (subcommand) {
    case 'list':
      return handlePoolList(ctx, rest);
    case 'show':
      return handlePoolShow(ctx, rest);
    case 'create':
      return handlePoolCreate(ctx, rest);
    case 'rename':
      return handlePoolRename(ctx, rest);
    case 'delete':
      return handlePoolDelete(ctx, rest);
    case 'reorder':
      return handlePoolReorder(ctx, rest);
    case 'rebalance':
      return handlePoolRebalance(ctx, rest);
    default:
      throw new CliError(
        'USAGE_ERROR',
        `Unknown pool subcommand '${subcommand}'. Expected list, show, create, rename, delete, reorder, or rebalance.`,
        { exitCode: EXIT_CODES.USAGE }
      );
  }
}
