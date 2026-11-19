import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  emitSuccess,
  resolvePoolArg,
  type CliContext,
  type PoolInfo,
} from '../context.js';
import {
  buildContentRangeHeader,
  DEFAULT_CHUNK_SIZE_BYTES,
  SMALL_UPLOAD_FAST_PATH_BYTES,
  validateTransferMemoryBudget,
} from '../lib/chunks.js';
import { CliError, EXIT_CODES } from '../lib/errors.js';
import {
  formatBytes,
  formatStderrEvent,
  renderProgressBar,
  renderTable,
} from '../lib/format.js';
import { maskEmail, toAccountRef } from '../lib/redact.js';
import { parseRemoteSelector } from '../lib/selectors.js';

type UploadConflictPolicy = 'reject' | 'replace' | 'keep_both' | 'skip';

interface UploadPlanDecision {
  relativePath: string;
  virtualPath: string;
  sizeBytes: number;
  status:
    | 'ok'
    | 'skip'
    | 'reject_ceiling'
    | 'reject_headroom'
    | 'reject_quota_24h'
    | 'conflict';
  accountId: string | null;
  reason: string;
  existingFileId?: string;
  existingSizeBytes?: number;
  headroomBeforeBytes?: number;
  headroomAfterBytes?: number;
}

interface UploadPlanSummary {
  poolId: number;
  canProceed: boolean;
  totalFiles: number;
  plannedFiles: number;
  skippedFiles: number;
  rejectedFiles: number;
  conflictFiles: number;
  totalBytes: number;
  plannedBytes: number;
  replacedBytes: number;
  netStorageDeltaBytes: number;
  accountAllocations: Record<string, { filesCount: number; bytesAllocated: number }>;
  items: UploadPlanDecision[];
}

interface InitUploadResponse {
  skipped: boolean;
  reason?: string;
  existingFileId?: string;
  jobId?: string;
  itemId?: string;
  fileId?: string;
  status?: string;
  accountId?: string;
  poolId: number;
  virtualPath: string;
  chunkSizeBytes?: number;
  offsetBytes?: number;
  totalBytes?: number;
}

interface ProbeUploadResponse {
  jobId: string;
  status: 'running' | 'completed';
  offsetBytes: number;
  totalBytes: number;
  sessionRestarted: boolean;
  accountId: string;
  poolId: number;
  virtualPath: string;
  chunkSizeBytes: number;
  file?: Record<string, unknown>;
}

interface ChunkUploadResponse {
  jobId: string;
  status: 'running' | 'completed';
  completed: boolean;
  offsetBytes: number;
  totalBytes: number;
  file?: Record<string, unknown>;
}

interface JobDetailResponse {
  job: {
    id: string;
    kind: string;
    status: string;
    poolId: number | null;
    totalBytes: number;
    transferredBytes: number;
    metadata: Record<string, unknown> | null;
  };
}

