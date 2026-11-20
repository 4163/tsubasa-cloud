export const CHUNK_ALIGNMENT_BYTES = 256 * 1024;
export const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const MAX_IN_FLIGHT_RAM_BYTES = 32 * 1024 * 1024;
export const SMALL_UPLOAD_FAST_PATH_BYTES = 5 * 1024 * 1024;

export function validateTransferMemoryBudget(
  chunkSizeBytes: number,
  concurrency: number,
):
  | { ok: true; chunkSizeBytes: number; concurrency: number; totalBytes: number }
  | { ok: false; error: string } {
  if (!Number.isInteger(chunkSizeBytes) || chunkSizeBytes < CHUNK_ALIGNMENT_BYTES) {
    return {
      ok: false,
      error: `chunkSizeBytes must be an integer >= ${CHUNK_ALIGNMENT_BYTES} (256 KiB).`,
    };
  }
  if (chunkSizeBytes % CHUNK_ALIGNMENT_BYTES !== 0) {
    return {
      ok: false,
      error: `chunkSizeBytes must be a multiple of ${CHUNK_ALIGNMENT_BYTES} (256 KiB).`,
    };
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    return {
      ok: false,
      error: 'concurrency must be an integer >= 1.',
    };
  }
  const totalBytes = chunkSizeBytes * concurrency;
  if (totalBytes > MAX_IN_FLIGHT_RAM_BYTES) {
    return {
      ok: false,
      error: `In-flight transfer memory (${totalBytes} B) exceeds maximum ceiling (${MAX_IN_FLIGHT_RAM_BYTES} B / 32 MiB).`,
    };
  }
  return {
    ok: true,
    chunkSizeBytes,
    concurrency,
    totalBytes,
  };
}

export function buildContentRangeHeader(start: number, end: number, totalBytes: number): string {
  return `bytes ${start}-${end}/${totalBytes}`;
}

const HEX_32_REGEX = /^[0-9a-f]{32}$/i;
const HEX_64_REGEX = /^[0-9a-f]{64}$/i;

export function detectHashAlgorithm(hash: string | null | undefined): 'md5' | 'sha256' | null {
  if (typeof hash !== 'string') {
    return null;
  }
  const trimmed = hash.trim();
  if (HEX_32_REGEX.test(trimmed)) {
    return 'md5';
  }
  if (HEX_64_REGEX.test(trimmed)) {
    return 'sha256';
  }
  return null;
}
