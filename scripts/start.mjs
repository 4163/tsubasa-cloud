import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const SERVER_ENTRY = path.join(PROJECT_ROOT, 'dist', 'server', 'index.js');
const CLIENT_ENTRY = path.join(PROJECT_ROOT, 'dist', 'index.html');
const SHUTDOWN_TIMEOUT_MS = 5000;

function ensureBuildArtifacts() {
  const missing = [];
  if (!fs.existsSync(SERVER_ENTRY)) {
    missing.push('dist/server/index.js');
  }
  if (!fs.existsSync(CLIENT_ENTRY)) {
    missing.push('dist/index.html');
  }

  if (missing.length > 0) {
    console.error(`Missing compiled bundle: ${missing.join(', ')}.`);
    console.error('Run `npm run build` first, then retry `npm start`.');
    process.exit(1);
  }
}

function main() {
  ensureBuildArtifacts();

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      TSUBASA_SERVE_STATIC: '1',
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });

  let shuttingDown = false;
  let forceKillTimer = null;

  const clearForceKillTimer = () => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  };

  const requestGracefulShutdown = (signal) => {
    if (shuttingDown || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    shuttingDown = true;

    // On Windows, child.kill('SIGINT') calls TerminateProcess and skips cleanup;
    // IPC lets dist/server/index.js close SQLite and release data/tsubasa.writer.lock.
    if (child.connected) {
      try {
        child.send({ type: 'tsubasa-server-shutdown' });
      } catch {
        child.kill(signal);
      }
    } else {
      child.kill(signal);
    }

    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, SHUTDOWN_TIMEOUT_MS);
    forceKillTimer.unref();
  };

  process.on('SIGINT', () => requestGracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => requestGracefulShutdown('SIGTERM'));

  child.once('error', (err) => {
    clearForceKillTimer();
    console.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  });

  child.once('exit', (code, signal) => {
    clearForceKillTimer();
    if (signal) {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }
    process.exit(code ?? 1);
  });
}

main();
