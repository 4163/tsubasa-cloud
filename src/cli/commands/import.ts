import fs from 'node:fs';
import path from 'node:path';
import {
  emitSuccess,
  readFlagValue,
  resolveRemoteTarget,
  type CliContext,
  type PoolInfo,
} from '../context.js';
import { CliError, EXIT_CODES } from '../lib/errors.js';
import {
  formatBytes,
  formatStderrEvent,
  renderProgressBar,
  renderTable,
} from '../lib/format.js';
import { maskEmail, scrubEmailsInString, toAccountRef } from '../lib/redact.js';

type ImportDriveMode = 'copy' | 'stream';
type ImportDriveConflictMode = 'skip' | 'reject' | 'replace' | 'keep_both';
type ImportSkipReason =
  | 'skipped_workspace_doc'
  | 'skipped_shortcut'
  | 'skipped_not_copyable'
  | 'skipped_exceeds_ceiling'
  | 'skipped_conflict';

interface ImportDrivePlanSummary {
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

interface ImportDriveJobResult {
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

interface JobDetailResponse {
  job: {
    id: string;
    kind: string;
    status: string;
    poolId: number | null;
    totalItems: number;
    completedItems: number;
    failedItems: number;
    skippedItems: number;
    totalBytes: number;
    transferredBytes: number;
    pauseReason: string | null;
    lastError: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: number;
    updatedAt: number;
    completedAt: number | null;
  };
  itemSummary: Record<string, number>;
  activeShareCount: number;
}

interface CachedSourceTokenSummary {
  cacheKey: string;
  clientId: string;
  scopeMode: string;
  email: string | null;
  hasRefreshToken: boolean;
  expiryDate: number | null;
  tokenPath: string;
}

const VALID_MODES = new Set<ImportDriveMode>(['copy', 'stream']);
const VALID_CONFLICTS = new Set<ImportDriveConflictMode>([
  'skip',
  'reject',
  'replace',
  'keep_both',
]);
const ACTIVE_STATUSES = new Set(['pending', 'queued', 'running']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleTokensCommand(ctx: CliContext, args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!action) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa import tokens <list|clear>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (action === 'list') {
    if (rest.length > 0) {
      throw new CliError('USAGE_ERROR', `Unexpected argument '${rest[0]}' for import tokens list.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    const res = await ctx.transport.requestJson<{ tokens: CachedSourceTokenSummary[] }>(
      '/api/transfers/source-tokens'
    );
    const tokens = (res.tokens ?? []).map((t) => ({
      ...t,
      accountRef: t.email ? toAccountRef(t.email) : null,
    }));

    const table = renderTable(
      tokens,
      [
        { key: 'cacheKey', header: 'KEY' },
        {
          key: 'email',
          header: 'EMAIL',
          format: (r) => {
            if (!r.email) return '-';
            return ctx.flags.showEmails ? r.email : maskEmail(r.email);
          },
        },
        { key: 'scopeMode', header: 'SCOPE' },
        {
          key: 'hasRefreshToken',
          header: 'REFRESH',
          format: (r) => (r.hasRefreshToken ? 'yes' : 'no'),
        },
        { key: 'clientId', header: 'CLIENT ID' },
      ],
      { emptyMessage: 'No cached source OAuth tokens found.' }
    );

    emitSuccess(ctx, { tokens }, table);
    return;
  }

  if (action === 'clear') {
    let cacheKey: string | undefined;
    let email: string | undefined;
    let clientId: string | undefined;

    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (token === '--key') {
        cacheKey = readFlagValue(rest, i, '--key').trim();
        i += 1;
        continue;
      }
      if (token.startsWith('--key=')) {
        cacheKey = token.slice('--key='.length).trim();
        continue;
      }
      if (token === '--email') {
        email = readFlagValue(rest, i, '--email').trim();
        i += 1;
        continue;
      }
      if (token.startsWith('--email=')) {
        email = token.slice('--email='.length).trim();
        continue;
      }
      if (token === '--client-id') {
        clientId = readFlagValue(rest, i, '--client-id').trim();
        i += 1;
        continue;
      }
      if (token.startsWith('--client-id=')) {
        clientId = token.slice('--client-id='.length).trim();
        continue;
      }
      throw new CliError('USAGE_ERROR', `Unknown argument '${token}' for import tokens clear.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }

    if (ctx.flags.dryRun) {
      emitSuccess(
        ctx,
        { dryRun: true, action: 'import tokens clear', cacheKey: cacheKey ?? null, email: email ?? null, clientId: clientId ?? null },
        '[dry-run] clear cached source OAuth tokens'
      );
      return;
    }

    const params = new URLSearchParams();
    if (cacheKey) params.set('cacheKey', cacheKey);
    if (email) params.set('email', email);
    if (clientId) params.set('clientId', clientId);
    const qs = params.toString();

    const res = await ctx.transport.requestJson<{
      removedCount: number;
      deletedKeys: string[];
    }>(`/api/transfers/source-tokens${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });

    emitSuccess(ctx, res, `Cleared ${res.removedCount} cached source token(s).`);
    return;
  }

  throw new CliError(
    'USAGE_ERROR',
    `Unknown import tokens subcommand '${action}'. Expected list or clear.`,
    { exitCode: EXIT_CODES.USAGE }
  );
}

function renderPlanHuman(
  ctx: CliContext,
  pool: PoolInfo,
  plan: ImportDrivePlanSummary
): string {
  const sourceLabel = plan.sourceEmail
    ? ctx.flags.showEmails
      ? plan.sourceEmail
      : maskEmail(plan.sourceEmail)
    : '-';

  const lines = [
    `[dry-run] Import drive plan -> ${pool.slug}:${plan.destPath} (poolId=${pool.id})`,
    `Source:     folderId=${plan.sourceFolderId} (root=${plan.isRootTarget}) account=${sourceLabel}`,
    `Mode:       ${plan.mode} | Conflict: ${plan.conflictMode}`,
    `Discovered: ${plan.totalDiscovered} | Importable: ${plan.importableCount} (${formatBytes(plan.importableBytes)})`,
    `Strategy:   shareFolders=${plan.shareFolderCount}, rootLooseStream=${plan.rootLooseStreamCount}`,
    `Headroom:   ${formatBytes(plan.availablePoolHeadroomBytes)} (sufficient=${plan.hasSufficientHeadroom}) | 24h Budget: ${formatBytes(plan.availableDailyBudgetBytes)} (pauseExpected=${plan.dailyCapPauseExpected})`,
    `Skipped:    workspace_doc=${plan.skipCounts.skipped_workspace_doc} shortcut=${plan.skipCounts.skipped_shortcut} not_copyable=${plan.skipCounts.skipped_not_copyable} exceeds_ceiling=${plan.skipCounts.skipped_exceeds_ceiling} conflict=${plan.skipCounts.skipped_conflict}`,
  ];

  const table = renderTable(
    plan.items.map((it) => ({ ...it })),
    [
      { key: 'status', header: 'STATUS' },
      { key: 'effectiveMode', header: 'MODE' },
      { key: 'sizeBytes', header: 'SIZE', align: 'right', format: (r) => formatBytes(r.sizeBytes) },
      { key: 'destVirtualPath', header: 'DEST PATH' },
    ],
    { emptyMessage: 'No items discovered in source folder.' }
  );

  return `${lines.join('\n')}\n\n${table}`;
}

async function runImportDriveImpl(
  ctx: CliContext,
  args: string[],
  forceDryRun: boolean
): Promise<void> {
  let destRaw = '/';
  let sourceAuthRaw: string | undefined;
  let mode: ImportDriveMode = 'copy';
  let conflictMode: ImportDriveConflictMode = 'skip';
  let noBrowser = false;
  let detach = false;
  let clearSourceTokensFirst = false;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--dest') {
      destRaw = readFlagValue(args, i, '--dest');
      i += 1;
      continue;
    }
    if (token.startsWith('--dest=')) {
      destRaw = token.slice('--dest='.length).trim();
      continue;
    }
    if (token === '--source-auth') {
      sourceAuthRaw = readFlagValue(args, i, '--source-auth');
      i += 1;
      continue;
    }
    if (token.startsWith('--source-auth=')) {
      sourceAuthRaw = token.slice('--source-auth='.length).trim();
      continue;
    }
    if (token === '--mode') {
      const val = readFlagValue(args, i, '--mode').toLowerCase() as ImportDriveMode;
      if (!VALID_MODES.has(val)) {
        throw new CliError('USAGE_ERROR', "Flag --mode must be 'copy' or 'stream'.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      mode = val;
      i += 1;
      continue;
    }
    if (token.startsWith('--mode=')) {
      const val = token.slice('--mode='.length).toLowerCase() as ImportDriveMode;
      if (!VALID_MODES.has(val)) {
        throw new CliError('USAGE_ERROR', "Flag --mode must be 'copy' or 'stream'.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      mode = val;
      continue;
    }
    if (token === '--conflict') {
      const val = readFlagValue(args, i, '--conflict').toLowerCase() as ImportDriveConflictMode;
      if (!VALID_CONFLICTS.has(val)) {
        throw new CliError(
          'USAGE_ERROR',
          "Flag --conflict must be 'skip', 'reject', 'replace', or 'keep_both'.",
          { exitCode: EXIT_CODES.USAGE }
        );
      }
      conflictMode = val;
      i += 1;
      continue;
    }
    if (token.startsWith('--conflict=')) {
      const val = token.slice('--conflict='.length).toLowerCase() as ImportDriveConflictMode;
      if (!VALID_CONFLICTS.has(val)) {
        throw new CliError(
          'USAGE_ERROR',
          "Flag --conflict must be 'skip', 'reject', 'replace', or 'keep_both'.",
          { exitCode: EXIT_CODES.USAGE }
        );
      }
      conflictMode = val;
      continue;
    }
    if (token === '--no-browser') {
      noBrowser = true;
      continue;
    }
    if (token === '--detach') {
      detach = true;
      continue;
    }
    if (token === '--clear-source-tokens') {
      clearSourceTokensFirst = true;
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for import drive.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  if (clearSourceTokensFirst && positionals.length === 0 && !sourceAuthRaw) {
    const res = await ctx.transport.requestJson<{
      removedCount: number;
      deletedKeys: string[];
    }>('/api/transfers/source-tokens', { method: 'DELETE' });
    emitSuccess(ctx, res, `Cleared ${res.removedCount} cached source token(s).`);
    return;
  }

  if (positionals.length !== 1 || !sourceAuthRaw) {
    throw new CliError(
      'USAGE_ERROR',
      'Usage: tsubasa import drive <folderIdOrUrl> --dest <path> --source-auth <cred.json> [--mode copy|stream] [--conflict skip|reject|replace|keep_both] [--no-browser] [--detach]',
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  const folderIdOrUrl = positionals[0].trim();
  const sourceAuthPath = path.resolve(process.cwd(), sourceAuthRaw);
  if (!fs.existsSync(sourceAuthPath)) {
    throw new CliError('NOT_FOUND', `Source OAuth credential file not found: ${sourceAuthPath}`, {
      exitCode: EXIT_CODES.NOT_FOUND,
    });
  }

  const { pool, path: destPath } = await resolveRemoteTarget(ctx, destRaw);
  if (pool.isSharePool) {
    throw new CliError('SHARE_POOL_READ_ONLY', 'Importing directly into Share Pool is disabled.', {
      exitCode: EXIT_CODES.CONFLICT,
    });
  }

  if (ctx.transport.mode === 'local' && detach) {
    throw new CliError('USAGE_ERROR', 'Cannot use --detach in standalone --local mode.', {
      exitCode: EXIT_CODES.USAGE,
      hint: 'Start the Tsubasa server for detached background jobs, or omit --detach.',
    });
  }

  const dryRun = forceDryRun || ctx.flags.dryRun;

  if (clearSourceTokensFirst && !dryRun) {
    await ctx.transport.requestJson('/api/transfers/source-tokens', { method: 'DELETE' });
  }

  if (dryRun) {
    const plan = await ctx.transport.requestJson<ImportDrivePlanSummary>(
      '/api/transfers/import-drive/plan',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderIdOrUrl,
          destPath,
          poolId: pool.id,
          sourceAuthPath,
          mode,
          conflictMode,
          noBrowser,
        }),
      }
    );

    const safePlan = {
      ...plan,
      poolSlug: pool.slug,
      sourceEmail:
        plan.sourceEmail && !ctx.flags.showEmails ? maskEmail(plan.sourceEmail) : plan.sourceEmail,
    };
    emitSuccess(ctx, { dryRun: true, ...safePlan }, renderPlanHuman(ctx, pool, plan));
    return;
  }

  const waitInPlace = ctx.transport.mode === 'local';
  const started = await ctx.transport.requestJson<ImportDriveJobResult>(
    '/api/transfers/import-drive',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folderIdOrUrl,
        destPath,
        poolId: pool.id,
        sourceAuthPath,
        mode,
        conflictMode,
        noBrowser,
        detach: !waitInPlace,
        wait: waitInPlace,
      }),
    }
  );

  if (detach) {
    emitSuccess(
      ctx,
      { poolSlug: pool.slug, ...started },
      `Started import drive job ${started.jobId} (status=${started.status}, items=${started.totalItems}, bytes=${formatBytes(started.totalBytes)}).`
    );
    return;
  }

  let detail = await ctx.transport.requestJson<JobDetailResponse>(
    `/api/jobs/${encodeURIComponent(started.jobId)}`
  );

  while (!waitInPlace && ACTIVE_STATUSES.has(detail.job.status)) {
    if (!ctx.flags.quiet) {
      if (ctx.flags.json) {
        ctx.stderr.write(
          formatStderrEvent({
            event: 'import_progress',
            jobId: detail.job.id,
            status: detail.job.status,
            completedItems: detail.job.completedItems,
            totalItems: detail.job.totalItems,
            skippedItems: detail.job.skippedItems,
            failedItems: detail.job.failedItems,
            transferredBytes: detail.job.transferredBytes,
            totalBytes: detail.job.totalBytes,
          })
        );
      } else if (ctx.stderr.isTTY) {
        ctx.stderr.write(
          `\r${renderProgressBar({
            current: detail.job.transferredBytes,
            total: detail.job.totalBytes,
            label: `import:${detail.job.completedItems}/${detail.job.totalItems}`,
          })}`
        );
      }
    }

    await sleep(1000);
    detail = await ctx.transport.requestJson<JobDetailResponse>(
      `/api/jobs/${encodeURIComponent(started.jobId)}`
    );
  }

  if (!waitInPlace && !ctx.flags.quiet && !ctx.flags.json && ctx.stderr.isTTY) {
    ctx.stderr.write('\n');
  }

  const finalJob = detail.job;
  const safeLastError =
    finalJob.lastError && !ctx.flags.showEmails
      ? scrubEmailsInString(finalJob.lastError)
      : finalJob.lastError;
  const summary = {
    jobId: finalJob.id,
    status: finalJob.status,
    poolId: pool.id,
    poolSlug: pool.slug,
    destPath,
    totalItems: finalJob.totalItems,
    completedItems: finalJob.completedItems,
    skippedItems: finalJob.skippedItems,
    failedItems: finalJob.failedItems,
    totalBytes: finalJob.totalBytes,
    transferredBytes: finalJob.transferredBytes,
    pauseReason: finalJob.pauseReason,
    lastError: safeLastError,
    itemSummary: detail.itemSummary,
    activeShareCount: detail.activeShareCount,
  };

  if (finalJob.status === 'paused') {
    const message =
      safeLastError ?? `Import job ${finalJob.id} paused (${finalJob.pauseReason ?? 'DAILY_TRANSFER_CAP'}).`;
    throw new CliError(
      finalJob.pauseReason === 'DAILY_TRANSFER_CAP' ? 'TRANSFER_QUOTA_EXCEEDED' : 'CONFLICT',
      message,
      {
        exitCode:
          finalJob.pauseReason === 'DAILY_TRANSFER_CAP' ? EXIT_CODES.QUOTA : EXIT_CODES.CONFLICT,
        details: summary,
        hint: `Run "tsubasa job resume ${finalJob.id}" after the 24h transfer window resets.`,
      }
    );
  }

  if (finalJob.status === 'failed') {
    throw new CliError(
      'UPSTREAM_ERROR',
      safeLastError || `Import drive job ${finalJob.id} failed.`,
      {
        exitCode: EXIT_CODES.AUTH_UPSTREAM,
        details: summary,
      }
    );
  }

  emitSuccess(
    ctx,
    summary,
    `Import drive job ${finalJob.id} (${finalJob.status}): completed=${finalJob.completedItems}/${finalJob.totalItems}, skipped=${finalJob.skippedItems}, failed=${finalJob.failedItems}, transferred=${formatBytes(finalJob.transferredBytes)}.`
  );
}

export async function handleImport(ctx: CliContext, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa import <drive|tokens> ...', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  switch (subcommand) {
    case 'drive':
      return runImportDriveImpl(ctx, rest, false);
    case 'tokens':
      return handleTokensCommand(ctx, rest);
    default:
      throw new CliError(
        'USAGE_ERROR',
        `Unknown import subcommand '${subcommand}'. Expected drive or tokens.`,
        { exitCode: EXIT_CODES.USAGE }
      );
  }
}

export async function handlePlanImportDrive(ctx: CliContext, args: string[]): Promise<void> {
  return runImportDriveImpl(ctx, args, true);
}
