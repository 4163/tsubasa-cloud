import { useEffect, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';

export type DitherCanvasVariant = 'home-top' | 'home-bottom' | 'policy';

export interface DitherCanvasProps {
  isDark: boolean;
  variant?: DitherCanvasVariant;
  /** On 'policy' at <= 768px, caps far-left edge tone (index 5) to adjacent index 4. Defaults to true for 'policy'. */
  shiftMobilePalette?: boolean;
}

// 4x4 Bayer threshold matrix normalized to [-0.5, +0.4375].
const BAYER_4X4: readonly (readonly number[])[] = [
  [-0.5, 0.0, -0.375, 0.125],
  [0.25, -0.25, 0.375, -0.125],
  [-0.3125, 0.1875, -0.4375, 0.0625],
  [0.4375, -0.0625, 0.3125, -0.1875],
];

function packRgba(r: number, g: number, b: number): number {
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

// Balanced light 4-tone sage-mint palette starting at #ffffff (home-top) and dark palette.
const LIGHT_PALETTE_32 = new Uint32Array([
  packRgba(255, 255, 255), // #ffffff
  packRgba(242, 246, 242), // #f2f6f2
  packRgba(227, 236, 230), // #e3ece6
  packRgba(206, 220, 211), // #cedcd3
]);

const DARK_PALETTE_32 = new Uint32Array([
  packRgba(11, 20, 18), // #0b1412
  packRgba(18, 33, 29), // #12211d
  packRgba(22, 45, 38), // #162d26
  packRgba(41, 65, 56), // #294138
]);

// 6-tone palettes for /data-policy: tones 0..4 plus index 5 on the far-left edge only.
const POLICY_LIGHT_PALETTE_32 = new Uint32Array([
  packRgba(255, 255, 255), // #ffffff
  packRgba(242, 246, 242), // #f2f6f2
  packRgba(228, 237, 231), // #e4ede7
  packRgba(212, 225, 217), // #d4e1d9
  packRgba(191, 209, 198), // #bfd1c6
  packRgba(170, 191, 177), // #aabfb1
]);

const POLICY_DARK_PALETTE_32 = new Uint32Array([
  packRgba(16, 29, 25), // #101d19
  packRgba(20, 37, 32), // #142520
  packRgba(28, 52, 44), // #1c342c
  packRgba(41, 65, 56), // #294138
  packRgba(45, 77, 66), // #2d4d42
  packRgba(51, 86, 74), // #33564a
]);

// Seamless 3-tone lower palettes starting at the exact bottom-row color of home-top
// (#cedcd3 light / #294138 dark) for zero visible join.
const HOME_BOTTOM_LIGHT_PALETTE_32 = new Uint32Array([
  packRgba(206, 220, 211), // #cedcd3
  packRgba(188, 205, 194), // #bccdc2
  packRgba(170, 191, 177), // #aabfb1
]);

const HOME_BOTTOM_DARK_PALETTE_32 = new Uint32Array([
  packRgba(41, 65, 56), // #294138
  packRgba(32, 55, 47), // #20372f
  packRgba(23, 43, 36), // #172b24
]);

const PIXEL_SCALE = 3;

const styles = stylex.create({
  canvasFull: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    display: 'block',
    pointerEvents: 'none',
    userSelect: 'none',
    imageRendering: 'pixelated',
  },
  canvasHomeTop: {
    position: 'absolute',
    top: '56px',
    left: 0,
    right: 0,
    width: '100%',
    height: '560px',
    display: 'block',
    pointerEvents: 'none',
    userSelect: 'none',
    imageRendering: 'pixelated',
    '@media (max-width: 768px)': {
      height: '480px',
    },
  },
  canvasHomeBottom: {
    position: 'absolute',
    top: '616px',
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: 'calc(100% - 616px)',
    display: 'block',
    pointerEvents: 'none',
    userSelect: 'none',
    imageRendering: 'pixelated',
    '@media (max-width: 768px)': {
      top: '536px',
      height: 'calc(100% - 536px)',
    },
  },
});

const MOBILE_MEDIA_QUERY = '(max-width: 768px)';

interface DitherSurfaceCache {
  width: number;
  height: number;
  docLeft: number;
  docTop: number;
  rectWidth: number;
  rectHeight: number;
  isDark: boolean;
  variant: DitherCanvasVariant;
  capPolicyEdge: boolean;
  image: ImageData | null;
  buf32: Uint32Array | null;
  ditherMap: Uint8Array;
}

const activeSurfaces = new Set<DitherSurfaceCache>();
let cursorListenersAttached = false;
let isTextureCursorActive = false;

function setTextureCursor(active: boolean): void {
  if (active === isTextureCursorActive) return;
  isTextureCursorActive = active;
  document.documentElement.style.cursor = active ? 'text' : '';
}

function handlePointerMove(e: PointerEvent): void {
  if (e.pointerType === 'touch') {
    setTextureCursor(false);
    return;
  }

  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest('header, footer, a, button, [data-dummy-window]')) {
    setTextureCursor(false);
    return;
  }

  const { pageX, pageY } = e;
  let onTransitionPixel = false;

  for (const surface of activeSurfaces) {
    const { width, height, docLeft, docTop, rectWidth, rectHeight, ditherMap } = surface;
    if (
      width === 0 ||
      height === 0 ||
      rectWidth <= 0 ||
      rectHeight <= 0 ||
      pageX < docLeft ||
      pageX >= docLeft + rectWidth ||
      pageY < docTop ||
      pageY >= docTop + rectHeight
    ) {
      continue;
    }

    const cx = Math.floor(((pageX - docLeft) / rectWidth) * width);
    const cy = Math.floor(((pageY - docTop) / rectHeight) * height);
    if (cx >= 0 && cx < width && cy >= 0 && cy < height && ditherMap[cy * width + cx] !== 0) {
      onTransitionPixel = true;
    }
    break;
  }

  setTextureCursor(onTransitionPixel);
}