interface LocalUploadCandidate {
  localPath: string;
  relativePath: string;
  virtualPath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface UploadFileResult {
  virtualPath: string;
  localPath: string | null;
  sizeBytes: number;
  status: 'uploaded' | 'skipped';
  fileId: string | null;
  jobId: string | null;
  accountId: string | null;
  accountRef: string | null;
  fastPath: boolean;
}

const VALID_CONFLICTS = new Set<UploadConflictPolicy>([
  'reject',
  'replace',
  'keep_both',
  'skip',
]);

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const next = args[index + 1];
  if (next === undefined || next.startsWith('-')) {
    throw new CliError('USAGE_ERROR', `Flag ${flag} requires a value.`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }
  return next;
}

function parseByteSizeFlag(raw: string, flagName: string): number {
  const trimmed = raw.trim();
  const match = /^(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib)?$/i.exec(trimmed);
  if (!match) {
    throw new CliError('USAGE_ERROR', `Invalid byte size '${raw}' for ${flagName}.`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }
  const num = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const mult =
    unit === 'b'
      ? 1
      : unit === 'k' || unit === 'kb' || unit === 'kib'
        ? 1024
        : unit === 'm' || unit === 'mb' || unit === 'mib'
          ? 1024 * 1024
          : 1024 * 1024 * 1024;
  const bytes = Math.round(num * mult);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new CliError('USAGE_ERROR', `Invalid byte size '${raw}' for ${flagName}.`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }
  return bytes;
}

function normalizePosixPath(rawPath: string): string {
  const cleaned = rawPath.replace(/\\/g, '/').trim();
  if (!cleaned || cleaned === '.') return '/';
  const normalized = path.posix.normalize(cleaned.startsWith('/') ? cleaned : `/${cleaned}`);
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

async function resolveRemoteTarget(
  ctx: CliContext,
  rawPath: string
): Promise<{ pool: PoolInfo; virtualPath: string }> {
  const parsed = parseRemoteSelector(rawPath);
  if (parsed.isRemote && parsed.pool && ctx.flags.pool) {
    const [prefixPool, flagPool] = await Promise.all([
      resolvePoolArg(ctx, parsed.pool),
      resolvePoolArg(ctx, ctx.flags.pool),
    ]);
    if (prefixPool.id !== flagPool.id) {
      throw new CliError(
        'USAGE_ERROR',
        `Conflicting pool selectors: target specifies '${parsed.pool}' while --pool specifies '${ctx.flags.pool}'.`,
        { exitCode: EXIT_CODES.USAGE }
      );
    }
    return { pool: prefixPool, virtualPath: normalizePosixPath(parsed.path) };
  }
  const pool = await resolvePoolArg(ctx, parsed.isRemote ? parsed.pool : undefined);
  return { pool, virtualPath: normalizePosixPath(parsed.path) };
}

async function statRemoteOptional(
  ctx: CliContext,
  poolId: number,
  virtualPath: string
): Promise<{ kind: 'file' | 'folder'; item: { id: string | null } } | null> {
  try {
    return await ctx.transport.requestJson<{
      kind: 'file' | 'folder';
      item: { id: string | null };
    }>(`/api/items/stat?poolId=${poolId}&path=${encodeURIComponent(virtualPath)}`);
  } catch (err) {
    if (err instanceof CliError && err.exitCode === EXIT_CODES.NOT_FOUND) {
      return null;
    }
    throw err;
  }
}

function collectLocalFiles(
  localPath: string,
  destVirtualBase: string,
  destIsExplicitFolder: boolean,
  recursive: boolean
): LocalUploadCandidate[] {
  const resolved = path.resolve(process.cwd(), localPath);
  if (!fs.existsSync(resolved)) {
    throw new CliError('NOT_FOUND', `Local path not found: ${resolved}`, {
      exitCode: EXIT_CODES.NOT_FOUND,
    });
  }

  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    const fileName = path.basename(resolved);
    const virtualPath =
      destVirtualBase === '/'
        ? `/${fileName}`
        : destIsExplicitFolder
          ? normalizePosixPath(path.posix.join(destVirtualBase, fileName))
          : destVirtualBase;
    return [
      {
        localPath: resolved,
        relativePath: fileName,
        virtualPath,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      },
    ];
  }

  if (!stat.isDirectory()) {
    throw new CliError('USAGE_ERROR', `Unsupported local path type: ${resolved}`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (!recursive) {
    throw new CliError(
      'USAGE_ERROR',
      `'${localPath}' is a directory; pass -r / --recursive to upload directories.`,
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  const results: LocalUploadCandidate[] = [];
  const rootName = path.basename(resolved);
  const remoteBase =
    destVirtualBase === '/'
      ? `/${rootName}`
      : destIsExplicitFolder
        ? normalizePosixPath(path.posix.join(destVirtualBase, rootName))
        : destVirtualBase;

  const walk = (dirPath: string, relDir: string): void => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const nextRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, nextRel);
      } else if (entry.isFile()) {
        const fileStat = fs.statSync(fullPath);
        results.push({
          localPath: fullPath,
          relativePath: nextRel,
          virtualPath: normalizePosixPath(path.posix.join(remoteBase, nextRel)),
          sizeBytes: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
        });
      }
    }
  };

  walk(resolved, '');
  return results;
}

function emitUploadProgress(
  ctx: CliContext,
  opts: {
    jobId: string | null;
    virtualPath: string;
    label: string;
    currentBytes: number;
    totalBytes: number;
    speedBytesPerSec: number;
    done?: boolean;
  }
): void {
  if (ctx.flags.quiet) {
    return;
  }
  if (ctx.flags.json) {
    ctx.stderr.write(
      formatStderrEvent({
        event: opts.done ? 'upload_complete' : 'upload_progress',
        jobId: opts.jobId,
        virtualPath: opts.virtualPath,
        currentBytes: opts.currentBytes,
        totalBytes: opts.totalBytes,
        speedBytesPerSec: Math.round(opts.speedBytesPerSec),
      })
    );
    return;
  }
  if (ctx.stderr.isTTY) {
    const bar = renderProgressBar({
      current: opts.currentBytes,
      total: opts.totalBytes,
      label: opts.label,
      speedBytesPerSec: opts.speedBytesPerSec,
    });
    ctx.stderr.write(`\r${bar}${opts.done ? '\n' : ''}`);
  } else if (opts.done) {
    ctx.stderr.write(
      `${opts.label}: ${formatBytes(opts.currentBytes)} (${Math.round(opts.speedBytesPerSec)} B/s)\n`
    );
  }
}

async function readLocalRange(
  filePath: string,
  start: number,
  length: number
): Promise<Buffer> {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let totalRead = 0;
    while (totalRead < length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalRead,
        length - totalRead,
        start + totalRead
      );
      if (bytesRead === 0) {
        break;
      }
      totalRead += bytesRead;
    }
    return totalRead === length ? buffer : buffer.subarray(0, totalRead);
  } finally {
    await handle.close();
  }
}

