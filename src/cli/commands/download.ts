import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  emitSuccess,
  readStdinLines,
  resolvePoolArg,
  type CliContext,
  type PoolInfo,
} from '../context.js';
import { detectHashAlgorithm } from '../lib/chunks.js';
import { CliError, EXIT_CODES, mapErrorCodeToExitCode } from '../lib/errors.js';
import { formatBytes, formatStderrEvent, renderProgressBar } from '../lib/format.js';
import { parseRemoteSelector } from '../lib/selectors.js';

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
}

type StatResponse =
  | { kind: 'file'; item: StatFileItem }
  | { kind: 'folder'; item: StatFolderItem };

interface FindResponse {
  items: Array<{
    kind: 'folder' | 'file';
    id: string;
    poolId: number;
    virtualPath: string;
    name: string;
    sizeBytes: number | null;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
}

interface PartSidecarMeta {
  fileId: string;
  driveFileId: string;
  sizeBytes: number;
  hash: string | null;
  poolId: number;
}

interface DownloadTask {
  pool: PoolInfo;
  file: StatFileItem;
  destPath: string;
}

interface DownloadResultItem {
  fileId: string;
  poolId: number;
  poolSlug: string;
  virtualPath: string;
  destPath: string;
  sizeBytes: number;
  hash: string | null;
  hashVerified: boolean;
  resumedFromBytes: number;
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
        `Conflicting pool selectors: path specifies '${parsed.pool}' while --pool specifies '${ctx.flags.pool}'.`,
        { exitCode: EXIT_CODES.USAGE }
      );
    }
    return { pool: prefixPool, virtualPath: normalizePosixPath(parsed.path) };
  }

  const pool = await resolvePoolArg(ctx, parsed.isRemote ? parsed.pool : undefined);
  return { pool, virtualPath: normalizePosixPath(parsed.path) };
}

async function statRemoteItem(
  ctx: CliContext,
  poolId: number,
  virtualPath: string
): Promise<StatResponse> {
  return ctx.transport.requestJson<StatResponse>(
    `/api/items/stat?poolId=${poolId}&path=${encodeURIComponent(virtualPath)}`
  );
}

async function collectFolderFiles(
  ctx: CliContext,
  poolId: number,
  folderPath: string
): Promise<StatFileItem[]> {
  const virtualPaths: string[] = [];
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

    const page = await ctx.transport.requestJson<FindResponse>(
      `/api/items/find?${params.toString()}`
    );
    for (const item of page.items ?? []) {
      if (item.kind === 'file') {
        virtualPaths.push(item.virtualPath);
      }
    }
    if (!page.hasMore || !page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }

  const results: StatFileItem[] = [];
  for (const vp of virtualPaths) {
    const st = await statRemoteItem(ctx, poolId, vp);
    if (st.kind === 'file') {
      results.push(st.item);
    }
  }
  return results;
}

function toSafeRelativeSegments(relativePosixPath: string): string[] {
  return relativePosixPath
    .split('/')
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

function readPartMeta(metaPath: string): PartSidecarMeta | null {
  if (!fs.existsSync(metaPath)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    if (
      typeof raw.fileId !== 'string' ||
      typeof raw.driveFileId !== 'string' ||
      typeof raw.sizeBytes !== 'number' ||
      typeof raw.poolId !== 'number' ||
      (raw.hash !== null && typeof raw.hash !== 'string')
    ) {
      return null;
    }
    return {
      fileId: raw.fileId,
      driveFileId: raw.driveFileId,
      sizeBytes: raw.sizeBytes,
      hash: raw.hash,
      poolId: raw.poolId,
    };
  } catch {
    return null;
  }
}

function metaMatches(meta: PartSidecarMeta, file: StatFileItem): boolean {
  return (
    meta.fileId === file.id &&
    meta.driveFileId === file.driveFileId &&
    meta.sizeBytes === file.sizeBytes &&
    meta.hash === (file.hash ?? null) &&
    meta.poolId === file.poolId
  );
}

async function computeFileHash(
  filePath: string,
  algorithm: 'md5' | 'sha256'
): Promise<string> {
  const hash = createHash(algorithm);
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex').toLowerCase();
}

async function parseDownloadErrorResponse(response: Response): Promise<never> {
  const text = await response.text();
  let record: Record<string, unknown> = {};
  if (text.length > 0) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null) {
        record = parsed as Record<string, unknown>;
      }
    } catch {
      record = { error: text };
    }
  }
  const code =
    typeof record.code === 'string' && record.code.length > 0
      ? record.code
      : response.status === 404
        ? 'NOT_FOUND'
        : response.status === 401 || response.status === 403
          ? 'AUTH_ERROR'
          : 'UPSTREAM_ERROR';
  const message =
    typeof record.error === 'string' && record.error.length > 0
      ? record.error
      : `Download failed with HTTP ${response.status}.`;
  throw new CliError(code, message, {
    exitCode: mapErrorCodeToExitCode(code, response.status),
  });
}

