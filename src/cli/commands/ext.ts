import path from 'node:path';
import { emitSuccess, type CliContext } from '../context.js';
import { CliError, EXIT_CODES } from '../lib/errors.js';
import {
  buildExtensionChildEnv,
  discoverExtensions,
  loadExtension,
  runExtension,
} from '../lib/extensions.js';
import { renderTable } from '../lib/format.js';

const CURRENT_CLI_SCHEMA_VERSION = 1;

function resolveCliBin(): string {
  const entry = process.argv[1]?.trim();
  if (!entry) {
    return 'tsubasa';
  }
  return path.resolve(entry);
}

async function handleExtList(ctx: CliContext, args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new CliError('USAGE_ERROR', `Unexpected argument '${args[0]}' for ext list.`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const discovery = discoverExtensions(ctx.transport.homeDir, CURRENT_CLI_SCHEMA_VERSION);
  const extensions = discovery.extensions.map((ext) => ({
    name: ext.manifest.name,
    description: ext.manifest.description,
    runtime: ext.manifest.runtime,
    entry: ext.manifest.entry,
    minSchemaVersion: ext.manifest.minSchemaVersion ?? null,
    dir: ext.dir,
    entryPath: ext.entryPath,
    manifestPath: ext.manifestPath,
  }));

  const payload = {
    extensionsDir: path.join(ctx.transport.homeDir, 'extensions'),
    extensions,
    invalid: discovery.invalid,
  };

  const lines: string[] = [];
  lines.push(
    renderTable(
      extensions,
      [
        { key: 'name', header: 'NAME' },
        { key: 'runtime', header: 'RUNTIME' },
        { key: 'entry', header: 'ENTRY' },
        {
          key: 'minSchemaVersion',
          header: 'MIN SCHEMA',
          align: 'right',
          format: (row) => (row.minSchemaVersion === null ? '-' : String(row.minSchemaVersion)),
        },
        { key: 'description', header: 'DESCRIPTION' },
      ],
      { emptyMessage: 'No extensions installed.' }
    )
  );

  if (discovery.invalid.length > 0) {
    lines.push('');
    lines.push('Invalid extensions:');
    for (const entry of discovery.invalid) {
      lines.push(`  ${entry.dirName}: ${entry.error}`);
    }
  }

  emitSuccess(ctx, payload, lines.join('\n'));
}

export async function handleExt(ctx: CliContext, args: string[]): Promise<void> {
  if (args.length === 0) {
    throw new CliError('USAGE_ERROR', 'Usage: tsubasa ext <list | <name> [args...]>', {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  const [subcommand, ...rest] = args;
  if (subcommand === 'list') {
    await handleExtList(ctx, rest);
    return;
  }

  const extension = loadExtension(
    ctx.transport.homeDir,
    subcommand,
    CURRENT_CLI_SCHEMA_VERSION
  );

  const envOptions = {
    cliBin: resolveCliBin(),
    schemaVersion: CURRENT_CLI_SCHEMA_VERSION,
    transport: ctx.transport.mode,
    homeDir: ctx.transport.homeDir,
    pool: ctx.flags.pool ?? process.env.TSUBASA_POOL,
    apiUrl: ctx.transport.mode === 'http' ? (ctx.transport.serverUrl ?? undefined) : undefined,
  };

  if (ctx.flags.dryRun) {
    const childEnv = buildExtensionChildEnv(envOptions);
    emitSuccess(
      ctx,
      {
        dryRun: true,
        action: 'ext',
        name: extension.manifest.name,
        runtime: extension.manifest.runtime,
        entryPath: extension.entryPath,
        args: rest,
        env: {
          TSUBASA_CLI_BIN: childEnv.TSUBASA_CLI_BIN,
          TSUBASA_SCHEMA_VERSION: childEnv.TSUBASA_SCHEMA_VERSION,
          TSUBASA_TRANSPORT: childEnv.TSUBASA_TRANSPORT,
          TSUBASA_HOME: childEnv.TSUBASA_HOME,
          TSUBASA_POOL: childEnv.TSUBASA_POOL ?? null,
          TSUBASA_API_URL: childEnv.TSUBASA_API_URL ?? null,
        },
      },
      `[dry-run] exec ${extension.manifest.name} (${extension.manifest.runtime}: ${extension.entryPath}) args=${JSON.stringify(rest)}`
    );
    return;
  }

  const exitCode = await runExtension({
    extension,
    args: rest,
    envOptions,
  });

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
