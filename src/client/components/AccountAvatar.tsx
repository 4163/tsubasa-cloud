import React, { useState, useMemo } from 'react';
import * as stylex from '@stylexjs/stylex';
import { radius } from '../tokens.stylex.js';

export interface AccountAvatarProps {
  avatarUrl?: string | null;
  displayName?: string | null;
  email?: string | null;
  index?: number;
}

/**
 * Calculates the relative luminance of an sRGB color according to W3C WCAG 2.1 specs.
 */
export function getRelativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r / 255, g / 255, b / 255].map((c) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Calculates the WCAG contrast ratio between two relative luminance values.
 */
export function getContrastRatio(lum1: number, lum2: number): number {
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Converts HSL components to RGB tuple [0-255].
 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sFrac = s / 100;
  const lFrac = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sFrac * Math.min(lFrac, 1 - lFrac);
  const f = (n: number) => lFrac - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/**
 * Fast deterministic string hash.
 */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Computes a unique, deterministic background color for an account avatar placeholder.
 * Strictly satisfies WCAG AAA contrast ratio (>= 7.0:1) against white text (#ffffff).
 *
 * Distributes hues using the golden angle (137.508 deg) so every consecutive
 * account index receives a visually distinct, vibrant hue.
 */
export function getAaaAvatarColor(
  index: number = 0,
  seed?: string
): { bg: string; text: string; contrast: number } {
  const i = typeof index === 'number' && index >= 0 ? index : (seed ? hashString(seed) : 0);
  const hue = Math.round((i * 137.507764) % 360);
  const s = 65;

  let l = 32;
  while (l > 10) {
    const [r, g, b] = hslToRgb(hue, s, l);
    const luma = getRelativeLuminance(r, g, b);
    if (luma <= 0.095) {
      const hex = '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
      const contrast = getContrastRatio(1.0, luma);
      return { bg: hex, text: '#ffffff', contrast };
    }
    l -= 1;
  }

  return { bg: '#1c1917', text: '#ffffff', contrast: 12.0 };
}

const styles = stylex.create({
  avatarPill: {
    width: '24px',
    height: '24px',
    borderRadius: radius.pill,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '11px',
    fontWeight: '600',
    flexShrink: 0,
    overflow: 'hidden',
    userSelect: 'none',
  },
  avatarImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    borderRadius: radius.pill,
    display: 'block',
  },
});

export function AccountAvatar({
  avatarUrl,
  displayName,
  email,
  index = 0,
}: AccountAvatarProps) {
  const [imgError, setImgError] = useState(false);

  const isCustomPfp = Boolean(avatarUrl && !avatarUrl.includes('default-user'));

  const color = useMemo(
    () => getAaaAvatarColor(index, email || displayName || undefined),
    [index, email, displayName]
  );

  const initial = (displayName?.[0] || email?.[0] || '?').toUpperCase();

  if (isCustomPfp && !imgError) {
    return (
      <div {...stylex.props(styles.avatarPill)}>
        <img
          src={avatarUrl!}
          alt={displayName || email || 'Account avatar'}
          {...stylex.props(styles.avatarImg)}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setImgError(true)}
        />
      </div>
    );
  }

  return (
    <div
      {...stylex.props(styles.avatarPill)}
      style={{ backgroundColor: color.bg, color: color.text }}
      aria-label={displayName || email || 'Account avatar'}
    >
      {initial}
    </div>
  );
}

