#!/usr/bin/env node
import {
  parseGlobalArgs,
  type CliContext,
  type CommandHandler,
  type GlobalFlags,
} from './context.js';
import { createCliTransport } from './transport.js';
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

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  status: handleStatus,
  ls: handleLs,
  stat: handleStat,
  find: handleFind,
  mkdir: handleMkdir,
  mv: handleMv,
  cp: handleCp,
  rm: handleRm,
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
      return false;

    case 'mkdir':
    case 'mv':
    case 'cp':
    case 'rm':
      return true;

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

    const write = isWriteCommand(command, subArgs, flags);
    const transport = await createCliTransport({
      homeDir: flags.home,
      server: flags.server,
      local: flags.local,
      write,
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
