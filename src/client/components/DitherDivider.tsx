import React, { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { layout } from '../tokens.stylex.js';

interface DitherDividerProps {
  orientation?: 'vertical' | 'horizontal';
  isDark?: boolean;
}

const styles = stylex.create({
  vertical: {
    width: layout.ditherStripHeight,
    height: '100%',
    flexShrink: 0,
    position: 'relative',
    userSelect: 'none',
    pointerEvents: 'none',
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  horizontal: {
    height: layout.ditherStripHeight,
    width: '100%',
    flexShrink: 0,
    position: 'relative',
    userSelect: 'none',
    pointerEvents: 'none',
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  canvas: {
    display: 'block',
    width: '100%',
    height: '100%',
    imageRendering: 'pixelated',
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
});

// 6x4 dither transition pattern matching the provided image
const PATTERN_6X4 = [
  [1, 1, 1, 0, 0, 0],
  [1, 1, 0, 1, 0, 1],
  [1, 1, 1, 0, 0, 0],
  [1, 1, 0, 1, 0, 1],
];

export function DitherDivider({ orientation = 'vertical', isDark = false }: DitherDividerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(max-width: 768px)').matches;
    }
    return false;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(max-width: 768px)');
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
    };

    if (mql.addEventListener) {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    } else if (mql.addListener) {
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    }
  }, []);

  useEffect(() => {
    if (isMobile) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = orientation === 'vertical' ? 6 : canvas.parentElement?.clientWidth || 280;
    const height = orientation === 'vertical' ? canvas.parentElement?.clientHeight || 800 : 6;

    canvas.width = width;
    canvas.height = height;

    // Palette values:
    // Light mode: in-between border (#c2d1c7) and surface (#f7faf5) -> [220, 230, 222]
    // Dark mode: in-between border (#1e302a) and surface (#12211d) -> [24, 40, 36]
    const [cDark, cLight] = isDark
      ? [
          [24, 40, 36], // in-between border #1e302a and surface #12211d
          [18, 33, 29], // surface #12211d
        ]
      : [
          [220, 230, 222], // in-between border #c2d1c7 and surface #f7faf5
          [247, 250, 245], // surface #f7faf5
        ];

    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const isDarkCell =
          orientation === 'vertical'
            ? PATTERN_6X4[y % 4][x % 6] === 1
            : PATTERN_6X4[x % 4][y % 6] === 1;
        const color = isDarkCell ? cDark : cLight;
        const idx = (y * width + x) * 4;

        data[idx] = color[0];
        data[idx + 1] = color[1];
        data[idx + 2] = color[2];
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }, [orientation, isDark, isMobile]);

  if (isMobile) {
    return null;
  }

  return (
    <div {...stylex.props(orientation === 'vertical' ? styles.vertical : styles.horizontal)}>
      <canvas ref={canvasRef} {...stylex.props(styles.canvas)} />
    </div>
  );
}

