import { useRef, useState, useEffect } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import {
  IconTrash,
  IconRotateCcw,
  IconEdit,
  IconCopy,
  IconScissors,
  IconClipboard,
  IconShare,
  IconLink,
  IconCheck,
} from './Icons.js';
import { formatBytes, COPY_FEEDBACK_DURATION_MS } from '../utils/format.js';
import type {
  ActionPortalClipboard,
  SelectedAccountGroup,
  SelectedShareBatch,
} from '../types.js';

const ACTIVE_SHARE_COPY_KEY = '__active__';

export const actionButtonStyles = stylex.create({
  focusRing: {
    outline: 'none',
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
  },
  primaryBtn: {
    height: '32px',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    borderRadius: radius.button,
    backgroundColor: colors.brandAccent,
    color: colors.brandAccentText,
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    transitionProperty: 'background-color, transform',
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easingOut,
    ':hover': {
      backgroundColor: colors.brandAccentHover,
    },
    ':active': {
      transform: 'scale(0.98)',
    },
    '@media (pointer: coarse)': {
      height: 'auto',
      minHeight: '44px',
    },
  },
  secondaryBtn: {
    height: '32px',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.button,
    backgroundColor: 'transparent',
    color: colors.primaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '500',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    transitionProperty: 'background-color, border-color, color, opacity',
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easingOut,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.brandAccent,
      color: colors.brandAccent,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      height: 'auto',
      minHeight: '44px',
    },
  },
  btnIcon: {
    width: '14px',
    height: '14px',
    flexShrink: 0,
  },
  iconOnlyBtn: {
    width: '32px',
    paddingLeft: spacing.space0,
    paddingRight: spacing.space0,
    justifyContent: 'center',
    '@media (pointer: coarse)': {
      width: '44px',
      minWidth: '44px',
      minHeight: '44px',
    },
  },
  compactHiddenLabel: {
    display: 'none',
  },
});

const styles = stylex.create({
  emptyTrashBtn: {
    height: '32px',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.button,
    backgroundColor: colors.danger,
    color: colors.dangerText,
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    transitionProperty: 'background-color, opacity',
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easingOut,
    ':hover': {
      backgroundColor: colors.dangerHover,
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      height: 'auto',
      minHeight: '44px',
    },
  },
  selectionBadgeSize: {
    color: colors.secondaryText,
    fontVariantNumeric: 'tabular-nums',
    fontSize: typography.fontSizeMeta,
  },
  selectionBadgeBtnSize: {
    color: colors.accentGoldText,
    fontVariantNumeric: 'tabular-nums',
    fontSize: typography.fontSizeMeta,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  badgeTruncateText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: '3.5ch',
    flexShrink: 1,
  },
  badgeStaticText: {
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  badgeStaticWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  badgeNoShrink: {
    flexShrink: 0,
  },
  shareBatchBtn: {
    flexShrink: 1,
    overflow: 'hidden',
  },
  shareBatchTextWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    flexShrink: 1,
    overflow: 'hidden',
  },
  selectionBadgeBtn: {
    height: '32px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    fontSize: typography.fontSizeBody,
    fontFamily: typography.fontFamilyBody,
    fontWeight: typography.fontWeightTitle,
    color: colors.accentGoldText,
    backgroundColor: colors.accentGold,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.button,
    borderWidth: '0px',
    userSelect: 'none',
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
    flexShrink: 1,
    overflow: 'hidden',
    cursor: 'pointer',
    transitionProperty: 'background-color, transform',
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easingOut,
    ':hover': {
      backgroundColor: colors.accentGoldHover,
    },
    ':active': {
      transform: 'scale(0.98)',
    },
    '@media (pointer: coarse)': {
      height: 'auto',
      minHeight: '44px',
    },
  },
  selectionBadge: {
    height: '32px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.button,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.primaryText,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    userSelect: 'none',
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    '@media (pointer: coarse)': {
      height: 'auto',
      minHeight: '44px',
    },
  },
  deleteSelectedBtn: {
    color: colors.dangerTextOnSurface,
    borderColor: colors.border,
    ':hover': {
      backgroundColor: colors.dangerSurface,
      borderColor: colors.danger,
      color: colors.dangerTextOnSurface,
    },
  },
  clearBtn: {
    height: '32px',
    backgroundColor: 'transparent',
    borderWidth: '0px',
    color: colors.secondaryText,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    fontSize: typography.fontSizeBody,
    fontFamily: typography.fontFamilyBody,
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.button,
    transitionProperty: 'background-color, color',
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easingOut,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
    },
    '@media (pointer: coarse)': {
      height: 'auto',
      minHeight: '44px',
    },
  },
  clusterDivider: {
    width: '1px',
    height: '20px',
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.space2,
    marginRight: spacing.space2,
    flexShrink: 0,
  },
});

