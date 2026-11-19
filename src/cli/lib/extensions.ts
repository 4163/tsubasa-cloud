import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliError, EXIT_CODES } from './errors.js';

export const EXTENSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type ExtensionRuntime = 'node' | 'python' | 'exec';

export interface ExtensionManifest {
  name: string;
  description: string;
  entry: string;
  runtime: ExtensionRuntime;
  minSchemaVersion?: number;
}

export interface ResolvedExtension {
  manifest: ExtensionManifest;
  dir: string;
  entryPath: string;
  manifestPath: string;
}

export interface InvalidExtensionEntry {
  dirName: string;
  dir: string;
  error: string;
}

export interface ExtensionDiscoveryResult {
  extensions: ResolvedExtension[];
  invalid: InvalidExtensionEntry[];
}

export interface PythonProbeResult {
  command: string;
  args: string[];
  version: string;
}

export interface ExtensionChildEnvOptions {
  cliBin: string;
  schemaVersion?: number;
  transport: 'http' | 'local';
  homeDir: string;
  pool?: string;
  apiUrl?: string;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface RunExtensionOptions {
  extension: ResolvedExtension;
  args: readonly string[];
  envOptions: ExtensionChildEnvOptions;
  cwd?: string;
}

const VALID_RUNTIMES = new Set<ExtensionRuntime>(['node', 'python', 'exec']);

function isContainedWithin(rootDir: string, candidatePath: string): boolean {
  const rel = path.relative(rootDir, candidatePath);
  if (rel === '' || rel === '..') {
    return false;
  }
  if (
    rel.startsWith(`..${path.sep}`) ||
    rel.startsWith('../') ||
    rel.startsWith('..\\') ||
    path.isAbsolute(rel)
  ) {
    return false;
  }
  return true;
}

export function validateExtensionName(
  name: string,
): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: 'Extension name must be a non-empty string.' };
  }
  if (!EXTENSION_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error: `Invalid extension name "${name}". Must match /^[a-z0-9][a-z0-9-]*$/.`,
    };
  }
  return { ok: true, name };
}

export function resolveContainedEntryPath(
  extensionDir: string,
  entry: string,
): { ok: true; entryPath: string } | { ok: false; error: string } {
  if (typeof entry !== 'string' || entry.trim().length === 0) {
    return { ok: false, error: 'Manifest "entry" must be a non-empty relative path.' };
  }
  if (
    path.isAbsolute(entry) ||
    /^[a-zA-Z]:/.test(entry) ||
    entry.startsWith('/') ||
    entry.startsWith('\\')
  ) {
    return { ok: false, error: `Manifest "entry" must be a relative path: "${entry}".` };
  }

  const rootResolved = path.resolve(extensionDir);
  const candidate = path.resolve(rootResolved, entry);

  if (!isContainedWithin(rootResolved, candidate)) {
    return {
      ok: false,
      error: `Manifest "entry" escapes extension directory: "${entry}".`,
    };
  }

  if (fs.existsSync(candidate)) {
    try {
      const realRoot = fs.realpathSync(rootResolved);
      const realCandidate = fs.realpathSync(candidate);
      if (!isContainedWithin(realRoot, realCandidate)) {
        return {
          ok: false,
          error: `Manifest "entry" resolves outside extension directory via symlink: "${entry}".`,
        };
      }
    } catch {
      return {
        ok: false,
        error: `Failed to resolve real path for manifest "entry": "${entry}".`,
      };
    }
  }

  return { ok: true, entryPath: candidate };
}

