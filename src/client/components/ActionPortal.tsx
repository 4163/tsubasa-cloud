import React, { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import {
  IconUpload,
  IconFolderPlus,
  IconRefreshCw,
  IconTrash,
  IconRotateCcw,
  IconEdit,
  IconCopy,
  IconScissors,
  IconClipboard,
  IconFolder,
  IconShare,
  IconLink,
  IconCheck,
} from './Icons.js';
import { formatBytes, COPY_FEEDBACK_DURATION_MS } from '../utils/format.js';
import { rejectInvalidInternalDragOver, parseInternalDropItems } from '../utils/virtualPath.js';

export interface ActionPortalClipboard {
  mode: 'cut' | 'copy';
  items: Array<{
    kind: 'file' | 'folder';
    id: string;
    name: string;
    virtualPath: string;
  }>;
}

export interface SelectedAccountGroup {
  accountId: string;
  accountName: string;
  fileIds: string[];
  totalBytes: number;
}

export interface SelectedShareBatch {
  batchFolderName: string;
  linksCount: number;
}

const ACTIVE_SHARE_COPY_KEY = '__active__';

interface ActionPortalProps {
  currentPath: string;
  onNavigatePath: (path: string) => void;
  onUploadFiles: (files: FileList) => void;
  onCreateFolderPrompt: () => void;
  onSyncAll: () => void;
  isSyncing: boolean;
  isTrashView?: boolean;
  trashedCount?: number;
  onEmptyTrash?: () => void;
  selectedCount?: number;
  selectedTotalBytes?: number;
  selectedAccountGroups?: SelectedAccountGroup[];
  onOpenMoveFilesModal?: (group: SelectedAccountGroup) => void;
  onClearSelection?: () => void;
  onDeleteSelected?: () => void;
  onRenamePrompt?: () => void;
  onRestoreSelected?: () => void;
  onCutSelected?: () => void;
  onCopySelected?: () => void;
  clipboard?: ActionPortalClipboard | null;
  onPaste?: () => void;
  onMoveItemsToPath?: (items: Array<{ kind: 'file' | 'folder'; id: string }>, targetPath: string) => void;
  onCopyItemsToPath?: (items: Array<{ kind: 'file' | 'folder'; id: string }>, targetPath: string) => void;
  onDropExternalToPath?: (targetPath: string, dataTransfer: DataTransfer) => void;
  onShareSelected?: () => void;
  isSharePoolActive?: boolean;
  sharePoolItemCount?: number;
  onClearSharePool?: () => void;
  activeShareLinksCount?: number;
  onCopyActiveShareLinks?: () => Promise<boolean> | void;
  selectedShareBatches?: SelectedShareBatch[];
  onCopyShareBatchLinks?: (batchFolderName: string) => Promise<boolean> | void;
}

const styles = stylex.create({
  portal: {
    height: layout.actionsPortalHeight,
    backgroundColor: colors.surface,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    boxSizing: 'border-box',
    gap: spacing.space3,
    flexWrap: 'nowrap',
    overflowX: 'hidden',
    '@media (pointer: coarse)': {
      height: 'auto',
      minHeight: layout.actionsPortalHeight,
      paddingTop: spacing.space1,
      paddingBottom: spacing.space1,
    },
  },
  portalCompact: {
    overflowX: 'auto',
  },
  breadcrumbs: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    marginRight: 'auto',
    paddingRight: spacing.space2,
    fontSize: typography.fontSizeBody,
    fontFamily: typography.fontFamilyBody,
    color: colors.secondaryText,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  crumbBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    color: colors.secondaryText,
    cursor: 'pointer',
    fontSize: typography.fontSizeBody,
    fontFamily: typography.fontFamilyBody,
    paddingTop: spacing.space1,
    paddingBottom: spacing.space1,
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    transitionProperty: 'background-color, color, border-color',
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
      minHeight: '44px',
    },
  },
  crumbActive: {
    color: colors.primaryText,
    fontWeight: typography.fontWeightTitle,
    cursor: 'default',
  },
  crumbActiveTrash: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space3,
  },
  crumbDragOver: {
    backgroundColor: colors.brandAccentSurface,
    color: colors.brandAccent,
    borderColor: colors.accentGold,
  },
  crumbSeparator: {
    color: colors.dimText,
    userSelect: 'none',
  },
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
  hiddenInput: {
    display: 'none',
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

export function ActionPortal({
  currentPath,
  onNavigatePath,
  onUploadFiles,
  onCreateFolderPrompt,
  onSyncAll,
  isSyncing,
  isTrashView = false,
  trashedCount = 0,
  onEmptyTrash,
  selectedCount = 0,
  selectedTotalBytes = 0,
  selectedAccountGroups,
  onOpenMoveFilesModal,
  onClearSelection,
  onDeleteSelected,
  onRenamePrompt,
  onRestoreSelected,
  onCutSelected,
  onCopySelected,
  clipboard,
  onPaste,
  onMoveItemsToPath,
  onCopyItemsToPath,
  onDropExternalToPath,
  onShareSelected,
  isSharePoolActive = false,
  sharePoolItemCount = 0,
  onClearSharePool,
  activeShareLinksCount = 0,
  onCopyActiveShareLinks,
  selectedShareBatches,
  onCopyShareBatchLinks,
}: ActionPortalProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const portalRef = useRef<HTMLDivElement | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [copiedKeys, setCopiedKeys] = useState<Set<string>>(new Set());
  const copyTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [compact, setCompact] = useState<boolean>(false);
  const compactRef = useRef<boolean>(false);
  compactRef.current = compact;
  const collapseThresholdRef = useRef<number>(0);

  const accountGroupsKey =
    selectedAccountGroups
      ?.map((g) => `${g.accountId}:${g.fileIds.length}:${g.totalBytes}`)
      .join(',') ?? '';
  const shareBatchesKey =
    selectedShareBatches
      ?.map((b) => `${b.batchFolderName}:${b.linksCount}`)
      .join(',') ?? '';
  const layoutSignature = [
    currentPath,
    selectedCount,
    selectedTotalBytes,
    accountGroupsKey,
    shareBatchesKey,
    clipboard ? `${clipboard.mode}:${clipboard.items.length}` : '',
    isTrashView ? 1 : 0,
    isTrashView ? trashedCount : 0,
    isSharePoolActive ? 1 : 0,
    isSharePoolActive && (sharePoolItemCount ?? 0) > 0 ? 1 : 0,
    isSharePoolActive ? activeShareLinksCount : 0,
    isSyncing ? 1 : 0,
    copiedKeys.size,
    onRestoreSelected ? 1 : 0,
    onRenamePrompt ? 1 : 0,
    onCutSelected ? 1 : 0,
    onCopySelected ? 1 : 0,
    onShareSelected ? 1 : 0,
    onDeleteSelected ? 1 : 0,
    onClearSelection ? 1 : 0,
    onPaste ? 1 : 0,
    onClearSharePool ? 1 : 0,
    onCopyActiveShareLinks ? 1 : 0,
    onCopyShareBatchLinks ? 1 : 0,
  ].join('|');

  const styledBadgeBtnsRef = useRef<Set<HTMLElement>>(new Set());

  // Compute badge floor widths once per layout signature so badges truncate
  // down to 3.5ch before toolbar buttons collapse to icon-only.
  const syncBadgeFloorWidths = useCallback((container: HTMLElement) => {
    if (styledBadgeBtnsRef.current.size > 0) {
      for (const prevBtn of styledBadgeBtnsRef.current) {
        prevBtn.style.minWidth = '';
      }
      styledBadgeBtnsRef.current.clear();
    }

    const badgeButtons = Array.from(
      container.querySelectorAll<HTMLElement>('[data-badge-btn="true"]')
    );
    if (badgeButtons.length === 0) return;

    const floors: Array<{ btn: HTMLElement; minWidth: string }> = [];
    for (const btn of badgeButtons) {
      const truncateEl = btn.querySelector<HTMLElement>('[data-badge-truncate="true"]');
      if (!truncateEl) continue;

      const btnStyle = getComputedStyle(btn);
      const padLeft = parseFloat(btnStyle.paddingLeft) || 0;
      const padRight = parseFloat(btnStyle.paddingRight) || 0;
      const borderLeft = parseFloat(btnStyle.borderLeftWidth) || 0;
      const borderRight = parseFloat(btnStyle.borderRightWidth) || 0;
      const gap = parseFloat(btnStyle.columnGap) || parseFloat(btnStyle.gap) || 0;

      let staticWidth = 0;
      for (const child of Array.from(btn.children) as HTMLElement[]) {
        if (child.tagName.toLowerCase() === 'svg') {
          staticWidth += child.getBoundingClientRect().width;
        }
      }
      for (const staticEl of Array.from(
        btn.querySelectorAll<HTMLElement>('[data-badge-static="true"]')
      )) {
        staticWidth += staticEl.getBoundingClientRect().width;
      }

      const totalGaps = Math.max(0, btn.children.length - 1) * gap;
      const truncateFloor = parseFloat(getComputedStyle(truncateEl).minWidth) || 28;
      const floorWidth =
        padLeft + padRight + borderLeft + borderRight + totalGaps + staticWidth + truncateFloor;
      floors.push({ btn, minWidth: `${Math.ceil(floorWidth)}px` });
    }

    for (const { btn, minWidth } of floors) {
      btn.style.minWidth = minWidth;
      styledBadgeBtnsRef.current.add(btn);
    }
  }, []);

  const measureExpandedScrollWidth = useCallback((container: HTMLElement): number => {
    const compactBtns = Array.from(
      container.querySelectorAll<HTMLElement>('[data-compact-btn]')
    );
    const compactLabels = Array.from(
      container.querySelectorAll<HTMLElement>('[data-compact-label="true"]')
    );
    const compactShorts = Array.from(
      container.querySelectorAll<HTMLElement>('[data-compact-short="true"]')
    );

    const prevWidth = container.style.width;
    container.style.width = 'max-content';
    for (const label of compactLabels) {
      label.style.display = 'inline';
    }
    for (const shortEl of compactShorts) {
      shortEl.style.display = 'none';
    }
    syncBadgeFloorWidths(container);
    for (const badgeBtn of styledBadgeBtnsRef.current) {
      badgeBtn.style.maxWidth = badgeBtn.style.minWidth;
    }
    for (const btn of compactBtns) {
      const pad = btn.dataset.compactBtn === 'primary' ? spacing.space5 : spacing.space4;
      btn.style.width = 'auto';
      btn.style.paddingLeft = pad;
      btn.style.paddingRight = pad;
    }

    const expandedWidth = Math.ceil(container.getBoundingClientRect().width);

    container.style.width = prevWidth;
    for (const badgeBtn of styledBadgeBtnsRef.current) {
      badgeBtn.style.maxWidth = '';
    }
    for (const btn of compactBtns) {
      btn.style.width = '';
      btn.style.paddingLeft = '';
      btn.style.paddingRight = '';
    }
    for (const label of compactLabels) {
      label.style.display = '';
    }
    for (const shortEl of compactShorts) {
      shortEl.style.display = '';
    }
    syncBadgeFloorWidths(container);

    return expandedWidth;
  }, [syncBadgeFloorWidths]);

  const reconcileOverflow = useCallback(() => {
    const el = portalRef.current;
    if (!el) return;

    const { scrollWidth, clientWidth } = el;
    if (clientWidth === 0) return;

    const applyCompact = (next: boolean) => {
      if (compactRef.current === next) return;
      compactRef.current = next;
      setCompact(next);
    };

    if (!compactRef.current) {
      if (scrollWidth > clientWidth) {
        collapseThresholdRef.current = scrollWidth;
        applyCompact(true);
      }
      return;
    }

    if (scrollWidth > clientWidth) {
      return;
    }

    if (collapseThresholdRef.current === 0) {
      const expandedWidth = measureExpandedScrollWidth(el);
      if (clientWidth >= expandedWidth + 8) {
        applyCompact(false);
      } else {
        collapseThresholdRef.current = expandedWidth;
      }
      return;
    }

    if (clientWidth >= collapseThresholdRef.current + 8) {
      const expandedWidth = measureExpandedScrollWidth(el);
      if (clientWidth >= expandedWidth + 8) {
        collapseThresholdRef.current = 0;
        applyCompact(false);
      } else {
        collapseThresholdRef.current = expandedWidth;
      }
    }
  }, [measureExpandedScrollWidth]);

  const prevSignatureRef = useRef<string | null>(null);
  const prevCompactRef = useRef<boolean>(compact);
  useLayoutEffect(() => {
    const el = portalRef.current;
    if (!el) return;
    const signatureChanged = prevSignatureRef.current !== layoutSignature;
    const compactChanged = prevCompactRef.current !== compact;
    if (signatureChanged) {
      prevSignatureRef.current = layoutSignature;
      collapseThresholdRef.current = 0;
    }
    if (signatureChanged || compactChanged) {
      prevCompactRef.current = compact;
      syncBadgeFloorWidths(el);
    }
    reconcileOverflow();
  }, [layoutSignature, compact, syncBadgeFloorWidths, reconcileOverflow]);

  useEffect(() => {
    const el = portalRef.current;
    if (!el) return;

    let rafId = 0;
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (rafId !== 0) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          reconcileOverflow();
        });
      });
      observer.observe(el);
    }

    let cancelled = false;
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (cancelled) return;
        syncBadgeFloorWidths(el);
        reconcileOverflow();
      });
    }

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.deltaX !== 0 || e.deltaY === 0) return;
      if (el.scrollWidth <= el.clientWidth) return;

      const delta =
        e.deltaMode === 1
          ? e.deltaY * 40
          : e.deltaMode === 2
            ? e.deltaY * el.clientWidth
            : e.deltaY;

      const prevScrollLeft = el.scrollLeft;
      el.scrollLeft += delta;
      if (el.scrollLeft !== prevScrollLeft) {
        e.preventDefault();
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      cancelled = true;
      if (rafId !== 0) cancelAnimationFrame(rafId);
      observer?.disconnect();
      el.removeEventListener('wheel', handleWheel);
    };
  }, [syncBadgeFloorWidths, reconcileOverflow]);

  const clearCopyFeedbackTimers = () => {
    for (const timer of copyTimersRef.current.values()) {
      clearTimeout(timer);
    }
    copyTimersRef.current.clear();
  };

  const markKeyCopied = (key: string) => {
    setCopiedKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    const existing = copyTimersRef.current.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      copyTimersRef.current.delete(key);
      setCopiedKeys((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, COPY_FEEDBACK_DURATION_MS);
    copyTimersRef.current.set(key, timer);
  };

  function renderShareCopyButton(
    copyKey: string,
    defaultLabel: string,
    copiedLabel: string,
    title: string,
    onCopy: () => Promise<boolean> | void,
    linksCount: number,
    batchInfo?: { batchFolderName: string; linksCount: number; showBatchName: boolean }
  ) {
    const isCopied = copiedKeys.has(copyKey);
    const isTruncatedBatch = Boolean(batchInfo?.showBatchName);
    const isIconOnly = !isTruncatedBatch && compact && linksCount <= 1;
    return (
      <button
        key={copyKey}
        type="button"
        data-badge-btn={isTruncatedBatch ? 'true' : undefined}
        data-compact-btn={isTruncatedBatch || linksCount > 1 ? undefined : 'secondary'}
        {...stylex.props(
          styles.secondaryBtn,
          styles.focusRing,
          isTruncatedBatch && styles.shareBatchBtn,
          isIconOnly && styles.iconOnlyBtn
        )}
        onClick={async () => {
          const result = await onCopy();
          if (result !== false) {
            markKeyCopied(copyKey);
          }
        }}
        title={isTruncatedBatch || isIconOnly ? title : undefined}
        aria-label={title}
      >
        {isCopied ? (
          <IconCheck {...stylex.props(styles.btnIcon)} />
        ) : (
          <IconLink {...stylex.props(styles.btnIcon)} />
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
              {...stylex.props(compact && styles.compactHiddenLabel)}
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

  useEffect(() => {
    setCopiedKeys(new Set());
    clearCopyFeedbackTimers();
  }, [currentPath, activeShareLinksCount, isSharePoolActive]);

  useEffect(() => {
    return () => {
      clearCopyFeedbackTimers();
    };
  }, []);

  useEffect(() => {
    const handleDragEnd = () => setDragOverIndex(null);
    window.addEventListener('dragend', handleDragEnd);
    return () => window.removeEventListener('dragend', handleDragEnd);
  }, []);

  // Normalize path segments
  const cleanPath = currentPath.trim() === '' ? '/' : currentPath;
  const segments = cleanPath.split('/').filter(Boolean);

  const groupedFilesCount = selectedAccountGroups?.reduce((sum, g) => sum + g.fileIds.length, 0) ?? 0;
  const nonGroupedCount = selectedCount - groupedFilesCount;

  function handleBreadcrumbClick(index: number) {
    if (index === -1) {
      onNavigatePath('/');
    } else {
      const targetPath = '/' + segments.slice(0, index + 1).join('/');
      onNavigatePath(targetPath);
    }
  }

  function handleBreadcrumbDragOver(e: React.DragEvent, index: number) {
    if (isSharePoolActive) return;
    const hasTsubasa = e.dataTransfer?.types?.includes('application/x-tsubasa-items');
    const hasFiles = e.dataTransfer?.types?.includes('Files');
    if (!hasTsubasa && !hasFiles) return;

    const targetPath = index === -1 ? '/' : '/' + segments.slice(0, index + 1).join('/');
    const isCopyDrag = hasTsubasa && (e.ctrlKey || e.altKey) && Boolean(onCopyItemsToPath);
    if (
      rejectInvalidInternalDragOver(
        e,
        targetPath,
        () => setDragOverIndex((prev) => (prev === index ? null : prev)),
        isCopyDrag
      )
    ) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = hasTsubasa ? (isCopyDrag ? 'copy' : 'move') : 'copy';
    setDragOverIndex(index);
  }

  function handleBreadcrumbDragLeave(e: React.DragEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverIndex((prev) => (prev === index ? null : prev));
    }
  }

  function handleBreadcrumbDrop(e: React.DragEvent, index: number) {
    if (isSharePoolActive) return;
    e.preventDefault();
    e.stopPropagation();
    (e.nativeEvent as any).__tsubasaHandled = true;
    setDragOverIndex(null);
    const targetPath = index === -1 ? '/' : '/' + segments.slice(0, index + 1).join('/');

    if (e.dataTransfer.types.includes('application/x-tsubasa-items')) {
      const isCopyDrag = (e.ctrlKey || e.altKey) && Boolean(onCopyItemsToPath);
      const parsed = parseInternalDropItems(e, targetPath, isCopyDrag);
      if (parsed) {
        if (isCopyDrag) {
          onCopyItemsToPath?.(parsed, targetPath);
        } else {
          onMoveItemsToPath?.(parsed, targetPath);
        }
      }
      return;
    }

    if (e.dataTransfer.types.includes('Files') && e.dataTransfer.files.length > 0) {
      onDropExternalToPath?.(targetPath, e.dataTransfer);
    }
  }

  return (
    <div ref={portalRef} {...stylex.props(styles.portal, compact && styles.portalCompact)}>
      <nav aria-label="Breadcrumb" {...stylex.props(styles.breadcrumbs)}>
        <button
          type="button"
          {...stylex.props(
            styles.crumbBtn,
            styles.focusRing,
            !isTrashView && segments.length === 0 && styles.crumbActive,
            dragOverIndex === -1 && styles.crumbDragOver
          )}
          onClick={() => handleBreadcrumbClick(-1)}
          onDragOver={(e) => handleBreadcrumbDragOver(e, -1)}
          onDragLeave={(e) => handleBreadcrumbDragLeave(e, -1)}
          onDrop={(e) => handleBreadcrumbDrop(e, -1)}
        >
          All files
        </button>

        {isTrashView ? (
          <>
            <span {...stylex.props(styles.crumbSeparator)}>›</span>
            <span
              {...stylex.props(styles.crumbActive, styles.crumbActiveTrash)}
            >
              <IconTrash size={14} />
              Trash ({trashedCount} item{trashedCount === 1 ? '' : 's'})
            </span>
          </>
        ) : (
          segments.map((segment, idx) => {
            const isLast = idx === segments.length - 1;
            const fullPath = '/' + segments.slice(0, idx + 1).join('/');
            return (
              <React.Fragment key={segment + idx}>
                <span {...stylex.props(styles.crumbSeparator)}>›</span>
                <button
                  type="button"
                  {...stylex.props(
                    styles.crumbBtn,
                    styles.focusRing,
                    isLast && styles.crumbActive,
                    dragOverIndex === idx && styles.crumbDragOver
                  )}
                  onClick={() => !isLast && handleBreadcrumbClick(idx)}
                  onDragOver={(e) => handleBreadcrumbDragOver(e, idx)}
                  onDragLeave={(e) => handleBreadcrumbDragLeave(e, idx)}
                  onDrop={(e) => handleBreadcrumbDrop(e, idx)}
                  aria-current={isLast ? 'page' : undefined}
                  title={fullPath}
                >
                  {segment}
                </button>
              </React.Fragment>
            );
          })
        )}
      </nav>

      {selectedCount > 0 && (
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
                      styles.focusRing,
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
                          {...stylex.props(compact && styles.compactHiddenLabel)}
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
                  {...stylex.props(compact && styles.compactHiddenLabel)}
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
              {...stylex.props(styles.primaryBtn, styles.focusRing, compact && styles.iconOnlyBtn)}
              onClick={onRestoreSelected}
              aria-label="Restore selected items"
            >
              <IconRotateCcw {...stylex.props(styles.btnIcon)} />
              <span
                data-compact-label="true"
                {...stylex.props(compact && styles.compactHiddenLabel)}
              >
                Restore
              </span>
            </button>
          )}

          {!isTrashView && !isSharePoolActive && selectedCount === 1 && onRenamePrompt && (
            <button
              type="button"
              data-compact-btn="secondary"
              {...stylex.props(styles.secondaryBtn, styles.focusRing, compact && styles.iconOnlyBtn)}
              onClick={onRenamePrompt}
              aria-label="Rename item"
              title="Rename item (F2)"
            >
              <IconEdit {...stylex.props(styles.btnIcon)} />
              <span
                data-compact-label="true"
                {...stylex.props(compact && styles.compactHiddenLabel)}
              >
                Rename
              </span>
            </button>
          )}

          {!isTrashView && !isSharePoolActive && onCutSelected && (
            <button
              type="button"
              data-compact-btn="secondary"
              {...stylex.props(styles.secondaryBtn, styles.focusRing, compact && styles.iconOnlyBtn)}
              onClick={onCutSelected}
              aria-label="Cut selected items"
              title="Cut selected items (Ctrl+X)"
            >
              <IconScissors {...stylex.props(styles.btnIcon)} />
              <span
                data-compact-label="true"
                {...stylex.props(compact && styles.compactHiddenLabel)}
              >
                Cut
              </span>
            </button>
          )}

          {!isTrashView && !isSharePoolActive && onCopySelected && (
            <button
              type="button"
              data-compact-btn="secondary"
              {...stylex.props(styles.secondaryBtn, styles.focusRing, compact && styles.iconOnlyBtn)}
              onClick={onCopySelected}
              aria-label="Copy selected items"
              title="Copy selected items (Ctrl+C)"
            >
              <IconCopy {...stylex.props(styles.btnIcon)} />
              <span
                data-compact-label="true"
                {...stylex.props(compact && styles.compactHiddenLabel)}
              >
                Copy
              </span>
            </button>
          )}

          {!isTrashView && !isSharePoolActive && onShareSelected && (
            <button
              type="button"
              data-compact-btn="secondary"
              {...stylex.props(styles.secondaryBtn, styles.focusRing, compact && styles.iconOnlyBtn)}
              onClick={onShareSelected}
              aria-label="Share selected items"
            >
              <IconShare {...stylex.props(styles.btnIcon)} />
              <span
                data-compact-label="true"
                {...stylex.props(compact && styles.compactHiddenLabel)}
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

              return renderShareCopyButton(
                batch.batchFolderName,
                defaultLabel,
                copiedLabel,
                title,
                () => onCopyShareBatchLinks(batch.batchFolderName),
                batch.linksCount,
                {
                  batchFolderName: batch.batchFolderName,
                  linksCount: batch.linksCount,
                  showBatchName,
                }
              );
            })}

          {onDeleteSelected && (
            <button
              type="button"
              data-compact-btn="secondary"
              {...stylex.props(
                styles.secondaryBtn,
                styles.focusRing,
                styles.deleteSelectedBtn,
                compact && styles.iconOnlyBtn
              )}
              onClick={onDeleteSelected}
              aria-label={isTrashView ? 'Purge selected items' : 'Delete selected items'}
              title="Delete selected (Delete)"
            >
              <IconTrash {...stylex.props(styles.btnIcon)} />
              <span
                data-compact-label="true"
                {...stylex.props(compact && styles.compactHiddenLabel)}
              >
                {isTrashView ? 'Purge' : 'Delete'}
              </span>
            </button>
          )}

          {onClearSelection && (
            <button
              type="button"
              {...stylex.props(styles.clearBtn, styles.focusRing)}
              onClick={onClearSelection}
              aria-label="Deselect all"
              title="Deselect all (Esc)"
            >
              Clear
            </button>
          )}
          <div {...stylex.props(styles.clusterDivider)} />
        </>
      )}

      {clipboard && !isTrashView && !isSharePoolActive && onPaste && (
        <>
          <button
            type="button"
            data-compact-btn="secondary"
            {...stylex.props(styles.secondaryBtn, styles.focusRing, compact && styles.iconOnlyBtn)}
            onClick={onPaste}
            aria-label={`Paste ${clipboard.items.length} item(s)`}
            title={`Paste ${clipboard.items.length} item(s) (${clipboard.mode === 'cut' ? 'move' : 'copy'}) into ${cleanPath}`}
          >
            <IconClipboard {...stylex.props(styles.btnIcon)} />
            <span
              data-compact-label="true"
              {...stylex.props(compact && styles.compactHiddenLabel)}
            >
              {`Paste (${clipboard.items.length})`}
            </span>
          </button>
          <div {...stylex.props(styles.clusterDivider)} />
        </>
      )}

      {isTrashView ? (
        <button
          type="button"
          data-compact-btn="secondary"
          {...stylex.props(styles.emptyTrashBtn, styles.focusRing, compact && styles.iconOnlyBtn)}
          onClick={onEmptyTrash}
          disabled={trashedCount === 0}
          aria-label="Empty trash"
        >
          <IconTrash {...stylex.props(styles.btnIcon)} />
          <span
            data-compact-label="true"
            {...stylex.props(compact && styles.compactHiddenLabel)}
          >
            Empty trash
          </span>
        </button>
      ) : (
        <>
          {!isSharePoolActive && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                {...stylex.props(styles.hiddenInput)}
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    onUploadFiles(e.target.files);
                    e.target.value = '';
                  }
                }}
              />

              <input
                ref={folderInputRef}
                type="file"
                multiple
                {...({ webkitdirectory: '', directory: '' } as any)}
                {...stylex.props(styles.hiddenInput)}
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    onUploadFiles(e.target.files);
                    e.target.value = '';
                  }
                }}
              />

              <button
                type="button"
                data-compact-btn="primary"
                {...stylex.props(styles.primaryBtn, styles.focusRing, compact && styles.iconOnlyBtn)}
                onClick={() => fileInputRef.current?.click()}
                aria-label="Upload file"
              >
                <IconUpload strokeWidth={2.5} {...stylex.props(styles.btnIcon)} />
                <span
                  data-compact-label="true"
                  {...stylex.props(compact && styles.compactHiddenLabel)}
                >
                  Upload file
                </span>
              </button>

              <button
                type="button"
                data-compact-btn="secondary"
                {...stylex.props(styles.secondaryBtn, styles.focusRing, compact && styles.iconOnlyBtn)}
                onClick={() => folderInputRef.current?.click()}
                aria-label="Upload folder"
              >
                <IconFolderPlus {...stylex.props(styles.btnIcon)} />
                <span
                  data-compact-label="true"
                  {...stylex.props(compact && styles.compactHiddenLabel)}
                >
                  Upload folder
                </span>
              </button>

              <button
                type="button"
                data-compact-btn="secondary"
                {...stylex.props(styles.secondaryBtn, styles.focusRing, compact && styles.iconOnlyBtn)}
                onClick={onCreateFolderPrompt}
                aria-label="New folder"
              >
                <IconFolder {...stylex.props(styles.btnIcon)} />
                <span
                  data-compact-label="true"
                  {...stylex.props(compact && styles.compactHiddenLabel)}
                >
                  New folder
                </span>
              </button>

              <button
                type="button"
                {...stylex.props(styles.secondaryBtn, styles.focusRing)}
                onClick={onSyncAll}
                disabled={isSyncing}
                aria-label={isSyncing ? 'Fetching Drive changes' : 'Fetch Drive changes'}
                title="Fetch external changes from Google Drive and scan .oauths/ credentials"
              >
                <IconRefreshCw {...stylex.props(styles.btnIcon)} />
                {isSyncing ? 'Fetching...' : 'Fetch Drive changes'}
              </button>
            </>
          )}

          {isSharePoolActive &&
            !isTrashView &&
            activeShareLinksCount > 0 &&
            onCopyActiveShareLinks &&
            renderShareCopyButton(
              ACTIVE_SHARE_COPY_KEY,
              activeShareLinksCount > 1 ? `Copy links (${activeShareLinksCount})` : 'Copy link',
              'Link copied',
              activeShareLinksCount > 1
                ? `Copy ${activeShareLinksCount} share links for this folder`
                : 'Copy share link for this folder',
              onCopyActiveShareLinks,
              activeShareLinksCount
            )}

          {isSharePoolActive && (sharePoolItemCount ?? 0) > 0 && onClearSharePool && (
            <button
              type="button"
              {...stylex.props(styles.emptyTrashBtn, styles.focusRing)}
              onClick={onClearSharePool}
              aria-label="Clear share pool"
              title="Permanently delete all copied files and folders in Share Pool"
            >
              <IconTrash {...stylex.props(styles.btnIcon)} />
              Clear share pool
            </button>
          )}
        </>
      )}
    </div>
  );
}