interface ShareCopyButtonProps {
  defaultLabel: string;
  copiedLabel: string;
  title: string;
  onCopy: () => Promise<boolean> | void;
  linksCount: number;
  compact: boolean;
  resetTrigger: string;
  onCopyStateChange?: () => void;
  batchInfo?: { batchFolderName: string; linksCount: number; showBatchName: boolean };
}

function ShareCopyButton({
  defaultLabel,
  copiedLabel,
  title,
  onCopy,
  linksCount,
  compact,
  resetTrigger,
  onCopyStateChange,
  batchInfo,
}: ShareCopyButtonProps) {
  const [isCopied, setIsCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsCopied(false);
  }, [resetTrigger]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const markCopied = () => {
    setIsCopied(true);
    onCopyStateChange?.();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setIsCopied(false);
      onCopyStateChange?.();
    }, COPY_FEEDBACK_DURATION_MS);
  };

  const isTruncatedBatch = Boolean(batchInfo?.showBatchName);
  const isIconOnly = !isTruncatedBatch && compact && linksCount <= 1;

  return (
    <button
      type="button"
      data-badge-btn={isTruncatedBatch ? 'true' : undefined}
      data-compact-btn={isTruncatedBatch || linksCount > 1 ? undefined : 'secondary'}
      {...stylex.props(
        actionButtonStyles.secondaryBtn,
        actionButtonStyles.focusRing,
        isTruncatedBatch && styles.shareBatchBtn,
        isIconOnly && actionButtonStyles.iconOnlyBtn
      )}
      onClick={async () => {
        try {
          const result = await onCopy();
          if (result !== false) {
            markCopied();
          }
        } catch {
          /* copy failed; leave button un-marked */
        }
      }}
      title={isTruncatedBatch || isIconOnly ? title : undefined}
      aria-label={title}
    >
      {isCopied ? (
        <IconCheck {...stylex.props(actionButtonStyles.btnIcon)} />
      ) : (
        <IconLink {...stylex.props(actionButtonStyles.btnIcon)} />
      )}
      {isTruncatedBatch && batchInfo ? (
        <span {...stylex.props(styles.shareBatchTextWrap)}>
          <span data-badge-static="true" {...stylex.props(styles.badgeStaticText)}>
            {isCopied ? 'Copied\u00A0' : 'Copy\u00A0'}
          </span>
          <span data-badge-truncate="true" {...stylex.props(styles.badgeTruncateText)}>
            {batchInfo.batchFolderName}
          </span>
          {!isCopied && batchInfo.linksCount > 1 && (
            <span data-badge-static="true" {...stylex.props(styles.badgeStaticText)}>
              {`\u00A0(${batchInfo.linksCount})`}
            </span>
          )}
        </span>
      ) : (
        <>
          <span
            data-compact-label="true"
            {...stylex.props(compact && actionButtonStyles.compactHiddenLabel)}
          >
            {isCopied ? copiedLabel : defaultLabel}
          </span>
          {compact && linksCount > 1 && (
            <span data-compact-short="true">{`(${linksCount})`}</span>
          )}
        </>
      )}
    </button>
  );
}

export interface SelectionBatchBarProps {
  selectedCount: number;
  selectedTotalBytes: number;
  selectedAccountGroups?: SelectedAccountGroup[];
  onOpenMoveFilesModal?: (group: SelectedAccountGroup) => void;
  onClearSelection?: () => void;
  onDeleteSelected?: () => void;
  onRenamePrompt?: () => void;
  onRestoreSelected?: () => void;
  onCutSelected?: () => void;
  onCopySelected?: () => void;
  onShareSelected?: () => void;
  isTrashView: boolean;
  isSharePoolActive: boolean;
  selectedShareBatches?: SelectedShareBatch[];
  onCopyShareBatchLinks?: (batchFolderName: string) => Promise<boolean> | void;
  compact: boolean;
  shareResetTrigger: string;
  onCopyStateChange?: () => void;
}