export function validateManifest(
  raw: unknown,
  expectedDirName: string,
  extensionDir: string,
  currentSchemaVersion = 1,
): { ok: true; extension: ResolvedExtension } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'Manifest must be a JSON object.' };
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.name !== 'string') {
    return { ok: false, error: 'Manifest "name" must be a string.' };
  }
  const nameCheck = validateExtensionName(record.name);
  if (!nameCheck.ok) {
    return nameCheck;
  }
  if (record.name !== expectedDirName) {
    return {
      ok: false,
      error: `Manifest name "${record.name}" does not match directory name "${expectedDirName}".`,
    };
  }

  if (typeof record.description !== 'string' || record.description.trim().length === 0) {
    return { ok: false, error: 'Manifest "description" must be a non-empty string.' };
  }

  if (typeof record.runtime !== 'string' || !VALID_RUNTIMES.has(record.runtime as ExtensionRuntime)) {
    return {
      ok: false,
      error: 'Manifest "runtime" must be one of "node", "python", or "exec".',
    };
  }

  if (typeof record.entry !== 'string') {
    return { ok: false, error: 'Manifest "entry" must be a string.' };
  }
  const entryCheck = resolveContainedEntryPath(extensionDir, record.entry);
  if (!entryCheck.ok) {
    return entryCheck;
  }

  let minSchemaVersion: number | undefined;
  if (record.minSchemaVersion !== undefined) {
    if (
      typeof record.minSchemaVersion !== 'number' ||
      !Number.isInteger(record.minSchemaVersion) ||
      record.minSchemaVersion < 1
    ) {
      return {
        ok: false,
        error: 'Manifest "minSchemaVersion" must be a positive integer.',
      };
    }
    if (record.minSchemaVersion > currentSchemaVersion) {
      return {
        ok: false,
        error: `Extension requires schema version ${record.minSchemaVersion}, but current CLI schema version is ${currentSchemaVersion}.`,
      };
    }
    minSchemaVersion = record.minSchemaVersion;
  }

  const resolvedDir = path.resolve(extensionDir);
  const manifest: ExtensionManifest = {
    name: record.name,
    description: record.description.trim(),
    entry: record.entry,
    runtime: record.runtime as ExtensionRuntime,
    ...(minSchemaVersion !== undefined ? { minSchemaVersion } : {}),
  };

  return {
    ok: true,
    extension: {
      manifest,
      dir: resolvedDir,
      entryPath: entryCheck.entryPath,
      manifestPath: path.join(resolvedDir, 'manifest.json'),
    },
  };
}

