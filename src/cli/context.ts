import { createInterface } from 'node:readline/promises';
import { CliError, EXIT_CODES } from './lib/errors.js';
import { formatJsonlLine } from './lib/format.js';
import { redactPayload } from './lib/redact.js';
import type { CliTransport } from './transport.js';

export interface GlobalFlags {
  json: boolean;
  dryRun: boolean;
  yes: boolean;
  quiet: boolean;
  showEmails: boolean;
  noWaitOutbox: boolean;
  pool?: string;
  server?: string;
  local: boolean;
  home?: string;
  help: boolean;
}

export interface ParsedGlobalArgs {
  flags: GlobalFlags;
  args: string[];
}

export interface PoolInfo {
  id: number;
  name: string;
  slug: string;
  sortOrder: number;
  driveFolderName: string;
  isSharePool: boolean;
  accountCount: number;
  fileCount: number;
  totalBytes: number;
}

export interface CliContext {
  flags: GlobalFlags;
  transport: CliTransport;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  isTTY: boolean;
}

export type CommandHandler = (ctx: CliContext, args: string[]) => Promise<void>;

export interface CommandModule {
  run: CommandHandler;
}

export function createDefaultGlobalFlags(): GlobalFlags {
  return {
    json: false,
    dryRun: false,
    yes: false,
    quiet: false,
    showEmails: false,
    noWaitOutbox: false,
    local: false,
    help: false,
  };
}

function readFlagValue(argv: readonly string[], index: number, flagName: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new CliError('USAGE_ERROR', `Flag ${flagName} requires a value.`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }
  return value;
}

export function parseGlobalArgs(argv: readonly string[]): ParsedGlobalArgs {
  const flags = createDefaultGlobalFlags();
  const args: string[] = [];

  let stopGlobalFlags = false;
  let extSeen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (stopGlobalFlags) {
      args.push(token);
      continue;
    }

    if (token === '--') {
      stopGlobalFlags = true;
      args.push(token);
      continue;
    }

    // Preserve everything verbatim after `ext <name>` (except `ext list`).
    if (extSeen && !token.startsWith('-')) {
      args.push(token);
      if (token !== 'list') {
        stopGlobalFlags = true;
      }
      extSeen = false;
      continue;
    }

    if (token === '--json') {
      flags.json = true;
      continue;
    }
    if (token === '--dry-run') {
      flags.dryRun = true;
      continue;
    }
    if (token === '--yes' || token === '-y') {
      flags.yes = true;
      continue;
    }
    if (token === '--quiet' || token === '-q') {
      flags.quiet = true;
      continue;
    }
    if (token === '--show-emails') {
      flags.showEmails = true;
      continue;
    }
    if (token === '--no-wait-outbox') {
      flags.noWaitOutbox = true;
      continue;
    }
    if (token === '--local') {
      flags.local = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      flags.help = true;
      continue;
    }

    if (token === '--pool') {
      flags.pool = readFlagValue(argv, i, '--pool');
      i += 1;
      continue;
    }
    if (token.startsWith('--pool=')) {
      const value = token.slice('--pool='.length).trim();
      if (!value) {
        throw new CliError('USAGE_ERROR', 'Flag --pool requires a non-empty value.', {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      flags.pool = value;
      continue;
    }

    if (token === '--server') {
      flags.server = readFlagValue(argv, i, '--server');
      i += 1;
      continue;
    }
    if (token.startsWith('--server=')) {
      const value = token.slice('--server='.length).trim();
      if (!value) {
        throw new CliError('USAGE_ERROR', 'Flag --server requires a non-empty value.', {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      flags.server = value;
      continue;
    }

    if (token === '--home') {
      flags.home = readFlagValue(argv, i, '--home');
      i += 1;
      continue;
    }
    if (token.startsWith('--home=')) {
      const value = token.slice('--home='.length).trim();
      if (!value) {
        throw new CliError('USAGE_ERROR', 'Flag --home requires a non-empty value.', {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      flags.home = value;
      continue;
    }

    if (args.length === 0 && token === 'ext') {
      extSeen = true;
    }
    args.push(token);
  }

  return { flags, args };
}

export async function requireConfirmation(
  ctx: CliContext,
  actionDescription: string
): Promise<void> {
  if (ctx.flags.yes) {
    return;
  }

  if (!ctx.isTTY) {
    throw new CliError(
      'CONFIRMATION_REQUIRED',
      `Refusing to ${actionDescription} in non-interactive mode without --yes.`,
      {
        exitCode: EXIT_CODES.USAGE,
        hint: 'Pass --yes to confirm this destructive action.',
      }
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: ctx.stderr,
  });
  try {
    const answer = await rl.question(`Proceed to ${actionDescription}? [y/N] `);
    const normalized = answer.trim().toLowerCase();
    if (normalized !== 'y' && normalized !== 'yes') {
      throw new CliError('CONFIRMATION_REQUIRED', 'Action cancelled by user.', {
        exitCode: EXIT_CODES.USAGE,
      });
    }
  } finally {
    rl.close();
  }
}

export async function readStdinLines(): Promise<string[]> {
  if (process.stdin.isTTY) {
    throw new CliError('USAGE_ERROR', 'Flag --stdin requires piped input on standard input.', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function resolvePoolArg(
  ctx: CliContext,
  explicitPool?: string
): Promise<PoolInfo> {
  const payload = await ctx.transport.requestJson<{ pools: PoolInfo[] }>('/api/pools');
  const allPools = payload.pools ?? [];
  if (allPools.length === 0) {
    throw new CliError('POOL_NOT_FOUND', 'No storage pools exist.', {
      exitCode: EXIT_CODES.NOT_FOUND,
    });
  }

  const selector =
    explicitPool?.trim() ||
    ctx.flags.pool?.trim() ||
    process.env.TSUBASA_POOL?.trim() ||
    '';

  if (!selector) {
    const firstStandard = allPools.find((p) => !p.isSharePool);
    if (!firstStandard) {
      throw new CliError('POOL_NOT_FOUND', 'No standard storage pool is available.', {
        exitCode: EXIT_CODES.NOT_FOUND,
      });
    }
    return firstStandard;
  }

  if (/^\d+$/.test(selector)) {
    const targetId = Number(selector);
    const byId = allPools.find((p) => p.id === targetId);
    if (byId) {
      return byId;
    }
  }

  const lower = selector.toLowerCase();
  const bySlug = allPools.find((p) => p.slug.toLowerCase() === lower);
  if (bySlug) {
    return bySlug;
  }

  throw new CliError('POOL_NOT_FOUND', `Pool '${selector}' not found.`, {
    exitCode: EXIT_CODES.NOT_FOUND,
    hint: 'Run `tsubasa pool list` to see available pool IDs and slugs.',
  });
}

export function emitSuccess<T>(ctx: CliContext, data: T, humanText?: string): void {
  const redacted = redactPayload(data, { showEmails: ctx.flags.showEmails });
  if (ctx.flags.json) {
    ctx.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
    return;
  }
  if (ctx.flags.quiet) {
    return;
  }
  if (humanText !== undefined) {
    const normalized = humanText.endsWith('\n') || humanText.length === 0 ? humanText : `${humanText}\n`;
    ctx.stdout.write(normalized);
    return;
  }
  ctx.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
}

export function emitJsonl(ctx: CliContext, records: Iterable<unknown>): void {
  for (const record of records) {
    const redacted = redactPayload(record, { showEmails: ctx.flags.showEmails });
    ctx.stdout.write(formatJsonlLine(redacted));
  }
}
