import React, { useEffect, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, layout } from '../tokens.stylex.js';

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
  },
  horizontal: {
    height: layout.ditherStripHeight,
    width: '100%',
    flexShrink: 0,
    position: 'relative',
    userSelect: 'none',
    pointerEvents: 'none',
  },
  canvas: {
    display: 'block',
    width: '100%',
    height: '100%',
    imageRendering: 'pixelated',
  },
});

const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

export function DitherDivider({ orientation = 'vertical', isDark = false }: DitherDividerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = orientation === 'vertical' ? 6 : canvas.parentElement?.clientWidth || 280;
    const height = orientation === 'vertical' ? canvas.parentElement?.clientHeight || 800 : 6;

    canvas.width = width;
    canvas.height = height;

    // Palette values for dither interpolation
    // Light mode: surface (#f7faf5) -> canvas (#eef2ec)
    // Dark mode: surface (#12211d) -> canvas (#0b1412)
    const [c1, c2] = isDark
      ? [
          [18, 33, 29], // #12211d
          [11, 20, 18], // #0b1412
        ]
      : [
          [247, 250, 245], // #f7faf5
          [238, 242, 236], // #eef2ec
        ];

    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const factor = orientation === 'vertical' ? x / Math.max(1, width - 1) : y / Math.max(1, height - 1);
        const threshold = (BAYER_4X4[y % 4][x % 4] + 0.5) / 16;
        const pickC2 = factor > threshold;

        const color = pickC2 ? c2 : c1;
        const idx = (y * width + x) * 4;

        data[idx] = color[0];
        data[idx + 1] = color[1];
        data[idx + 2] = color[2];
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }, [orientation, isDark]);

  return (
    <div {...stylex.props(orientation === 'vertical' ? styles.vertical : styles.horizontal)}>
      <canvas ref={canvasRef} {...stylex.props(styles.canvas)} />
    </div>
  );
}

