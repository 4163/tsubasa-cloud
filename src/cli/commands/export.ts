import { readFlagValue, throwHttpError, type CliContext } from '../context.js';
import { CliError, EXIT_CODES } from '../lib/errors.js';
import { formatCsv } from '../lib/format.js';

const EXPORT_ENTITIES = new Set([
  'pools',
  'accounts',
  'folders',
  'files',
  'transferLogs',
  'shareLinks',
  'outbox',
  'transferJobs',
]);

function projectRowFields(
  row: Record<string, unknown>,
  fields: readonly string[],
  preserveType = false
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (preserveType && '_type' in row) {
    out._type = row._type;
  }
  for (const field of fields) {
    if (field in row) {
      out[field] = row[field];
    } else {
      out[field] = null;
    }
  }
  return out;
}

async function writeChunk(stream: NodeJS.WriteStream, chunk: Uint8Array | string): Promise<void> {
  if (stream.write(chunk)) {
    return;
  }
  await new Promise<void>((resolve) => {
    stream.once('drain', resolve);
  });
}

export async function handleExport(ctx: CliContext, args: string[]): Promise<void> {
  let preset = 'standard';
  const includes: string[] = [];
  let explicitPool: string | undefined;
  let account: string | undefined;
  let pathFilter: string | undefined;
  let trashed = 'exclude';
  let format = 'json';
  let entity: string | undefined;
  let fields: string[] | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--preset') {
      preset = readFlagValue(args, i, '--preset').trim().toLowerCase();
      i += 1;
      continue;
    }
    if (token.startsWith('--preset=')) {
      preset = token.slice('--preset='.length).trim().toLowerCase();
      continue;
    }
    if (token === '--include') {
      const val = readFlagValue(args, i, '--include');
      includes.push(...val.split(',').map((s) => s.trim()).filter(Boolean));
      i += 1;
      continue;
    }
    if (token.startsWith('--include=')) {
      const val = token.slice('--include='.length);
      includes.push(...val.split(',').map((s) => s.trim()).filter(Boolean));
      continue;
    }
    if (token === '--pool') {
      explicitPool = readFlagValue(args, i, '--pool').trim();
      i += 1;
      continue;
    }
    if (token.startsWith('--pool=')) {
      explicitPool = token.slice('--pool='.length).trim();
      continue;
    }
    if (token === '--account') {
      account = readFlagValue(args, i, '--account').trim();
      i += 1;
      continue;
    }
    if (token.startsWith('--account=')) {
      account = token.slice('--account='.length).trim();
      continue;
    }
    if (token === '--path') {
      pathFilter = readFlagValue(args, i, '--path').trim();
      i += 1;
      continue;
    }
    if (token.startsWith('--path=')) {
      pathFilter = token.slice('--path='.length).trim();
      continue;
    }
    if (token === '--trashed') {
      trashed = readFlagValue(args, i, '--trashed').trim().toLowerCase();
      i += 1;
      continue;
    }
    if (token.startsWith('--trashed=')) {
      trashed = token.slice('--trashed='.length).trim().toLowerCase();
      continue;
    }
    if (token === '--format') {
      format = readFlagValue(args, i, '--format').trim().toLowerCase();
      i += 1;
      continue;
    }
    if (token.startsWith('--format=')) {
      format = token.slice('--format='.length).trim().toLowerCase();
      continue;
    }
    if (token === '--entity') {
      entity = readFlagValue(args, i, '--entity').trim();
      i += 1;
      continue;
    }
    if (token.startsWith('--entity=')) {
      entity = token.slice('--entity='.length).trim();
      continue;
    }
    if (token === '--fields') {
      const rawFields = readFlagValue(args, i, '--fields');
      fields = rawFields.split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
      continue;
    }
    if (token.startsWith('--fields=')) {
      const rawFields = token.slice('--fields='.length);
      fields = rawFields.split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }

    throw new CliError('USAGE_ERROR', `Unknown argument for export: ${token}`, {
      exitCode: EXIT_CODES.USAGE,
    });
  }

  if (format === 'table') {
    throw new CliError(
      'USAGE_ERROR',
      'export does not support --format table. Use json, jsonl, or csv (with --entity).',
      { exitCode: EXIT_CODES.USAGE }
    );
  }
  if (format !== 'json' && format !== 'jsonl' && format !== 'csv') {
    throw new CliError(
      'USAGE_ERROR',
      `Invalid export format '${format}'. Expected json, jsonl, or csv.`,
      { exitCode: EXIT_CODES.USAGE }
    );
  }
  if (preset !== 'minimal' && preset !== 'standard' && preset !== 'full') {
    throw new CliError(
      'USAGE_ERROR',
      `Invalid preset '${preset}'. Expected minimal, standard, or full.`,
      { exitCode: EXIT_CODES.USAGE }
    );
  }
  if (trashed !== 'exclude' && trashed !== 'include' && trashed !== 'only') {
    throw new CliError(
      'USAGE_ERROR',
      `Invalid trashed mode '${trashed}'. Expected exclude, include, or only.`,
      { exitCode: EXIT_CODES.USAGE }
    );
  }

  if (entity !== undefined) {
    if (!EXPORT_ENTITIES.has(entity)) {
      throw new CliError(
        'USAGE_ERROR',
        `Unknown entity '${entity}'. Allowed: ${Array.from(EXPORT_ENTITIES).join(', ')}.`,
        { exitCode: EXIT_CODES.USAGE }
      );
    }
    if (includes.length > 0 && (includes.length > 1 || includes[0] !== entity)) {
      throw new CliError(
        'USAGE_ERROR',
        'Cannot combine --entity with multiple or conflicting --include entities.',
        { exitCode: EXIT_CODES.USAGE }
      );
    }
  }

  for (const inc of includes) {
    if (!EXPORT_ENTITIES.has(inc)) {
      throw new CliError(
        'USAGE_ERROR',
        `Unknown entity '${inc}' in --include. Allowed: ${Array.from(EXPORT_ENTITIES).join(', ')}.`,
        { exitCode: EXIT_CODES.USAGE }
      );
    }
  }

  if (format === 'csv' && !entity) {
    throw new CliError(
      'USAGE_ERROR',
      '--format csv requires a single --entity <name>.',
      {
        exitCode: EXIT_CODES.USAGE,
        hint: 'Example: tsubasa export --format csv --entity files',
      }
    );
  }

  if (fields && fields.length > 0 && !entity) {
    throw new CliError(
      'USAGE_ERROR',
      '--fields requires a single --entity <name>.',
      {
        exitCode: EXIT_CODES.USAGE,
        hint: 'Example: tsubasa export --entity files --fields id,virtualPath,sizeBytes',
      }
    );
  }

  const effectiveInclude = entity ? [entity] : includes;
  const query = new URLSearchParams();
  query.set('format', format === 'jsonl' ? 'jsonl' : 'json');
  query.set('preset', preset);
  query.set('trashed', trashed);
  if (effectiveInclude.length > 0) {
    query.set('include', effectiveInclude.join(','));
  }
  const poolFilter = explicitPool || ctx.flags.pool;
  if (poolFilter) {
    query.set('pool', poolFilter);
  }
  if (account) {
    query.set('account', account);
  }
  if (pathFilter) {
    query.set('path', pathFilter);
  }
  if (ctx.flags.showEmails) {
    query.set('showEmails', 'true');
  }

  const url = `/api/export?${query.toString()}`;

  if (format === 'jsonl') {
    const response = await ctx.transport.request(url, {
      method: 'GET',
      headers: { Accept: 'application/x-ndjson' },
    });
    if (!response.ok) {
      await throwHttpError(response);
    }
    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    if (!fields || fields.length === 0) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            await writeChunk(ctx.stdout, value);
          }
        }
      } finally {
        reader.releaseLock();
      }
      return;
    }

    // Stream line-by-line when projecting --fields on a single entity.
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          if (line.trim().length > 0) {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const outRecord =
              parsed._type === 'meta'
                ? parsed
                : projectRowFields(parsed, fields, true);
            await writeChunk(ctx.stdout, `${JSON.stringify(outRecord)}\n`);
          }
          newlineIdx = buffer.indexOf('\n');
        }
      }
      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        const parsed = JSON.parse(buffer) as Record<string, unknown>;
        const outRecord =
          parsed._type === 'meta'
            ? parsed
            : projectRowFields(parsed, fields, true);
        await writeChunk(ctx.stdout, `${JSON.stringify(outRecord)}\n`);
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }

  const payload = await ctx.transport.requestJson<Record<string, unknown>>(url);

  if (format === 'csv' && entity) {
    const rows = Array.isArray(payload[entity])
      ? (payload[entity] as Record<string, unknown>[])
      : [];
    const csv = formatCsv(rows, fields);
    ctx.stdout.write(csv.length > 0 ? `${csv}\n` : '');
    return;
  }

  if (entity && fields && fields.length > 0 && Array.isArray(payload[entity])) {
    payload[entity] = (payload[entity] as Record<string, unknown>[]).map((row) =>
      projectRowFields(row, fields)
    );
  }

  ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
