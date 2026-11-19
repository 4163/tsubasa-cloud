import React, { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import {
  IconUpload,
  IconFolderPlus,
  IconRefreshCw,
  IconTrash,
  IconFolder,
} from './Icons.js';
import { rejectInvalidInternalDragOver, parseInternalDropItems, markDropHandled } from '../utils/virtualPath.js';
import type {
  ActionPortalClipboard,
  SelectedAccountGroup,
  SelectedShareBatch,
} from '../types.js';
import {
  SelectionBatchBar,
  ClipboardPasteBar,
  SharePoolBar,
  actionButtonStyles,
} from './ActionPortalBars.js';
import { useHorizontalWheelScroll } from '../hooks/useHorizontalWheelScroll.js';

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
  hiddenInput: {
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
  const [copyFeedbackVersion, setCopyFeedbackVersion] = useState<number>(0);
  const handleCopyStateChange = useCallback(() => {
    setCopyFeedbackVersion((v) => v + 1);
  }, []);
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
    copyFeedbackVersion,
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

    return () => {
      cancelled = true;
      if (rafId !== 0) cancelAnimationFrame(rafId);
      observer?.disconnect();
    };
  }, [syncBadgeFloorWidths, reconcileOverflow]);

  useHorizontalWheelScroll({ viewportRef: portalRef });

  useEffect(() => {
    const handleDragEnd = () => setDragOverIndex(null);
    window.addEventListener('dragend', handleDragEnd);
    return () => window.removeEventListener('dragend', handleDragEnd);
  }, []);

  const cleanPath = currentPath.trim() === '' ? '/' : currentPath;
  const segments = cleanPath.split('/').filter(Boolean);
  const shareResetTrigger = `${currentPath}|${activeShareLinksCount}|${isSharePoolActive ? 1 : 0}`;

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
    markDropHandled(e);
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
            actionButtonStyles.focusRing,
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
                    actionButtonStyles.focusRing,
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

      <SelectionBatchBar
        selectedCount={selectedCount}
        selectedTotalBytes={selectedTotalBytes}
        selectedAccountGroups={selectedAccountGroups}
        onOpenMoveFilesModal={onOpenMoveFilesModal}
        onClearSelection={onClearSelection}
        onDeleteSelected={onDeleteSelected}
        onRenamePrompt={onRenamePrompt}
        onRestoreSelected={onRestoreSelected}
        onCutSelected={onCutSelected}
        onCopySelected={onCopySelected}
        onShareSelected={onShareSelected}
        isTrashView={isTrashView}
        isSharePoolActive={isSharePoolActive}
        selectedShareBatches={selectedShareBatches}
        onCopyShareBatchLinks={onCopyShareBatchLinks}
        compact={compact}
        shareResetTrigger={shareResetTrigger}
        onCopyStateChange={handleCopyStateChange}
      />

      <ClipboardPasteBar
        clipboard={clipboard}
        isTrashView={isTrashView}
        isSharePoolActive={isSharePoolActive}
        onPaste={onPaste}
        cleanPath={cleanPath}
        compact={compact}
      />

      {isTrashView ? (
        <button
          type="button"
          data-compact-btn="secondary"
          {...stylex.props(styles.emptyTrashBtn, actionButtonStyles.focusRing, compact && actionButtonStyles.iconOnlyBtn)}
          onClick={onEmptyTrash}
          disabled={trashedCount === 0}
          aria-label="Empty trash"
          title={compact ? 'Empty trash' : undefined}
        >
          <IconTrash {...stylex.props(actionButtonStyles.btnIcon)} />
          <span
            data-compact-label="true"
            {...stylex.props(compact && actionButtonStyles.compactHiddenLabel)}
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
                webkitdirectory=""
                directory=""
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
                {...stylex.props(actionButtonStyles.primaryBtn, actionButtonStyles.focusRing, compact && actionButtonStyles.iconOnlyBtn)}
                onClick={() => fileInputRef.current?.click()}
                aria-label="Upload file"
                title={compact ? 'Upload file' : undefined}
              >
                <IconUpload strokeWidth={2.5} {...stylex.props(actionButtonStyles.btnIcon)} />
                <span
                  data-compact-label="true"
                  {...stylex.props(compact && actionButtonStyles.compactHiddenLabel)}
                >
                  Upload file
                </span>
              </button>

              <button
                type="button"
                data-compact-btn="secondary"
                {...stylex.props(actionButtonStyles.secondaryBtn, actionButtonStyles.focusRing, compact && actionButtonStyles.iconOnlyBtn)}
                onClick={() => folderInputRef.current?.click()}
                aria-label="Upload folder"
                title={compact ? 'Upload folder' : undefined}
              >
                <IconFolderPlus {...stylex.props(actionButtonStyles.btnIcon)} />
                <span
                  data-compact-label="true"
                  {...stylex.props(compact && actionButtonStyles.compactHiddenLabel)}
                >
                  Upload folder
                </span>
              </button>

              <button
                type="button"
                data-compact-btn="secondary"
                {...stylex.props(actionButtonStyles.secondaryBtn, actionButtonStyles.focusRing, compact && actionButtonStyles.iconOnlyBtn)}
                onClick={onCreateFolderPrompt}
                aria-label="New folder"
                title={compact ? 'New folder' : undefined}
              >
                <IconFolder {...stylex.props(actionButtonStyles.btnIcon)} />
                <span
                  data-compact-label="true"
                  {...stylex.props(compact && actionButtonStyles.compactHiddenLabel)}
                >
                  New folder
                </span>
              </button>

              <button
                type="button"
                {...stylex.props(actionButtonStyles.secondaryBtn, actionButtonStyles.focusRing)}
                onClick={onSyncAll}
                disabled={isSyncing}
                aria-label={isSyncing ? 'Fetching Drive changes' : 'Fetch Drive changes'}
                title="Fetch external changes from Google Drive and scan .oauths/ credentials"
              >
                <IconRefreshCw {...stylex.props(actionButtonStyles.btnIcon)} />
                {isSyncing ? 'Fetching...' : 'Fetch Drive changes'}
              </button>
            </>
          )}

          <SharePoolBar
            isSharePoolActive={isSharePoolActive}
            isTrashView={isTrashView}
            activeShareLinksCount={activeShareLinksCount}
            onCopyActiveShareLinks={onCopyActiveShareLinks}
            sharePoolItemCount={sharePoolItemCount ?? 0}
            onClearSharePool={onClearSharePool}
            compact={compact}
            shareResetTrigger={shareResetTrigger}
            onCopyStateChange={handleCopyStateChange}
          />
        </>
      )}
    </div>
  );
}

