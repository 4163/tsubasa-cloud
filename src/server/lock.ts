import fs from 'node:fs';
import path from 'node:path';
import { resolveWriterLockPath } from './paths.js';

export interface WriterLockMetadata {
  pid: number;
  startedAt: string;
  command: string;
  cwd: string;
}

export interface AcquireWriterLockOptions {
  lockPath?: string;
  homeDir?: string;
  command?: string;
  cwd?: string;
}

export interface WriterLockHandle {
  lockPath: string;
  metadata: WriterLockMetadata;
  release(): void;
}

export class WriterLockError extends Error {
  readonly code = 'WRITER_LOCK_HELD' as const;
  readonly lockPath: string;
  readonly holder: WriterLockMetadata | null;

  constructor(lockPath: string, holder: WriterLockMetadata | null, message?: string) {
    const fallbackMessage = holder
      ? `Writer lock is held by pid ${holder.pid} (started ${holder.startedAt})`
      : 'Writer lock is already held by another process';
    super(message ?? fallbackMessage);
    this.name = 'WriterLockError';
    this.lockPath = lockPath;
    this.holder = holder;
  }
}

const MAX_ACQUIRE_ATTEMPTS = 20;
const PARTIAL_WRITE_GRACE_MS = 1_000;
const RECOVER_LOCK_STALE_MS = 5_000;
const RETRY_DELAY_MS = 25;

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  try {
    Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      // Fallback busy wait if Atomics.wait is unavailable.
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') {
      return false;
    }
    if (code === 'EPERM') {
      return true;
    }
    return true;
  }
}

function parseLockMetadata(raw: string): WriterLockMetadata | null {
  try {
    const parsed = JSON.parse(raw) as Partial<WriterLockMetadata>;
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.command !== 'string' ||
      typeof parsed.cwd !== 'string'
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      command: parsed.command,
      cwd: parsed.cwd,
    };
  } catch {
    return null;
  }
}

export function readWriterLock(lockPath = resolveWriterLockPath()): WriterLockMetadata | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    return parseLockMetadata(raw);
  } catch {
    return null;
  }
}

function tryCreateExclusiveLockFile(filePath: string, payload: string): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      return false;
    }
    throw err;
  }

  try {
    fs.writeFileSync(fd, payload, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      // Ignore filesystems that do not support fsync on regular files.
    }
    return true;
  } catch (err) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup if writing the lock payload failed.
    }
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

type InspectLockResult =
  | { state: 'missing' }
  | { state: 'live'; holder: WriterLockMetadata }
  | { state: 'fresh_partial' }
  | { state: 'stale'; holder: WriterLockMetadata | null };

function inspectExistingLock(lockPath: string): InspectLockResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { state: 'missing' };
    }
    throw err;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { state: 'missing' };
    }
    throw err;
  }

  const holder = parseLockMetadata(raw);
  if (!holder) {
    const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
    if (ageMs < PARTIAL_WRITE_GRACE_MS) {
      return { state: 'fresh_partial' };
    }
    return { state: 'stale', holder: null };
  }

  if (isProcessAlive(holder.pid)) {
    return { state: 'live', holder };
  }

  return { state: 'stale', holder };
}

function tryCleanupStaleRecoveryLock(recoverPath: string): void {
  try {
    const stat = fs.statSync(recoverPath);
    const raw = fs.readFileSync(recoverPath, 'utf8');
    const holder = parseLockMetadata(raw);
    const ageMs = Math.max(0, Date.now() - stat.mtimeMs);

    if ((holder && !isProcessAlive(holder.pid)) || ageMs >= RECOVER_LOCK_STALE_MS) {
      fs.unlinkSync(recoverPath);
    }
  } catch {
    // Already removed or unreadable; next acquire attempt will observe current state.
  }
}

function createLockHandle(lockPath: string, metadata: WriterLockMetadata): WriterLockHandle {
  let released = false;

  return {
    lockPath,
    metadata,
    release(): void {
      if (released) {
        return;
      }
      released = true;

      try {
        const current = readWriterLock(lockPath);
        if (
          current &&
          (current.pid !== metadata.pid || current.startedAt !== metadata.startedAt)
        ) {
          return;
        }
        fs.unlinkSync(lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.warn(`Failed to release writer lock ${lockPath}:`, err);
        }
      }
    },
  };
}

export function acquireWriterLock(options: AcquireWriterLockOptions = {}): WriterLockHandle {
  const lockPath = options.lockPath ?? resolveWriterLockPath(options.homeDir);
  const recoverPath = `${lockPath}.recover`;
  const metadata: WriterLockMetadata = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: options.command ?? process.argv.join(' '),
    cwd: options.cwd ?? process.cwd(),
  };
  const payload = `${JSON.stringify(metadata, null, 2)}\n`;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    if (tryCreateExclusiveLockFile(lockPath, payload)) {
      return createLockHandle(lockPath, metadata);
    }

    const inspection = inspectExistingLock(lockPath);
    if (inspection.state === 'missing') {
      continue;
    }

    if (inspection.state === 'live') {
      throw new WriterLockError(lockPath, inspection.holder);
    }

    if (inspection.state === 'fresh_partial') {
      sleepSync(RETRY_DELAY_MS);
      continue;
    }

    // Serialize stale-lock reaping with a secondary atomic O_EXCL recovery lock so two
    // contenders cannot both unlink the file and clobber each other's fresh acquisition.
    if (!tryCreateExclusiveLockFile(recoverPath, payload)) {
      tryCleanupStaleRecoveryLock(recoverPath);
      sleepSync(RETRY_DELAY_MS);
      continue;
    }

    try {
      const recheck = inspectExistingLock(lockPath);
      if (recheck.state === 'live') {
        throw new WriterLockError(lockPath, recheck.holder);
      }
      if (recheck.state === 'fresh_partial') {
        sleepSync(RETRY_DELAY_MS);
        continue;
      }

      if (recheck.state === 'stale') {
        try {
          fs.unlinkSync(lockPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            throw err;
          }
        }
      }

      if (tryCreateExclusiveLockFile(lockPath, payload)) {
        return createLockHandle(lockPath, metadata);
      }
    } finally {
      try {
        fs.unlinkSync(recoverPath);
      } catch {
        // Best-effort cleanup of recovery lock.
      }
    }
  }

  const finalHolder = readWriterLock(lockPath);
  throw new WriterLockError(lockPath, finalHolder);
}
