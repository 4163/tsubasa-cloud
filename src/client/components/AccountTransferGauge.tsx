import { useEffect } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography } from '../tokens.stylex.js';
import { IconClock } from './Icons.js';
import { DAILY_UPLOAD_LIMIT_BYTES, formatGbCompact } from '../utils/accountTransfer.js';
import type { AccountTransferStats } from '../types.js';

const styles = stylex.create({
  transferSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    paddingTop: spacing.space1,
    marginTop: '2px',
  },
  transferHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: typography.fontSizeBadge,
  },
  transferLabel: {
    fontFamily: typography.fontFamilyBody,
    fontSize: '10px',
    fontWeight: '600',
    color: colors.secondaryText,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  transferValueText: {
    fontSize: '10px',
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
  },
  transferProgressBarContainer: {
    width: '100%',
    height: '4px',
    borderRadius: radius.pill,
    backgroundColor: colors.progressTrack,
    overflow: 'hidden',
  },
  transferProgressBarFill: {
    width: '100%',
    height: '100%',
    backgroundColor: colors.brandAccent,
    borderRadius: radius.pill,
    transformOrigin: 'left center',
    transition: 'transform 0.3s ease',
  },
  transferProgressBarBreach: {
    backgroundColor: colors.danger,
  },
  progressScale: (scale: number) => ({
    transform: `scaleX(${scale})`,
  }),
});

export function hasActiveTransferStats(stats?: AccountTransferStats): boolean {
  if (!stats) return false;
  const uploaded = stats.uploadedBytes24h ?? 0;
  const remaining = stats.remainingUploadBytes24h ?? DAILY_UPLOAD_LIMIT_BYTES;
  const isRateLimited = stats.isUploadRateLimited || remaining <= 0;
  return uploaded > 0 || isRateLimited;
}

interface AccountTransferGaugeProps {
  stats?: AccountTransferStats;
  onTimerExpired?: () => void;
}

export function AccountTransferGauge({ stats, onTimerExpired }: AccountTransferGaugeProps) {
  const uploaded = stats?.uploadedBytes24h ?? 0;
  const remaining = stats?.remainingUploadBytes24h ?? DAILY_UPLOAD_LIMIT_BYTES;
  const isRateLimited = stats?.isUploadRateLimited || remaining <= 0;
  const oldestTs = stats?.oldestTransferTimestamp ?? null;

  const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

  useEffect(() => {
    if (!oldestTs || uploaded === 0) return;

    const delayMs = Math.max(1000, oldestTs + ROLLING_WINDOW_MS - Date.now());
    const timer = setTimeout(() => {
      if (onTimerExpired) onTimerExpired();
    }, delayMs);

    return () => clearTimeout(timer);
  }, [oldestTs, uploaded, onTimerExpired]);

  if (!hasActiveTransferStats(stats)) {
    return null;
  }

  const pct = Math.min(100, Math.max(0, Math.round((uploaded / DAILY_UPLOAD_LIMIT_BYTES) * 100)));
  const uploadedGb = formatGbCompact(uploaded);

  return (
    <div {...stylex.props(styles.transferSection)}>
      <div {...stylex.props(styles.transferHeaderRow)}>
        <span {...stylex.props(styles.transferLabel)}>
          <IconClock size={11} />
          24h quota
        </span>
        <span {...stylex.props(styles.transferValueText)}>
          {uploadedGb} / 750 GB ({pct}%)
        </span>
      </div>

      <div {...stylex.props(styles.transferProgressBarContainer)}>
        <div
          {...stylex.props(
            styles.transferProgressBarFill,
            isRateLimited && styles.transferProgressBarBreach,
            styles.progressScale((isRateLimited ? 100 : pct) / 100)
          )}
        />
      </div>
    </div>
  );
}