async function hashLocalFilePrefix(
  filePath: string,
  endExclusive: number
): Promise<ReturnType<typeof createHash>> {
  const hasher = createHash('md5');
  if (endExclusive <= 0) {
    return hasher;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath, {
      start: 0,
      end: endExclusive - 1,
    });
    stream.on('data', (chunk) => hasher.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hasher;
}

async function uploadSmallLocalFile(
  ctx: CliContext,
  poolId: number,
  candidate: LocalUploadCandidate,
  conflictMode: UploadConflictPolicy
): Promise<UploadFileResult> {
  if (conflictMode === 'skip') {
    const existing = await statRemoteOptional(ctx, poolId, candidate.virtualPath);
    if (existing && existing.kind === 'file') {
      return {
        virtualPath: candidate.virtualPath,
        localPath: candidate.localPath,
        sizeBytes: candidate.sizeBytes,
        status: 'skipped',
        fileId: existing.item.id,
        jobId: null,
        accountId: null,
        accountRef: null,
        fastPath: true,
      };
    }
  }

  const effectiveConflict = conflictMode === 'skip' ? 'reject' : conflictMode;
  const startedAt = Date.now();

  const bodyStream =
    candidate.sizeBytes === 0
      ? null
      : (Readable.toWeb(fs.createReadStream(candidate.localPath)) as ReadableStream<Uint8Array>);

  const params = new URLSearchParams({
    virtualPath: candidate.virtualPath,
    sizeBytes: String(candidate.sizeBytes),
    poolId: String(poolId),
    conflictMode: effectiveConflict,
  });

  const init: RequestInit & { duplex?: string } = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    ...(bodyStream ? { body: bodyStream as NonNullable<RequestInit['body']>, duplex: 'half' } : {}),
  };

  const saved = await ctx.transport.requestJson<{
    id: string;
    virtualPath: string;
    accountId: string;
    sizeBytes: number;
  }>(`/api/files/upload?${params.toString()}`, init);

  const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
  emitUploadProgress(ctx, {
    jobId: null,
    virtualPath: saved.virtualPath,
    label: path.basename(candidate.localPath),
    currentBytes: saved.sizeBytes,
    totalBytes: saved.sizeBytes,
    speedBytesPerSec: saved.sizeBytes / elapsedSec,
    done: true,
  });

  return {
    virtualPath: saved.virtualPath,
    localPath: candidate.localPath,
    sizeBytes: saved.sizeBytes,
    status: 'uploaded',
    fileId: saved.id,
    jobId: null,
    accountId: saved.accountId,
    accountRef: toAccountRef(saved.accountId),
    fastPath: true,
  };
}

