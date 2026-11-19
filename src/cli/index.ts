#!/usr/bin/env node
import {
  computeDbFingerprint,
  resolveTsubasaPaths,
  setTsubasaHomeOverride,
} from '../server/paths.js';
import {
  parseGlobalArgs,
  type CliContext,
  type CommandHandler,
  type GlobalFlags,
} from './context.js';
import { createCliTransport, type CliTransport } from './transport.js';
import { CliError, EXIT_CODES, formatCliError } from './lib/errors.js';
import { CLI_HELP_SCHEMA, serializeHelpSchema } from './lib/helpSchema.js';
import {
  handleStatus,
  handleLs,
  handleStat,
  handleFind,
  handleMkdir,
  handleMv,
  handleCp,
  handleRm,
} from './commands/files.js';
import { handlePool } from './commands/pools.js';
import { handleAccount } from './commands/accounts.js';
import {
  handleTrash,
  handleSync,
  handleOutbox,
  handleShare,
  handleAudit,
  handleDupes,
  handleDb,
} from './commands/ops.js';
import { runAuthCommand } from './commands/auth.js';
import { handleExport } from './commands/export.js';
import { handleExt } from './commands/ext.js';
import { handleDownload } from './commands/download.js';
import { handleUpload, handlePlanUpload } from './commands/upload.js';
import { handleJob } from './commands/jobs.js';
import { handleImport, handlePlanImportDrive } from './commands/import.js';

async function handlePlan(ctx: CliContext, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa plan <upload|import-drive> [args...]', {
      exitCode: EXIT_CODES.USAGE,
    });
  }
  if (sub === 'upload') {
    await handlePlanUpload(ctx, args.slice(1));
    return;
  }
  if (sub === 'import-drive') {
    await handlePlanImportDrive(ctx, args.slice(1));
    return;
  }
  throw new CliError('USAGE_ERROR', `Unknown plan subcommand '${sub}'. Expected: upload, import-drive.`, {
    exitCode: EXIT_CODES.USAGE,
  });
}

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  status: handleStatus,
  ls: handleLs,
  stat: handleStat,
  find: handleFind,
  mkdir: handleMkdir,
  mv: handleMv,
  cp: handleCp,
  rm: handleRm,
  upload: handleUpload,
  download: handleDownload,
  export: handleExport,
  ext: handleExt,
  job: handleJob,
  import: handleImport,
  plan: handlePlan,
  pool: handlePool,
  account: handleAccount,
  trash: handleTrash,
  sync: handleSync,
  outbox: handleOutbox,
  share: handleShare,
  audit: handleAudit,
  dupes: handleDupes,
  db: handleDb,
  auth: runAuthCommand,
};

function isWriteCommand(command: string, subArgs: readonly string[], flags: GlobalFlags): boolean {
  if (flags.dryRun) {
    return false;
  }

  const sub = subArgs[0];
  switch (command) {
    case 'status':
    case 'ls':
    case 'stat':
    case 'find':
    case 'audit':
    case 'dupes':
    case 'download':
    case 'export':
    case 'plan':
      return false;

    case 'mkdir':
    case 'mv':
    case 'cp':
    case 'rm':
    case 'upload':
      return true;

    case 'job':
      return sub !== 'list' && sub !== 'status';

    case 'pool':
      return sub !== 'list' && sub !== 'show';

    case 'account':
      if (sub === 'list' || sub === 'show') {
        return false;
      }
      if (sub === 'quota') {
        return subArgs.includes('--refresh');
      }
      return true;

    case 'trash':
      return sub !== 'list';

    case 'outbox':
      return sub !== 'list';

    case 'share':
      return sub !== 'list';

    case 'sync':
      return true;

    case 'auth':
      return sub !== 'check';

    case 'db':
      return sub !== 'backup';

    case 'import':
      if (sub === 'tokens' && subArgs[1] === 'list') {
        return false;
      }
      return true;

    default:
      return false;
  }
}

