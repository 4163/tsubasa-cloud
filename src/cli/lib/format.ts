export interface TableColumn<T> {
  key: string;
  header: string;
  align?: 'left' | 'right';
  format?: (row: T) => string;
}

function padCell(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  return align === 'right' ? value.padStart(width, ' ') : value.padEnd(width, ' ');
}

export function renderTable<T extends Record<string, unknown>>(
  rows: readonly T[],
  columns: readonly TableColumn<T>[],
  options?: { emptyMessage?: string },
): string {
  if (rows.length === 0) {
    return options?.emptyMessage ?? '';
  }
  if (columns.length === 0) {
    return '';
  }

  const widths = columns.map((col) => col.header.length);
  const renderedRows: string[][] = [];

  for (const row of rows) {
    const cells: string[] = [];
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const raw = col.format ? col.format(row) : row[col.key];
      const text = raw === null || raw === undefined ? '' : String(raw);
      cells.push(text);
      if (text.length > widths[i]) {
        widths[i] = text.length;
      }
    }
    renderedRows.push(cells);
  }

  const headerLine = columns
    .map((col, i) => padCell(col.header, widths[i], col.align))
    .join('  ')
    .trimEnd();

  const separatorLine = columns
    .map((_, i) => '-'.repeat(Math.max(3, widths[i])))
    .join('  ');

  const bodyLines = renderedRows.map((cells) =>
    cells
      .map((cell, i) => padCell(cell, widths[i], columns[i].align))
      .join('  ')
      .trimEnd(),
  );

  return [headerLine, separatorLine, ...bodyLines].join('\n');
}

export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\r') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function formatCsv<T extends Record<string, unknown>>(
  rows: readonly T[],
  fields?: readonly string[],
): string {
  const columns: string[] = [];
  if (fields && fields.length > 0) {
    columns.push(...fields);
  } else {
    const seen = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      }
    }
  }

  if (columns.length === 0 && rows.length === 0) {
    return '';
  }

  const lines: string[] = [];
  if (columns.length > 0) {
    lines.push(columns.map((col) => escapeCsvField(col)).join(','));
  }

  for (const row of rows) {
    lines.push(columns.map((col) => escapeCsvField(row[col])).join(','));
  }

  return lines.join('\n');
}

export function formatJsonlLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes === 0) {
    return '0 B';
  }
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  if (abs < 1024) {
    return `${sign}${Math.round(abs)} B`;
  }

  const unitIndex = Math.min(
    Math.floor(Math.log(abs) / Math.log(1024)),
    BINARY_UNITS.length - 1,
  );
  const scaled = abs / 1024 ** unitIndex;
  const precision = Math.max(0, Math.trunc(decimals));
  return `${sign}${scaled.toFixed(precision)} ${BINARY_UNITS[unitIndex]}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0ms';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  if (ms < 3_600_000) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${pad2(m)}m ${pad2(s)}s`;
}

export function renderProgressBar(progress: {
  current: number;
  total: number;
  label?: string;
  width?: number;
  speedBytesPerSec?: number;
}): string {
  const width = Math.max(4, Math.trunc(progress.width ?? 20));
  const safeCurrent = Number.isFinite(progress.current) && progress.current > 0 ? progress.current : 0;
  const safeTotal = Number.isFinite(progress.total) && progress.total > 0 ? progress.total : 0;

  const ratio = safeTotal > 0 ? Math.min(1, Math.max(0, safeCurrent / safeTotal)) : 0;
  const filled = Math.round(ratio * width);
  let barBody: string;
  if (filled <= 0) {
    barBody = ' '.repeat(width);
  } else if (filled >= width) {
    barBody = '='.repeat(width);
  } else {
    barBody = `${'='.repeat(filled - 1)}>${' '.repeat(width - filled)}`;
  }

  const pct = `${(ratio * 100).toFixed(1)}%`;
  const counts =
    safeTotal > 0
      ? `${formatBytes(safeCurrent)} / ${formatBytes(safeTotal)}`
      : `${formatBytes(safeCurrent)}`;
  const speed =
    progress.speedBytesPerSec !== undefined &&
    Number.isFinite(progress.speedBytesPerSec) &&
    progress.speedBytesPerSec >= 0
      ? ` (${formatBytes(progress.speedBytesPerSec)}/s)`
      : '';
  const prefix = progress.label ? `${progress.label} ` : '';

  return `${prefix}[${barBody}] ${pct} ${counts}${speed}`;
}

export function formatStderrEvent(event: Record<string, unknown>): string {
  return `${JSON.stringify({ ts: Date.now(), ...event })}\n`;
}
