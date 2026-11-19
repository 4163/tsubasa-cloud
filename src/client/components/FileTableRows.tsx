import React from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import {
  IconFolderFilled,
  FileTypeIcon,
  IconDownload,
  IconTrash,
  IconChevronRight,
  IconChevronDown,
  IconRotateCcw,
  IconCheck,
  IconShare,
  IconLink,
} from './Icons.js';
import { formatBytes } from '../utils/format.js';
import {
  markDropHandled,
  setActiveInternalDragPayload,
  rejectInvalidInternalDragOver,
  parseInternalDropItems,
} from '../utils/virtualPath.js';
import { isInternalItemDrag } from '../utils/dataTransfer.js';
import { formatDate, getAccountTooltip } from '../utils/fileTableSort.js';
import { evaluateAccountTransferCandidate } from '../utils/accountTransfer.js';
import { RedactedEmail } from './RedactedEmail.js';
import type { AccountItem, ClientFileRecord, ClientFolder } from '../types.js';

export const rowStyles = stylex.create({
  gutterCell: {
    width: '16px',
    flexShrink: 0,
    height: '100%',
    boxSizing: 'border-box',
    cursor: 'default',
    backgroundColor: 'transparent',
    userSelect: 'none',
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  rowWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: layout.tableRowHeight,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderLeftColor: 'transparent',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'stretch',
    boxSizing: 'border-box',
    backgroundColor: {
      default: 'transparent',
      ':has([data-row="true"]:hover)': colors.rowHover,
    },
    userSelect: 'none',
    transition: motion.transitionFast,
    '@media (pointer: coarse)': {
      height: '44px',
      ':has([data-row="true"]:active)': {
        backgroundColor: colors.rowHover,
        transition: motion.transitionTap,
      },
    },
    '@media (max-width: 768px)': {
      height: layout.mobileRowHeight,
    },
  },
  rowWrapperSelected: {
    borderLeftColor: colors.accentGold,
    backgroundColor: {
      default: colors.selectionBg,
      ':has([data-row="true"]:hover)': colors.selectionBg,
    },
  },
  rowWrapperDragOver: {
    borderLeftColor: colors.accentGold,
    backgroundColor: {
      default: colors.brandAccentSurface,
      ':has([data-row="true"]:hover)': colors.brandAccentSurface,
    },
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    display: 'grid',
    gridTemplateColumns: '40px minmax(240px, 3fr) 160px 110px 156px 96px',
    alignItems: 'center',
    paddingLeft: '0px',
    paddingRight: spacing.space4,
    boxSizing: 'border-box',
    cursor: 'default',
    userSelect: 'none',
    fontSize: typography.fontSizeBody,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    backgroundColor: 'transparent',
    transition: motion.transitionFast,
    '@media (pointer: coarse)': {
      gridTemplateColumns: '40px minmax(240px, 3fr) 160px 110px 156px 120px',
    },
    '@media (max-width: 768px)': {
      gridTemplateColumns: '36px minmax(0, 1fr) auto',
      paddingLeft: spacing.space2,
      paddingRight: spacing.space3,
    },
  },
  rowCutMuted: {
    opacity: 0.5,
  },
  checkboxCell: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
  },
  checkbox: {
    minWidth: '28px',
    minHeight: '28px',
    borderRadius: radius.compact,
    borderWidth: '0px',
    backgroundColor: 'transparent',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: '0px',
    color: colors.primary,
    transition: motion.transitionFast,
    outline: 'none',
    boxSizing: 'border-box',
    flexShrink: 0,
    ':hover': {
      backgroundColor: colors.surfaceAlt,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    '@media (pointer: coarse)': {
      minWidth: '36px',
      minHeight: '36px',
    },
  },
  checkboxBox: {
    width: '16px',
    height: '16px',
    borderRadius: radius.compact,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    backgroundColor: colors.surface,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    transition: motion.transitionFast,
    pointerEvents: 'none',
  },
  checkboxBoxChecked: {
    backgroundColor: colors.accentGold,
    borderColor: colors.accentGold,
    color: colors.accentGoldText,
  },
  nameCell: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  },
  itemIcon: {
    width: '16px',
    height: '16px',
    flexShrink: 0,
    color: colors.secondaryText,
  },
  folderIcon: {
    color: colors.accentGold,
  },
  itemLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: '400',
    userSelect: 'none',
  },
  accountCell: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    height: '100%',
    paddingLeft: '2px',
    paddingRight: spacing.space6,
    overflow: 'hidden',
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  selectWrapper: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    maxWidth: '136px',
  },
  selectChevron: {
    position: 'absolute',
    right: '7px',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    color: colors.brandAccent,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  accountSelect: {
    appearance: 'none',
    WebkitAppearance: 'none',
    MozAppearance: 'none',
    fontSize: typography.fontSizeBadge,
    fontFamily: typography.fontFamilyMono,
    height: '22px',
    lineHeight: '18px',
    paddingTop: '1px',
    paddingBottom: '1px',
    paddingLeft: spacing.space2,
    paddingRight: '22px',
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccentSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.brandAccent,
    width: '100%',
    maxWidth: '136px',
    outline: 'none',
    cursor: 'pointer',
    boxSizing: 'border-box',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    transitionProperty: 'background-color, opacity',
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easingOut,
    ':hover': {
      borderColor: colors.accentGold,
      backgroundColor: colors.surfaceAlt,
    },
    ':focus': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    ':focus-visible': {
      borderColor: colors.focusRing,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    '@media (pointer: coarse)': {
      minHeight: '36px',
    },
  },
  accountSelectTransferring: {
    opacity: 0.5,
    cursor: 'wait',
    pointerEvents: 'none',
  },
  accountPill: {
    fontSize: typography.fontSizeBadge,
    fontFamily: typography.fontFamilyMono,
    display: 'inline-block',
    maxWidth: '100%',
    height: '22px',
    lineHeight: '18px',
    paddingTop: '1px',
    paddingBottom: '1px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccentSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    color: colors.brandAccent,
    boxSizing: 'border-box',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
    cursor: 'default',
    userSelect: 'text',
  },
  tabularCell: {
    fontVariantNumeric: 'tabular-nums',
    fontSize: typography.fontSizeMeta,
    color: colors.secondaryText,
    paddingRight: spacing.space2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    '@media (max-width: 768px)': {
      display: 'none',
    },
  },
  dateCell: {
    paddingRight: spacing.space4,
  },
  actionsCell: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: spacing.space1,
    '@media (max-width: 768px)': {
      justifyContent: 'flex-end',
    },
  },
  rowBtn: {
    backgroundColor: 'transparent',
    borderWidth: '0px',
    cursor: 'pointer',
    minWidth: '26px',
    minHeight: '26px',
    padding: spacing.space1,
    color: colors.secondaryText,
    borderRadius: radius.compact,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    outline: 'none',
    boxSizing: 'border-box',
    transition: motion.transitionFast,
    ':hover': {
      color: colors.primaryText,
      backgroundColor: colors.surfaceAlt,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
      transition: motion.transitionTap,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-2px',
    },
    '@media (pointer: coarse)': {
      minWidth: '36px',
      minHeight: '36px',
    },
  },
  rowBtnDanger: {
    ':hover': {
      color: colors.danger,
      backgroundColor: colors.dangerSurface,
    },
  },
  rowBtnCopied: {
    color: colors.success,
    backgroundColor: colors.successSurface,
  },
  actionIcon: {
    width: '14px',
    height: '14px',
  },
});