export function SelectionBatchBar({
  selectedCount,
  selectedTotalBytes,
  selectedAccountGroups,
  onOpenMoveFilesModal,
  onClearSelection,
  onDeleteSelected,
  onRenamePrompt,
  onRestoreSelected,
  onCutSelected,
  onCopySelected,
  onShareSelected,
  isTrashView,
  isSharePoolActive,
  selectedShareBatches,
  onCopyShareBatchLinks,
  compact,
  shareResetTrigger,
  onCopyStateChange,
}: SelectionBatchBarProps) {
  if (selectedCount <= 0) return null;

  const groupedFilesCount = selectedAccountGroups?.reduce((sum, g) => sum + g.fileIds.length, 0) ?? 0;
  const nonGroupedCount = selectedCount - groupedFilesCount;

  return (
    <>
      {!isSharePoolActive && selectedAccountGroups && selectedAccountGroups.length > 0 ? (
        <>
          {selectedAccountGroups.map((group) => {
            const canTruncateName = group.accountName.length > 3;
            return (
              <button
                key={group.accountId}
                type="button"
                data-badge-btn={canTruncateName ? 'true' : undefined}
                {...stylex.props(
                  styles.selectionBadgeBtn,
                  actionButtonStyles.focusRing,
                  !canTruncateName && styles.badgeNoShrink
                )}
                onClick={() => onOpenMoveFilesModal?.(group)}
                title={`${group.accountName} · ${group.fileIds.length} selected · ${formatBytes(group.totalBytes)}. Click to move selected files to another account`}
              >
                {canTruncateName ? (
                  <span data-badge-truncate="true" {...stylex.props(styles.badgeTruncateText)}>
                    {group.accountName}
                  </span>
                ) : (
                  <span {...stylex.props(styles.badgeStaticText)}>
                    {group.accountName}
                  </span>
                )}
                <span
                  data-badge-static={canTruncateName ? 'true' : undefined}
                  {...stylex.props(styles.badgeStaticWrap)}
                >
                  <span>
                    {'· '}
                    <span
                      data-compact-label="true"
                      {...stylex.props(compact && actionButtonStyles.compactHiddenLabel)}
                    >
                      {`${group.fileIds.length} selected`}
                    </span>
                    {compact && (
                      <span data-compact-short="true">{`(${group.fileIds.length})`}</span>
                    )}
                  </span>
                  <span {...stylex.props(styles.selectionBadgeBtnSize)}>
                    · {formatBytes(group.totalBytes)}
                  </span>
                </span>
              </button>
            );
          })}
          {nonGroupedCount > 0 && (
            <span {...stylex.props(styles.selectionBadge)}>
              <span>
                {nonGroupedCount} folder{nonGroupedCount === 1 ? '' : 's'}
              </span>
            </span>
          )}
        </>
      ) : (
        <span {...stylex.props(styles.selectionBadge)}>
          <span>
            <span
              data-compact-label="true"
              {...stylex.props(compact && actionButtonStyles.compactHiddenLabel)}
            >
              {`${selectedCount} selected`}
            </span>
            {compact && (
              <span data-compact-short="true">{`(${selectedCount})`}</span>
            )}
          </span>
          {selectedTotalBytes > 0 && (
            <span {...stylex.props(styles.selectionBadgeSize)}>
              · {formatBytes(selectedTotalBytes)}
            </span>
          )}
        </span>
      )}

      {isTrashView && onRestoreSelected && (
        <button
          type="button"
          data-compact-btn="primary"
          {...stylex.props(actionButtonStyles.primaryBtn, actionButtonStyles.focusRing, compact && actionButtonStyles.iconOnlyBtn)}
          onClick={onRestoreSelected}
          aria-label="Restore selected items"
        >
          <IconRotateCcw {...stylex.props(actionButtonStyles.btnIcon)} />
          <span
            data-compact-label="true"
            {...stylex.props(compact && actionButtonStyles.compactHiddenLabel)}
          >
            Restore
          </span>
        </button>
      )}

      {!isTrashView && !isSharePoolActive && selectedCount === 1 && onRenamePrompt && (
        <button
          type="button"
          data-compact-btn="secondary"
          {...stylex.props(actionButtonStyles.secondaryBtn, actionButtonStyles.focusRing, compact && actionButtonStyles.iconOnlyBtn)}
          onClick={onRenamePrompt}
          aria-label="Rename item"
          title="Rename item (F2)"
        >
          <IconEdit {...stylex.props(actionButtonStyles.btnIcon)} />
          <span
            data-compact-label="true"
            {...stylex.props(compact && actionButtonStyles.compactHiddenLabel)}
          >
            Rename
          </span>
        </button>
      )}

      {!isTrashView && !isSharePoolActive && onCutSelected && (
        <button
          type="button"
          data-compact-btn="secondary"
          {...stylex.props(actionButtonStyles.secondaryBtn, actionButtonStyles.focusRing, compact && actionButtonStyles.iconOnlyBtn)}
          onClick={onCutSelected}
          aria-label="Cut selected items"
          title="Cut selected items (Ctrl+X)"
        >
          <IconScissors {...stylex.props(actionButtonStyles.btnIcon)} />
          <span
            data-compact-label="true"
            {...stylex.props(compact && actionButtonStyles.compactHiddenLabel)}
          >
            Cut
          </span>
        </button>
      )}

      {!isTrashView && !isSharePoolActive && onCopySelected && (
        <button
          type="button"
          data-compact-btn="secondary"
          {...stylex.props(actionButtonStyles.secondaryBtn, actionButtonStyles.focusRing, compact && actionButtonStyles.iconOnlyBtn)}
          onClick={onCopySelected}
          aria-label="Copy selected items"
          title="Copy selected items (Ctrl+C)"
        >
          <IconCopy {...stylex.props(actionButtonStyles.btnIcon)} />
          <span
            data-compact-label="true"
            {...stylex.props(compact && actionButtonStyles.compactHiddenLabel)}
          >
            Copy
          </span>
        </button>
      )}

      {!isTrashView && !isSharePoolActive && onShareSelected && (
        <button
          type="button"
          data-compact-btn="secondary"
          {...stylex.props(actionButtonStyles.secondaryBtn, actionButtonStyles.focusRing, compact && actionButtonStyles.iconOnlyBtn)}
          onClick={onShareSelected}
          aria-label="Share selected items"
        >
          <IconShare {...stylex.props(actionButtonStyles.btnIcon)} />
          <span
            data-compact-label="true"
            {...stylex.props(compact && actionButtonStyles.compactHiddenLabel)}
          >
            Share
          </span>
        </button>
      )}

      {isSharePoolActive &&
        !isTrashView &&
        selectedShareBatches &&
        selectedShareBatches.length > 0 &&
        onCopyShareBatchLinks &&
        selectedShareBatches.map((batch) => {
          const showBatchName = selectedShareBatches.length > 1;
          const defaultLabel = showBatchName
            ? batch.linksCount > 1
              ? `Copy ${batch.batchFolderName} (${batch.linksCount})`
              : `Copy ${batch.batchFolderName}`
            : batch.linksCount > 1
              ? `Copy links (${batch.linksCount})`
              : 'Copy link';
          const copiedLabel = showBatchName ? `Copied ${batch.batchFolderName}` : 'Link copied';
          const title =
            batch.linksCount > 1
              ? `Copy ${batch.linksCount} share links for ${batch.batchFolderName}`
              : `Copy share link for ${batch.batchFolderName}`;

          return (
            <ShareCopyButton
              key={batch.batchFolderName}
              defaultLabel={defaultLabel}
              copiedLabel={copiedLabel}
              title={title}
              onCopy={() => onCopyShareBatchLinks(batch.batchFolderName)}
              linksCount={batch.linksCount}
              compact={compact}
              resetTrigger={shareResetTrigger}
              onCopyStateChange={onCopyStateChange}
              batchInfo={{
                batchFolderName: batch.batchFolderName,
                linksCount: batch.linksCount,
                showBatchName,
              }}
            />
          );
        })}

      {onDeleteSelected && (
        <button
          type="button"
          data-compact-btn="secondary"
          {...stylex.props(
            actionButtonStyles.secondaryBtn,
            actionButtonStyles.focusRing,
            styles.deleteSelectedBtn,
            compact && actionButtonStyles.iconOnlyBtn
          )}
          onClick={onDeleteSelected}
          aria-label={isTrashView ? 'Purge selected items' : 'Delete selected items'}
          title="Delete selected (Delete)"
        >
          <IconTrash {...stylex.props(actionButtonStyles.btnIcon)} />
          <span
            data-compact-label="true"
            {...stylex.props(compact && actionButtonStyles.compactHiddenLabel)}
          >
            {isTrashView ? 'Purge' : 'Delete'}
          </span>
        </button>
      )}

      {onClearSelection && (
        <button
          type="button"
          {...stylex.props(styles.clearBtn, actionButtonStyles.focusRing)}
          onClick={onClearSelection}
          aria-label="Deselect all"
          title="Deselect all (Esc)"
        >
          Clear
        </button>
      )}
      <div {...stylex.props(styles.clusterDivider)} />
    </>
  );
}