async function streamLocalChunksForJob(
  ctx: CliContext,
  opts: {
    jobId: string;
    localPath: string;
    virtualPath: string;
    totalBytes: number;
    chunkSizeBytes: number;
    initialOffset: number;
  }
): Promise<ChunkUploadResponse> {
  let offset = opts.initialOffset;
  let restartedOnce = false;

  while (true) {
    const hasher = await hashLocalFilePrefix(opts.localPath, offset);
    const startedAt = Date.now();
    const startOffset = offset;
    let lastProgressAt = 0;

    if (opts.totalBytes === 0) {
      const emptyHash = hasher.digest('hex').toLowerCase();
      return ctx.transport.requestJson<ChunkUploadResponse>(
        `/api/transfers/${encodeURIComponent(opts.jobId)}/chunk`,
        {
          method: 'PUT',
          headers: {
            'Content-Range': 'bytes 0-0/0',
            'X-Tsubasa-Local-Md5': emptyHash,
          },
        }
      );
    }

    let current = offset;
    let needRestart = false;
    let finalRes: ChunkUploadResponse | null = null;

    while (current < opts.totalBytes) {
      const size = Math.min(opts.chunkSizeBytes, opts.totalBytes - current);
      const end = current + size - 1;
      const chunkBuf = await readLocalRange(opts.localPath, current, size);
      if (chunkBuf.byteLength !== size) {
        throw new CliError(
          'LOCAL_FILE_CHANGED',
          `Local file '${opts.localPath}' shrank unexpectedly during upload.`,
          { exitCode: EXIT_CODES.CONFLICT }
        );
      }

      hasher.update(chunkBuf);
      const isFinalChunk = end + 1 === opts.totalBytes;
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Range': buildContentRangeHeader(current, end, opts.totalBytes),
      };
      if (isFinalChunk) {
        headers['X-Tsubasa-Local-Md5'] = hasher.digest('hex').toLowerCase();
      }

      try {
        const res = await ctx.transport.requestJson<ChunkUploadResponse>(
          `/api/transfers/${encodeURIComponent(opts.jobId)}/chunk`,
          {
            method: 'PUT',
            headers,
            body: new Uint8Array(chunkBuf),
          }
        );

        current = res.offsetBytes;
        const now = Date.now();
        if (res.completed || now - lastProgressAt >= 150) {
          const elapsedSec = Math.max(0.001, (now - startedAt) / 1000);
          emitUploadProgress(ctx, {
            jobId: opts.jobId,
            virtualPath: opts.virtualPath,
            label: path.basename(opts.localPath),
            currentBytes: current,
            totalBytes: opts.totalBytes,
            speedBytesPerSec: (current - startOffset) / elapsedSec,
            done: res.completed,
          });
          lastProgressAt = now;
        }

        if (res.completed) {
          finalRes = res;
          break;
        }
      } catch (err) {
        if (err instanceof CliError && err.code === 'UPLOAD_SESSION_EXPIRED' && !restartedOnce) {
          restartedOnce = true;
          const stats = fs.statSync(opts.localPath);
          const probe = await ctx.transport.requestJson<ProbeUploadResponse>(
            `/api/transfers/${encodeURIComponent(opts.jobId)}/probe?sizeBytes=${stats.size}&mtimeMs=${Math.round(stats.mtimeMs)}`
          );
          if (probe.status === 'completed') {
            return {
              jobId: probe.jobId,
              status: 'completed',
              completed: true,
              offsetBytes: probe.totalBytes,
              totalBytes: probe.totalBytes,
              file: probe.file,
            };
          }
          offset = probe.offsetBytes;
          needRestart = true;
          break;
        }
        throw err;
      }
    }

    if (needRestart) {
      continue;
    }

    if (!finalRes) {
      throw new CliError('RUNTIME_ERROR', `Upload job '${opts.jobId}' did not finish cleanly.`, {
        exitCode: EXIT_CODES.RUNTIME,
      });
    }
    return finalRes;
  }
}