export interface DragItemPayload {
  kind: 'file' | 'folder';
  id: string;
  name: string;
  virtualPath: string;
  isTrashed?: boolean;
}

interface MemoParentRowProps {
  path: string;
  rowIndex: number;
  virtualSize: number;
  virtualStart: number;
  isSelected: boolean;
  isDragOver: boolean;
  isTrashView: boolean;
  isSharePoolActive: boolean;
  canCopy: boolean;
  onItemClick: (id: string, e: React.MouseEvent) => void;
  onNavigate: (path: string) => void;
  onSetDragOverRowId: React.Dispatch<React.SetStateAction<string | null>>;
  onRowDrop: (e: React.DragEvent, targetVirtualPath: string) => void;
}

export const MemoParentRow = React.memo(function MemoParentRow({
  path,
  rowIndex,
  virtualSize,
  virtualStart,
  isSelected,
  isDragOver,
  isTrashView,
  isSharePoolActive,
  canCopy,
  onItemClick,
  onNavigate,
  onSetDragOverRowId,
  onRowDrop,
}: MemoParentRowProps) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      aria-selected={isSelected}
      {...stylex.props(
        rowStyles.rowWrapper,
        isSelected && rowStyles.rowWrapperSelected,
        isDragOver && rowStyles.rowWrapperDragOver
      )}
      style={{
        height: `${virtualSize}px`,
        transform: `translateY(${virtualStart}px)`,
      }}
    >
      <div
        data-marquee-gutter="true"
        aria-hidden="true"
        {...stylex.props(rowStyles.gutterCell)}
      />
      <div
        data-row="true"
        {...stylex.props(rowStyles.rowMain)}
        onClick={(e) => {
          e.stopPropagation();
          onItemClick('__parent__', e);
        }}
        onDragOver={(e) => {
          if (isTrashView || isSharePoolActive) return;
          const isInternal = isInternalItemDrag(e);
          const isCopyDrag = isInternal && (e.ctrlKey || e.altKey) && canCopy;
          if (
            rejectInvalidInternalDragOver(
              e,
              path,
              () => onSetDragOverRowId((prev) => (prev === '__parent__' ? null : prev)),
              isCopyDrag
            )
          ) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = isInternal ? (isCopyDrag ? 'copy' : 'move') : 'copy';
          }
          onSetDragOverRowId('__parent__');
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget as Node)) {
            onSetDragOverRowId((prev) => (prev === '__parent__' ? null : prev));
          }
        }}
        onDrop={(e) => {
          const isCopyDrag = (e.ctrlKey || e.altKey) && canCopy;
          if (isInternalItemDrag(e) && !parseInternalDropItems(e, path, isCopyDrag)) {
            e.preventDefault();
            e.stopPropagation();
            markDropHandled(e);
            setActiveInternalDragPayload(null);
            onSetDragOverRowId(null);
            return;
          }
          onSetDragOverRowId(null);
          onRowDrop(e, path);
        }}
      >
        <div role="gridcell" {...stylex.props(rowStyles.checkboxCell)} />
        <div role="gridcell" {...stylex.props(rowStyles.nameCell)} title={path}>
          <IconFolderFilled {...stylex.props(rowStyles.itemIcon, rowStyles.folderIcon)} />
          <span {...stylex.props(rowStyles.itemLabel)}>.. (Parent directory)</span>
        </div>
        <div role="gridcell" {...stylex.props(rowStyles.accountCell)}>
          <span {...stylex.props(rowStyles.accountPill)}>Parent folder</span>
        </div>
        <div role="gridcell" {...stylex.props(rowStyles.tabularCell)}>—</div>
        <div role="gridcell" {...stylex.props(rowStyles.tabularCell, rowStyles.dateCell)}>—</div>
        <div role="gridcell" {...stylex.props(rowStyles.actionsCell)}>
          <button
            type="button"
            {...stylex.props(rowStyles.rowBtn)}
            aria-label="Open parent folder"
            onClick={(e) => {
              e.stopPropagation();
              onNavigate(path);
            }}
          >
            <IconChevronRight {...stylex.props(rowStyles.actionIcon)} />
          </button>
        </div>
      </div>
    </div>
  );
});

