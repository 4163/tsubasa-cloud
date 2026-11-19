import React, { useEffect, useId, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, layout, radius, spacing, typography } from '../tokens.stylex.js';
import { IconAlertTriangle } from './Icons.js';
import { formatBytes, formatSignedBytes } from '../utils/format.js';
import { ModalDialog } from './ModalDialog.js';
import { ModalHeader, modalChromeStyles } from './ModalChrome.js';
import { useScrollableKeyboardNav } from '../hooks/useScrollableKeyboardNav.js';
import type {
  MoveConflictItem,
  MoveConflictResolutionMode,
} from '../types.js';

export interface MoveConflictModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetFolderPath: string;
  conflicts: MoveConflictItem[];
  cleanCount: number;
  onResolve: (mode: MoveConflictResolutionMode) => Promise<void>;
  isSubmitting: boolean;
  errorMessage?: string | null;
}

function getDestinationDirectory(destPath: string, fallbackDir: string): string {
  const normalized = destPath.startsWith('/') ? destPath : `/${destPath}`;
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return fallbackDir || '/';
  return normalized.slice(0, lastSlash);
}

function formatConflictDate(epochValue: number | undefined): string | null {
  if (!epochValue || !Number.isFinite(epochValue)) return null;
  const ms = epochValue < 1_000_000_000_000 ? epochValue * 1000 : epochValue;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function getConflictMatchMeta(conflict: MoveConflictItem): { label: string; isIdentical: boolean } {
  const match = conflict.contentMatch;
  if (match === 'identical') {
    return { label: 'Identical copy', isIdentical: true };
  }
  if (conflict.existingSizeBytes !== undefined && conflict.existingSizeBytes === conflict.sourceSizeBytes) {
    return {
      label: match === 'different' ? 'Same size, different content' : 'Same size (no checksum)',
      isIdentical: false,
    };
  }
  return { label: 'Different size', isIdentical: false };
}

const styles = stylex.create({
  surface: {
    width: layout.drawerWidth,
  },
  summaryText: {
    margin: 0,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    lineHeight: typography.lineHeightBody,
    color: colors.primaryText,
    overflowWrap: 'anywhere',
  },
  subText: {
    margin: 0,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    lineHeight: typography.lineHeightMeta,
    color: colors.secondaryText,
  },
  pathInline: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    color: colors.primaryText,
  },
  detailCard: {
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  detailRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.space3,
    fontSize: typography.fontSizeMeta,
    lineHeight: typography.lineHeightMeta,
  },
  detailLabel: {
    fontFamily: typography.fontFamilyBody,
    fontWeight: typography.fontWeightSection,
    color: colors.secondaryText,
    flexShrink: 0,
  },
  detailValue: {
    fontFamily: typography.fontFamilyMono,
    color: colors.primaryText,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'right',
  },
  conflictList: {
    maxHeight: '160px',
    overflowY: 'auto',
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radius.compact,
    padding: spacing.space2,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space1,
    boxSizing: 'border-box',
    outline: 'none',
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
  },
  conflictRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto 64px',
    alignItems: 'center',
    gap: spacing.space2,
    paddingTop: spacing.space1,
    paddingBottom: spacing.space1,
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
  },
  conflictName: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    color: colors.primaryText,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  conflictSizes: {
    fontFamily: typography.fontFamilyMono,
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    textAlign: 'right',
  },
  matchBadge: {
    height: '18px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    borderWidth: '1px',
    borderStyle: 'solid',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    boxSizing: 'border-box',
  },
  matchBadgeIdentical: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSubtle,
    color: colors.secondaryText,
  },
  matchBadgeDiff: {
    backgroundColor: colors.warningSurface,
    borderColor: colors.warningBorder,
    color: colors.warning,
  },
  infoBox: {
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
  },
  infoText: {
    margin: 0,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    lineHeight: typography.lineHeightBody,
    color: colors.secondaryText,
  },
  warningBox: {
    padding: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.dangerSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
  },
  warningText: {
    margin: 0,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    lineHeight: typography.lineHeightBody,
    color: colors.dangerTextOnSurface,
  },
  skipBtn: {
    color: colors.primaryText,
    fontWeight: typography.fontWeightSection,
  },
  overwriteBtn: {
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.danger,
    justifyContent: 'center',
    ':hover': {
      borderColor: colors.dangerHover,
    },
    ':disabled': {
      opacity: 0.45,
      backgroundColor: colors.surfaceAlt,
      color: colors.secondaryText,
      borderColor: colors.borderSubtle,
    },
  },
  keepBothBtn: {
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    justifyContent: 'center',
  },
});