function handlePointerClear(): void {
  setTextureCursor(false);
}

function handleDocumentMouseLeave(e: MouseEvent): void {
  if (e.relatedTarget === null) {
    setTextureCursor(false);
  }
}

function attachCursorListeners(): void {
  if (cursorListenersAttached) return;
  cursorListenersAttached = true;
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerleave', handlePointerClear);
  window.addEventListener('blur', handlePointerClear);
  document.addEventListener('mouseleave', handleDocumentMouseLeave);
}

function detachCursorListenersIfEmpty(): void {
  if (!cursorListenersAttached || activeSurfaces.size > 0) return;
  cursorListenersAttached = false;
  window.removeEventListener('pointermove', handlePointerMove);
  window.removeEventListener('pointerleave', handlePointerClear);
  window.removeEventListener('blur', handlePointerClear);
  document.removeEventListener('mouseleave', handleDocumentMouseLeave);
  setTextureCursor(false);
}

function clampIndex(value: number, maxIndex: number): number {
  return value < 0 ? 0 : value > maxIndex ? maxIndex : value;
}

function renderDither(
  canvas: HTMLCanvasElement,
  cache: DitherSurfaceCache,
  isDark: boolean,
  variant: DitherCanvasVariant,
  capPolicyEdge: boolean,
): void {
  const rect = canvas.getBoundingClientRect();
  cache.docLeft = rect.left + window.scrollX;
  cache.docTop = rect.top + window.scrollY;
  cache.rectWidth = rect.width;
  cache.rectHeight = rect.height;

  const width = Math.max(1, Math.ceil(rect.width / PIXEL_SCALE));
  const height = Math.max(1, Math.ceil(rect.height / PIXEL_SCALE));

  if (
    cache.image !== null &&
    cache.width === width &&
    cache.height === height &&
    cache.isDark === isDark &&
    cache.variant === variant &&
    cache.capPolicyEdge === capPolicyEdge
  ) {
    return;
  }

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let image = cache.image;
  let buf32 = cache.buf32;
  if (!image || !buf32 || cache.width !== width || cache.height !== height) {
    image = ctx.createImageData(width, height);
    buf32 = new Uint32Array(image.data.buffer);
    cache.image = image;
    cache.buf32 = buf32;
  }

  const pixelCount = width * height;
  if (cache.ditherMap.length !== pixelCount) {
    cache.ditherMap = new Uint8Array(pixelCount);
  }
  const { ditherMap } = cache;

  cache.width = width;
  cache.height = height;
  cache.isDark = isDark;
  cache.variant = variant;
  cache.capPolicyEdge = capPolicyEdge;

  const palette =
    variant === 'home-bottom'
      ? isDark
        ? HOME_BOTTOM_DARK_PALETTE_32
        : HOME_BOTTOM_LIGHT_PALETTE_32
      : variant === 'policy'
        ? isDark
          ? POLICY_DARK_PALETTE_32
          : POLICY_LIGHT_PALETTE_32
        : isDark
          ? DARK_PALETTE_32
          : LIGHT_PALETTE_32;

  const maxIndex = palette.length - 1;
  const policyMaxIndex = capPolicyEdge && maxIndex > 0 ? maxIndex - 1 : maxIndex;
  const invW = width > 1 ? 1 / (width - 1) : 0;
  const invH = height > 1 ? 1 / (height - 1) : 0;

  let offset = 0;
  for (let y = 0; y < height; y++) {
    const ny = y * invH;
    const bayerRow = BAYER_4X4[y & 3];
    for (let x = 0; x < width; x++, offset++) {
      const nx = x * invW;
      const threshold = bayerRow[x & 3];
      let baseIndex: number;
      let index: number;

      if (variant === 'policy') {
        // Open-to-the-right field with a far-left boost (nx < 0.25) stepping into index 5.
        // At <= 768px (capPolicyEdge), index 5 clamps to index 4 so tones 0..4 stay unchanged.
        const distFromLeft = Math.hypot((nx + 0.14) * 1.15, (ny - 0.5) * 0.92);
        const leftArc = 0.72 * Math.exp(-distFromLeft * distFromLeft * 2.0);
        const rightOpen = Math.pow(1 - nx, 1.6);
        const dy = (ny - 0.5) * 1.12;
        const outerCorner = rightOpen * (0.28 + dy * dy * 1.35);
        const farLeftBoost = nx < 0.25 ? 0.24 * Math.pow(1 - nx / 0.25, 2) : 0;
        const scaled = (0.04 + leftArc + outerCorner + farLeftBoost) * 4;
        baseIndex = clampIndex(Math.round(scaled), policyMaxIndex);
        index = clampIndex(Math.round(scaled + threshold * 0.9), policyMaxIndex);
      } else {
        let value: number;
        if (variant === 'home-bottom') {
          // Starts 100% solid palette[0] across ny <= 0.04 to join home-top seamlessly,
          // then cascades cleanly down around DummyWindow to the footer horizon.
          const dx = nx - 0.5;
          const radial = Math.abs(dx) * 0.42;
          const vertical = Math.max(0, (ny - 0.04) / 0.96);
          value = vertical * 0.82 + radial * vertical * 0.55;
        } else {
          // Hero radial-diagonal Bayer 4x4 field.
          const dx = nx - 0.5;
          const dy = ny - 0.15;
          const dist = Math.hypot(dx * 1.15, dy * 1.35);
          value = 0.12 + dist * 0.72 + ny * 0.16;
        }

        if (value < 0) value = 0;
        else if (value > 1) value = 1;

        const scaled = value * maxIndex;
        baseIndex = clampIndex(Math.round(scaled), maxIndex);
        index = clampIndex(Math.round(scaled + threshold * 0.9), maxIndex);
      }

      ditherMap[offset] = index !== baseIndex ? 1 : 0;
      buf32[offset] = palette[index];
    }
  }

  ctx.putImageData(image, 0, 0);
}

