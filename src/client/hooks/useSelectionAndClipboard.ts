import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActionPortalClipboard, ClientFileRecord, ClientFolder } from '../types.js';
import { getParentDir } from '../utils/virtualPath.js';
import { isModalActive } from '../utils/workspaceHelpers.js';

export interface UseSelectionAndClipboardOptions {
  activePoolId: number;
  loadedFilesPoolId: number | null;
  loadedTrashPoolId: number | null;
  isSharePoolActive: boolean;
  currentNav: 'files' | 'trash';
  currentPath: string;
  files: ClientFileRecord[];
  folders: ClientFolder[];
  trashedFiles: ClientFileRecord[];
  displayedFiles: ClientFileRecord[];
  displayedTrashedFiles: ClientFileRecord[];
  visibleSelectableIds: Set<string>;
  handleNavigate: (newPath: string) => void;
  handleMoveItems: (
    itemsToMove: Array<{ kind: 'file' | 'folder'; id: string }>,
    targetFolderPath: string
  ) => Promise<void>;
  handleCopyItems: (
    itemsToCopy: Array<{ kind: 'file' | 'folder'; id: string }>,
    targetFolderPath: string
  ) => Promise<void>;
  handleOpenNewFolder: () => void;
  handleOpenRenameSelected: () => void;
  handleDeleteSelected: () => Promise<void>;
  handleDownload: (file: ClientFileRecord) => void;
}

