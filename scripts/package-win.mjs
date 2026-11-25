import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const SQLITE_BUILD_DIR = path.join(PROJECT_ROOT, 'node_modules', 'better-sqlite3', 'build');
const SQLITE_BINARY_PATH = path.join(SQLITE_BUILD_DIR, 'Release', 'better_sqlite3.node');
const STAGING_DIR = path.join(PROJECT_ROOT, '.build');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');
const PORTABLE_MARKER_NAME = '.portable';
const PORTABLE_MARKER_CONTENT = 'Portable mode marker for Tsubasa~ Cloud.\n';

// Probe in a child process so Windows does not lock native .node binaries inside this process.
function canSystemNodeLoadSqlite() {
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      "import('better-sqlite3').then(({ default: Database }) => { const db = new Database(':memory:'); db.close(); })",
    ],
    {
      cwd: PROJECT_ROOT,
      stdio: 'ignore',
    }
  );

  return probe.status === 0;
}

function createSqliteBackup() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tsubasa-sqlite-backup-'));
  const backupBuildDir = path.join(tempRoot, 'build');
  fs.cpSync(SQLITE_BUILD_DIR, backupBuildDir, { recursive: true });

  // Move any live compiled .node binary off build/ on the same volume so electron-builder can
  // rebuild even when another Node process (such as dev:server) has it mapped on Windows.
  let movedNodePath = null;
  let createdStagingDir = false;
  if (fs.existsSync(SQLITE_BINARY_PATH)) {
    createdStagingDir = !fs.existsSync(STAGING_DIR);
    fs.mkdirSync(STAGING_DIR, { recursive: true });
    movedNodePath = path.join(STAGING_DIR, `better_sqlite3.${process.pid}.node.bak`);
    fs.renameSync(SQLITE_BINARY_PATH, movedNodePath);
  }

  return { tempRoot, backupBuildDir, movedNodePath, createdStagingDir };
}