export function DitherCanvas({
  isDark,
  variant = 'home-top',
  shiftMobilePalette = variant === 'policy',
}: DitherCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cacheRef = useRef<DitherSurfaceCache>({
    width: 0,
    height: 0,
    docLeft: 0,
    docTop: 0,
    rectWidth: 0,
    rectHeight: 0,
    isDark: false,
    variant: 'home-top',
    capPolicyEdge: false,
    image: null,
    buf32: null,
    ditherMap: new Uint8Array(0),
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const surface = cacheRef.current;
    activeSurfaces.add(surface);
    attachCursorListeners();

    const mobileMedia = window.matchMedia(MOBILE_MEDIA_QUERY);
    const draw = () => {
      const capPolicyEdge = variant === 'policy' && shiftMobilePalette && mobileMedia.matches;
      renderDither(canvas, surface, isDark, variant, capPolicyEdge);
    };
    draw();

    // Redraw synchronously on resize (zero debounce) to avoid stretched pixels during drag.
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    mobileMedia.addEventListener('change', draw);

    return () => {
      observer.disconnect();
      mobileMedia.removeEventListener('change', draw);
      activeSurfaces.delete(surface);
      detachCursorListenersIfEmpty();
    };
  }, [isDark, variant, shiftMobilePalette]);

  const canvasStyle =
    variant === 'home-top'
      ? styles.canvasHomeTop
      : variant === 'home-bottom'
        ? styles.canvasHomeBottom
        : styles.canvasFull;

  return <canvas ref={canvasRef} aria-hidden="true" {...stylex.props(canvasStyle)} />;
}