export async function resumeLocalUploadJob(
  ctx: CliContext,
  jobId: string
): Promise<Record<string, unknown>> {
  const detail = await ctx.transport.requestJson<JobDetailResponse>(
    `/api/jobs/${encodeURIComponent(jobId)}`
  );
  const job = detail.job;
  if (job.kind !== 'upload') {
    throw new CliError('USAGE_ERROR', `Job '${jobId}' is '${job.kind}', not an upload job.`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const localPath = typeof job.metadata?.localPath === 'string' ? job.metadata.localPath : null;
  if (!localPath) {
    throw new CliError(
      'USAGE_ERROR',
      `Upload job '${jobId}' has no localPath (stdin uploads cannot be resumed).`,
      { exitCode: EXIT_CODES.USAGE }
    );
  }
  if (!fs.existsSync(localPath)) {
    throw new CliError('NOT_FOUND', `Local source file no longer exists: ${localPath}`, {
      exitCode: EXIT_CODES.NOT_FOUND,
    });
  }

  const stats = fs.statSync(localPath);
  const probe = await ctx.transport.requestJson<ProbeUploadResponse>(
    `/api/transfers/${encodeURIComponent(jobId)}/probe?sizeBytes=${stats.size}&mtimeMs=${Math.round(stats.mtimeMs)}`
  );

  if (probe.status === 'completed') {
    return {
      jobId: probe.jobId,
      status: 'completed',
      virtualPath: probe.virtualPath,
      totalBytes: probe.totalBytes,
      offsetBytes: probe.totalBytes,
      alreadyCompleted: true,
      file: probe.file ?? null,
    };
  }

  const chunkResult = await streamLocalChunksForJob(ctx, {
    jobId: probe.jobId,
    localPath,
    virtualPath: probe.virtualPath,
    totalBytes: probe.totalBytes,
    chunkSizeBytes: probe.chunkSizeBytes || DEFAULT_CHUNK_SIZE_BYTES,
    initialOffset: probe.offsetBytes,
  });

  return {
    jobId: chunkResult.jobId,
    status: chunkResult.status,
    virtualPath: probe.virtualPath,
    totalBytes: chunkResult.totalBytes,
    offsetBytes: chunkResult.offsetBytes,
    sessionRestarted: probe.sessionRestarted,
    accountId: probe.accountId,
    accountRef: toAccountRef(probe.accountId),
    file: chunkResult.file ?? null,
  };
}

async function uploadResumableLocalFile(
  ctx: CliContext,
  poolId: number,
  candidate: LocalUploadCandidate,
  conflictMode: UploadConflictPolicy,
  chunkSizeBytes: number
): Promise<UploadFileResult> {
  const initRes = await ctx.transport.requestJson<InitUploadResponse>('/api/transfers/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      virtualPath: candidate.virtualPath,
      sizeBytes: candidate.sizeBytes,
      poolId,
      localPath: candidate.localPath,
      mtimeMs: candidate.mtimeMs,
      chunkSizeBytes,
      conflictMode,
    }),
  });

  if (initRes.skipped) {
    return {
      virtualPath: initRes.virtualPath,
      localPath: candidate.localPath,
      sizeBytes: candidate.sizeBytes,
      status: 'skipped',
      fileId: initRes.existingFileId ?? null,
      jobId: null,
      accountId: null,
      accountRef: null,
      fastPath: false,
    };
  }

  const jobId = initRes.jobId as string;
  const chunkRes = await streamLocalChunksForJob(ctx, {
    jobId,
    localPath: candidate.localPath,
    virtualPath: initRes.virtualPath,
    totalBytes: candidate.sizeBytes,
    chunkSizeBytes: initRes.chunkSizeBytes ?? chunkSizeBytes,
    initialOffset: initRes.offsetBytes ?? 0,
  });

  const fileObj = chunkRes.file as { id?: string; virtualPath?: string; accountId?: string } | undefined;
  const accountId = fileObj?.accountId ?? initRes.accountId ?? null;
  return {
    virtualPath: fileObj?.virtualPath ?? initRes.virtualPath,
    localPath: candidate.localPath,
    sizeBytes: candidate.sizeBytes,
    status: 'uploaded',
    fileId: fileObj?.id ?? initRes.fileId ?? null,
    jobId,
    accountId,
    accountRef: accountId ? toAccountRef(accountId) : null,
    fastPath: false,
  };
}