export function MoveConflictModal({
  isOpen,
  onClose,
  targetFolderPath,
  conflicts,
  cleanCount,
  onResolve,
  isSubmitting,
  errorMessage,
}: MoveConflictModalProps) {
  const [activeMode, setActiveMode] = useState<MoveConflictResolutionMode | null>(null);
  const submittingRef = useRef(false);
  const keepBothBtnRef = useRef<HTMLButtonElement | null>(null);
  const conflictListRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!isOpen || !isSubmitting) {
      submittingRef.current = false;
      setActiveMode(null);
    }
  }, [isOpen, isSubmitting]);

  const effectiveOpen = isOpen && conflicts.length > 0;
  const singleConflict = conflicts.length === 1 ? conflicts[0] : null;

  useScrollableKeyboardNav({
    scrollRef: conflictListRef,
    enabled: effectiveOpen && !singleConflict,
  });

  const handleChoose = (mode: MoveConflictResolutionMode) => {
    if (submittingRef.current || isSubmitting) return;
    submittingRef.current = true;
    setActiveMode(mode);
    void onResolve(mode).finally(() => {
      submittingRef.current = false;
    });
  };

  const singleSourceDate = singleConflict ? formatConflictDate(singleConflict.sourceUpdatedAt) : null;
  const singleExistingDate = singleConflict ? formatConflictDate(singleConflict.existingUpdatedAt) : null;

  const overwriteableConflicts = conflicts.filter(
    (c) => c.canOverwrite ?? Boolean(c.existingFileId)
  );
  const hasOverwriteTarget = overwriteableConflicts.length > 0;
  const reclaimedBytes = overwriteableConflicts.reduce(
    (sum, c) => sum + (c.existingSizeBytes ?? 0),
    0
  );
  const identicalCount = conflicts.filter((c) => c.contentMatch === 'identical').length;
  const differentCount = conflicts.length - identicalCount;
  const singleMatchMeta = singleConflict ? getConflictMatchMeta(singleConflict) : null;
  const singleDeltaBytes =
    singleConflict && singleConflict.existingSizeBytes !== undefined
      ? singleConflict.sourceSizeBytes - singleConflict.existingSizeBytes
      : null;

  return (
    <ModalDialog
      isOpen={effectiveOpen}
      onClose={onClose}
      isBusy={isSubmitting}
      ariaLabelledBy={titleId}
      initialFocusRef={keepBothBtnRef}
      surfaceStyle={styles.surface}
    >
      <ModalHeader
        titleId={titleId}
        title={singleConflict ? 'File already exists' : `${conflicts.length} files already exist`}
        icon={<IconAlertTriangle size={16} />}
        onClose={onClose}
        isBusy={isSubmitting}
        closeAriaLabel="Close dialog"
        closeIconSize={14}
      />

      <div {...stylex.props(modalChromeStyles.body)}>
        {singleConflict ? (
          <>
            <p {...stylex.props(styles.summaryText)}>
              "{singleConflict.sourceName}" already exists in{' '}
              <span {...stylex.props(styles.pathInline)}>
                {getDestinationDirectory(singleConflict.destPath, targetFolderPath)}
              </span>
              .
            </p>
            {cleanCount > 0 && (
              <p {...stylex.props(styles.subText)}>
                {cleanCount} other {cleanCount === 1 ? 'item' : 'items'} will move with no conflicts.
              </p>
            )}
            <div {...stylex.props(styles.detailCard)}>
              {singleMatchMeta && (
                <div {...stylex.props(styles.detailRow)}>
                  <span {...stylex.props(styles.detailLabel)}>Content check</span>
                  <span
                    {...stylex.props(
                      styles.matchBadge,
                      singleMatchMeta.isIdentical ? styles.matchBadgeIdentical : styles.matchBadgeDiff
                    )}
                  >
                    {singleMatchMeta.label}
                  </span>
                </div>
              )}
              <div {...stylex.props(styles.detailRow)}>
                <span {...stylex.props(styles.detailLabel)}>Moving file</span>
                <span {...stylex.props(styles.detailValue)}>
                  {formatBytes(singleConflict.sourceSizeBytes)}
                  {singleSourceDate ? `, ${singleSourceDate}` : ''}
                </span>
              </div>
              {(singleConflict.existingSizeBytes !== undefined || singleExistingDate) && (
                <div {...stylex.props(styles.detailRow)}>
                  <span {...stylex.props(styles.detailLabel)}>
                    {hasOverwriteTarget ? 'Existing file' : 'Colliding item'}
                  </span>
                  <span {...stylex.props(styles.detailValue)}>
                    {singleConflict.existingSizeBytes !== undefined
                      ? formatBytes(singleConflict.existingSizeBytes)
                      : 'Unknown size'}
                    {singleExistingDate ? `, ${singleExistingDate}` : ''}
                  </span>
                </div>
              )}
              {hasOverwriteTarget && singleDeltaBytes !== null && (
                <div {...stylex.props(styles.detailRow)}>
                  <span {...stylex.props(styles.detailLabel)}>If overwritten</span>
                  <span {...stylex.props(styles.detailValue)}>
                    Frees {formatBytes(singleConflict.existingSizeBytes ?? 0)} ({formatSignedBytes(singleDeltaBytes)} net)
                  </span>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <p {...stylex.props(styles.summaryText)}>
              {conflicts.length} files already exist in{' '}
              <span {...stylex.props(styles.pathInline)}>{targetFolderPath || '/'}</span>.
            </p>
            <p {...stylex.props(styles.subText)}>
              {identicalCount > 0 && differentCount > 0
                ? `${identicalCount} identical, ${differentCount} different`
                : identicalCount === conflicts.length
                ? 'All colliding files are byte-for-byte identical'
                : 'Colliding files have differing size or content'}
              {cleanCount > 0
                ? ` · ${cleanCount} other ${cleanCount === 1 ? 'item' : 'items'} will move with no conflicts`
                : ''}
            </p>
            <div
              ref={conflictListRef}
              role="region"
              aria-label="Conflicting files"
              tabIndex={0}
              {...stylex.props(styles.conflictList)}
            >
              {conflicts.map((conflict) => {
                const meta = getConflictMatchMeta(conflict);
                return (
                  <div key={conflict.sourceFileId} {...stylex.props(styles.conflictRow)}>
                    <span {...stylex.props(styles.conflictName)} title={conflict.destPath}>
                      {conflict.sourceName}
                    </span>
                    <span {...stylex.props(styles.conflictSizes)}>
                      {formatBytes(conflict.sourceSizeBytes)}
                      {conflict.existingSizeBytes !== undefined
                        ? ` / ${formatBytes(conflict.existingSizeBytes)}`
                        : ''}
                    </span>
                    <span
                      {...stylex.props(
                        styles.matchBadge,
                        meta.isIdentical ? styles.matchBadgeIdentical : styles.matchBadgeDiff
                      )}
                      title={meta.label}
                    >
                      {meta.isIdentical ? 'Identical' : 'Different'}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {hasOverwriteTarget ? (
          <div {...stylex.props(styles.warningBox)}>
            <p {...stylex.props(styles.warningText)}>
              Overwrite permanently replaces{' '}
              {overwriteableConflicts.length === 1
                ? 'the existing file'
                : `${overwriteableConflicts.length} existing files`}{' '}
              without moving to Trash, freeing {formatBytes(reclaimedBytes)}.
            </p>
          </div>
        ) : (
          <div {...stylex.props(styles.infoBox)}>
            <p {...stylex.props(styles.infoText)}>
              Name collision within this move batch. No existing destination file can be overwritten; choose Skip or Keep both.
            </p>
          </div>
        )}

        <div role="status" aria-live="polite">
          {errorMessage && (
            <div {...stylex.props(styles.warningBox)}>
              <p {...stylex.props(styles.warningText)}>{errorMessage}</p>
            </div>
          )}
        </div>
      </div>

      <div {...stylex.props(modalChromeStyles.footer, modalChromeStyles.footerWrap)}>
        <button
          type="button"
          {...stylex.props(modalChromeStyles.cancelBtn, modalChromeStyles.cancelBtnSurface, styles.skipBtn)}
          onClick={() => handleChoose('skip')}
          disabled={isSubmitting}
        >
          {isSubmitting && activeMode === 'skip' ? 'Skipping...' : 'Skip'}
        </button>
        <button
          type="button"
          {...stylex.props(modalChromeStyles.dangerBtn, styles.overwriteBtn)}
          onClick={() => handleChoose('overwrite')}
          disabled={isSubmitting || !hasOverwriteTarget}
          title={
            !hasOverwriteTarget
              ? 'Overwrite is unavailable because there is no existing destination file to replace'
              : undefined
          }
        >
          {isSubmitting && activeMode === 'overwrite' ? 'Overwriting...' : 'Overwrite'}
        </button>
        <button
          ref={keepBothBtnRef}
          type="button"
          autoFocus
          {...stylex.props(modalChromeStyles.primaryBtn, styles.keepBothBtn)}
          onClick={() => handleChoose('keep_both')}
          disabled={isSubmitting}
        >
          {isSubmitting && activeMode === 'keep_both' ? 'Keeping both...' : 'Keep both'}
        </button>
      </div>
    </ModalDialog>
  );
}