export interface ClipboardPasteBarProps {
  clipboard?: ActionPortalClipboard | null;
  isTrashView: boolean;
  isSharePoolActive: boolean;
  onPaste?: () => void;
  cleanPath: string;
  compact: boolean;
}

export function ClipboardPasteBar({
  clipboard,
  isTrashView,
  isSharePoolActive,
  onPaste,
  cleanPath,
  compact,
}: ClipboardPasteBarProps) {
  if (!clipboard || isTrashView || isSharePoolActive || !onPaste) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        data-compact-btn="secondary"
        {...stylex.props(actionButtonStyles.secondaryBtn, actionButtonStyles.focusRing, compact && actionButtonStyles.iconOnlyBtn)}
        onClick={onPaste}
        aria-label={`Paste ${clipboard.items.length} item(s)`}
        title={`Paste ${clipboard.items.length} item(s) (${clipboard.mode === 'cut' ? 'move' : 'copy'}) into ${cleanPath}`}
      >
        <IconClipboard {...stylex.props(actionButtonStyles.btnIcon)} />
        <span
          data-compact-label="true"
          {...stylex.props(compact && actionButtonStyles.compactHiddenLabel)}
        >
          {`Paste (${clipboard.items.length})`}
        </span>
      </button>
      <div {...stylex.props(styles.clusterDivider)} />
    </>
  );
}

