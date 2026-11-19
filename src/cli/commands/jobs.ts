import {
  emitSuccess,
  formatTimestamp,
  readFlagValue,
  type CliContext,
} from '../context.js';
import { CliError, EXIT_CODES } from '../lib/errors.js';
import {
  formatBytes,
  formatStderrEvent,
  renderProgressBar,
  renderTable,
} from '../lib/format.js';
import { maskEmail, scrubEmailsInString, toAccountRef } from '../lib/redact.js';
import { resumeLocalUploadJob } from './upload.js';

type JobRecord = {
  id: string;
  kind: string;
  status: string;
  source: 'persisted' | 'memory';
  poolId: number | null;
  sourcePoolId: number | null;
  accountId: string | null;
  conflictPolicy: string | null;
  mode: string | null;
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

interface JobDetailResponse {
  job: JobRecord;
  itemSummary: Record<string, number>;
  activeShareCount: number;
  items: Array<Record<string, unknown>>;
}

const ACTIVE_JOB_STATUSES = new Set(['pending', 'queued', 'running']);

function formatAccount(accountId: string | null, showEmails: boolean): string {
  if (!accountId) return '-';
  const ref = toAccountRef(accountId);
  return showEmails ? `${ref} (${accountId})` : `${ref} (${maskEmail(accountId)})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleJobList(ctx: CliContext, args: string[]): Promise<void> {
  let kind: string | undefined;
  let status: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--kind') {
      kind = readFlagValue(args, i, '--kind').trim();
      i += 1;
      continue;
    }
    if (token.startsWith('--kind=')) {
      kind = token.slice('--kind='.length).trim();
      continue;
    }
    if (token === '--status') {
      status = readFlagValue(args, i, '--status').trim();
      i += 1;
      continue;
    }
    if (token.startsWith('--status=')) {
      status = token.slice('--status='.length).trim();
      continue;
    }
    if (token === '--limit') {
      const parsed = Number(readFlagValue(args, i, '--limit'));
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 500) {
        throw new CliError('VALIDATION_ERROR', 'Flag --limit must be an integer between 1 and 500.', {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      limit = parsed;
      i += 1;
      continue;
    }
    if (token.startsWith('--limit=')) {
      const parsed = Number(token.slice('--limit='.length));
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 500) {
        throw new CliError('VALIDATION_ERROR', 'Flag --limit must be an integer between 1 and 500.', {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      limit = parsed;
      continue;
    }
    throw new CliError('USAGE_ERROR', `Unknown argument '${token}' for job list.`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (status) params.set('status', status);
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString();

  const res = await ctx.transport.requestJson<{ jobs: JobRecord[] }>(
    `/api/jobs${qs ? `?${qs}` : ''}`
  );
  const jobs = (res.jobs ?? []).map((j) => ({
    ...j,
    accountRef: j.accountId ? toAccountRef(j.accountId) : null,
  }));

  const table = renderTable(
    jobs,
    [
      { key: 'id', header: 'ID' },
      { key: 'kind', header: 'KIND' },
      { key: 'status', header: 'STATUS' },
      {
        key: 'completedItems',
        header: 'ITEMS',
        align: 'right',
        format: (r) => `${r.completedItems}/${r.totalItems}`,
      },
      {
        key: 'transferredBytes',
        header: 'BYTES',
        align: 'right',
        format: (r) => `${formatBytes(r.transferredBytes)}/${formatBytes(r.totalBytes)}`,
      },
      {
        key: 'accountRef',
        header: 'ACCOUNT',
        format: (r) => formatAccount(r.accountId, ctx.flags.showEmails),
      },
      { key: 'updatedAt', header: 'UPDATED', format: (r) => formatTimestamp(r.updatedAt) },
    ],
    { emptyMessage: 'No jobs found.' }
  );

  emitSuccess(ctx, { jobs }, table);
}

export async function handleJobStatus(ctx: CliContext, args: string[]): Promise<void> {
  let follow = false;
  const positionals: string[] = [];

  for (const token of args) {
    if (token === '--follow' || token === '-f') {
      follow = true;
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for job status.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  if (positionals.length !== 1) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa job status <job-id> [--follow]', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const jobId = positionals[0];
  let detail = await ctx.transport.requestJson<JobDetailResponse>(
    `/api/jobs/${encodeURIComponent(jobId)}`
  );

  while (follow && ACTIVE_JOB_STATUSES.has(detail.job.status)) {
    if (!ctx.flags.quiet) {
      if (ctx.flags.json) {
        ctx.stderr.write(
          formatStderrEvent({
            event: 'job_progress',
            jobId: detail.job.id,
            kind: detail.job.kind,
            status: detail.job.status,
            completedItems: detail.job.completedItems,
            totalItems: detail.job.totalItems,
            transferredBytes: detail.job.transferredBytes,
            totalBytes: detail.job.totalBytes,
          })
        );
      } else if (ctx.stderr.isTTY) {
        ctx.stderr.write(
          `\r${renderProgressBar({
            current: detail.job.transferredBytes,
            total: detail.job.totalBytes,
            label: `${detail.job.kind}:${detail.job.status}`,
          })}`
        );
      }
    }

    await sleep(1000);
    detail = await ctx.transport.requestJson<JobDetailResponse>(
      `/api/jobs/${encodeURIComponent(jobId)}`
    );
  }

  if (follow && !ctx.flags.quiet && !ctx.flags.json && ctx.stderr.isTTY) {
    ctx.stderr.write('\n');
  }

  const j = detail.job;
  const lines = [
    `Job ID:      ${j.id}`,
    `Kind:        ${j.kind} (${j.source})`,
    `Status:      ${j.status}`,
    `Pool:        ${j.poolId ?? '-'}`,
    `Source Pool: ${j.sourcePoolId ?? '-'}`,
    `Account:     ${formatAccount(j.accountId, ctx.flags.showEmails)}`,
    `Items:       ${j.completedItems}/${j.totalItems} completed, ${j.skippedItems} skipped, ${j.failedItems} failed`,
    `Bytes:       ${formatBytes(j.transferredBytes)} / ${formatBytes(j.totalBytes)}`,
    `Shares Open: ${detail.activeShareCount}`,
    `Created:     ${formatTimestamp(j.createdAt)}`,
    `Updated:     ${formatTimestamp(j.updatedAt)}`,
    `Completed:   ${formatTimestamp(j.completedAt)}`,
  ];
  if (j.pauseReason) {
    lines.push(`Pause:       ${j.pauseReason}`);
  }
  if (j.lastError) {
    lines.push(
      `Last Error:  ${ctx.flags.showEmails ? j.lastError : scrubEmailsInString(j.lastError)}`
    );
  }

  const redactStringField = (value: unknown): unknown =>
    typeof value === 'string' && value.length > 0 && !ctx.flags.showEmails
      ? maskEmail(value)
      : value;

  const redactedMetadata = j.metadata
    ? {
        ...j.metadata,
        ...(j.metadata.accountId !== undefined
          ? { accountId: redactStringField(j.metadata.accountId) }
          : {}),
        ...(j.metadata.sourceAccountId !== undefined
          ? {
              sourceAccountRef:
                typeof j.metadata.sourceAccountId === 'string'
                  ? toAccountRef(j.metadata.sourceAccountId)
                  : null,
              sourceAccountId: redactStringField(j.metadata.sourceAccountId),
            }
          : {}),
        ...(j.metadata.targetAccountId !== undefined
          ? {
              targetAccountRef:
                typeof j.metadata.targetAccountId === 'string'
                  ? toAccountRef(j.metadata.targetAccountId)
                  : null,
              targetAccountId: redactStringField(j.metadata.targetAccountId),
            }
          : {}),
        ...(j.metadata.sourceEmail !== undefined
          ? { sourceEmail: redactStringField(j.metadata.sourceEmail) }
          : {}),
      }
    : null;

  const redactedItems = (detail.items ?? []).map((item) => ({
    ...item,
    ...(typeof item.sourceAccountId === 'string'
      ? {
          sourceAccountRef: toAccountRef(item.sourceAccountId),
          sourceAccountId: redactStringField(item.sourceAccountId),
        }
      : {}),
    ...(typeof item.targetAccountId === 'string'
      ? {
          targetAccountRef: toAccountRef(item.targetAccountId),
          targetAccountId: redactStringField(item.targetAccountId),
        }
      : {}),
  }));

  emitSuccess(
    ctx,
    {
      ...detail,
      items: redactedItems,
      job: {
        ...j,
        accountRef: j.accountId ? toAccountRef(j.accountId) : null,
        metadata: redactedMetadata,
      },
    },
    lines.join('\n')
  );
}

export async function handleJobResume(ctx: CliContext, args: string[]): Promise<void> {
  let wait = true;
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
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for job resume.`, {
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

  if (positionals.length !== 1) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa job resume <job-id> [--detach]', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const jobId = positionals[0];
  const detail = await ctx.transport.requestJson<JobDetailResponse>(
    `/api/jobs/${encodeURIComponent(jobId)}`
  );

  if (ctx.flags.dryRun) {
    emitSuccess(
      ctx,
      {
        dryRun: true,
        action: 'job resume',
        jobId,
        kind: detail.job.kind,
        status: detail.job.status,
      },
      `[dry-run] resume ${detail.job.kind} job ${jobId} (status=${detail.job.status})`
    );
    return;
  }

  if (detail.job.kind === 'upload' && typeof detail.job.metadata?.localPath === 'string') {
    const resumed = await resumeLocalUploadJob(ctx, jobId);
    emitSuccess(ctx, resumed, `Resumed upload job ${jobId}: status=${String(resumed.status)}`);
    return;
  }

  const res = await ctx.transport.requestJson<Record<string, unknown>>(
    `/api/jobs/${encodeURIComponent(jobId)}/resume`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wait }),
    }
  );

  const sanitizedRes: Record<string, unknown> = {
    ...res,
    ...(typeof res.sourceAccountId === 'string'
      ? {
          accountRef: toAccountRef(res.sourceAccountId),
          sourceAccountId: ctx.flags.showEmails ? res.sourceAccountId : maskEmail(res.sourceAccountId),
        }
      : {}),
  };

  emitSuccess(
    ctx,
    sanitizedRes,
    `Job ${jobId} resume: status=${String(res.status ?? 'ok')}${res.queued ? ' (queued)' : ''}`
  );
}