export function discoverExtensions(
  homeDir: string,
  currentSchemaVersion = 1,
): ExtensionDiscoveryResult {
  const extensionsRoot = path.join(homeDir, 'extensions');
  if (!fs.existsSync(extensionsRoot)) {
    return { extensions: [], invalid: [] };
  }

  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(extensionsRoot);
  } catch {
    return { extensions: [], invalid: [] };
  }
  if (!rootStat.isDirectory()) {
    return { extensions: [], invalid: [] };
  }

  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(extensionsRoot, { withFileTypes: true });
  } catch {
    return { extensions: [], invalid: [] };
  }

  const extensions: ResolvedExtension[] = [];
  const invalid: InvalidExtensionEntry[] = [];

  for (const entry of dirEntries) {
    const extDir = path.join(extensionsRoot, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = fs.statSync(extDir).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) {
      continue;
    }

    const manifestPath = path.join(extDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      invalid.push({
        dirName: entry.name,
        dir: path.resolve(extDir),
        error: 'Missing manifest.json.',
      });
      continue;
    }

    let rawJson: unknown;
    try {
      const content = fs.readFileSync(manifestPath, 'utf8');
      rawJson = JSON.parse(content);
    } catch (err) {
      invalid.push({
        dirName: entry.name,
        dir: path.resolve(extDir),
        error: `Failed to parse manifest.json: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const validation = validateManifest(rawJson, entry.name, extDir, currentSchemaVersion);
    if (!validation.ok) {
      invalid.push({
        dirName: entry.name,
        dir: path.resolve(extDir),
        error: validation.error,
      });
      continue;
    }

    extensions.push(validation.extension);
  }

  extensions.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  invalid.sort((a, b) => a.dirName.localeCompare(b.dirName));

  return { extensions, invalid };
}

export function loadExtension(
  homeDir: string,
  name: string,
  currentSchemaVersion = 1,
): ResolvedExtension {
  const nameCheck = validateExtensionName(name);
  if (!nameCheck.ok) {
    throw new CliError('VALIDATION_ERROR', nameCheck.error, {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const extDir = path.join(homeDir, 'extensions', name);
  const manifestPath = path.join(extDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new CliError('NOT_FOUND', `Extension "${name}" is not installed.`, {
      exitCode: EXIT_CODES.NOT_FOUND,
      hint: `Expected manifest at ${manifestPath}`,
    });
  }

  let rawJson: unknown;
  try {
    const content = fs.readFileSync(manifestPath, 'utf8');
    rawJson = JSON.parse(content);
  } catch (err) {
    throw new CliError(
      'VALIDATION_ERROR',
      `Failed to parse manifest for extension "${name}": ${err instanceof Error ? err.message : String(err)}`,
      {
        exitCode: EXIT_CODES.USAGE,
        cause: err,
      },
    );
  }

  const validation = validateManifest(rawJson, name, extDir, currentSchemaVersion);
  if (!validation.ok) {
    throw new CliError(
      'VALIDATION_ERROR',
      `Invalid manifest for extension "${name}": ${validation.error}`,
      {
        exitCode: EXIT_CODES.USAGE,
      },
    );
  }

  if (!fs.existsSync(validation.extension.entryPath)) {
    throw new CliError(
      'VALIDATION_ERROR',
      `Extension "${name}" entry file does not exist: ${validation.extension.entryPath}`,
      {
        exitCode: EXIT_CODES.USAGE,
      },
    );
  }

  return validation.extension;
}

export function probePythonInterpreter(
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): PythonProbeResult | null {
  const targetPlatform = platform ?? process.platform;
  const candidates: Array<[string, string[]]> = [];

  const customPython = env?.TSUBASA_PYTHON?.trim();
  if (customPython) {
    candidates.push([customPython, []]);
  }

  if (targetPlatform === 'win32') {
    candidates.push(['py', ['-3']], ['python3', []], ['python', []]);
  } else {
    candidates.push(['python3', []], ['python', []]);
  }

  for (const [cmd, prefixArgs] of candidates) {
    const result = spawnSync(cmd, [...prefixArgs, '--version'], {
      shell: false,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ?? process.env,
    });

    if (result.status === 0 && !result.error) {
      const version = (result.stdout || result.stderr || '').trim();
      return {
        command: cmd,
        args: prefixArgs,
        version,
      };
    }
  }

  return null;
}

export function buildExtensionChildEnv(
  options: ExtensionChildEnvOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env) };

  env.TSUBASA_CLI_BIN = options.cliBin;
  env.TSUBASA_SCHEMA_VERSION = String(options.schemaVersion ?? 1);
  env.TSUBASA_TRANSPORT = options.transport;
  env.TSUBASA_HOME = options.homeDir;

  if (options.pool && options.pool.length > 0) {
    env.TSUBASA_POOL = options.pool;
  }

  if (options.transport === 'local') {
    delete env.TSUBASA_API_URL;
  } else if (options.transport === 'http' && options.apiUrl && options.apiUrl.length > 0) {
    env.TSUBASA_API_URL = options.apiUrl;
  }

  return env;
}

export async function runExtension(options: RunExtensionOptions): Promise<number> {
  const childEnv = buildExtensionChildEnv(options.envOptions);
  const { extension, args } = options;

  let command: string;
  let argv: string[];

  switch (extension.manifest.runtime) {
    case 'node': {
      command = process.execPath;
      argv = [extension.entryPath, ...args];
      break;
    }
    case 'python': {
      const py = probePythonInterpreter(childEnv);
      if (!py) {
        throw new CliError('RUNTIME_ERROR', 'No Python 3 interpreter found', {
          exitCode: EXIT_CODES.RUNTIME,
          hint: 'Install Python 3 or set TSUBASA_PYTHON.',
        });
      }
      command = py.command;
      argv = [...py.args, extension.entryPath, ...args];
      break;
    }
    case 'exec': {
      command = extension.entryPath;
      argv = [...args];
      break;
    }
  }

  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, argv, {
      shell: false,
      stdio: 'inherit',
      env: childEnv,
      cwd: options.cwd ?? process.cwd(),
    });

    const onSigInt = () => {
      if (!child.killed) {
        child.kill('SIGINT');
      }
    };

    const onSigTerm = () => {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    };

    const cleanup = () => {
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
    };

    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);

    child.once('error', (err) => {
      cleanup();
      reject(
        new CliError(
          'RUNTIME_ERROR',
          `Failed to execute extension "${extension.manifest.name}": ${err.message}`,
          {
            exitCode: EXIT_CODES.RUNTIME,
            cause: err,
          },
        ),
      );
    });

    child.once('close', (code, signal) => {
      cleanup();
      if (typeof code === 'number') {
        resolve(code);
        return;
      }
      if (signal === 'SIGINT') {
        resolve(130);
        return;
      }
      if (signal === 'SIGTERM') {
        resolve(143);
        return;
      }
      resolve(1);
    });
  });
}