function rebuildSqliteForSystemNode() {
  const isWin = process.platform === 'win32';
  const command = isWin ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const args = isWin
    ? ['/d', '/c', 'npm', 'rebuild', 'better-sqlite3']
    : ['rebuild', 'better-sqlite3'];

  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`npm rebuild better-sqlite3 failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function spawnElectronBuilder(extraArgs) {
  const isWin = process.platform === 'win32';
  const localBin = path.join(
    'node_modules',
    '.bin',
    isWin ? 'electron-builder.cmd' : 'electron-builder'
  );
  const absoluteBin = path.join(PROJECT_ROOT, localBin);

  if (!fs.existsSync(absoluteBin)) {
    throw new Error(`Missing local electron-builder binary at ${absoluteBin}`);
  }

  const builderArgs = ['--win', '--config', 'electron-builder.yml', ...extraArgs];
  const command = isWin ? process.env.ComSpec || 'cmd.exe' : absoluteBin;
  const args = isWin ? ['/d', '/c', localBin, ...builderArgs] : builderArgs;

  return spawn(command, args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
}

function findRecentZipArtifacts(releaseDir, buildStartMs) {
  if (!fs.existsSync(releaseDir)) {
    return [];
  }

  const thresholdMs = buildStartMs - 2000;
  const results = [];

  for (const entry of fs.readdirSync(releaseDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zip')) {
      continue;
    }

    const fullPath = path.join(releaseDir, entry.name);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs >= thresholdMs) {
      results.push(fullPath);
    }
  }

  return results;
}

export function injectPortableMarkerIntoZip(zipPath) {
  if (process.platform !== 'win32') {
    throw new Error('injectPortableMarkerIntoZip requires Windows PowerShell');
  }

  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$zipPath = $env:TSUBASA_ZIP_PATH',
    '$markerName = $env:TSUBASA_PORTABLE_NAME',
    '$markerContent = $env:TSUBASA_PORTABLE_CONTENT',
    '$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Update)',
    'try {',
    '  $existing = $zip.GetEntry($markerName)',
    '  if ($null -ne $existing) { $existing.Delete() }',
    '  $entry = $zip.CreateEntry($markerName, [System.IO.Compression.CompressionLevel]::Optimal)',
    '  $writer = New-Object System.IO.StreamWriter($entry.Open(), (New-Object System.Text.UTF8Encoding($false)))',
    '  try {',
    '    $writer.Write($markerContent)',
    '  } finally {',
    '    $writer.Dispose()',
    '  }',
    '} finally {',
    '  $zip.Dispose()',
    '}',
  ].join('; ');

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    {
      env: {
        ...process.env,
        TSUBASA_ZIP_PATH: zipPath,
        TSUBASA_PORTABLE_NAME: PORTABLE_MARKER_NAME,
        TSUBASA_PORTABLE_CONTENT: PORTABLE_MARKER_CONTENT,
      },
      encoding: 'utf8',
    }
  );

  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `Failed to inject ${PORTABLE_MARKER_NAME} into ${path.basename(zipPath)} (exit ${result.status ?? 'unknown'})${details ? `: ${details}` : ''}`
    );
  }
}

async function main() {
  const extraArgs = process.argv.slice(2);
  const hadBuildDir = fs.existsSync(SQLITE_BUILD_DIR);
  const systemNodeLoadedBefore = canSystemNodeLoadSqlite();
  let backup = null;
  let cleanedUp = false;
  let activeChild = null;

  if (hadBuildDir && systemNodeLoadedBefore) {
    backup = createSqliteBackup();
  }

  const restoreSqlite = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    try {
      if (backup) {
        fs.rmSync(SQLITE_BUILD_DIR, { recursive: true, force: true });
        fs.cpSync(backup.backupBuildDir, SQLITE_BUILD_DIR, { recursive: true });
        if (backup.movedNodePath && fs.existsSync(backup.movedNodePath)) {
          fs.rmSync(SQLITE_BINARY_PATH, { force: true });
          fs.renameSync(backup.movedNodePath, SQLITE_BINARY_PATH);
        }
      } else if (!hadBuildDir) {
        // Restore prebuild-only state if electron-builder generated a local build/ directory.
        fs.rmSync(SQLITE_BUILD_DIR, { recursive: true, force: true });
        if (!canSystemNodeLoadSqlite()) {
          rebuildSqliteForSystemNode();
        }
      } else {
        rebuildSqliteForSystemNode();
      }
    } finally {
      if (backup) {
        fs.rmSync(backup.tempRoot, { recursive: true, force: true });
        if (backup.createdStagingDir) {
          try {
            if (fs.existsSync(STAGING_DIR) && fs.readdirSync(STAGING_DIR).length === 0) {
              fs.rmdirSync(STAGING_DIR);
            }
          } catch {
            // Leave .build intact if another process is using it.
          }
        }
      }
    }
  };

  const handleTerminationSignal = (signal) => {
    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      activeChild.kill(signal);
    }
    try {
      restoreSqlite();
    } catch (err) {
      console.error('Failed to restore better-sqlite3 after signal:', err);
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };

  process.once('SIGINT', () => handleTerminationSignal('SIGINT'));
  process.once('SIGTERM', () => handleTerminationSignal('SIGTERM'));

  let exitCode = 0;
  const buildStartMs = Date.now();

  try {
    activeChild = spawnElectronBuilder(extraArgs);

    exitCode = await new Promise((resolve, reject) => {
      activeChild.once('error', reject);
      activeChild.once('exit', (code, signal) => {
        if (signal) {
          resolve(signal === 'SIGINT' ? 130 : 143);
          return;
        }
        resolve(code ?? 1);
      });
    });
  } finally {
    restoreSqlite();
  }

  if (!canSystemNodeLoadSqlite()) {
    throw new Error(
      'System Node failed to load better-sqlite3 after restoring node_modules/better-sqlite3'
    );
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }

  // Inject `.portable` only into freshly built `.zip` archives; never touch `release/win-unpacked/`.
  const zipArtifacts = findRecentZipArtifacts(RELEASE_DIR, buildStartMs);
  for (const zipPath of zipArtifacts) {
    injectPortableMarkerIntoZip(zipPath);
    console.log(`Injected ${PORTABLE_MARKER_NAME} into ${path.basename(zipPath)}`);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