interface MemoFolderRowProps {
  folder: ClientFolder;
  rowIndex: number;
  virtualSize: number;
  virtualStart: number;
  isSelected: boolean;
  isDragOver: boolean;
  isCut: boolean;
  folderSize: number;
  folderBatchLinks?: Array<{ webViewLink: string; accountId: string }>;
  isCopiedBatch: boolean;
  isTrashView: boolean;
  isSharePoolActive: boolean;
  canCopy: boolean;
  isSearching: boolean;
  onItemClick: (id: string, e: React.MouseEvent) => void;
  onCheckboxToggle: (id: string, e: React.MouseEvent) => void;
  onRowDragStart: (e: React.DragEvent, item: DragItemPayload) => void;
  onSetDragOverRowId: React.Dispatch<React.SetStateAction<string | null>>;
  onRowDrop: (e: React.DragEvent, targetVirtualPath: string) => void;
  onShareItem?: (item: { kind: 'file' | 'folder'; id: string; name: string; virtualPath: string }) => void;
  onCopyBatchLinks?: (folderId: string, folderName: string) => void;
  onDeleteFolder?: (folder: ClientFolder) => void;
  onNavigate: (path: string) => void;
}

export const MemoFolderRow = React.memo(function MemoFolderRow({
  folder,
  rowIndex,
  virtualSize,
  virtualStart,
  isSelected,
  isDragOver,
  isCut,
  folderSize,
  folderBatchLinks,
  isCopiedBatch,
  isTrashView,
  isSharePoolActive,
  canCopy,
  isSearching,
  onItemClick,
  onCheckboxToggle,
  onRowDragStart,
  onSetDragOverRowId,
  onRowDrop,
  onShareItem,
  onCopyBatchLinks,
  onDeleteFolder,
  onNavigate,
}: MemoFolderRowProps) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      aria-selected={isSelected}
      {...stylex.props(
        rowStyles.rowWrapper,
        isSelected && rowStyles.rowWrapperSelected,
        isDragOver && rowStyles.rowWrapperDragOver
      )}
      style={{
        height: `${virtualSize}px`,
        transform: `translateY(${virtualStart}px)`,
      }}
    >
      <div
        data-marquee-gutter="true"
        aria-hidden="true"
        {...stylex.props(rowStyles.gutterCell)}
      />
      <div
        data-row="true"
        draggable={!isTrashView}
        onDragStart={(e) =>
          onRowDragStart(e, {
            kind: 'folder',
            id: folder.id,
            name: folder.name,
            virtualPath: folder.virtualPath,
          })
        }
        onDragOver={(e) => {
          if (isTrashView || isSharePoolActive) return;
          const isInternal = isInternalItemDrag(e);
          const isCopyDrag = isInternal && (e.ctrlKey || e.altKey) && canCopy;
          if (
            rejectInvalidInternalDragOver(
              e,
              folder.virtualPath,
              () => onSetDragOverRowId((prev) => (prev === folder.id ? null : prev)),
              isCopyDrag
            )
          ) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = isInternal ? (isCopyDrag ? 'copy' : 'move') : 'copy';
          }
          onSetDragOverRowId(folder.id);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget as Node)) {
            onSetDragOverRowId((prev) => (prev === folder.id ? null : prev));
          }
        }}
        onDrop={(e) => {
          const isCopyDrag = (e.ctrlKey || e.altKey) && canCopy;
          if (isInternalItemDrag(e) && !parseInternalDropItems(e, folder.virtualPath, isCopyDrag)) {
            e.preventDefault();
            e.stopPropagation();
            markDropHandled(e);
            setActiveInternalDragPayload(null);
            onSetDragOverRowId(null);
            return;
          }
          onSetDragOverRowId(null);
          onRowDrop(e, folder.virtualPath);
        }}
        {...stylex.props(
          rowStyles.rowMain,
          isCut && rowStyles.rowCutMuted
        )}
        onClick={(e) => {
          e.stopPropagation();
          onItemClick(folder.id, e);
        }}
      >
        <div role="gridcell" {...stylex.props(rowStyles.checkboxCell)}>
          <button
            type="button"
            role="checkbox"
            aria-checked={isSelected}
            aria-label={`Select folder ${folder.name}`}
            {...stylex.props(rowStyles.checkbox)}
            onClick={(e) => onCheckboxToggle(folder.id, e)}
          >
            <span
              aria-hidden="true"
              {...stylex.props(rowStyles.checkboxBox, isSelected && rowStyles.checkboxBoxChecked)}
            >
              {isSelected && <IconCheck size={12} strokeWidth={3} />}
            </span>
          </button>
        </div>

        <div role="gridcell" {...stylex.props(rowStyles.nameCell)} title={folder.virtualPath}>
          <IconFolderFilled {...stylex.props(rowStyles.itemIcon, rowStyles.folderIcon)} />
          <span {...stylex.props(rowStyles.itemLabel)}>
            {isSearching ? folder.virtualPath : folder.name}
          </span>
        </div>

        <div role="gridcell" {...stylex.props(rowStyles.accountCell)}>
          <span {...stylex.props(rowStyles.accountPill)}>Cluster folder</span>
        </div>

        <div
          role="gridcell"
          {...stylex.props(rowStyles.tabularCell)}
          title={folderSize > 0 ? `${formatBytes(folderSize)} across descendant files` : 'Empty folder'}
        >
          {folderSize > 0 ? formatBytes(folderSize) : '—'}
        </div>
        <div role="gridcell" {...stylex.props(rowStyles.tabularCell, rowStyles.dateCell)}>
          {formatDate(folder.updatedAt)}
        </div>
        <div role="gridcell" {...stylex.props(rowStyles.actionsCell)}>
          {!isTrashView && !isSharePoolActive && onShareItem && (
            <button
              type="button"
              {...stylex.props(rowStyles.rowBtn)}
              aria-label={`Share folder ${folder.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onShareItem({
                  kind: 'folder',
                  id: folder.id,
                  name: folder.name,
                  virtualPath: folder.virtualPath,
                });
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <IconShare {...stylex.props(rowStyles.actionIcon)} />
            </button>
          )}
          {folderBatchLinks && folderBatchLinks.length > 0 && onCopyBatchLinks && (
            <button
              type="button"
              {...stylex.props(
                rowStyles.rowBtn,
                isCopiedBatch && rowStyles.rowBtnCopied
              )}
              aria-label={`Copy share link for ${folder.name}`}
              title={
                folderBatchLinks.length === 1
                  ? `Copy share link: ${folderBatchLinks[0].webViewLink}`
                  : `Copy ${folderBatchLinks.length} share links (across ${folderBatchLinks.length} drives)`
              }
              onClick={(e) => {
                e.stopPropagation();
                onCopyBatchLinks(folder.id, folder.name);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {isCopiedBatch ? (
                <IconCheck {...stylex.props(rowStyles.actionIcon)} />
              ) : (
                <IconLink {...stylex.props(rowStyles.actionIcon)} />
              )}
            </button>
          )}
          {onDeleteFolder && (
            <button
              type="button"
              {...stylex.props(rowStyles.rowBtn, rowStyles.rowBtnDanger)}
              aria-label="Delete folder"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteFolder(folder);
              }}
            >
              <IconTrash {...stylex.props(rowStyles.actionIcon)} />
            </button>
          )}
          <button
            type="button"
            {...stylex.props(rowStyles.rowBtn)}
            aria-label="Open folder"
            onClick={(e) => {
              e.stopPropagation();
              onNavigate(folder.virtualPath);
            }}
          >
            <IconChevronRight {...stylex.props(rowStyles.actionIcon)} />
          </button>
        </div>
      </div>
    </div>
  );
});

interface MemoFileRowProps {
  file: ClientFileRecord;
  isTrashItem: boolean;
  rowIndex: number;
  virtualSize: number;
  virtualStart: number;
  isSelected: boolean;
  isCut: boolean;
  fileAcc?: AccountItem;
  accounts?: AccountItem[];
  canTransfer: boolean;
  isTransferring: boolean;
  isTrashView: boolean;
  isSharePoolActive: boolean;
  isSearching: boolean;
  onItemClick: (id: string, e: React.MouseEvent) => void;
  onCheckboxToggle: (id: string, e: React.MouseEvent) => void;
  onRowDragStart: (e: React.DragEvent, item: DragItemPayload) => void;
  onTransferFile?: (fileId: string, targetAccountId: string) => void;
  onShareItem?: (item: { kind: 'file' | 'folder'; id: string; name: string; virtualPath: string }) => void;
  onDownload: (file: ClientFileRecord) => void;
  onTrash: (file: ClientFileRecord) => void;
  onRestore?: (file: ClientFileRecord) => void;
  onPermanentDelete?: (file: ClientFileRecord) => void;
}

export const MemoFileRow = React.memo(function MemoFileRow({
  file,
  isTrashItem,
  rowIndex,
  virtualSize,
  virtualStart,
  isSelected,
  isCut,
  fileAcc,
  accounts,
  canTransfer,
  isTransferring,
  isTrashView,
  isSharePoolActive,
  isSearching,
  onItemClick,
  onCheckboxToggle,
  onRowDragStart,
  onTransferFile,
  onShareItem,
  onDownload,
  onTrash,
  onRestore,
  onPermanentDelete,
}: MemoFileRowProps) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      aria-selected={isSelected}
      {...stylex.props(
        rowStyles.rowWrapper,
        isSelected && rowStyles.rowWrapperSelected
      )}
      style={{
        height: `${virtualSize}px`,
        transform: `translateY(${virtualStart}px)`,
      }}
    >
      <div
        data-marquee-gutter="true"
        aria-hidden="true"
        {...stylex.props(rowStyles.gutterCell)}
      />
      <div
        data-row="true"
        draggable={!isTrashView}
        onDragStart={(e) =>
          onRowDragStart(e, {
            kind: 'file',
            id: file.id,
            name: file.name,
            virtualPath: file.virtualPath,
            ...(isTrashItem ? { isTrashed: true } : {}),
          })
        }
        onDragOver={(e) => {
          if (!isTrashItem && (isTrashView || isSharePoolActive)) return;
          if (!isInternalItemDrag(e)) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'none';
          }
        }}
        onDrop={
          isTrashItem
            ? undefined
            : (e) => {
                if (isTrashView || isSharePoolActive) return;
                if (!isInternalItemDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                markDropHandled(e);
              }
        }
        {...stylex.props(
          rowStyles.rowMain,
          !isTrashItem && isCut && rowStyles.rowCutMuted
        )}
        onClick={(e) => {
          e.stopPropagation();
          onItemClick(file.id, e);
        }}
      >
        <div role="gridcell" {...stylex.props(rowStyles.checkboxCell)}>
          <button
            type="button"
            role="checkbox"
            aria-checked={isSelected}
            aria-label={isTrashItem ? `Select trashed file ${file.name}` : `Select file ${file.name}`}
            {...stylex.props(rowStyles.checkbox)}
            onClick={(e) => onCheckboxToggle(file.id, e)}
          >
            <span
              aria-hidden="true"
              {...stylex.props(rowStyles.checkboxBox, isSelected && rowStyles.checkboxBoxChecked)}
            >
              {isSelected && <IconCheck size={12} strokeWidth={3} />}
            </span>
          </button>
        </div>

        <div role="gridcell" {...stylex.props(rowStyles.nameCell)} title={file.virtualPath}>
          <FileTypeIcon name={file.name || file.virtualPath} {...stylex.props(rowStyles.itemIcon)} />
          <span
            {...stylex.props(rowStyles.itemLabel)}
            title={isTrashItem ? `Original location: ${file.virtualPath}` : undefined}
          >
            {isTrashItem ? file.virtualPath : isSearching ? file.virtualPath : file.name}
          </span>
        </div>

        <div role="gridcell" {...stylex.props(rowStyles.accountCell)}>
          {!isTrashItem && canTransfer && accounts && onTransferFile ? (
            <div {...stylex.props(rowStyles.selectWrapper)}>
              <select
                aria-label={`Transfer ${file.name} to another account`}
                title={fileAcc ? `${fileAcc.displayName || file.accountId} (${fileAcc.email || file.accountId})` : file.accountId}
                value={file.accountId}
                disabled={isTransferring}
                {...stylex.props(
                  rowStyles.accountSelect,
                  isTransferring && rowStyles.accountSelectTransferring
                )}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => {
                  e.stopPropagation();
                  const targetId = e.target.value;
                  if (targetId && targetId !== file.accountId) {
                    onTransferFile(file.id, targetId);
                  }
                }}
              >
                {!fileAcc && (
                  <option value={file.accountId} disabled>
                    {file.accountId}
                  </option>
                )}
                {accounts.map((acc) => {
                  const { isMuted, optionTitle, optionLabel } = evaluateAccountTransferCandidate(
                    acc,
                    file.sizeBytes,
                    { isCurrent: acc.id === file.accountId }
                  );

                  return (
                    <option key={acc.id} value={acc.id} disabled={isMuted} title={optionTitle}>
                      {optionLabel}
                    </option>
                  );
                })}
              </select>
              <div {...stylex.props(rowStyles.selectChevron)}>
                <IconChevronDown size={10} strokeWidth={2.5} />
              </div>
            </div>
          ) : (
            <RedactedEmail
              email={fileAcc?.email || file.accountId}
              tooltip={getAccountTooltip(file.accountId, fileAcc)}
              style={rowStyles.accountPill}
            />
          )}
        </div>

        <div role="gridcell" {...stylex.props(rowStyles.tabularCell)}>
          {formatBytes(file.sizeBytes)}
        </div>

        <div role="gridcell" {...stylex.props(rowStyles.tabularCell, rowStyles.dateCell)}>
          {formatDate(isTrashItem ? file.trashedAt || file.updatedAt : file.updatedAt)}
        </div>

        <div role="gridcell" {...stylex.props(rowStyles.actionsCell)}>
          {isTrashItem ? (
            <>
              {onRestore && (
                <button
                  type="button"
                  {...stylex.props(rowStyles.rowBtn)}
                  aria-label="Restore to original location"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRestore(file);
                  }}
                >
                  <IconRotateCcw {...stylex.props(rowStyles.actionIcon)} />
                </button>
              )}
              {onPermanentDelete && (
                <button
                  type="button"
                  {...stylex.props(rowStyles.rowBtn, rowStyles.rowBtnDanger)}
                  aria-label="Delete permanently from Google Drive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPermanentDelete(file);
                  }}
                >
                  <IconTrash {...stylex.props(rowStyles.actionIcon)} />
                </button>
              )}
            </>
          ) : (
            <>
              {!isTrashView && !isSharePoolActive && onShareItem && (
                <button
                  type="button"
                  {...stylex.props(rowStyles.rowBtn)}
                  aria-label={`Share file ${file.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onShareItem({
                      kind: 'file',
                      id: file.id,
                      name: file.name,
                      virtualPath: file.virtualPath,
                    });
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <IconShare {...stylex.props(rowStyles.actionIcon)} />
                </button>
              )}
              <button
                type="button"
                {...stylex.props(rowStyles.rowBtn)}
                aria-label="Download file"
                onClick={(e) => {
                  e.stopPropagation();
                  onDownload(file);
                }}
              >
                <IconDownload {...stylex.props(rowStyles.actionIcon)} />
              </button>
              <button
                type="button"
                {...stylex.props(rowStyles.rowBtn)}
                aria-label="Move to trash"
                onClick={(e) => {
                  e.stopPropagation();
                  onTrash(file);
                }}
              >
                <IconTrash {...stylex.props(rowStyles.actionIcon)} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
});