async function uploadFromStdin(
  ctx: CliContext,
  poolId: number,
  virtualPath: string,
  sizeBytes: number,
  conflictMode: UploadConflictPolicy,
  chunkSizeBytes: number
): Promise<UploadFileResult> {
  if (sizeBytes <= SMALL_UPLOAD_FAST_PATH_BYTES) {
    if (conflictMode === 'skip') {
      const existing = await statRemoteOptional(ctx, poolId, virtualPath);
      if (existing && existing.kind === 'file') {
        return {
          virtualPath,
          localPath: null,
          sizeBytes,
          status: 'skipped',
          fileId: existing.item.id,
          jobId: null,
          accountId: null,
          accountRef: null,
          fastPath: true,
        };
      }
    }

    const effectiveConflict = conflictMode === 'skip' ? 'reject' : conflictMode;
    const params = new URLSearchParams({
      virtualPath,
      sizeBytes: String(sizeBytes),
      poolId: String(poolId),
      conflictMode: effectiveConflict,
    });
    const bodyStream =
      sizeBytes === 0
        ? null
        : (Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);

    const saved = await ctx.transport.requestJson<{
      id: string;
      virtualPath: string;
      accountId: string;
      sizeBytes: number;
    }>(`/api/files/upload?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      ...(bodyStream ? { body: bodyStream as NonNullable<RequestInit['body']>, duplex: 'half' } : {}),
    } as RequestInit);

    return {
      virtualPath: saved.virtualPath,
      localPath: null,
      sizeBytes: saved.sizeBytes,
      status: 'uploaded',
      fileId: saved.id,
      jobId: null,
      accountId: saved.accountId,
      accountRef: toAccountRef(saved.accountId),
      fastPath: true,
    };
  }

  const initRes = await ctx.transport.requestJson<InitUploadResponse>('/api/transfers/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      virtualPath,
      sizeBytes,
      poolId,
      chunkSizeBytes,
      conflictMode,
    }),
  });

  if (initRes.skipped) {
    return {
      virtualPath: initRes.virtualPath,
      localPath: null,
      sizeBytes,
      status: 'skipped',
      fileId: initRes.existingFileId ?? null,
      jobId: null,
      accountId: null,
      accountRef: null,
      fastPath: false,
    };
  }

  const jobId = initRes.jobId as string;
  const effectiveChunk = initRes.chunkSizeBytes ?? chunkSizeBytes;
  const hasher = createHash('md5');
  const pendingBuffers: Buffer[] = [];
  let pendingLen = 0;
  let sentBytes = 0;
  const startedAt = Date.now();

  const flushChunk = async (buf: Buffer, isFinal: boolean): Promise<ChunkUploadResponse> => {
    hasher.update(buf);
    const start = sentBytes;
    const end = start + buf.byteLength - 1;
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Range': buildContentRangeHeader(start, end, sizeBytes),
    };
    if (isFinal) {
      headers['X-Tsubasa-Local-Md5'] = hasher.digest('hex').toLowerCase();
    }
    const res = await ctx.transport.requestJson<ChunkUploadResponse>(
      `/api/transfers/${encodeURIComponent(jobId)}/chunk`,
      {
        method: 'PUT',
        headers,
        body: new Uint8Array(buf),
      }
    );
    sentBytes = res.offsetBytes;
    const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
    emitUploadProgress(ctx, {
      jobId,
      virtualPath: initRes.virtualPath,
      label: path.posix.basename(virtualPath),
      currentBytes: sentBytes,
      totalBytes: sizeBytes,
      speedBytesPerSec: sentBytes / elapsedSec,
      done: res.completed,
    });
    return res;
  };

  for await (const rawChunk of process.stdin) {
    const buf = typeof rawChunk === 'string' ? Buffer.from(rawChunk) : rawChunk;
    if (buf.byteLength === 0) continue;
    pendingBuffers.push(buf);
    pendingLen += buf.byteLength;

    while (pendingLen >= effectiveChunk && sentBytes + effectiveChunk < sizeBytes) {
      const combined = Buffer.concat(pendingBuffers);
      const slice = combined.subarray(0, effectiveChunk);
      const rest = combined.subarray(effectiveChunk);
      pendingBuffers.length = 0;
      if (rest.byteLength > 0) {
        pendingBuffers.push(rest);
      }
      pendingLen = rest.byteLength;
      await flushChunk(slice, false);
    }
  }

  const remaining = pendingBuffers.length > 0 ? Buffer.concat(pendingBuffers) : Buffer.alloc(0);
  if (sentBytes + remaining.byteLength !== sizeBytes) {
    throw new CliError(
      'VALIDATION_ERROR',
      `Stdin stream ended at ${sentBytes + remaining.byteLength} bytes, expected --size ${sizeBytes}.`,
      { exitCode: EXIT_CODES.USAGE }
    );
  }
  const finalRes = await flushChunk(remaining, true);

  const fileObj = finalRes.file as { id?: string; virtualPath?: string; accountId?: string } | undefined;
  const accountId = fileObj?.accountId ?? initRes.accountId ?? null;
  return {
    virtualPath: fileObj?.virtualPath ?? initRes.virtualPath,
    localPath: null,
    sizeBytes,
    status: 'uploaded',
    fileId: fileObj?.id ?? initRes.fileId ?? null,
    jobId,
    accountId,
    accountRef: accountId ? toAccountRef(accountId) : null,
    fastPath: false,
  };
}

function formatPlanPayload(
  ctx: CliContext,
  pool: PoolInfo,
  summary: UploadPlanSummary
): Record<string, unknown> {
  const allocations: Record<string, { accountRef: string; filesCount: number; bytesAllocated: number }> = {};
  for (const [accId, stats] of Object.entries(summary.accountAllocations)) {
    const ref = toAccountRef(accId);
    const key = ctx.flags.showEmails ? accId : ref;
    allocations[key] = {
      accountRef: ref,
      filesCount: stats.filesCount,
      bytesAllocated: stats.bytesAllocated,
    };
  }

  return {
    dryRun: true,
    poolId: pool.id,
    poolSlug: pool.slug,
    canProceed: summary.canProceed,
    totalFiles: summary.totalFiles,
    plannedFiles: summary.plannedFiles,
    skippedFiles: summary.skippedFiles,
    rejectedFiles: summary.rejectedFiles,
    conflictFiles: summary.conflictFiles,
    totalBytes: summary.totalBytes,
    plannedBytes: summary.plannedBytes,
    replacedBytes: summary.replacedBytes,
    netStorageDeltaBytes: summary.netStorageDeltaBytes,
    accountAllocations: allocations,
    items: summary.items,
  };
}

function renderPlanHuman(ctx: CliContext, pool: PoolInfo, summary: UploadPlanSummary): string {
  const header = [
    `[dry-run] Upload plan for pool '${pool.slug}' (id=${pool.id}): ${summary.canProceed ? 'READY' : 'BLOCKED'}`,
    `Files: total=${summary.totalFiles} planned=${summary.plannedFiles} skipped=${summary.skippedFiles} conflicts=${summary.conflictFiles} rejected=${summary.rejectedFiles}`,
    `Bytes: total=${formatBytes(summary.totalBytes)} planned=${formatBytes(summary.plannedBytes)} netDelta=${formatBytes(summary.netStorageDeltaBytes)}`,
  ];

  const table = renderTable(
    summary.items.map((item) => ({ ...item })),
    [
      { key: 'status', header: 'STATUS' },
      { key: 'virtualPath', header: 'DEST' },
      { key: 'sizeBytes', header: 'SIZE', align: 'right', format: (r) => formatBytes(r.sizeBytes) },
      {
        key: 'accountId',
        header: 'TARGET',
        format: (r) => {
          if (!r.accountId) return '-';
          const ref = toAccountRef(r.accountId);
          return ctx.flags.showEmails ? `${ref} (${r.accountId})` : `${ref} (${maskEmail(r.accountId)})`;
        },
      },
      { key: 'reason', header: 'NOTE' },
    ],
    { emptyMessage: 'No files to upload.' }
  );

  return `${header.join('\n')}\n\n${table}`;
}

async function runUploadImpl(
  ctx: CliContext,
  args: string[],
  forceDryRun: boolean
): Promise<void> {
  let recursive = false;
  let conflictMode: UploadConflictPolicy = 'reject';
  let chunkSizeBytes = DEFAULT_CHUNK_SIZE_BYTES;
  let concurrency = 2;
  let declaredSize: number | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '-r' || token === '--recursive') {
      recursive = true;
      continue;
    }
    if (token === '--conflict') {
      const val = readFlagValue(args, i, '--conflict').toLowerCase() as UploadConflictPolicy;
      if (!VALID_CONFLICTS.has(val)) {
        throw new CliError(
          'USAGE_ERROR',
          "Flag --conflict must be 'reject', 'replace', 'keep_both', or 'skip'.",
          { exitCode: EXIT_CODES.USAGE }
        );
      }
      conflictMode = val;
      i += 1;
      continue;
    }
    if (token.startsWith('--conflict=')) {
      const val = token.slice('--conflict='.length).toLowerCase() as UploadConflictPolicy;
      if (!VALID_CONFLICTS.has(val)) {
        throw new CliError(
          'USAGE_ERROR',
          "Flag --conflict must be 'reject', 'replace', 'keep_both', or 'skip'.",
          { exitCode: EXIT_CODES.USAGE }
        );
      }
      conflictMode = val;
      continue;
    }
    if (token === '--chunk-size') {
      chunkSizeBytes = parseByteSizeFlag(readFlagValue(args, i, '--chunk-size'), '--chunk-size');
      i += 1;
      continue;
    }
    if (token.startsWith('--chunk-size=')) {
      chunkSizeBytes = parseByteSizeFlag(token.slice('--chunk-size='.length), '--chunk-size');
      continue;
    }
    if (token === '--concurrency') {
      concurrency = Number(readFlagValue(args, i, '--concurrency'));
      i += 1;
      continue;
    }
    if (token.startsWith('--concurrency=')) {
      concurrency = Number(token.slice('--concurrency='.length));
      continue;
    }
    if (token === '--size') {
      declaredSize = parseByteSizeFlag(readFlagValue(args, i, '--size'), '--size');
      i += 1;
      continue;
    }
    if (token.startsWith('--size=')) {
      declaredSize = parseByteSizeFlag(token.slice('--size='.length), '--size');
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for upload.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  const budgetCheck = validateTransferMemoryBudget(chunkSizeBytes, concurrency);
  if (!budgetCheck.ok) {
    throw new CliError('VALIDATION_ERROR', budgetCheck.error, {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (positionals.length < 2) {
    throw new CliError(
      'USAGE_ERROR',
      'Usage: tsubasa upload <local-path...> <remote-dest> [-r] [--conflict <mode>]',
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  const remoteDestRaw = positionals[positionals.length - 1];
  const localInputs = positionals.slice(0, -1);
  const isStdin = localInputs.length === 1 && localInputs[0] === '-';
  if (!isStdin && localInputs.includes('-')) {
    throw new CliError(
      'USAGE_ERROR',
      "Stdin source ('-') must be the only source argument.",
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  const { pool, virtualPath: destVirtualBase } = await resolveRemoteTarget(ctx, remoteDestRaw);
  if (pool.isSharePool) {
    throw new CliError('SHARE_POOL_READ_ONLY', 'Uploading directly to Share Pool is disabled.', {
      exitCode: EXIT_CODES.CONFLICT,
    });
  }

  const dryRun = forceDryRun || ctx.flags.dryRun;

  if (isStdin) {
    if (declaredSize === undefined) {
      throw new CliError('USAGE_ERROR', "Flag --size <bytes> is required when uploading from '-'.", {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    if (destVirtualBase === '/') {
      throw new CliError(
        'USAGE_ERROR',
        'Remote destination must include a filename when uploading from stdin.',
        { exitCode: EXIT_CODES.USAGE }
      );
    }

    if (dryRun) {
      const plan = await ctx.transport.requestJson<UploadPlanSummary>('/api/transfers/upload/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poolId: pool.id,
          conflictMode,
          items: [
            {
              relativePath: path.posix.basename(destVirtualBase),
              virtualPath: destVirtualBase,
              sizeBytes: declaredSize,
            },
          ],
        }),
      });
      emitSuccess(ctx, formatPlanPayload(ctx, pool, plan), renderPlanHuman(ctx, pool, plan));
      return;
    }

    const res = await uploadFromStdin(
      ctx,
      pool.id,
      destVirtualBase,
      declaredSize,
      conflictMode,
      chunkSizeBytes
    );
    emitSuccess(
      ctx,
      res,
      `${res.status === 'skipped' ? 'Skipped' : 'Uploaded'} ${pool.slug}:${res.virtualPath} (${formatBytes(res.sizeBytes)})`
    );
    return;
  }

  const existingDestStat = await statRemoteOptional(ctx, pool.id, destVirtualBase);
  const destEndsWithSlash = remoteDestRaw.endsWith('/');
  const multipleInputs = localInputs.length > 1;
  const destIsFolder =
    destVirtualBase === '/' ||
    destEndsWithSlash ||
    multipleInputs ||
    existingDestStat?.kind === 'folder';

  const candidates: LocalUploadCandidate[] = [];
  for (const input of localInputs) {
    candidates.push(...collectLocalFiles(input, destVirtualBase, destIsFolder, recursive));
  }

  if (candidates.length === 0) {
    throw new CliError('USAGE_ERROR', 'No local files found to upload.', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (dryRun) {
    const plan = await ctx.transport.requestJson<UploadPlanSummary>('/api/transfers/upload/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        poolId: pool.id,
        conflictMode,
        items: candidates.map((c) => ({
          relativePath: c.relativePath,
          virtualPath: c.virtualPath,
          sizeBytes: c.sizeBytes,
        })),
      }),
    });
    emitSuccess(ctx, formatPlanPayload(ctx, pool, plan), renderPlanHuman(ctx, pool, plan));
    return;
  }

  const results: UploadFileResult[] = new Array(candidates.length);
  let nextIdx = 0;
  const workerCount = Math.min(concurrency, candidates.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = nextIdx;
        nextIdx += 1;
        if (idx >= candidates.length) {
          return;
        }
        const candidate = candidates[idx];
        if (candidate.sizeBytes <= SMALL_UPLOAD_FAST_PATH_BYTES) {
          results[idx] = await uploadSmallLocalFile(ctx, pool.id, candidate, conflictMode);
        } else {
          results[idx] = await uploadResumableLocalFile(
            ctx,
            pool.id,
            candidate,
            conflictMode,
            chunkSizeBytes
          );
        }
      }
    })
  );

  const uploadedCount = results.filter((r) => r.status === 'uploaded').length;
  const skippedCount = results.filter((r) => r.status === 'skipped').length;
  const totalBytes = results.reduce((sum, r) => sum + (r.status === 'uploaded' ? r.sizeBytes : 0), 0);

  const payload =
    results.length === 1
      ? results[0]
      : {
          poolId: pool.id,
          poolSlug: pool.slug,
          uploadedCount,
          skippedCount,
          totalBytes,
          files: results,
        };

  emitSuccess(
    ctx,
    payload,
    `Uploaded ${uploadedCount} file(s) (${formatBytes(totalBytes)})${skippedCount > 0 ? `, skipped ${skippedCount}` : ''}.`
  );
}

export async function handleUpload(ctx: CliContext, args: string[]): Promise<void> {
  return runUploadImpl(ctx, args, false);
}

export async function handlePlanUpload(ctx: CliContext, args: string[]): Promise<void> {
  return runUploadImpl(ctx, args, true);
}
