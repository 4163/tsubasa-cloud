import path from 'node:path';
import {
  emitJsonl,
  emitSuccess,
  formatTimestamp,
  normalizePosixPath,
  readFlagValue,
  readStdinLines,
  requireConfirmation,
  resolvePoolArg,
  resolveRemoteTarget,
  type CliContext,
  type PoolInfo,
} from '../context.js';
import { CliError, EXIT_CODES } from '../lib/errors.js';
import { formatBytes, renderTable } from '../lib/format.js';
import { maskEmail, toAccountRef } from '../lib/redact.js';
import { parseRemoteSelector } from '../lib/selectors.js';

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
}

interface PooledStorageOverview {
  poolId: number;
  totalAccounts: number;
  totalLimitBytes: number;
  totalUsedBytes: number;
  totalHeadroomBytes: number;
  totalTsubasaUsedBytes: number;
  accounts: StorageAccountSummary[];
}

interface OutboxStatusSummary {
  counts: {
    pending: number;
    processing: number;
    failed: number;
    dead: number;
  };
}

type FindItem = {
  kind: 'folder' | 'file';
  id: string;
  poolId: number;
  virtualPath: string;
  name: string;
  sizeBytes: number | null;
  mimeType: string | null;
  accountId: string | null;
  updatedAt: number;
};

