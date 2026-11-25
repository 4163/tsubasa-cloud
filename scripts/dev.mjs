import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const IS_WIN = process.platform === 'win32';
const FORCE_KILL_DELAY_MS = 1500;

const SERVICES = [
  { name: 'server', script: 'dev:server', color: '\x1b[36m' },
  { name: 'web', script: 'dev:web', color: '\x1b[35m' },
];

const RESET = '\x1b[0m';

function formatPrefix(service, isTty) {
  const label = `[${service.name}]`;
  return isTty ? `${service.color}${label}${RESET} ` : `${label} `;
}

function pipePrefixed(stream, target, prefix) {
  let buffer = '';

  const flushLine = (line) => {
    const cleaned = line.endsWith('\r') ? line.slice(0, -1) : line;
    target.write(`${prefix}${cleaned}\n`);
  };

  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      flushLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  });

  stream.on('end', () => {
    if (buffer.length > 0) {
      flushLine(buffer);
      buffer = '';
    }
  });
}

function spawnNpmScript(scriptName) {
  const command = IS_WIN ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const args = IS_WIN ? ['/d', '/c', 'npm', 'run', scriptName] : ['run', scriptName];
  const env = { ...process.env };
  if (process.stdout.isTTY && env.FORCE_COLOR === undefined) {
    env.FORCE_COLOR = '1';
  }

  return spawn(command, args, {
    cwd: PROJECT_ROOT,
    env,
    // Ignore stdin so Windows cmd.exe wrappers do not prompt "Terminate batch job (Y/N)?".
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function forceKillTree(child) {
  if (!isRunning(child) || !child.pid) {
    return;
  }

  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // Process already exited.
  }
}

function requestStop(child, signal) {
  if (!isRunning(child) || !child.pid) {
    return;
  }

  if (IS_WIN) {
    // Attempt graceful process-tree termination first; callers follow up with forceKillTree.
    spawn('taskkill', ['/PID', String(child.pid), '/T'], { stdio: 'ignore' });
    return;
  }

  try {
    child.kill(signal);
  } catch {
    // Process already exited.
  }
}

function main() {
  const entries = SERVICES.map((service) => {
    const child = spawnNpmScript(service.script);
    if (child.stdout) {
      pipePrefixed(child.stdout, process.stdout, formatPrefix(service, Boolean(process.stdout.isTTY)));
    }
    if (child.stderr) {
      pipePrefixed(child.stderr, process.stderr, formatPrefix(service, Boolean(process.stderr.isTTY)));
    }
    return { service, child };
  });

  let shuttingDown = false;
  let finalExitCode = 0;
  let forceKillTimer = null;
  let remaining = entries.length;

  const finishIfAllExited = () => {
    if (remaining > 0) {
      return;
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    process.exit(finalExitCode);
  };

  const shutdown = (exitCode, signal = 'SIGTERM') => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    finalExitCode = exitCode;

    for (const { child } of entries) {
      requestStop(child, signal);
    }

    forceKillTimer = setTimeout(() => {
      for (const { child } of entries) {
        forceKillTree(child);
      }
      process.exit(finalExitCode);
    }, FORCE_KILL_DELAY_MS);
    forceKillTimer.unref();

    finishIfAllExited();
  };

  for (const { service, child } of entries) {
    child.once('error', (err) => {
      console.error(`[${service.name}] failed to start: ${err.message}`);
      remaining = Math.max(0, remaining - 1);
      shutdown(1);
    });

    child.once('exit', (code, signal) => {
      remaining = Math.max(0, remaining - 1);

      if (!shuttingDown) {
        const exitCode = code && code !== 0 ? code : 1;
        const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        console.error(`[${service.name}] exited unexpectedly (${reason}); stopping remaining processes.`);
        shutdown(exitCode);
        return;
      }

      finishIfAllExited();
    });
  }

  process.once('SIGINT', () => shutdown(130, 'SIGINT'));
  process.once('SIGTERM', () => shutdown(143, 'SIGTERM'));
}

main();