function renderHumanHelp(commandName?: string): string {
  if (commandName) {
    const matched = CLI_HELP_SCHEMA.commands.find((c) => c.name === commandName);
    if (matched) {
      const lines = [
        `${matched.usage}`,
        '',
        matched.description,
      ];
      if (matched.subcommands && matched.subcommands.length > 0) {
        lines.push('', 'Subcommands:');
        for (const sub of matched.subcommands) {
          lines.push(`  ${sub.usage.padEnd(42)} ${sub.description}`);
        }
      }
      lines.push('', 'Run `tsubasa --help` for global flags and all commands.');
      return `${lines.join('\n')}\n`;
    }
  }

  const lines: string[] = [
    `${CLI_HELP_SCHEMA.name} - ${CLI_HELP_SCHEMA.description}`,
    '',
    'Usage:',
    '  tsubasa [global-flags] <command> [args...]',
    '',
    'Global flags:',
  ];

  for (const flag of CLI_HELP_SCHEMA.globalFlags) {
    const label = [flag.name, flag.alias, flag.arg].filter(Boolean).join(' ');
    lines.push(`  ${label.padEnd(28)} ${flag.description}`);
  }

  lines.push('', 'Commands:');
  for (const cmd of CLI_HELP_SCHEMA.commands) {
    lines.push(`  ${cmd.name.padEnd(16)} ${cmd.description}`);
  }

  lines.push('', 'Exit codes:');
  for (const ec of CLI_HELP_SCHEMA.exitCodes) {
    lines.push(`  ${String(ec.code).padEnd(4)} ${ec.name.padEnd(28)} ${ec.description}`);
  }

  return `${lines.join('\n')}\n`;
}

async function createProbeOnlyTransport(flags: GlobalFlags): Promise<CliTransport> {
  if (flags.home) {
    setTsubasaHomeOverride(flags.home);
  }
  const paths = resolveTsubasaPaths(flags.home);
  const dbFingerprint = computeDbFingerprint(paths.dbPath);

  const rawExplicitServer = flags.server?.trim() || process.env.TSUBASA_API_URL?.trim() || '';
  if (rawExplicitServer && flags.local) {
    throw new CliError(
      'USAGE_ERROR',
      'Cannot combine --server / TSUBASA_API_URL with --local.',
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  let mode: 'http' | 'local' = 'local';
  let serverUrl: string | null = null;

  if (rawExplicitServer) {
    mode = 'http';
    serverUrl = rawExplicitServer.replace(/\/+$/, '');
  } else if (!flags.local) {
    const defaultUrl = `http://127.0.0.1:${process.env.PORT?.trim() || '3000'}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    try {
      const res = await fetch(`${defaultUrl}/api/health`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (res.ok) {
        const body = (await res.json()) as { service?: unknown; dbFingerprint?: unknown };
        if (body.service === 'tsubasa-backend' && body.dbFingerprint === dbFingerprint) {
          mode = 'http';
          serverUrl = defaultUrl;
        }
      }
    } catch {
      // Fall back to local mode for extension child env.
    } finally {
      clearTimeout(timer);
    }
  }

  const unsupported = async (): Promise<never> => {
    throw new CliError('RUNTIME_ERROR', 'Probe-only transport does not execute API requests.', {
      exitCode: EXIT_CODES.RUNTIME,
    });
  };

  return {
    mode,
    serverUrl,
    homeDir: paths.homeDir,
    dbPath: paths.dbPath,
    dbFingerprint,
    request: unsupported,
    requestJson: unsupported,
    async close(): Promise<void> {},
  };
}

async function main(): Promise<void> {
  let flagsForErrors: { json: boolean; showEmails: boolean } = {
    json: false,
    showEmails: false,
  };

  try {
    const { flags, args } = parseGlobalArgs(process.argv.slice(2));
    flagsForErrors = { json: flags.json, showEmails: flags.showEmails };

    if (flags.help || args.length === 0) {
      if (flags.json) {
        process.stdout.write(`${serializeHelpSchema(true)}\n`);
      } else {
        process.stdout.write(renderHumanHelp(args[0]));
      }
      return;
    }

    const [command, ...subArgs] = args;
    const handler = COMMAND_HANDLERS[command];
    if (!handler) {
      throw new CliError(
        'USAGE_ERROR',
        `Unknown command '${command}'.`,
        {
          exitCode: EXIT_CODES.USAGE,
          hint: "Run 'tsubasa --help' to list available commands.",
        }
      );
    }

    const transport =
      command === 'ext'
        ? await createProbeOnlyTransport(flags)
        : await createCliTransport({
            homeDir: flags.home,
            server: flags.server,
            local: flags.local,
            write: isWriteCommand(command, subArgs, flags),
            noWaitOutbox: flags.noWaitOutbox,
          });

    const ctx: CliContext = {
      flags,
      transport,
      stdout: process.stdout,
      stderr: process.stderr,
      isTTY: Boolean(process.stdin.isTTY),
    };

    try {
      await handler(ctx, subArgs);
    } finally {
      await transport.close();
    }
  } catch (err) {
    const formatted = formatCliError(err, flagsForErrors);
    process.stderr.write(formatted.text);
    process.exitCode = formatted.exitCode;
  }
}

void main();