interface FindResponse {
  poolId: number;
  path: string;
  items: FindItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface StatFileItem {
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
  isTrashed: boolean;
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface StatFolderItem {
  id: string | null;
  poolId: number;
  virtualPath: string;
  name: string;
  parentFolderId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

type StatResponse =
  | { kind: 'file'; item: StatFileItem }
  | { kind: 'folder'; item: StatFolderItem };

const MOVE_CONFLICT_MODES = new Set(['reject', 'skip', 'keep_both', 'overwrite']);

async function statOptional(
  ctx: CliContext,
  poolId: number,
  virtualPath: string
): Promise<StatResponse | null> {
  try {
    return await ctx.transport.requestJson<StatResponse>(
      `/api/items/stat?poolId=${poolId}&path=${encodeURIComponent(virtualPath)}`
    );
  } catch (err) {
    if (err instanceof CliError && err.exitCode === EXIT_CODES.NOT_FOUND) {
      return null;
    }
    throw err;
  }
}

async function statRequired(
  ctx: CliContext,
  poolId: number,
  virtualPath: string
): Promise<StatResponse> {
  return ctx.transport.requestJson<StatResponse>(
    `/api/items/stat?poolId=${poolId}&path=${encodeURIComponent(virtualPath)}`
  );
}

function formatAccountCell(accountId: string | null, showEmails: boolean): string {
  if (!accountId) return '-';
  const ref = toAccountRef(accountId);
  const label = showEmails ? accountId : maskEmail(accountId);
  return `${ref} (${label})`;
}

function parsePositiveInt(raw: string, flag: string, max = 1000): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new CliError('VALIDATION_ERROR', `Flag ${flag} must be an integer between 1 and ${max}.`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }
  return parsed;
}

export async function handleStatus(ctx: CliContext, args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new CliError('USAGE_ERROR', `Unexpected argument '${args[0]}' for status.`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const [poolsRes, accountsRes, outboxRes] = await Promise.all([
    ctx.transport.requestJson<{ pools: PoolInfo[] }>('/api/pools'),
    ctx.transport.requestJson<{ accounts: AccountListItem[] }>('/api/accounts'),
    ctx.transport.requestJson<OutboxStatusSummary>('/api/sync/status'),
  ]);

  let targetPools = poolsRes.pools ?? [];
  if (ctx.flags.pool) {
    const selected = await resolvePoolArg(ctx);
    targetPools = targetPools.filter((p) => p.id === selected.id);
  }

  const overviews = await Promise.all(
    targetPools.map((p) =>
      ctx.transport.requestJson<PooledStorageOverview>(`/api/storage/overview?poolId=${p.id}`)
    )
  );
  const overviewByPoolId = new Map(overviews.map((ov) => [ov.poolId, ov]));

  const storageAccById = new Map<string, StorageAccountSummary>();
  for (const ov of overviews) {
    for (const acc of ov.accounts) {
      storageAccById.set(acc.id, acc);
    }
  }

  const targetPoolIds = new Set(targetPools.map((p) => p.id));
  const filteredAccounts = (accountsRes.accounts ?? []).filter((a) => targetPoolIds.has(a.poolId));

  const poolRows = targetPools.map((p) => {
    const ov = overviewByPoolId.get(p.id);
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      isSharePool: p.isSharePool,
      accountCount: p.accountCount,
      fileCount: p.fileCount,
      totalLimitBytes: ov?.totalLimitBytes ?? 0,
      totalUsedBytes: ov?.totalUsedBytes ?? 0,
      totalHeadroomBytes: ov?.totalHeadroomBytes ?? 0,
      totalTsubasaUsedBytes: ov?.totalTsubasaUsedBytes ?? 0,
    };
  });

  const accountRows = filteredAccounts.map((acc) => {
    const st = storageAccById.get(acc.accountId);
    return {
      accountRef: toAccountRef(acc.accountId),
      accountId: acc.accountId,
      email: st?.email ?? acc.accountId,
      poolId: acc.poolId,
      authorized: acc.authorized,
      isDisabled: acc.isDisabled,
      syncState: st?.syncState ?? (acc.authorized ? 'unhydrated' : 'unauthorized'),
      quotaLimitBytes: st?.quotaLimitBytes ?? 0,
      quotaUsedBytes: st?.quotaUsedBytes ?? 0,
      headroomBytes: st?.headroomBytes ?? 0,
      canSwitchPool: acc.canSwitchPool,
    };
  });

  const totals = {
    poolCount: poolRows.length,
    accountCount: accountRows.length,
    authorizedAccountCount: accountRows.filter((a) => a.authorized).length,
    activeAccountCount: accountRows.filter((a) => a.authorized && !a.isDisabled).length,
    fileCount: poolRows.reduce((sum, p) => sum + p.fileCount, 0),
    totalLimitBytes: poolRows.reduce((sum, p) => sum + p.totalLimitBytes, 0),
    totalUsedBytes: poolRows.reduce((sum, p) => sum + p.totalUsedBytes, 0),
    totalHeadroomBytes: poolRows.reduce((sum, p) => sum + p.totalHeadroomBytes, 0),
    totalTsubasaUsedBytes: poolRows.reduce((sum, p) => sum + p.totalTsubasaUsedBytes, 0),
  };

  const payload = {
    transport: {
      mode: ctx.transport.mode,
      serverUrl: ctx.transport.serverUrl,
      homeDir: ctx.transport.homeDir,
      dbFingerprint: ctx.transport.dbFingerprint,
    },
    totals,
    outbox: outboxRes.counts,
    pools: poolRows,
    accounts: accountRows,
  };

  const lines: string[] = [
    `Transport: ${ctx.transport.mode}${ctx.transport.serverUrl ? ` (${ctx.transport.serverUrl})` : ''}`,
    `Pools: ${totals.poolCount} | Accounts: ${totals.activeAccountCount}/${totals.accountCount} active | Files: ${totals.fileCount}`,
    `Storage: ${formatBytes(totals.totalUsedBytes)} / ${formatBytes(totals.totalLimitBytes)} used (${formatBytes(totals.totalHeadroomBytes)} headroom)`,
    `Outbox: pending=${outboxRes.counts.pending} processing=${outboxRes.counts.processing} failed=${outboxRes.counts.failed} dead=${outboxRes.counts.dead}`,
  ];

  if (poolRows.length > 0) {
    lines.push('');
    lines.push(
      renderTable(poolRows, [
        { key: 'id', header: 'ID', align: 'right' },
        { key: 'slug', header: 'SLUG' },
        { key: 'name', header: 'NAME' },
        { key: 'accountCount', header: 'ACCOUNTS', align: 'right' },
        { key: 'fileCount', header: 'FILES', align: 'right' },
        { key: 'totalUsedBytes', header: 'USED', align: 'right', format: (r) => formatBytes(r.totalUsedBytes) },
        { key: 'totalHeadroomBytes', header: 'HEADROOM', align: 'right', format: (r) => formatBytes(r.totalHeadroomBytes) },
      ])
    );
  }

  if (accountRows.length > 0) {
    lines.push('');
    lines.push(
      renderTable(accountRows, [
        { key: 'accountRef', header: 'REF' },
        {
          key: 'email',
          header: 'EMAIL',
          format: (r) => (ctx.flags.showEmails ? r.email : maskEmail(r.email)),
        },
        { key: 'poolId', header: 'POOL', align: 'right' },
        {
          key: 'syncState',
          header: 'STATUS',
          format: (r) => (!r.authorized ? 'unauthorized' : r.isDisabled ? 'disabled' : r.syncState),
        },
        { key: 'quotaUsedBytes', header: 'USED', align: 'right', format: (r) => formatBytes(r.quotaUsedBytes) },
        { key: 'headroomBytes', header: 'HEADROOM', align: 'right', format: (r) => formatBytes(r.headroomBytes) },
      ])
    );
  }

  emitSuccess(ctx, payload, lines.join('\n'));
}

export async function handleLs(ctx: CliContext, args: string[]): Promise<void> {
  let recursive = false;
  let limit = 100;
  let cursor: string | undefined;
  let format: 'table' | 'json' | 'jsonl' = 'table';
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '-r' || token === '--recursive') {
      recursive = true;
      continue;
    }
    if (token === '--limit') {
      limit = parsePositiveInt(readFlagValue(args, i, '--limit'), '--limit');
      i += 1;
      continue;
    }
    if (token.startsWith('--limit=')) {
      limit = parsePositiveInt(token.slice('--limit='.length), '--limit');
      continue;
    }
    if (token === '--cursor') {
      cursor = readFlagValue(args, i, '--cursor');
      i += 1;
      continue;
    }
    if (token.startsWith('--cursor=')) {
      cursor = token.slice('--cursor='.length);
      continue;
    }
    if (token === '--format') {
      const val = readFlagValue(args, i, '--format').toLowerCase();
      if (val !== 'table' && val !== 'json' && val !== 'jsonl') {
        throw new CliError('USAGE_ERROR', "Flag --format must be 'table', 'json', or 'jsonl'.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      format = val;
      i += 1;
      continue;
    }
    if (token.startsWith('--format=')) {
      const val = token.slice('--format='.length).toLowerCase();
      if (val !== 'table' && val !== 'json' && val !== 'jsonl') {
        throw new CliError('USAGE_ERROR', "Flag --format must be 'table', 'json', or 'jsonl'.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      format = val;
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for ls.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  if (positionals.length > 1) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa ls [path]', { exitCode: EXIT_CODES.USAGE });
  }

  const rawPath = positionals[0] ?? '/';
  const { pool, path: virtualPath } = await resolveRemoteTarget(ctx, rawPath);

  const params = new URLSearchParams({
    poolId: String(pool.id),
    path: virtualPath,
    recursive: recursive ? 'true' : 'false',
    limit: String(limit),
  });
  if (cursor) {
    params.set('afterPath', cursor);
  }

  const res = await ctx.transport.requestJson<FindResponse>(`/api/items/find?${params.toString()}`);
  let items = res.items ?? [];

  if (items.length === 0 && virtualPath !== '/' && !cursor) {
    const itemStat = await statOptional(ctx, pool.id, virtualPath);
    if (!itemStat) {
      throw new CliError('NOT_FOUND', `Path '${virtualPath}' not found in pool '${pool.slug}'.`, {
        exitCode: EXIT_CODES.NOT_FOUND,
      });
    }
    if (itemStat.kind === 'file') {
      items = [
        {
          kind: 'file',
          id: itemStat.item.id,
          poolId: itemStat.item.poolId,
          virtualPath: itemStat.item.virtualPath,
          name: itemStat.item.name,
          sizeBytes: itemStat.item.sizeBytes,
          mimeType: itemStat.item.mimeType,
          accountId: itemStat.item.accountId,
          updatedAt: itemStat.item.updatedAt,
        },
      ];
    }
  }

  if (format === 'jsonl') {
    emitJsonl(ctx, items);
    return;
  }

  const payload = {
    poolId: pool.id,
    poolSlug: pool.slug,
    path: virtualPath,
    recursive,
    items,
    nextCursor: res.nextCursor,
    hasMore: res.hasMore,
  };

  if (ctx.flags.json || format === 'json') {
    emitSuccess(ctx, payload);
    return;
  }

  const table = renderTable(
    items,
    [
      { key: 'kind', header: 'TYPE', format: (r) => (r.kind === 'folder' ? 'dir' : 'file') },
      {
        key: 'name',
        header: recursive ? 'PATH' : 'NAME',
        format: (r) => (recursive ? r.virtualPath : r.name),
      },
      {
        key: 'sizeBytes',
        header: 'SIZE',
        align: 'right',
        format: (r) => (r.kind === 'file' && r.sizeBytes !== null ? formatBytes(r.sizeBytes) : '-'),
      },
      {
        key: 'accountId',
        header: 'ACCOUNT',
        format: (r) => formatAccountCell(r.accountId, ctx.flags.showEmails),
      },
      {
        key: 'updatedAt',
        header: 'UPDATED',
        format: (r) => formatTimestamp(r.updatedAt),
      },
    ],
    { emptyMessage: `(${pool.slug}:${virtualPath} is empty)` }
  );

  const footer = res.hasMore && res.nextCursor ? `\nMore items available. Next cursor: ${res.nextCursor}` : '';
  emitSuccess(ctx, payload, `${table}${footer}`);
}

export async function handleStat(ctx: CliContext, args: string[]): Promise<void> {
  const positionals: string[] = [];
  for (const token of args) {
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for stat.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa stat <path>', { exitCode: EXIT_CODES.USAGE });
  }

  const { pool, path: virtualPath } = await resolveRemoteTarget(ctx, positionals[0]);
  const statRes = await statRequired(ctx, pool.id, virtualPath);
  const payload = {
    kind: statRes.kind,
    poolId: pool.id,
    poolSlug: pool.slug,
    item: statRes.item,
  };

  let lines: string[];
  if (statRes.kind === 'file') {
    const f = statRes.item;
    lines = [
      `Kind:        file`,
      `Pool:        ${pool.slug} (id=${pool.id})`,
      `Path:        ${f.virtualPath}`,
      `Name:        ${f.name}`,
      `ID:          ${f.id}`,
      `Size:        ${formatBytes(f.sizeBytes)} (${f.sizeBytes} bytes)`,
      `MIME Type:   ${f.mimeType}`,
      `Hash:        ${f.hash ?? '-'}`,
      `Account:     ${formatAccountCell(f.accountId, ctx.flags.showEmails)}`,
      `Drive ID:    ${f.driveFileId}`,
      `Created:     ${formatTimestamp(f.createdAt)}`,
      `Updated:     ${formatTimestamp(f.updatedAt)}`,
    ];
  } else {
    const d = statRes.item;
    lines = [
      `Kind:        folder`,
      `Pool:        ${pool.slug} (id=${pool.id})`,
      `Path:        ${d.virtualPath}`,
      `Name:        ${d.name}`,
      `ID:          ${d.id ?? '-'}`,
      `Parent ID:   ${d.parentFolderId ?? '-'}`,
      `Created:     ${formatTimestamp(d.createdAt)}`,
      `Updated:     ${formatTimestamp(d.updatedAt)}`,
    ];
  }

  emitSuccess(ctx, payload, lines.join('\n'));
}

export async function handleFind(ctx: CliContext, args: string[]): Promise<void> {
  let glob: string | undefined;
  let scopePath = '/';
  let limit = 100;
  let cursor: string | undefined;
  let recursive = true;
  let format: 'table' | 'json' | 'jsonl' = 'table';
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--glob') {
      glob = readFlagValue(args, i, '--glob');
      i += 1;
      continue;
    }
    if (token.startsWith('--glob=')) {
      glob = token.slice('--glob='.length);
      continue;
    }
    if (token === '--path') {
      scopePath = readFlagValue(args, i, '--path');
      i += 1;
      continue;
    }
    if (token.startsWith('--path=')) {
      scopePath = token.slice('--path='.length);
      continue;
    }
    if (token === '--limit') {
      limit = parsePositiveInt(readFlagValue(args, i, '--limit'), '--limit');
      i += 1;
      continue;
    }
    if (token.startsWith('--limit=')) {
      limit = parsePositiveInt(token.slice('--limit='.length), '--limit');
      continue;
    }
    if (token === '--cursor') {
      cursor = readFlagValue(args, i, '--cursor');
      i += 1;
      continue;
    }
    if (token.startsWith('--cursor=')) {
      cursor = token.slice('--cursor='.length);
      continue;
    }
    if (token === '--no-recursive') {
      recursive = false;
      continue;
    }
    if (token === '--format') {
      const val = readFlagValue(args, i, '--format').toLowerCase();
      if (val !== 'table' && val !== 'json' && val !== 'jsonl') {
        throw new CliError('USAGE_ERROR', "Flag --format must be 'table', 'json', or 'jsonl'.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      format = val;
      i += 1;
      continue;
    }
    if (token.startsWith('--format=')) {
      const val = token.slice('--format='.length).toLowerCase();
      if (val !== 'table' && val !== 'json' && val !== 'jsonl') {
        throw new CliError('USAGE_ERROR', "Flag --format must be 'table', 'json', or 'jsonl'.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      format = val;
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for find.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  if (positionals.length > 1) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa find [query] [--glob <pattern>]', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const query = positionals[0] ?? '';
  const { pool, path: virtualPath } = await resolveRemoteTarget(ctx, scopePath);

  const params = new URLSearchParams({
    poolId: String(pool.id),
    path: virtualPath,
    recursive: recursive ? 'true' : 'false',
    limit: String(limit),
  });
  if (query) params.set('q', query);
  if (glob) params.set('glob', glob);
  if (cursor) params.set('afterPath', cursor);

  const res = await ctx.transport.requestJson<FindResponse>(`/api/items/find?${params.toString()}`);
  const items = res.items ?? [];

  if (format === 'jsonl') {
    emitJsonl(ctx, items);
    return;
  }

  const payload = {
    poolId: pool.id,
    poolSlug: pool.slug,
    query: query || null,
    glob: glob ?? null,
    path: virtualPath,
    items,
    nextCursor: res.nextCursor,
    hasMore: res.hasMore,
  };

  if (ctx.flags.json || format === 'json') {
    emitSuccess(ctx, payload);
    return;
  }

  const table = renderTable(
    items,
    [
      { key: 'kind', header: 'TYPE', format: (r) => (r.kind === 'folder' ? 'dir' : 'file') },
      { key: 'virtualPath', header: 'PATH' },
      {
        key: 'sizeBytes',
        header: 'SIZE',
        align: 'right',
        format: (r) => (r.kind === 'file' && r.sizeBytes !== null ? formatBytes(r.sizeBytes) : '-'),
      },
      {
        key: 'accountId',
        header: 'ACCOUNT',
        format: (r) => formatAccountCell(r.accountId, ctx.flags.showEmails),
      },
    ],
    { emptyMessage: 'No matching items found.' }
  );

  const footer = res.hasMore && res.nextCursor ? `\nMore items available. Next cursor: ${res.nextCursor}` : '';
  emitSuccess(ctx, payload, `${table}${footer}`);
}

export async function handleMkdir(ctx: CliContext, args: string[]): Promise<void> {
  const positionals: string[] = [];
  for (const token of args) {
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for mkdir.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa mkdir <path>', { exitCode: EXIT_CODES.USAGE });
  }

  const { pool, path: virtualPath } = await resolveRemoteTarget(ctx, positionals[0]);
  if (virtualPath === '/') {
    throw new CliError('USAGE_ERROR', "Cannot create root directory '/'.", {
      exitCode: EXIT_CODES.USAGE,
    });
  }
  const name = path.posix.basename(virtualPath);

  if (ctx.flags.dryRun) {
    const existing = await statOptional(ctx, pool.id, virtualPath);
    emitSuccess(
      ctx,
      {
        dryRun: true,
        action: 'mkdir',
        poolId: pool.id,
        poolSlug: pool.slug,
        virtualPath,
        name,
        alreadyExists: Boolean(existing),
      },
      `[dry-run] mkdir ${pool.slug}:${virtualPath}${existing ? ' (already exists)' : ''}`
    );
    return;
  }

  const created = await ctx.transport.requestJson<{
    id: string;
    poolId: number;
    virtualPath: string;
    name: string;
  }>('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ virtualPath, name, poolId: pool.id }),
  });

  emitSuccess(
    ctx,
    { ...created, poolSlug: pool.slug },
    `Created folder ${pool.slug}:${created.virtualPath}`
  );
}

async function resolveBatchTargets(
  ctx: CliContext,
  rawInputs: readonly string[]
): Promise<{ pool: PoolInfo; paths: string[] }> {
  const resolved = await Promise.all(rawInputs.map((raw) => resolveRemoteTarget(ctx, raw)));
  const firstPool = resolved[0].pool;
  for (const item of resolved) {
    if (item.pool.id !== firstPool.id) {
      throw new CliError(
        'USAGE_ERROR',
        `Cross-pool paths are not supported in this command ('${firstPool.slug}' vs '${item.pool.slug}').`,
        { exitCode: EXIT_CODES.USAGE }
      );
    }
  }
  return { pool: firstPool, paths: resolved.map((r) => r.path) };
}

export async function handleMv(ctx: CliContext, args: string[]): Promise<void> {
  let useStdin = false;
  let conflictMode = 'reject';
  let toPoolSelector: string | undefined;
  let wait = true;
  let explicitDetach = false;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--stdin') {
      useStdin = true;
      continue;
    }
    if (token === '--to-pool') {
      toPoolSelector = readFlagValue(args, i, '--to-pool');
      i += 1;
      continue;
    }
    if (token.startsWith('--to-pool=')) {
      toPoolSelector = token.slice('--to-pool='.length).trim();
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
    if (token === '--conflict') {
      conflictMode = readFlagValue(args, i, '--conflict').toLowerCase();
      i += 1;
      continue;
    }
    if (token.startsWith('--conflict=')) {
      conflictMode = token.slice('--conflict='.length).toLowerCase();
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for mv.`, {
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

  if (!MOVE_CONFLICT_MODES.has(conflictMode)) {
    throw new CliError(
      'USAGE_ERROR',
      "Flag --conflict must be 'reject', 'skip', 'keep_both', or 'overwrite'.",
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  const stdinLines = useStdin ? await readStdinLines() : [];
  if (useStdin && positionals.length < 1) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa mv --stdin <dest>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }
  if (!useStdin && positionals.length < 2) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa mv <src...> <dest>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const destRaw = positionals[positionals.length - 1];
  const srcRaws = [...positionals.slice(0, -1), ...stdinLines];
  if (srcRaws.length === 0) {
    throw new CliError('USAGE_ERROR', 'At least one source path is required for mv.', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const { pool, paths: srcPaths } = await resolveBatchTargets(ctx, srcRaws);

  let destPool: PoolInfo;
  let destPath: string;
  if (toPoolSelector) {
    const parsedDest = parseRemoteSelector(destRaw);
    destPool = await resolvePoolArg(ctx, toPoolSelector);
    if (parsedDest.isRemote && parsedDest.pool) {
      const explicitPrefixPool = await resolvePoolArg(ctx, parsedDest.pool);
      if (explicitPrefixPool.id !== destPool.id) {
        throw new CliError(
          'USAGE_ERROR',
          `Conflicting destination pool selectors: '${parsedDest.pool}' vs --to-pool '${toPoolSelector}'.`,
          { exitCode: EXIT_CODES.USAGE }
        );
      }
    }
    destPath = normalizePosixPath(parsedDest.path);
  } else {
    const resolvedDest = await resolveRemoteTarget(ctx, destRaw);
    destPool = resolvedDest.pool;
    destPath = resolvedDest.path;
  }

  for (const srcPath of srcPaths) {
    if (srcPath === '/') {
      throw new CliError('USAGE_ERROR', "Cannot move root directory '/'.", {
        exitCode: EXIT_CODES.USAGE,
      });
    }
  }

  const srcStats = await Promise.all(srcPaths.map((p) => statRequired(ctx, pool.id, p)));

  if (destPool.id !== pool.id) {
    if (pool.isSharePool || destPool.isSharePool) {
      throw new CliError(
        'SHARE_POOL_READ_ONLY',
        'Cross-pool move cannot target or originate from Share Pool.',
        { exitCode: EXIT_CODES.CONFLICT }
      );
    }

    const items = srcStats.map((st, idx) => ({
      kind: st.kind,
      id: st.item.id as string,
      path: srcPaths[idx],
    }));

    const destStat = await statOptional(ctx, destPool.id, destPath);
    const useDestDir =
      items.length > 1 ||
      destPath === '/' ||
      destRaw.endsWith('/') ||
      destStat?.kind === 'folder';

    if (ctx.flags.dryRun) {
      emitSuccess(
        ctx,
        {
          dryRun: true,
          action: 'cross_pool_move',
          sourcePoolId: pool.id,
          sourcePoolSlug: pool.slug,
          destPoolId: destPool.id,
          destPoolSlug: destPool.slug,
          items,
          ...(useDestDir ? { destDir: destPath } : { destPath }),
          conflictMode,
        },
        `[dry-run] cross-pool mv ${items.length} item(s): ${pool.slug} -> ${destPool.slug}:${destPath}`
      );
      return;
    }

    const moveRes = await ctx.transport.requestJson<{
      jobId: string;
      status: string;
      sourcePoolId: number;
      destPoolId: number;
      totalItems: number;
      completedItems: number;
      failedItems: number;
      skippedItems: number;
      totalBytes: number;
      transferredBytes: number;
      queued: boolean;
      lastError: string | null;
    }>('/api/transfers/cross-pool-move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourcePoolId: pool.id,
        destPoolId: destPool.id,
        items,
        ...(useDestDir ? { destDir: destPath } : { destPath }),
        conflictMode,
        wait,
      }),
    });

    emitSuccess(
      ctx,
      {
        action: 'cross_pool_move',
        sourcePoolSlug: pool.slug,
        destPoolSlug: destPool.slug,
        ...moveRes,
      },
      `Cross-pool move job ${moveRes.jobId} (${moveRes.status}): ${moveRes.completedItems}/${moveRes.totalItems} item(s), ${formatBytes(moveRes.transferredBytes)}${moveRes.queued ? ' [queued]' : ''}`
    );
    return;
  }

  const destStat = await statOptional(ctx, pool.id, destPath);

  if (srcStats.length === 1) {
    const srcStat = srcStats[0];
    const srcPath = srcPaths[0];
    const srcId = srcStat.item.id;
    if (!srcId) {
      throw new CliError('USAGE_ERROR', "Cannot move root directory '/'.", {
        exitCode: EXIT_CODES.USAGE,
      });
    }

    const srcParent = path.posix.dirname(srcPath);
    const destParent = path.posix.dirname(destPath);
    const destBasename = path.posix.basename(destPath);
    const srcBasename = path.posix.basename(srcPath);

    const isMoveIntoFolder = destPath === '/' || destStat?.kind === 'folder';
    const isSameParentRename = !isMoveIntoFolder && srcParent === destParent;

    if (isSameParentRename) {
      if (ctx.flags.dryRun) {
        emitSuccess(
          ctx,
          {
            dryRun: true,
            action: 'rename',
            poolId: pool.id,
            poolSlug: pool.slug,
            kind: srcStat.kind,
            oldPath: srcPath,
            newPath: destPath,
          },
          `[dry-run] rename ${pool.slug}:${srcPath} -> ${destPath}`
        );
        return;
      }

      const renamed = await ctx.transport.requestJson<{
        success: boolean;
        oldPath: string;
        newPath: string;
      }>('/api/items/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: srcStat.kind,
          id: srcId,
          name: destBasename,
          poolId: pool.id,
        }),
      });
      emitSuccess(
        ctx,
        { action: 'rename', poolId: pool.id, poolSlug: pool.slug, ...renamed },
        `Renamed ${pool.slug}:${renamed.oldPath} -> ${renamed.newPath}`
      );
      return;
    }

    const targetFolderPath = isMoveIntoFolder ? destPath : destParent;
    if (!isMoveIntoFolder && targetFolderPath !== '/') {
      const parentStat = await statOptional(ctx, pool.id, targetFolderPath);
      if (!parentStat || parentStat.kind !== 'folder') {
        throw new CliError(
          'NOT_FOUND',
          `Destination folder '${targetFolderPath}' not found in pool '${pool.slug}'.`,
          { exitCode: EXIT_CODES.NOT_FOUND }
        );
      }
    }

    const needsRenameAfterMove = !isMoveIntoFolder && destBasename !== srcBasename;
    if (ctx.flags.dryRun) {
      emitSuccess(
        ctx,
        {
          dryRun: true,
          action: 'move',
          poolId: pool.id,
          poolSlug: pool.slug,
          sources: srcPaths,
          targetFolderPath,
          renameTo: needsRenameAfterMove ? destBasename : null,
          conflictMode,
        },
        `[dry-run] mv ${pool.slug}:${srcPath} -> ${destPath}`
      );
      return;
    }

    const results = await ctx.transport.requestJson<
      Array<{ success?: boolean; skipped?: boolean; newPath?: string; name?: string }>
    >(
      '/api/items/move',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ kind: srcStat.kind, id: srcId }],
          targetFolderPath,
          poolId: pool.id,
          conflictMode,
        }),
      }
    );

    if (needsRenameAfterMove && !results[0]?.skipped) {
      const renamed = await ctx.transport.requestJson<{
        success: boolean;
        oldPath: string;
        newPath: string;
      }>('/api/items/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: srcStat.kind,
          id: srcId,
          name: destBasename,
          poolId: pool.id,
        }),
      });
      if (results[0]) {
        results[0] = {
          ...results[0],
          newPath: renamed.newPath ?? destPath,
          ...(results[0].name !== undefined ? { name: destBasename } : {}),
        };
      }
    }

    emitSuccess(
      ctx,
      { action: 'move', poolId: pool.id, poolSlug: pool.slug, targetFolderPath, results },
      `Moved ${pool.slug}:${srcPath} -> ${destPath}`
    );
    return;
  }

  if (destPath !== '/' && destStat?.kind !== 'folder') {
    throw new CliError(
      'USAGE_ERROR',
      `Destination '${destPath}' must be an existing folder when moving multiple items.`,
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  const items = srcStats.map((st) => ({
    kind: st.kind,
    id: st.item.id as string,
  }));

  if (ctx.flags.dryRun) {
    emitSuccess(
      ctx,
      {
        dryRun: true,
        action: 'move',
        poolId: pool.id,
        poolSlug: pool.slug,
        sources: srcPaths,
        targetFolderPath: destPath,
        conflictMode,
      },
      `[dry-run] mv ${srcPaths.length} item(s) -> ${pool.slug}:${destPath}`
    );
    return;
  }

  const results = await ctx.transport.requestJson<unknown[]>('/api/items/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items,
      targetFolderPath: destPath,
      poolId: pool.id,
      conflictMode,
    }),
  });

  emitSuccess(
    ctx,
    { action: 'move', poolId: pool.id, poolSlug: pool.slug, targetFolderPath: destPath, results },
    `Moved ${items.length} item(s) -> ${pool.slug}:${destPath}`
  );
}

export async function handleCp(ctx: CliContext, args: string[]): Promise<void> {
  let useStdin = false;
  const positionals: string[] = [];

  for (const token of args) {
    if (token === '--stdin') {
      useStdin = true;
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for cp.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  const stdinLines = useStdin ? await readStdinLines() : [];
  if (useStdin && positionals.length < 1) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa cp --stdin <dest>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }
  if (!useStdin && positionals.length < 2) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa cp <src...> <dest>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const destRaw = positionals[positionals.length - 1];
  const srcRaws = [...positionals.slice(0, -1), ...stdinLines];
  if (srcRaws.length === 0) {
    throw new CliError('USAGE_ERROR', 'At least one source path is required for cp.', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const { pool, paths: allPaths } = await resolveBatchTargets(ctx, [...srcRaws, destRaw]);
  const srcPaths = allPaths.slice(0, -1);
  const destPath = allPaths[allPaths.length - 1];

  for (const srcPath of srcPaths) {
    if (srcPath === '/') {
      throw new CliError('USAGE_ERROR', "Cannot copy root directory '/'.", {
        exitCode: EXIT_CODES.USAGE,
      });
    }
  }

  const srcStats = await Promise.all(srcPaths.map((p) => statRequired(ctx, pool.id, p)));
  const destStat = await statOptional(ctx, pool.id, destPath);

  let targetFolderPath = destPath;
  if (destPath !== '/' && destStat?.kind !== 'folder') {
    if (
      srcPaths.length === 1 &&
      !destStat &&
      path.posix.basename(destPath) === path.posix.basename(srcPaths[0])
    ) {
      const parentDir = path.posix.dirname(destPath);
      if (parentDir !== '/') {
        const parentStat = await statOptional(ctx, pool.id, parentDir);
        if (!parentStat || parentStat.kind !== 'folder') {
          throw new CliError(
            'NOT_FOUND',
            `Destination folder '${parentDir}' not found in pool '${pool.slug}'.`,
            { exitCode: EXIT_CODES.NOT_FOUND }
          );
        }
      }
      targetFolderPath = parentDir;
    } else {
      throw new CliError(
        'NOT_FOUND',
        `Destination folder '${destPath}' not found in pool '${pool.slug}'.`,
        { exitCode: EXIT_CODES.NOT_FOUND }
      );
    }
  }

  const items = srcStats.map((st) => ({
    kind: st.kind,
    id: st.item.id as string,
  }));

  if (ctx.flags.dryRun) {
    emitSuccess(
      ctx,
      {
        dryRun: true,
        action: 'copy',
        poolId: pool.id,
        poolSlug: pool.slug,
        sources: srcPaths,
        targetFolderPath,
      },
      `[dry-run] cp ${srcPaths.length} item(s) -> ${pool.slug}:${targetFolderPath}`
    );
    return;
  }

  const results = await ctx.transport.requestJson<unknown[]>('/api/items/copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items,
      targetFolderPath,
      poolId: pool.id,
    }),
  });

  emitSuccess(
    ctx,
    { action: 'copy', poolId: pool.id, poolSlug: pool.slug, targetFolderPath, results },
    `Copied ${items.length} item(s) -> ${pool.slug}:${targetFolderPath}`
  );
}

async function collectDescendantFileIds(
  ctx: CliContext,
  poolId: number,
  folderPath: string
): Promise<string[]> {
  const fileIds: string[] = [];
  let cursor: string | undefined;

  while (true) {
    const params = new URLSearchParams({
      poolId: String(poolId),
      path: folderPath,
      recursive: 'true',
      limit: '1000',
    });
    if (cursor) {
      params.set('afterPath', cursor);
    }
    const res = await ctx.transport.requestJson<FindResponse>(`/api/items/find?${params.toString()}`);
    for (const item of res.items) {
      if (item.kind === 'file') {
        fileIds.push(item.id);
      }
    }
    if (!res.hasMore || !res.nextCursor) {
      break;
    }
    cursor = res.nextCursor;
  }

  return fileIds;
}

export async function handleRm(ctx: CliContext, args: string[]): Promise<void> {
  let permanent = false;
  let useStdin = false;
  const positionals: string[] = [];

  for (const token of args) {
    if (token === '--permanent') {
      permanent = true;
      continue;
    }
    if (token === '--stdin') {
      useStdin = true;
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for rm.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  const stdinLines = useStdin ? await readStdinLines() : [];
  const rawPaths = [...positionals, ...stdinLines];
  if (rawPaths.length === 0) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa rm [--permanent] <paths...>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const resolvedTargets = await Promise.all(rawPaths.map((p) => resolveRemoteTarget(ctx, p)));
  for (const target of resolvedTargets) {
    if (target.path === '/') {
      throw new CliError('USAGE_ERROR', "Cannot remove root directory '/'.", {
        exitCode: EXIT_CODES.USAGE,
      });
    }
  }

  const resolvedStats = await Promise.all(
    resolvedTargets.map(async (target) => ({
      pool: target.pool,
      virtualPath: target.path,
      stat: await statRequired(ctx, target.pool.id, target.path),
    }))
  );

  if (ctx.flags.dryRun) {
    emitSuccess(
      ctx,
      {
        dryRun: true,
        permanent,
        targets: resolvedStats.map((t) => ({
          poolId: t.pool.id,
          poolSlug: t.pool.slug,
          kind: t.stat.kind,
          virtualPath: t.virtualPath,
        })),
      },
      `[dry-run] rm${permanent ? ' --permanent' : ''} ${resolvedStats.length} target(s)`
    );
    return;
  }

  if (permanent) {
    await requireConfirmation(
      ctx,
      `permanently delete ${resolvedStats.length} item(s)`
    );
  }

  const results: Array<{
    poolId: number;
    poolSlug: string;
    kind: 'file' | 'folder';
    virtualPath: string;
    permanent: boolean;
  }> = [];

  for (const target of resolvedStats) {
    if (target.stat.kind === 'file') {
      const fileId = target.stat.item.id;
      if (permanent) {
        await ctx.transport.requestJson(`/api/files/${encodeURIComponent(fileId)}/permanent`, {
          method: 'DELETE',
        });
      } else {
        await ctx.transport.requestJson(`/api/files/${encodeURIComponent(fileId)}/trash`, {
          method: 'POST',
        });
      }
    } else {
      const descendantFileIds = permanent
        ? await collectDescendantFileIds(ctx, target.pool.id, target.virtualPath)
        : [];
      await ctx.transport.requestJson(
        `/api/folders?poolId=${target.pool.id}&virtualPath=${encodeURIComponent(target.virtualPath)}`,
        { method: 'DELETE' }
      );
      for (const fileId of descendantFileIds) {
        await ctx.transport.requestJson(`/api/files/${encodeURIComponent(fileId)}/permanent`, {
          method: 'DELETE',
        });
      }
    }

    results.push({
      poolId: target.pool.id,
      poolSlug: target.pool.slug,
      kind: target.stat.kind,
      virtualPath: target.virtualPath,
      permanent,
    });
  }

  emitSuccess(
    ctx,
    { permanent, removed: results },
    `${permanent ? 'Permanently deleted' : 'Trashed'} ${results.length} item(s).`
  );
}