function emitProgress(
  ctx: CliContext,
  opts: {
    fileId: string;
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
        event: opts.done ? 'download_complete' : 'download_progress',
        fileId: opts.fileId,
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

async function writeChunkToStream(
  stream: NodeJS.WritableStream,
  chunk: Uint8Array
): Promise<void> {
  if (!stream.write(chunk)) {
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        stream.off('drain', onDrain);
        stream.off('error', onError);
      };
      stream.once('drain', onDrain);
      stream.once('error', onError);
    });
  }
}

async function downloadToStdout(ctx: CliContext, file: StatFileItem): Promise<void> {
  const response = await ctx.transport.request(
    `/api/files/${encodeURIComponent(file.id)}/download?poolId=${file.poolId}`
  );
  if (!response.ok) {
    await parseDownloadErrorResponse(response);
  }

  const headerSizeRaw = response.headers.get('x-tsubasa-size');
  const expectedSize =
    headerSizeRaw !== null && /^\d+$/.test(headerSizeRaw.trim())
      ? Number(headerSizeRaw.trim())
      : file.sizeBytes;
  const expectedHash = response.headers.get('x-tsubasa-hash')?.trim() || file.hash || null;
  const hashAlgo = detectHashAlgorithm(expectedHash);

  if (expectedHash && !hashAlgo) {
    throw new CliError(
      'RUNTIME_ERROR',
      `Unsupported hash format '${expectedHash}' for '${file.virtualPath}'.`,
      { exitCode: EXIT_CODES.RUNTIME }
    );
  }

  const hasher = hashAlgo ? createHash(hashAlgo) : null;
  let actualBytes = 0;

  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          actualBytes += value.byteLength;
          hasher?.update(value);
          await writeChunkToStream(ctx.stdout, value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  if (actualBytes !== expectedSize) {
    throw new CliError(
      'RUNTIME_ERROR',
      `Byte count mismatch for '${file.virtualPath}': expected ${expectedSize}, received ${actualBytes}.`,
      { exitCode: EXIT_CODES.RUNTIME }
    );
  }

  if (hasher && expectedHash) {
    const actualHash = hasher.digest('hex').toLowerCase();
    if (actualHash !== expectedHash.toLowerCase()) {
      throw new CliError(
        'RUNTIME_ERROR',
        `Hash mismatch for '${file.virtualPath}': expected ${expectedHash}, got ${actualHash}.`,
        { exitCode: EXIT_CODES.RUNTIME }
      );
    }
  } else if (!expectedHash && !ctx.flags.quiet) {
    ctx.stderr.write(
      `Warning: '${file.virtualPath}' has no stored hash; verified byte count (${actualBytes} B) only.\n`
    );
  }
}

async function verifyCompletedPart(
  ctx: CliContext,
  partPath: string,
  file: StatFileItem,
  expectedSize: number,
  expectedHash: string | null
): Promise<boolean> {
  const actualSize = fs.statSync(partPath).size;
  if (actualSize !== expectedSize) {
    throw new CliError(
      'RUNTIME_ERROR',
      `Downloaded size mismatch for '${file.virtualPath}': expected ${expectedSize} bytes, got ${actualSize} bytes.`,
      { exitCode: EXIT_CODES.RUNTIME }
    );
  }

  if (!expectedHash) {
    if (!ctx.flags.quiet) {
      ctx.stderr.write(
        `Warning: '${file.virtualPath}' has no stored hash; verified byte count (${actualSize} B) only.\n`
      );
    }
    return false;
  }

  const algo = detectHashAlgorithm(expectedHash);
  if (!algo) {
    throw new CliError(
      'RUNTIME_ERROR',
      `Unsupported hash format '${expectedHash}' for '${file.virtualPath}'.`,
      { exitCode: EXIT_CODES.RUNTIME }
    );
  }

  const actualHash = await computeFileHash(partPath, algo);
  if (actualHash !== expectedHash.toLowerCase()) {
    throw new CliError(
      'RUNTIME_ERROR',
      `Hash mismatch for '${file.virtualPath}': expected ${expectedHash}, got ${actualHash}.`,
      { exitCode: EXIT_CODES.RUNTIME }
    );
  }

  return true;
}

async function downloadFileResumable(
  ctx: CliContext,
  task: DownloadTask
): Promise<DownloadResultItem> {
  const { pool, file, destPath } = task;
  const destDir = path.dirname(destPath);
  fs.mkdirSync(destDir, { recursive: true });

  const partPath = `${destPath}.part`;
  const metaPath = `${destPath}.part.meta.json`;

  let resumeOffset = 0;
  const existingMeta = readPartMeta(metaPath);
  if (existingMeta && metaMatches(existingMeta, file) && fs.existsSync(partPath)) {
    const partSize = fs.statSync(partPath).size;
    if (file.sizeBytes > 0 && partSize > 0 && partSize < file.sizeBytes) {
      resumeOffset = partSize;
    } else if (file.sizeBytes > 0 && partSize === file.sizeBytes) {
      let alreadyValid = false;
      try {
        const hashVerified = await verifyCompletedPart(
          ctx,
          partPath,
          file,
          file.sizeBytes,
          file.hash ?? null
        );
        alreadyValid = true;
        fs.renameSync(partPath, destPath);
        fs.rmSync(metaPath, { force: true });
        return {
          fileId: file.id,
          poolId: pool.id,
          poolSlug: pool.slug,
          virtualPath: file.virtualPath,
          destPath,
          sizeBytes: file.sizeBytes,
          hash: file.hash ?? null,
          hashVerified,
          resumedFromBytes: file.sizeBytes,
        };
      } catch (err) {
        if (alreadyValid) {
          throw err;
        }
        fs.rmSync(partPath, { force: true });
        resumeOffset = 0;
      }
    }
  }

  const sidecar: PartSidecarMeta = {
    fileId: file.id,
    driveFileId: file.driveFileId,
    sizeBytes: file.sizeBytes,
    hash: file.hash ?? null,
    poolId: file.poolId,
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');

  const headers: Record<string, string> = {};
  // Skip Range header for 0-byte files so Drive never returns HTTP 416.
  if (file.sizeBytes > 0 && resumeOffset > 0) {
    headers.Range = `bytes=${resumeOffset}-`;
  }

  const response = await ctx.transport.request(
    `/api/files/${encodeURIComponent(file.id)}/download?poolId=${file.poolId}`,
    { headers }
  );

  if (!response.ok) {
    await parseDownloadErrorResponse(response);
  }

  const headerFileId = response.headers.get('x-tsubasa-file-id')?.trim();
  if (headerFileId && headerFileId !== file.id) {
    throw new CliError(
      'RUNTIME_ERROR',
      `Server returned file ID '${headerFileId}' when requesting '${file.id}'.`,
      { exitCode: EXIT_CODES.RUNTIME }
    );
  }

  const headerSizeRaw = response.headers.get('x-tsubasa-size')?.trim();
  const expectedSize =
    headerSizeRaw && /^\d+$/.test(headerSizeRaw) ? Number(headerSizeRaw) : file.sizeBytes;
  const expectedHash = response.headers.get('x-tsubasa-hash')?.trim() || file.hash || null;

  let effectiveOffset = resumeOffset;
  let appendMode = resumeOffset > 0 && response.status === 206;

  // If a resumed request returns HTTP 200 instead of 206, truncate .part to 0 bytes before writing.
  if (resumeOffset > 0 && response.status === 200) {
    if (fs.existsSync(partPath)) {
      fs.truncateSync(partPath, 0);
    }
    effectiveOffset = 0;
    appendMode = false;
  }

  let currentBytes = effectiveOffset;
  const startedAt = Date.now();
  let lastProgressAt = 0;

  const writeStream = fs.createWriteStream(partPath, {
    flags: appendMode ? 'a' : 'w',
  });

  try {
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            await writeChunkToStream(writeStream, value);
            currentBytes += value.byteLength;
            const now = Date.now();
            if (now - lastProgressAt >= 150) {
              const elapsedSec = Math.max(0.001, (now - startedAt) / 1000);
              const speed = (currentBytes - effectiveOffset) / elapsedSec;
              emitProgress(ctx, {
                fileId: file.id,
                virtualPath: file.virtualPath,
                label: file.name,
                currentBytes,
                totalBytes: expectedSize,
                speedBytesPerSec: speed,
              });
              lastProgressAt = now;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.once('error', reject);
      writeStream.once('finish', resolve);
      writeStream.end();
    });
  } catch (err) {
    writeStream.destroy();
    throw err;
  }

  const totalElapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
  emitProgress(ctx, {
    fileId: file.id,
    virtualPath: file.virtualPath,
    label: file.name,
    currentBytes,
    totalBytes: expectedSize,
    speedBytesPerSec: (currentBytes - effectiveOffset) / totalElapsedSec,
    done: true,
  });

  const hashVerified = await verifyCompletedPart(
    ctx,
    partPath,
    file,
    expectedSize,
    expectedHash
  );

  fs.renameSync(partPath, destPath);
  fs.rmSync(metaPath, { force: true });

  return {
    fileId: file.id,
    poolId: pool.id,
    poolSlug: pool.slug,
    virtualPath: file.virtualPath,
    destPath,
    sizeBytes: expectedSize,
    hash: expectedHash,
    hashVerified,
    resumedFromBytes: effectiveOffset,
  };
}

export async function handleDownload(ctx: CliContext, args: string[]): Promise<void> {
  let useStdin = false;
  const positionals: string[] = [];

  for (const token of args) {
    if (token === '--stdin') {
      useStdin = true;
      continue;
    }
    if (token === '-r' || token === '--recursive') {
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      throw new CliError('USAGE_ERROR', `Unknown flag '${token}' for download.`, {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    positionals.push(token);
  }

  const stdinLines = useStdin ? await readStdinLines() : [];
  let remoteInputs: string[] = [];
  let localArg: string | undefined;

  if (useStdin) {
    if (positionals.length > 1) {
      throw new CliError('USAGE_ERROR', 'Usage: tsubasa download --stdin [local-dir]', {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    remoteInputs = stdinLines;
    localArg = positionals[0];
  } else {
    if (positionals.length === 0) {
      throw new CliError('USAGE_ERROR', 'Usage: tsubasa download <remote-path> [local-path]', {
        exitCode: EXIT_CODES.USAGE,
      });
    }
    if (positionals.length === 1) {
      remoteInputs = [positionals[0]];
    } else if (positionals.length === 2) {
      remoteInputs = [positionals[0]];
      localArg = positionals[1];
    } else {
      remoteInputs = positionals.slice(0, -1);
      localArg = positionals[positionals.length - 1];
    }
  }

  if (remoteInputs.length === 0) {
    throw new CliError('USAGE_ERROR', 'At least one remote path is required for download.', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const isStdoutTarget = localArg === '-';
  if (isStdoutTarget) {
    if (ctx.flags.json) {
      throw new CliError(
        'USAGE_ERROR',
        "Cannot combine stdout download ('-') with --json.",
        { exitCode: EXIT_CODES.USAGE }
      );
    }
    if (remoteInputs.length > 1) {
      throw new CliError(
        'USAGE_ERROR',
        "Stdout download ('-') only supports a single remote file.",
        { exitCode: EXIT_CODES.USAGE }
      );
    }
  }

  const resolvedSources = await Promise.all(
    remoteInputs.map(async (raw) => {
      const target = await resolveRemoteTarget(ctx, raw);
      const stat = await statRemoteItem(ctx, target.pool.id, target.virtualPath);
      return { ...target, stat };
    })
  );

  if (isStdoutTarget) {
    const only = resolvedSources[0];
    if (only.stat.kind !== 'file') {
      throw new CliError(
        'USAGE_ERROR',
        `Cannot stream folder '${only.virtualPath}' to stdout ('-').`,
        { exitCode: EXIT_CODES.USAGE }
      );
    }
    if (ctx.flags.dryRun) {
      emitSuccess(
        ctx,
        {
          dryRun: true,
          action: 'download',
          fileId: only.stat.item.id,
          virtualPath: only.virtualPath,
          dest: '-',
          sizeBytes: only.stat.item.sizeBytes,
        },
        `[dry-run] download ${only.pool.slug}:${only.virtualPath} -> stdout (${formatBytes(only.stat.item.sizeBytes)})`
      );
      return;
    }
    await downloadToStdout(ctx, only.stat.item);
    return;
  }

  const tasks: DownloadTask[] = [];
  const multipleSources = resolvedSources.length > 1;
  const resolvedLocalBase = localArg ? path.resolve(process.cwd(), localArg) : process.cwd();
  const localLooksLikeDir =
    !localArg ||
    localArg.endsWith('/') ||
    localArg.endsWith('\\') ||
    (fs.existsSync(resolvedLocalBase) && fs.statSync(resolvedLocalBase).isDirectory());

  for (const src of resolvedSources) {
    if (src.stat.kind === 'file') {
      let destPath: string;
      if (!localArg) {
        destPath = path.resolve(process.cwd(), src.stat.item.name);
      } else if (multipleSources || localLooksLikeDir) {
        destPath = path.join(resolvedLocalBase, src.stat.item.name);
      } else {
        destPath = resolvedLocalBase;
      }
      tasks.push({ pool: src.pool, file: src.stat.item, destPath });
      continue;
    }

    const folderFiles = await collectFolderFiles(ctx, src.pool.id, src.virtualPath);
    const folderBaseName =
      src.virtualPath === '/' ? src.pool.slug : path.posix.basename(src.virtualPath);
    const rootDestDir = !localArg
      ? path.resolve(process.cwd(), folderBaseName)
      : multipleSources
        ? path.join(resolvedLocalBase, folderBaseName)
        : resolvedLocalBase;

    const prefix = src.virtualPath === '/' ? '/' : `${src.virtualPath}/`;
    for (const file of folderFiles) {
      const relPosix = file.virtualPath.startsWith(prefix)
        ? file.virtualPath.slice(prefix.length)
        : file.name;
      const segments = toSafeRelativeSegments(relPosix);
      const destPath = path.join(rootDestDir, ...(segments.length > 0 ? segments : [file.name]));
      tasks.push({ pool: src.pool, file, destPath });
    }
  }

  if (ctx.flags.dryRun) {
    const preview = tasks.map((t) => {
      const partPath = `${t.destPath}.part`;
      const meta = readPartMeta(`${t.destPath}.part.meta.json`);
      const partSize =
        meta && metaMatches(meta, t.file) && fs.existsSync(partPath)
          ? fs.statSync(partPath).size
          : 0;
      return {
        fileId: t.file.id,
        poolId: t.pool.id,
        poolSlug: t.pool.slug,
        virtualPath: t.file.virtualPath,
        destPath: t.destPath,
        sizeBytes: t.file.sizeBytes,
        resumeFromBytes: partSize > 0 && partSize <= t.file.sizeBytes ? partSize : 0,
      };
    });
    const totalBytes = preview.reduce((sum, item) => sum + item.sizeBytes, 0);
    emitSuccess(
      ctx,
      { dryRun: true, action: 'download', count: preview.length, totalBytes, files: preview },
      `[dry-run] download ${preview.length} file(s) (${formatBytes(totalBytes)})`
    );
    return;
  }

  const downloaded: DownloadResultItem[] = [];
  for (const task of tasks) {
    downloaded.push(await downloadFileResumable(ctx, task));
  }

  const totalBytes = downloaded.reduce((sum, d) => sum + d.sizeBytes, 0);
  const summaryPayload =
    downloaded.length === 1 && !multipleSources && resolvedSources[0].stat.kind === 'file'
      ? downloaded[0]
      : { count: downloaded.length, totalBytes, files: downloaded };

  emitSuccess(
    ctx,
    summaryPayload,
    `Downloaded ${downloaded.length} file(s) (${formatBytes(totalBytes)}).`
  );
}