export function useSelectionAndClipboard({
  activePoolId,
  loadedFilesPoolId,
  loadedTrashPoolId,
  isSharePoolActive,
  currentNav,
  currentPath,
  files,
  folders,
  trashedFiles,
  displayedFiles,
  displayedTrashedFiles,
  visibleSelectableIds,
  handleNavigate,
  handleMoveItems,
  handleCopyItems,
  handleOpenNewFolder,
  handleOpenRenameSelected,
  handleDeleteSelected,
  handleDownload,
}: UseSelectionAndClipboardOptions) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [clipboard, setClipboard] = useState<ActionPortalClipboard | null>(null);

  const handleSelect = useCallback((id: string, isMulti: boolean) => {
    setSelectedIds((prev) => {
      if (id === '__parent__') {
        if (prev.has('__parent__') && prev.size === 1) {
          return new Set();
        }
        return new Set(['__parent__']);
      }
      if (isMulti) {
        const next = new Set(prev);
        next.delete('__parent__');
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      }
      return new Set([id]);
    });
  }, []);

  const handleSelectMultiple = useCallback((ids: string[], mode: 'set' | 'add' | 'toggle' = 'set') => {
    setSelectedIds((prev) => {
      if (mode === 'set') {
        return new Set(ids.filter((id) => id !== '__parent__'));
      }
      const next = new Set(prev);
      next.delete('__parent__');
      if (mode === 'add') {
        for (const id of ids) {
          if (id !== '__parent__') next.add(id);
        }
      } else if (mode === 'toggle') {
        for (const id of ids) {
          if (id === '__parent__') continue;
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }
      }
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleCutSelected = useCallback(() => {
    if (isSharePoolActive) return;
    const actionableIds = Array.from(selectedIds).filter((id) => id !== '__parent__');
    if (actionableIds.length === 0 || currentNav === 'trash') return;
    const selectedFolders = folders.filter((f) => actionableIds.includes(f.id));
    const selectedFilesList = files.filter((f) => actionableIds.includes(f.id) && !f.isTrashed);
    const items = [
      ...selectedFolders.map((f) => ({ kind: 'folder' as const, id: f.id, name: f.name, virtualPath: f.virtualPath })),
      ...selectedFilesList.map((f) => ({ kind: 'file' as const, id: f.id, name: f.name, virtualPath: f.virtualPath })),
    ];
    if (items.length > 0) {
      setClipboard({ mode: 'cut', items });
    }
  }, [isSharePoolActive, selectedIds, currentNav, folders, files]);

  const handleCopySelected = useCallback(() => {
    if (isSharePoolActive) return;
    const actionableIds = Array.from(selectedIds).filter((id) => id !== '__parent__');
    if (actionableIds.length === 0 || currentNav === 'trash') return;
    const selectedFolders = folders.filter((f) => actionableIds.includes(f.id));
    const selectedFilesList = files.filter((f) => actionableIds.includes(f.id) && !f.isTrashed);
    const items = [
      ...selectedFolders.map((f) => ({ kind: 'folder' as const, id: f.id, name: f.name, virtualPath: f.virtualPath })),
      ...selectedFilesList.map((f) => ({ kind: 'file' as const, id: f.id, name: f.name, virtualPath: f.virtualPath })),
    ];
    if (items.length > 0) {
      setClipboard({ mode: 'copy', items });
    }
  }, [isSharePoolActive, selectedIds, currentNav, folders, files]);

  const handlePaste = useCallback(() => {
    if (isSharePoolActive) return;
    if (!clipboard || clipboard.items.length === 0 || currentNav === 'trash') return;
    if (clipboard.mode === 'cut') {
      void handleMoveItems(clipboard.items, currentPath);
    } else {
      void handleCopyItems(clipboard.items, currentPath);
    }
  }, [isSharePoolActive, clipboard, currentNav, currentPath, handleMoveItems, handleCopyItems]);

  useEffect(() => {
    if (selectedIds.size === 0) return;
    if (currentNav === 'trash') {
      if (loadedTrashPoolId !== activePoolId) return;
    } else if (loadedFilesPoolId !== activePoolId) {
      return;
    }

    let changed = false;
    for (const id of selectedIds) {
      if (id !== '__parent__' && !visibleSelectableIds.has(id)) {
        changed = true;
        break;
      }
    }
    if (!changed) return;

    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (id === '__parent__' || visibleSelectableIds.has(id)) next.add(id);
      }
      return next;
    });
  }, [selectedIds, currentNav, activePoolId, loadedFilesPoolId, loadedTrashPoolId, visibleSelectableIds]);

  const actionableSelectedCount = useMemo(() => {
    if (selectedIds.size === 0) return 0;
    let count = 0;
    for (const id of selectedIds) {
      if (id !== '__parent__' && visibleSelectableIds.has(id)) {
        count += 1;
      }
    }
    return count;
  }, [selectedIds, visibleSelectableIds]);

  const selectedFiles = useMemo(() => {
    const source = currentNav === 'trash' ? displayedTrashedFiles : displayedFiles;
    return source.filter((f) => selectedIds.has(f.id));
  }, [currentNav, displayedTrashedFiles, displayedFiles, selectedIds]);

  const selectedTotalBytes = useMemo(() => {
    return selectedFiles.reduce((acc, f) => acc + (f.sizeBytes || 0), 0);
  }, [selectedFiles]);

  const keydownStateRef = useRef({
    selectedIds,
    folders,
    files,
    trashedFiles,
    currentNav,
    clipboard,
    currentPath,
    isSharePoolActive,
    activePoolId,
    handleNavigate,
    handleCutSelected,
    handleCopySelected,
    handlePaste,
    handleOpenNewFolder,
    handleOpenRenameSelected,
    handleDeleteSelected,
    handleDownload,
  });
  keydownStateRef.current = {
    selectedIds,
    folders,
    files,
    trashedFiles,
    currentNav,
    clipboard,
    currentPath,
    isSharePoolActive,
    activePoolId,
    handleNavigate,
    handleCutSelected,
    handleCopySelected,
    handlePaste,
    handleOpenNewFolder,
    handleOpenRenameSelected,
    handleDeleteSelected,
    handleDownload,
  };

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const activeEl = document.activeElement as HTMLElement | null;
      const interactiveSelector =
        'input, textarea, select, button, a, [contenteditable], [contenteditable="true"], dialog[open], [role="dialog"], [popover]:popover-open';
      const isInteractiveEl = (node: HTMLElement | null) =>
        Boolean(node && (node.closest(interactiveSelector) !== null || node.isContentEditable));
      if (isInteractiveEl(target) || isInteractiveEl(activeEl)) {
        return;
      }
      if (isModalActive()) {
        return;
      }

      const state = keydownStateRef.current;

      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        window.history.back();
        return;
      }

      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        window.history.forward();
        return;
      }

      if (e.key === 'Escape') {
        if (state.selectedIds.size > 0) {
          e.preventDefault();
          setSelectedIds(new Set());
        } else if (state.clipboard?.mode === 'cut') {
          e.preventDefault();
          setClipboard(null);
        }
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedIds.size > 0) {
        if (state.selectedIds.size === 1 && state.selectedIds.has('__parent__')) {
          return;
        }
        e.preventDefault();
        void state.handleDeleteSelected();
        return;
      }

      if (
        e.key === 'Backspace' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        state.selectedIds.size === 0 &&
        state.currentNav === 'files' &&
        state.currentPath !== '/'
      ) {
        e.preventDefault();
        state.handleNavigate(getParentDir(state.currentPath));
        return;
      }

      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        !e.altKey &&
        (e.key === 'n' || e.key === 'N')
      ) {
        if (!state.isSharePoolActive && state.currentNav === 'files') {
          e.preventDefault();
          state.handleOpenNewFolder();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
        if (
          !state.isSharePoolActive &&
          state.selectedIds.size > 0 &&
          !state.selectedIds.has('__parent__') &&
          state.currentNav !== 'trash'
        ) {
          e.preventDefault();
          state.handleCutSelected();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        if (
          !state.isSharePoolActive &&
          state.selectedIds.size > 0 &&
          !state.selectedIds.has('__parent__') &&
          state.currentNav !== 'trash'
        ) {
          e.preventDefault();
          state.handleCopySelected();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
        if (
          !state.isSharePoolActive &&
          state.clipboard &&
          state.clipboard.items.length > 0 &&
          state.currentNav !== 'trash'
        ) {
          e.preventDefault();
          state.handlePaste();
        }
        return;
      }

      if (e.key === 'F2') {
        if (
          !state.isSharePoolActive &&
          state.selectedIds.size === 1 &&
          !state.selectedIds.has('__parent__')
        ) {
          e.preventDefault();
          state.handleOpenRenameSelected();
        }
        return;
      }

      if (e.key === 'Enter') {
        if (state.selectedIds.size === 1 && state.currentNav !== 'trash') {
          const singleId = Array.from(state.selectedIds)[0];
          if (singleId === '__parent__') {
            e.preventDefault();
            state.handleNavigate(getParentDir(state.currentPath));
            return;
          }
          const foundFolder = state.folders.find((f) => f.id === singleId);
          if (foundFolder) {
            e.preventDefault();
            state.handleNavigate(foundFolder.virtualPath);
            return;
          }
          const foundFile = state.files.find((f) => f.id === singleId && !f.isTrashed);
          if (foundFile) {
            e.preventDefault();
            state.handleDownload(foundFile);
            return;
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return {
    selectedIds,
    setSelectedIds,
    clipboard,
    setClipboard,
    handleSelect,
    handleSelectMultiple,
    handleClearSelection,
    handleCutSelected,
    handleCopySelected,
    handlePaste,
    actionableSelectedCount,
    selectedFiles,
    selectedTotalBytes,
  };
}
