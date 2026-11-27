import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDemoDir = path.join(rootDir, 'dist', 'demo');
const sitePublicDir = path.join(rootDir, 'site', 'public');
const targetDemoDir = path.join(sitePublicDir, 'demo');
const stagingDir = path.join(sitePublicDir, `.demo-sync-tmp-${process.pid}`);
const backupDir = path.join(sitePublicDir, `.demo-sync-prev-${process.pid}`);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const buildResult = spawnSync(npmCmd, ['run', 'build:demo'], {
  cwd: rootDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

const builtIndexPath = path.join(distDemoDir, 'index.html');
if (!fs.existsSync(builtIndexPath)) {
  console.error(`Demo build output missing: ${builtIndexPath}`);
  process.exit(1);
}

const RM_OPTIONS = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 };

fs.mkdirSync(sitePublicDir, { recursive: true });
fs.rmSync(stagingDir, RM_OPTIONS);
fs.rmSync(backupDir, RM_OPTIONS);

function isDirLockError(err) {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err.code === 'EPERM' || err.code === 'EBUSY'));
}

function replaceInPlace(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(destinationDir)) {
    fs.rmSync(path.join(destinationDir, entry), RM_OPTIONS);
  }
  fs.cpSync(sourceDir, destinationDir, { recursive: true, force: true });
}

try {
  fs.cpSync(distDemoDir, stagingDir, { recursive: true });

  const hadExistingTarget = fs.existsSync(targetDemoDir);
  if (hadExistingTarget) {
    let renamedTarget = false;
    try {
      fs.renameSync(targetDemoDir, backupDir);
      renamedTarget = true;
    } catch (renameErr) {
      if (!isDirLockError(renameErr)) {
        throw renameErr;
      }
      replaceInPlace(stagingDir, targetDemoDir);
    }

    if (renamedTarget) {
      try {
        fs.renameSync(stagingDir, targetDemoDir);
      } catch (swapErr) {
        if (fs.existsSync(backupDir) && !fs.existsSync(targetDemoDir)) {
          fs.renameSync(backupDir, targetDemoDir);
        }
        throw swapErr;
      }
      try {
        fs.rmSync(backupDir, RM_OPTIONS);
      } catch (cleanupErr) {
        console.warn(`Warning: failed to remove backup directory ${backupDir}:`, cleanupErr);
      }
    }
  } else {
    try {
      fs.renameSync(stagingDir, targetDemoDir);
    } catch (renameErr) {
      if (!isDirLockError(renameErr)) {
        throw renameErr;
      }
      replaceInPlace(stagingDir, targetDemoDir);
    }
  }
} finally {
  fs.rmSync(stagingDir, RM_OPTIONS);
}

console.log(`Synced demo bundle to ${targetDemoDir}`);
