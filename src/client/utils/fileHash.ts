const HASH_CHUNK_BYTES = 2 * 1024 * 1024;

export type ContentHashAlgorithm = 'md5' | 'sha256';
export type FileContentVerification = 'identical' | 'different' | 'unverified';

export interface ParsedContentHash {
  algo: ContentHashAlgorithm;
  hex: string;
}

export function parseContentHash(raw?: string | null): ParsedContentHash | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/^(sha256-|md5-)/, '');
  if (/^[0-9a-f]{32}$/.test(cleaned)) {
    return { algo: 'md5', hex: cleaned };
  }
  if (/^[0-9a-f]{64}$/.test(cleaned)) {
    return { algo: 'sha256', hex: cleaned };
  }
  return null;
}

// Per-round shift amounts and sine constants for RFC 1321 MD5.
const MD5_SHIFTS = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++) {
  MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;
}

function createMd5Hasher() {
  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;

  const block = new Uint8Array(64);
  const words = new Int32Array(16);
  let blockOffset = 0;
  let totalBytes = 0;

  const compressBlock = (buf: Uint8Array, offset: number) => {
    for (let i = 0; i < 16; i++) {
      const idx = offset + i * 4;
      words[i] =
        buf[idx] |
        (buf[idx + 1] << 8) |
        (buf[idx + 2] << 16) |
        (buf[idx + 3] << 24);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }

      const temp = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_K[i] + words[g]) | 0;
      const s = MD5_SHIFTS[i];
      const rotated = (sum << s) | (sum >>> (32 - s));
      b = (b + rotated) | 0;
      a = temp;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  };

  return {
    update(chunk: Uint8Array) {
      totalBytes += chunk.byteLength;
      let pos = 0;

      if (blockOffset > 0) {
        const needed = 64 - blockOffset;
        if (chunk.byteLength < needed) {
          block.set(chunk, blockOffset);
          blockOffset += chunk.byteLength;
          return;
        }
        block.set(chunk.subarray(0, needed), blockOffset);
        compressBlock(block, 0);
        blockOffset = 0;
        pos = needed;
      }

      while (pos + 64 <= chunk.byteLength) {
        compressBlock(chunk, pos);
        pos += 64;
      }

      if (pos < chunk.byteLength) {
        block.set(chunk.subarray(pos), 0);
        blockOffset = chunk.byteLength - pos;
      }
    },

    digestHex(): string {
      const bitLenLow = (totalBytes * 8) >>> 0;
      const bitLenHigh = Math.floor((totalBytes * 8) / 0x100000000) >>> 0;

      block[blockOffset++] = 0x80;
      if (blockOffset > 56) {
        block.fill(0, blockOffset, 64);
        compressBlock(block, 0);
        blockOffset = 0;
      }
      block.fill(0, blockOffset, 56);

      const view = new DataView(block.buffer);
      view.setUint32(56, bitLenLow, true);
      view.setUint32(60, bitLenHigh, true);
      compressBlock(block, 0);

      const out = new Uint8Array(16);
      const outView = new DataView(out.buffer);
      outView.setInt32(0, a0, true);
      outView.setInt32(4, b0, true);
      outView.setInt32(8, c0, true);
      outView.setInt32(12, d0, true);

      let hex = '';
      for (let i = 0; i < 16; i++) {
        hex += out[i].toString(16).padStart(2, '0');
      }
      return hex;
    },
  };
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function createSha256Hasher() {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const block = new Uint8Array(64);
  const w = new Uint32Array(64);
  let blockOffset = 0;
  let totalBytes = 0;

  const compressBlock = (buf: Uint8Array, offset: number) => {
    for (let i = 0; i < 16; i++) {
      const idx = offset + i * 4;
      w[i] =
        ((buf[idx] << 24) |
          (buf[idx + 1] << 16) |
          (buf[idx + 2] << 8) |
          buf[idx + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  };

  return {
    update(chunk: Uint8Array) {
      totalBytes += chunk.byteLength;
      let pos = 0;

      if (blockOffset > 0) {
        const needed = 64 - blockOffset;
        if (chunk.byteLength < needed) {
          block.set(chunk, blockOffset);
          blockOffset += chunk.byteLength;
          return;
        }
        block.set(chunk.subarray(0, needed), blockOffset);
        compressBlock(block, 0);
        blockOffset = 0;
        pos = needed;
      }

      while (pos + 64 <= chunk.byteLength) {
        compressBlock(chunk, pos);
        pos += 64;
      }

      if (pos < chunk.byteLength) {
        block.set(chunk.subarray(pos), 0);
        blockOffset = chunk.byteLength - pos;
      }
    },

    digestHex(): string {
      const bitLenLow = (totalBytes * 8) >>> 0;
      const bitLenHigh = Math.floor((totalBytes * 8) / 0x100000000) >>> 0;

      block[blockOffset++] = 0x80;
      if (blockOffset > 56) {
        block.fill(0, blockOffset, 64);
        compressBlock(block, 0);
        blockOffset = 0;
      }
      block.fill(0, blockOffset, 56);

      const view = new DataView(block.buffer);
      view.setUint32(56, bitLenHigh, false);
      view.setUint32(60, bitLenLow, false);
      compressBlock(block, 0);

      let hex = '';
      for (let i = 0; i < 8; i++) {
        hex += state[i].toString(16).padStart(8, '0');
      }
      return hex;
    },
  };
}

export async function computeFileDigest(
  file: Blob,
  algo: ContentHashAlgorithm,
  signal?: AbortSignal
): Promise<string> {
  if (algo === 'sha256' && file.size <= 32 * 1024 * 1024 && typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await file.arrayBuffer();
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  const hasher = algo === 'md5' ? createMd5Hasher() : createSha256Hasher();
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const end = Math.min(file.size, offset + HASH_CHUNK_BYTES);
    const chunkBuf = await file.slice(offset, end).arrayBuffer();
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    hasher.update(new Uint8Array(chunkBuf));
  }
  return hasher.digestHex();
}

export async function verifyFileMatchesHash(
  file: Blob,
  existingSizeBytes: number,
  existingHash: string | null | undefined,
  signal?: AbortSignal
): Promise<FileContentVerification> {
  if (file.size !== existingSizeBytes) {
    return 'different';
  }
  const parsed = parseContentHash(existingHash);
  if (!parsed) {
    return file.size === 0 ? 'identical' : 'unverified';
  }
  const actualHex = await computeFileDigest(file, parsed.algo, signal);
  return actualHex === parsed.hex ? 'identical' : 'different';
}