export interface SharePoolBarProps {
  isSharePoolActive: boolean;
  isTrashView: boolean;
  activeShareLinksCount: number;
  onCopyActiveShareLinks?: () => Promise<boolean> | void;
  sharePoolItemCount: number;
  onClearSharePool?: () => void;
  compact: boolean;
  shareResetTrigger: string;
  onCopyStateChange?: () => void;
}

export function SharePoolBar({
  isSharePoolActive,
  isTrashView,
  activeShareLinksCount,
  onCopyActiveShareLinks,
  sharePoolItemCount,
  onClearSharePool,
  compact,
  shareResetTrigger,
  onCopyStateChange,
}: SharePoolBarProps) {
  if (!isSharePoolActive || isTrashView) {
    return null;
  }

  return (
    <>
      {activeShareLinksCount > 0 && onCopyActiveShareLinks && (
        <ShareCopyButton
          key={ACTIVE_SHARE_COPY_KEY}
          defaultLabel={
            activeShareLinksCount > 1 ? `Copy links (${activeShareLinksCount})` : 'Copy link'
          }
          copiedLabel="Link copied"
          title={
            activeShareLinksCount > 1
              ? `Copy ${activeShareLinksCount} share links for this folder`
              : 'Copy share link for this folder'
          }
          onCopy={onCopyActiveShareLinks}
          linksCount={activeShareLinksCount}
          compact={compact}
          resetTrigger={shareResetTrigger}
          onCopyStateChange={onCopyStateChange}
        />
      )}

      {sharePoolItemCount > 0 && onClearSharePool && (
        <button
          type="button"
          {...stylex.props(styles.emptyTrashBtn, actionButtonStyles.focusRing)}
          onClick={onClearSharePool}
          aria-label="Clear share pool"
          title="Permanently delete all copied files and folders in Share Pool"
        >
          <IconTrash {...stylex.props(actionButtonStyles.btnIcon)} />
          Clear share pool
        </button>
      )}
    </>
  );
}
