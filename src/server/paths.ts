import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TsubasaPaths {
  homeDir: string;
  dataDir: string;
  dbPath: string;
  oauthsDir: string;
  writerLockPath: string;
  sourceTokensDir: string;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

let cachedPackageRoot: string | null = null;
let explicitHomeOverride: string | null = null;

function readPackageName(packageJsonPath: string): string | null {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

export function getPackageRootDir(): string {
  if (cachedPackageRoot) {
    return cachedPackageRoot;
  }

  let current = MODULE_DIR;
  let nearestPackageDir: string | null = null;

  while (true) {
    const candidatePkg = path.join(current, 'package.json');
    if (fs.existsSync(candidatePkg)) {
      if (!nearestPackageDir) {
        nearestPackageDir = current;
      }
      if (readPackageName(candidatePkg) === 'tsubasa') {
        cachedPackageRoot = current;
        return cachedPackageRoot;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  cachedPackageRoot = nearestPackageDir ?? path.resolve(MODULE_DIR, '..', '..');
  return cachedPackageRoot;
}

export function setTsubasaHomeOverride(homeDir: string | null | undefined): void {
  const trimmed = homeDir?.trim();
  explicitHomeOverride = trimmed ? path.resolve(trimmed) : null;
}

export function getTsubasaHomeOverride(): string | null {
  return explicitHomeOverride;
}

export function resolveTsubasaHome(homeOverride?: string): string {
  const explicitArg = homeOverride?.trim();
  if (explicitArg) {
    return path.resolve(explicitArg);
  }

  if (explicitHomeOverride) {
    return explicitHomeOverride;
  }

  const envHome = process.env.TSUBASA_HOME?.trim();
  if (envHome) {
    return path.resolve(envHome);
  }

  return getPackageRootDir();
}

export function resolveDataDir(homeOverride?: string): string {
  return path.join(resolveTsubasaHome(homeOverride), 'data');
}

export function resolveDbPath(homeOverride?: string): string {
  const explicitArg = homeOverride?.trim();
  if (explicitArg || explicitHomeOverride) {
    return path.join(resolveDataDir(explicitArg), 'tsubasa.db');
  }

  const envDbPath = process.env.TSUBASA_DB_PATH?.trim();
  if (envDbPath) {
    return envDbPath === ':memory:' ? ':memory:' : path.resolve(envDbPath);
  }

  return path.join(resolveDataDir(), 'tsubasa.db');
}

export function resolveOAuthsDir(homeOverride?: string): string {
  return path.join(resolveTsubasaHome(homeOverride), '.oauths');
}

export function resolveWriterLockPath(homeOverride?: string): string {
  return path.join(resolveDataDir(homeOverride), 'tsubasa.writer.lock');
}

export function resolveSourceTokensDir(homeOverride?: string): string {
  return path.join(resolveDataDir(homeOverride), 'source-tokens');
}

export function resolveTsubasaPaths(homeOverride?: string): TsubasaPaths {
  const homeDir = resolveTsubasaHome(homeOverride);
  const dataDir = resolveDataDir(homeOverride);
  return {
    homeDir,
    dataDir,
    dbPath: resolveDbPath(homeOverride),
    oauthsDir: resolveOAuthsDir(homeOverride),
    writerLockPath: resolveWriterLockPath(homeOverride),
    sourceTokensDir: resolveSourceTokensDir(homeOverride),
  };
}

function resolveRealPathOrAncestor(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const realpathFn = fs.realpathSync.native ?? fs.realpathSync;

  try {
    return realpathFn(resolved);
  } catch {
    // Walk up until an existing ancestor is found, then rejoin remaining path segments.
  }

  const tailSegments: string[] = [];
  let current = resolved;

  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      return resolved;
    }
    tailSegments.unshift(path.basename(current));
    current = parent;

    try {
      const realAncestor = realpathFn(current);
      return path.join(realAncestor, ...tailSegments);
    } catch {
      continue;
    }
  }
}

export function canonicalizePathForFingerprint(targetPath: string): string {
  if (targetPath === ':memory:') {
    return ':memory:';
  }
  const canonical = path.normalize(resolveRealPathOrAncestor(targetPath));
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function computeDbFingerprint(targetDbPath?: string): string {
  const resolved = targetDbPath ?? resolveDbPath();
  const canonical = canonicalizePathForFingerprint(resolved);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function getDbFingerprint(homeOverride?: string): string {
  return computeDbFingerprint(resolveDbPath(homeOverride));
}