export async function handleJobCancel(ctx: CliContext, args: string[]): Promise<void> {
  const positionals: string[] = [];
  for (const token of args) {
    if (token.startsWith('-')) {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for job cancel.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  if (positionals.length !== 1) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa job cancel <job-id>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const jobId = positionals[0];
  if (ctx.flags.dryRun) {
    const detail = await ctx.transport.requestJson<JobDetailResponse>(
      `/api/jobs/${encodeURIComponent(jobId)}`
    );
    emitSuccess(
      ctx,
      { dryRun: true, action: 'job cancel', jobId, kind: detail.job.kind, status: detail.job.status },
      `[dry-run] cancel ${detail.job.kind} job ${jobId} (status=${detail.job.status})`
    );
    return;
  }

  const res = await ctx.transport.requestJson<Record<string, unknown>>(
    `/api/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: 'POST' }
  );
  emitSuccess(ctx, res, `Cancelled job ${jobId}.`);
}

export async function handleJob(ctx: CliContext, args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa job <list|status|resume|cancel>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  switch (subcommand) {
    case 'list':
      return handleJobList(ctx, rest);
    case 'status':
      return handleJobStatus(ctx, rest);
    case 'resume':
      return handleJobResume(ctx, rest);
    case 'cancel':
      return handleJobCancel(ctx, rest);
    default:
      throw new CliError(
        'USAGE_ERROR',
        `Unknown job subcommand '${subcommand}'. Expected list, status, resume, or cancel.`,
        { exitCode: EXIT_CODES.USAGE }
      );
  }
}
