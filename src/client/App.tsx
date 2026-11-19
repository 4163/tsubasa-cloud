import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, darkColors, layout, motion, radius, spacing, typography } from './tokens.stylex.js';
import { Header } from './components/Header.js';
import { Sidebar } from './components/Sidebar.js';
import { ActionPortal } from './components/ActionPortal.js';
import { FileTable } from './components/FileTable.js';
import { DitherDivider } from './components/DitherDivider.js';
import { IconAlertTriangle, IconClose } from './components/Icons.js';
import { WorkspaceOverlays } from './components/WorkspaceOverlays.js';
import type {
  AccountItem,
  ClientFileRecord,
  PoolSummary,
  RenameTarget,
  SelectedAccountGroup,
  SelectedShareBatch,
  ShareTargetItem,
  StagedItem,
} from './types.js';
import {
  extractErrorMessage,
  isModalActive,
  reportDevError,
} from './utils/workspaceHelpers.js';
import { useThemeChoice } from './hooks/useResolvedTheme.js';
import { useWorkspaceData } from './hooks/useWorkspaceData.js';
import { useWorkspaceNavigation } from './hooks/useWorkspaceNavigation.js';
import { useSelectionAndClipboard } from './hooks/useSelectionAndClipboard.js';
import { useItemCrudAndTransfer } from './hooks/useItemCrudAndTransfer.js';
import { useTrashMutations } from './hooks/useTrashMutations.js';
import { useExternalDropUpload } from './hooks/useExternalDropUpload.js';
import { useSyncAndRebalance } from './hooks/useSyncAndRebalance.js';
import { useAccountLifecycle } from './hooks/useAccountLifecycle.js';
import { usePoolManagement } from './hooks/usePoolManagement.js';
import { useShareActions } from './hooks/useShareActions.js';
import { invalidateShareInspectCache } from './utils/queryCache.js';
import { useBeforeUnload, useMediaQuery } from './utils/useBeforeUnload.js';

const styles = stylex.create({
  shell: {
    width: '100vw',
    height: '100vh',
    display: 'flex',
    backgroundColor: colors.canvas,
    overflow: 'hidden',
    position: 'relative',
  },
  mainWorkspace: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    height: '100%',
    minWidth: 0,
    overflow: 'hidden',
    position: 'relative',
  },
  workspaceTopChrome: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    minWidth: 0,
    marginLeft: layout.ditherStripHeight,
    '@media (max-width: 768px)': {
      marginLeft: '0px',
    },
  },
  workspaceErrorRegion: {
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    backgroundColor: colors.surface,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  workspaceErrorBanner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space3,
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    backgroundColor: colors.dangerSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    borderRadius: radius.compact,
    color: colors.dangerTextOnSurface,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    lineHeight: typography.lineHeightBody,
    boxSizing: 'border-box',
  },
  workspaceErrorContent: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    minWidth: 0,
    flex: 1,
  },
  workspaceErrorIcon: {
    flexShrink: 0,
  },
  workspaceErrorText: {
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  workspaceErrorDismissBtn: {
    height: '28px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    backgroundColor: colors.surface,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightSection,
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space1,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    cursor: 'pointer',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
    },
    ':active': {
      backgroundColor: colors.selectionBg,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
      minWidth: '44px',
    },
  },
  fileTableStage: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    position: 'relative',
  },
  fileTablePane: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  fileTablePaneHidden: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    contentVisibility: 'hidden',
    display: {
      default: 'flex',
      '@supports not (content-visibility: hidden)': 'none',
    },
  },
});

const EMPTY_SELECTED_IDS = new Set<string>();

export function App() {
  const { themeChoice, effectiveTheme, handleThemeChange } = useThemeChoice();

  const [searchQuery, setSearchQuery] = useState<string>('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const surfaceWorkspaceError = useCallback((context: string, err: unknown, fallback: string) => {
    const message = extractErrorMessage(err, fallback);
    setWorkspaceError(message);
    reportDevError(context, err instanceof Error ? err : message);
  }, []);
  const [renameModalItem, setRenameModalItem] = useState<RenameTarget | null>(null);
  const [movePoolTargetAccount, setMovePoolTargetAccount] = useState<AccountItem | null>(null);
  const [moveFilesModalGroup, setMoveFilesModalGroup] = useState<SelectedAccountGroup | null>(null);
  const [scrollRequest, setScrollRequest] = useState<{ id: string; seq: number } | null>(null);

  const isSyncingRef = useRef(false);
  const pendingOpsCountRefForData = useRef(0);
  const [isMobileOpen, setIsMobileOpen] = useState<boolean>(false);

  const [stagedFiles, setStagedFiles] = useState<Array<File | StagedItem>>([]);
  const [stagedEmptyFolders, setStagedEmptyFolders] = useState<string[]>([]);
  const [uploadTargetPath, setUploadTargetPath] = useState<string | undefined>(undefined);
  const [isUploadDrawerOpen, setIsUploadDrawerOpen] = useState<boolean>(false);

  const [isExternalChangesOpen, setIsExternalChangesOpen] = useState<boolean>(false);
  const [externalChangesAccountId, setExternalChangesAccountId] = useState<string | undefined>(undefined);

  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState<boolean>(false);
  const [pendingPurgeFiles, setPendingPurgeFiles] = useState<ClientFileRecord[] | null>(null);
  const [isNewFolderOpen, setIsNewFolderOpen] = useState<boolean>(false);
  const [shareModalState, setShareModalState] = useState<{
    items: ShareTargetItem[];
    sourcePoolId: number;
  } | null>(null);
  const [isClearSharePoolOpen, setIsClearSharePoolOpen] = useState<boolean>(false);

  const currentPathRefForData = useRef('/');
  const uiCallbacksRef = useRef({
    onClearUiState: () => {},
    onRestoreCachedPoolUi: () => {},
    onPoolSwitched: () => {},
    onAuthConflictsDetected: (_accountFilterId?: string) => {},
    onPopStateCloseModals: () => {},
    setSelectedIds: (_updater: React.SetStateAction<Set<string>>) => {},
    handleMoveItems: async (
      _items: Array<{ kind: 'file' | 'folder'; id: string }>,
      _targetFolderPath: string
    ) => {},
    handleCopyItems: async (
      _items: Array<{ kind: 'file' | 'folder'; id: string }>,
      _targetFolderPath: string
    ) => {},
    handleOpenNewFolder: () => {},
    handleOpenRenameSelected: () => {},
    handleDeleteSelected: async () => {},
    handleDownload: (_file: ClientFileRecord) => {},
  });

  const handleClearUiState = useCallback(() => uiCallbacksRef.current.onClearUiState(), []);
  const handleRestoreCachedPoolUi = useCallback(() => uiCallbacksRef.current.onRestoreCachedPoolUi(), []);
  const handlePoolSwitched = useCallback(() => uiCallbacksRef.current.onPoolSwitched(), []);
  const handleAuthConflictsDetected = useCallback(
    (accountFilterId?: string) => uiCallbacksRef.current.onAuthConflictsDetected(accountFilterId),
    []
  );
  const handlePopStateCloseModals = useCallback(() => uiCallbacksRef.current.onPopStateCloseModals(), []);
  const setSelectedIdsProxy = useCallback(
    (updater: React.SetStateAction<Set<string>>) => uiCallbacksRef.current.setSelectedIds(updater),
    []
  );
  const handleMoveItemsProxy = useCallback(
    (items: Array<{ kind: 'file' | 'folder'; id: string }>, targetFolderPath: string) =>
      uiCallbacksRef.current.handleMoveItems(items, targetFolderPath),
    []
  );
  const handleCopyItemsProxy = useCallback(
    (items: Array<{ kind: 'file' | 'folder'; id: string }>, targetFolderPath: string) =>
      uiCallbacksRef.current.handleCopyItems(items, targetFolderPath),
    []
  );
  const handleOpenNewFolderProxy = useCallback(() => uiCallbacksRef.current.handleOpenNewFolder(), []);
  const handleOpenRenameSelectedProxy = useCallback(() => uiCallbacksRef.current.handleOpenRenameSelected(), []);
  const handleDeleteSelectedProxy = useCallback(() => uiCallbacksRef.current.handleDeleteSelected(), []);
  const handleDownloadProxy = useCallback(
    (file: ClientFileRecord) => uiCallbacksRef.current.handleDownload(file),
    []
  );

  const {
    pools,
    setPools,
    poolsRef,
    activePoolId,
    setActivePoolId,
    activePoolIdRef,
    activePool,
    isSharePoolActive,
    isPoolSharePool,
    storage,
    setStorage,
    storageRef,
    discovered,
    setDiscovered,
    discoveredRef,
    files,
    setFiles,
    filesRef,
    folders,
    setFolders,
    foldersRef,
    trashedFiles,
    setTrashedFiles,
    trashedFilesRef,
    loadedFilesPoolId,
    loadedTrashPoolId,
    setLoadedTrashPoolId,
    shareLinksByBatch,
    setShareLinksByBatch,
    shareLinksPoolId,
    pendingDiscrepancies,
    setPendingDiscrepancies,
    trashStaleRef,
    failedFilesLoadPoolRef,
    skipNextPoolEffectRef,
    markTrashStale,
    checkAccountDiscrepancies,
    loadClusterData,
    loadFiles,
    loadTrashFiles,
    clearWorkspaceState,
    handleSelectPool,
    presentAuthorizedAccount,
  } = useWorkspaceData({
    currentPathRef: currentPathRefForData,
    isSyncingRef,
    pendingOpsCountRef: pendingOpsCountRefForData,
    surfaceWorkspaceError,
    onClearUiState: handleClearUiState,
    onRestoreCachedPoolUi: handleRestoreCachedPoolUi,
    onPoolSwitched: handlePoolSwitched,
    onAuthConflictsDetected: handleAuthConflictsDetected,
  });

  const isPopStateBlockedRef = useRef(false);

  const {
    currentPath,
    setCurrentPath,
    currentPathRef,
    currentNav,
    setCurrentNav,
    currentNavRef,
    hasVisitedFiles,
    hasVisitedTrash,
    filteredAccountIds,
    setFilteredAccountIds,
    handleToggleAccountFilter,
    handleSelectNav,
    handleNavigate,
    handleNavigatePath,
    displayedFiles,
    displayedTrashedFiles,
    displayedFolders,
    visibleSelectableIds,
  } = useWorkspaceNavigation({
    activePoolId,
    loadedFilesPoolId,
    failedFilesLoadPoolRef,
    files,
    folders,
    trashedFiles,
    setSelectedIds: setSelectedIdsProxy,
    setWorkspaceError,
    isPopStateBlockedRef,
    onPopStateCloseModals: handlePopStateCloseModals,
  });

  const {
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
  } = useSelectionAndClipboard({
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
    handleMoveItems: handleMoveItemsProxy,
    handleCopyItems: handleCopyItemsProxy,
    handleOpenNewFolder: handleOpenNewFolderProxy,
    handleOpenRenameSelected: handleOpenRenameSelectedProxy,
    handleDeleteSelected: handleDeleteSelectedProxy,
    handleDownload: handleDownloadProxy,
  });

  const {
    pendingOpsCount,
    runPendingOp,
    pendingMoveConflict,
    setPendingMoveConflict,
    isResolvingMoveConflict,
    setIsResolvingMoveConflict,
    handleCreateFolder,
    handleDownload,
    handleDeleteFolder,
    handleDeleteSelected,
    handleMoveItems,
    handleDropItemsToRoot,
    handleResolveMoveConflict,
    handleTrashItems,
    handleCopyItems,
    handleRename,
  } = useItemCrudAndTransfer({
    isSharePoolActive,
    activePoolIdRef,
    poolsRef,
    setPools,
    filesRef,
    setFiles,
    foldersRef,
    setFolders,
    trashedFilesRef,
    setTrashedFiles,
    currentNavRef,
    currentPathRef,
    filteredAccountIds,
    selectedIds,
    setSelectedIds,
    clipboard,
    setClipboard,
    setPendingPurgeFiles,
    setConfirmEmptyTrash,
    setScrollRequest,
    setWorkspaceError,
    surfaceWorkspaceError,
    markTrashStale,
    handleNavigate,
    loadFiles,
    loadTrashFiles,
    loadClusterData,
  });

  const {
    handleTrash,
    handleRestoreFile,
    handlePermanentDelete,
    handleConfirmPurgeFiles,
    handleBatchRestore,
    handleEmptyTrashExecute,
  } = useTrashMutations({
    activePoolIdRef,
    filesRef,
    setFiles,
    trashedFilesRef,
    setTrashedFiles,
    trashStaleRef,
    currentNav,
    currentNavRef,
    currentPathRef,
    selectedIds,
    setSelectedIds,
    pendingPurgeFiles,
    setPendingPurgeFiles,
    setConfirmEmptyTrash,
    setWorkspaceError,
    surfaceWorkspaceError,
    markTrashStale,
    runPendingOp,
    loadFiles,
    loadTrashFiles,
    loadClusterData,
  });

  const { handleDropExternalToPath, handleDropExternalToRoot } = useExternalDropUpload({
    isSharePoolActive,
    currentNav,
    currentPath,
    setStagedFiles,
    setStagedEmptyFolders,
    setUploadTargetPath,
    setIsUploadDrawerOpen,
    surfaceWorkspaceError,
  });

  const loadedTrashPoolIdRef = useRef(loadedTrashPoolId);
  loadedTrashPoolIdRef.current = loadedTrashPoolId;

  const {
    isSyncing,
    transferringFileIds,
    handleSyncAll,
    accountItems,
    externalChangesAccounts,
    handleTransferFile,
    handleTransferBatch,
  } = useSyncAndRebalance({
    activePoolId,
    activePoolIdRef,
    isSharePoolActive,
    isPoolSharePool,
    storage,
    discovered,
    discoveredRef,
    files,
    pendingDiscrepancies,
    currentNavRef,
    currentPathRef,
    externalChangesAccountId,
    setWorkspaceError,
    surfaceWorkspaceError,
    runPendingOp,
    markTrashStale,
    checkAccountDiscrepancies,
    loadClusterData,
    loadFiles,
  });

  const {
    isImporting,
    sidebarError,
    clearSidebarError,
    driveActionModal,
    setDriveActionModal,
    handleImportOAuth,
    handleEnableAccount,
    handleDisableAccountItem,
    handleRemoveAccountItem,
    handleConfirmDriveAction: handleExecuteDriveAction,
    driveFilesCount,
    driveTotalBytes,
    authUrls,
    authUrlErrors,
    copiedAuthUrlId,
    handleCopyAuthUrl,
  } = useAccountLifecycle({
    activePoolIdRef,
    accountItems,
    files,
    trashedFiles,
    loadedTrashPoolIdRef,
    trashStaleRef,
    currentPathRef,
    loadClusterData,
    loadFiles,
    loadTrashFiles,
    presentAuthorizedAccount,
  });

  const {
    handleCreatePool,
    handleDeletePool,
    handleSwitchAccountPool,
  } = usePoolManagement({
    poolsRef,
    setPools,
    activePoolIdRef,
    skipNextPoolEffectRef,
    setStorage,
    storageRef,
    setDiscovered,
    discoveredRef,
    currentNavRef,
    currentPathRef,
    setWorkspaceError,
    surfaceWorkspaceError,
    runPendingOp,
    markTrashStale,
    loadClusterData,
    loadFiles,
    loadTrashFiles,
    handleSelectPool,
  });

  const {
    handleShareSelected,
    handleShareItem,
    handleShareComplete,
    handleClearSharePoolConfirm,
    handleCopyBatchLinks,
    hasLockedSharePoolAccounts,
  } = useShareActions({
    activePoolId,
    activePoolIdRef,
    isSharePoolActive,
    skipNextPoolEffectRef,
    setActivePoolId,
    accountItems,
    files,
    setFiles,
    folders,
    setFolders,
    setTrashedFiles,
    setLoadedTrashPoolId,
    trashStaleRef,
    shareLinksByBatch,
    setShareLinksByBatch,
    currentNav,
    currentNavRef,
    setCurrentNav,
    currentPathRef,
    selectedIds,
    setSelectedIds,
    setShareModalState,
    setWorkspaceError,
    runPendingOp,
    loadClusterData,
    loadFiles,
    loadTrashFiles,
    clearWorkspaceState,
    handleNavigate,
  });

  isSyncingRef.current = isSyncing;

  const handleOpenNewFolder = useCallback(() => {
    if (isSharePoolActive) return;
    setIsNewFolderOpen(true);
  }, [isSharePoolActive]);

  const handleOpenRenameSelected = useCallback(() => {
    if (isSharePoolActive) return;
    if (selectedIds.size !== 1 || selectedIds.has('__parent__')) return;
    const selectedId = Array.from(selectedIds)[0];
    const foundFolder = folders.find((f) => f.id === selectedId);
    if (foundFolder) {
      setRenameModalItem({ kind: 'folder', id: foundFolder.id, name: foundFolder.name });
      return;
    }
    const allFiles = currentNav === 'trash' ? trashedFiles : files;
    const foundFile = allFiles.find((f) => f.id === selectedId);
    if (foundFile) {
      setRenameModalItem({ kind: 'file', id: foundFile.id, name: foundFile.name });
    }
  }, [isSharePoolActive, selectedIds, currentNav, folders, files, trashedFiles]);

  pendingOpsCountRefForData.current = pendingOpsCount;
  isPopStateBlockedRef.current = driveActionModal.isLoading || pendingOpsCount > 0 || isResolvingMoveConflict;
  currentPathRefForData.current = currentPath;
  uiCallbacksRef.current = {
    onClearUiState: () => {
      setFilteredAccountIds(new Set());
      setSelectedIds(new Set());
      setClipboard(null);
      setWorkspaceError(null);
      clearSidebarError();
      setPendingMoveConflict(null);
      setPendingPurgeFiles(null);
      setIsResolvingMoveConflict(false);
      setScrollRequest(null);
    },
    onRestoreCachedPoolUi: () => {
      setFilteredAccountIds(new Set());
      setSelectedIds(new Set());
      setClipboard(null);
    },
    onPoolSwitched: () => {
      setCurrentPath('/');
      setWorkspaceError(null);
      clearSidebarError();
      setIsUploadDrawerOpen(false);
      setIsExternalChangesOpen(false);
      setShareModalState(null);
      setIsClearSharePoolOpen(false);
      setMoveFilesModalGroup(null);
      setPendingMoveConflict(null);
      setPendingPurgeFiles(null);
      setIsResolvingMoveConflict(false);
      setRenameModalItem(null);
      setDriveActionModal((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));
    },
    onAuthConflictsDetected: (accountFilterId?: string) => {
      if (accountFilterId) {
        setExternalChangesAccountId(accountFilterId);
      }
      setIsExternalChangesOpen(true);
    },
    onPopStateCloseModals: () => {
      if (renameModalItem) setRenameModalItem(null);
      if (movePoolTargetAccount) setMovePoolTargetAccount(null);
      if (moveFilesModalGroup) setMoveFilesModalGroup(null);
      if (pendingMoveConflict) setPendingMoveConflict(null);
      if (isUploadDrawerOpen) setIsUploadDrawerOpen(false);
      if (isExternalChangesOpen) setIsExternalChangesOpen(false);
      if (isNewFolderOpen) setIsNewFolderOpen(false);
      if (confirmEmptyTrash) setConfirmEmptyTrash(false);
      if (pendingPurgeFiles) setPendingPurgeFiles(null);
      if (shareModalState) setShareModalState(null);
      if (isClearSharePoolOpen) setIsClearSharePoolOpen(false);
      if (driveActionModal.isOpen && !driveActionModal.isLoading) {
        setDriveActionModal((prev) => ({ ...prev, isOpen: false }));
      }
    },
    setSelectedIds,
    handleMoveItems,
    handleCopyItems,
    handleOpenNewFolder,
    handleOpenRenameSelected,
    handleDeleteSelected,
    handleDownload,
  };

  const hasInFlightAppProcess =
    isSyncing ||
    isImporting ||
    transferringFileIds.size > 0 ||
    driveActionModal.isLoading ||
    pendingOpsCount > 0;

  useBeforeUnload(hasInFlightAppProcess);

  const isMobileViewport = useMediaQuery('(max-width: 768px)');
  const prevMobileViewportRef = useRef(isMobileViewport);
  useEffect(() => {
    if (prevMobileViewportRef.current !== isMobileViewport) {
      prevMobileViewportRef.current = isMobileViewport;
      if (!isMobileViewport) {
        setIsMobileOpen(false);
      }
      setIsExternalChangesOpen(false);
      setExternalChangesAccountId(undefined);
    }
  }, [isMobileViewport]);

  useEffect(() => {
    let resizeTimer: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      document.body.classList.add('resize-animation-stopper');
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        document.body.classList.remove('resize-animation-stopper');
      }, 150);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimer);
    };
  }, []);

  useEffect(() => {
    if (currentNav === 'trash') {
      if (loadedTrashPoolId !== activePoolId || trashStaleRef.current) {
        void loadTrashFiles(activePoolId);
      }
    }
    setConfirmEmptyTrash(false);
    setPendingPurgeFiles(null);
  }, [currentNav, activePoolId, loadedTrashPoolId, loadTrashFiles]);

  const handleUploadFiles = useCallback(
    (fileList: FileList) => {
      if (isSharePoolActive) return;
      const list = Array.from(fileList);
      if (list.length > 0) {
        setStagedFiles(list);
        setStagedEmptyFolders([]);
        setUploadTargetPath(undefined);
        setIsUploadDrawerOpen(true);
      }
    },
    [isSharePoolActive]
  );

  const handleStageDroppedUpload = useCallback(
    (dropped: { files: Array<{ file: File; virtualPath: string }>; emptyFolders: string[]; basePath?: string }) => {
      if (isSharePoolActive || isModalActive()) return;
      if (dropped.files.length > 0 || dropped.emptyFolders.length > 0) {
        setStagedFiles(dropped.files);
        setStagedEmptyFolders(dropped.emptyFolders);
        setUploadTargetPath(dropped.basePath);
        setIsUploadDrawerOpen(true);
      }
    },
    [isSharePoolActive]
  );

  const isSharePoolDataReady = isSharePoolActive && loadedFilesPoolId === activePoolId;
  const isShareLinksReady = isSharePoolDataReady && shareLinksPoolId === activePoolId;

  useEffect(() => {
    if (
      isSharePoolDataReady &&
      files.length === 0 &&
      folders.length === 0 &&
      hasLockedSharePoolAccounts &&
      (loadedTrashPoolId !== activePoolId || trashStaleRef.current)
    ) {
      void loadTrashFiles(activePoolId);
    }
  }, [
    isSharePoolDataReady,
    files.length,
    folders.length,
    hasLockedSharePoolAccounts,
    loadedTrashPoolId,
    activePoolId,
    loadTrashFiles,
  ]);
  const isTableLoading =
    currentNav === 'trash' ? loadedTrashPoolId !== activePoolId : loadedFilesPoolId !== activePoolId;
  const activeBatchFolderName =
    isShareLinksReady && currentNav !== 'trash' && currentPath !== '/'
      ? (currentPath.split('/').filter(Boolean)[0] ?? null)
      : null;
  const activeBatchLinks = activeBatchFolderName ? (shareLinksByBatch[activeBatchFolderName] ?? []) : [];

  const trashedTotalBytes = useMemo(
    () => trashedFiles.reduce((acc, f) => acc + (f.sizeBytes || 0), 0),
    [trashedFiles]
  );
  const pendingPurgeTotalBytes = useMemo(
    () => (pendingPurgeFiles ?? []).reduce((acc, f) => acc + (f.sizeBytes || 0), 0),
    [pendingPurgeFiles]
  );
  const sharePoolTotalBytes = useMemo(
    () =>
      Math.max(
        activePool?.totalBytes ?? 0,
        files.reduce((acc, f) => acc + (f.sizeBytes || 0), 0)
      ) + trashedTotalBytes,
    [activePool?.totalBytes, files, trashedTotalBytes]
  );
  const sharePoolTotalItemCount =
    Math.max(activePool?.fileCount ?? 0, files.length) + folders.length + trashedFiles.length;

  const selectedAccountGroups: SelectedAccountGroup[] = useMemo(() => {
    if (currentNav === 'trash') return [];
    const groupsMap = new Map<string, { fileIds: string[]; totalBytes: number }>();
    for (const f of selectedFiles) {
      const existing = groupsMap.get(f.accountId);
      if (existing) {
        existing.fileIds.push(f.id);
        existing.totalBytes += f.sizeBytes || 0;
      } else {
        groupsMap.set(f.accountId, { fileIds: [f.id], totalBytes: f.sizeBytes || 0 });
      }
    }
    return Array.from(groupsMap.entries()).map(([accountId, group]) => {
      const acc = accountItems.find((a) => a.id === accountId);
      return {
        accountId,
        accountName: acc?.displayName || accountId,
        fileIds: group.fileIds,
        totalBytes: group.totalBytes,
      };
    });
  }, [currentNav, selectedFiles, accountItems]);

  const selectedShareBatches: SelectedShareBatch[] = useMemo(() => {
    if (!isShareLinksReady || currentNav === 'trash' || currentPath !== '/') {
      return [];
    }
    const batches: SelectedShareBatch[] = [];
    for (const folder of displayedFolders) {
      if (!selectedIds.has(folder.id)) continue;
      const segments = folder.virtualPath.split('/').filter(Boolean);
      if (segments.length !== 1) continue;
      const batchFolderName = segments[0];
      const links = shareLinksByBatch[batchFolderName] ?? [];
      if (links.length === 0) continue;
      batches.push({
        batchFolderName,
        linksCount: links.length,
      });
    }
    return batches;
  }, [isShareLinksReady, currentNav, currentPath, displayedFolders, selectedIds, shareLinksByBatch]);

  const modalFiles = useMemo(() => {
    if (!moveFilesModalGroup) return [];
    const idsSet = new Set(moveFilesModalGroup.fileIds);
    return selectedFiles.filter(
      (f) => idsSet.has(f.id) && f.accountId === moveFilesModalGroup.accountId
    );
  }, [moveFilesModalGroup, selectedFiles]);

  const handleRenamePoolPrompt = useCallback((pool: PoolSummary) => {
    setRenameModalItem({ kind: 'pool', id: String(pool.id), name: pool.name });
  }, []);

  const handleOpenMovePool = useCallback((acc: AccountItem) => {
    setMovePoolTargetAccount(acc);
  }, []);

  const handleOpenExternalChanges = useCallback((accId?: string) => {
    setExternalChangesAccountId(accId);
    setIsExternalChangesOpen(true);
  }, []);

  const handleCloseMobile = useCallback(() => {
    setIsMobileOpen(false);
  }, []);

  const handleToggleMobileMenu = useCallback(() => {
    setIsMobileOpen((o) => !o);
  }, []);

  const handleOpenEmptyTrash = useCallback(() => {
    setPendingPurgeFiles(null);
    setConfirmEmptyTrash(true);
  }, []);

  const handleOpenMoveFilesModal = useCallback((group: SelectedAccountGroup) => {
    setMoveFilesModalGroup(group);
  }, []);

  const handleOpenClearSharePool = useCallback(() => {
    const poolId = activePoolIdRef.current;
    if (loadedTrashPoolIdRef.current !== poolId || trashStaleRef.current) {
      void loadTrashFiles(poolId);
    }
    setIsClearSharePoolOpen(true);
  }, [loadTrashFiles]);

  const activeBatchFolderNameRef = useRef(activeBatchFolderName);
  activeBatchFolderNameRef.current = activeBatchFolderName;

  const handleCopyActiveShareLinks = useCallback(async () => {
    if (!activeBatchFolderNameRef.current) return false;
    return handleCopyBatchLinks(activeBatchFolderNameRef.current);
  }, [handleCopyBatchLinks]);

  const handleDropFilesToTable = useCallback((droppedFiles: File[]) => {
    if (isModalActive()) return;
    if (droppedFiles.length > 0) {
      setStagedFiles(droppedFiles);
      setStagedEmptyFolders([]);
      setUploadTargetPath(undefined);
      setIsUploadDrawerOpen(true);
    }
  }, []);

  return (
    <div
      {...stylex.props(
        styles.shell,
        effectiveTheme === 'dark' && darkColors
      )}
      data-theme={effectiveTheme}
    >
      <div className="grain-overlay" />

      <Sidebar
        accounts={accountItems}
        filteredAccountIds={filteredAccountIds}
        onToggleAccountFilter={handleToggleAccountFilter}
        tsubasaUsedBytes={storage?.totalTsubasaUsedBytes ?? storage?.systemStorage?.systemBytesTotal ?? 0}
        poolHeadroomBytes={storage?.totalHeadroomBytes ?? 0}
        clusterTransfer={storage?.clusterTransfer}
        pools={pools}
        activePoolId={activePoolId}
        onSelectPool={handleSelectPool}
        onCreatePool={handleCreatePool}
        onRenamePoolPrompt={isSharePoolActive ? undefined : handleRenamePoolPrompt}
        onDeletePoolPrompt={isSharePoolActive ? undefined : handleDeletePool}
        onOpenMovePool={handleOpenMovePool}
        currentNav={currentNav}
        onSelectNav={handleSelectNav}
        onRefreshStorage={loadClusterData}
        onOpenExternalChanges={isSharePoolActive ? undefined : handleOpenExternalChanges}
        onImportOAuth={handleImportOAuth}
        onDisableAccount={handleDisableAccountItem}
        onEnableAccount={handleEnableAccount}
        onRemoveAccount={handleRemoveAccountItem}
        authUrls={authUrls}
        authUrlErrors={authUrlErrors}
        copiedAuthUrlId={copiedAuthUrlId}
        onCopyAuthUrl={handleCopyAuthUrl}
        isImporting={isImporting}
        sidebarError={sidebarError}
        onDismissSidebarError={clearSidebarError}
        isMobileOpen={isMobileOpen}
        isDimmed={isExternalChangesOpen}
        onCloseMobile={handleCloseMobile}
        onDropItemsToRoot={isSharePoolActive ? undefined : handleDropItemsToRoot}
        onDropItemsToTrash={handleTrashItems}
        onDropExternalToRoot={isSharePoolActive ? undefined : handleDropExternalToRoot}
      />

      <div {...stylex.props(styles.mainWorkspace)}>
        <DitherDivider orientation="vertical" isDark={effectiveTheme === 'dark'} />

        <div {...stylex.props(styles.workspaceTopChrome)}>
          <Header
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            theme={themeChoice}
            onThemeChange={handleThemeChange}
            onToggleMobileMenu={handleToggleMobileMenu}
            isMobileMenuOpen={isMobileOpen}
          />

          <ActionPortal
            currentPath={currentPath}
            onNavigatePath={handleNavigatePath}
            onUploadFiles={handleUploadFiles}
            onCreateFolderPrompt={handleOpenNewFolder}
            onSyncAll={handleSyncAll}
            isSyncing={isSyncing}
            isTrashView={currentNav === 'trash'}
            trashedCount={displayedTrashedFiles.length}
            onEmptyTrash={handleOpenEmptyTrash}
            selectedCount={actionableSelectedCount}
            selectedTotalBytes={selectedTotalBytes}
            selectedAccountGroups={selectedAccountGroups}
            onOpenMoveFilesModal={isSharePoolActive ? undefined : handleOpenMoveFilesModal}
            onClearSelection={handleClearSelection}
            onDeleteSelected={handleDeleteSelected}
            onRenamePrompt={isSharePoolActive ? undefined : handleOpenRenameSelected}
            onRestoreSelected={handleBatchRestore}
            onCutSelected={isSharePoolActive ? undefined : handleCutSelected}
            onCopySelected={isSharePoolActive ? undefined : handleCopySelected}
            clipboard={isSharePoolActive ? null : clipboard}
            onPaste={isSharePoolActive ? undefined : handlePaste}
            onMoveItemsToPath={isSharePoolActive ? undefined : handleMoveItems}
            onCopyItemsToPath={isSharePoolActive ? undefined : handleCopyItems}
            onDropExternalToPath={isSharePoolActive ? undefined : handleDropExternalToPath}
            onShareSelected={isSharePoolActive ? undefined : handleShareSelected}
            isSharePoolActive={isSharePoolActive}
            sharePoolItemCount={isSharePoolDataReady ? sharePoolTotalItemCount : 0}
            onClearSharePool={isSharePoolDataReady ? handleOpenClearSharePool : undefined}
            activeShareLinksCount={activeBatchLinks.length}
            onCopyActiveShareLinks={
              activeBatchLinks.length > 0 && activeBatchFolderName ? handleCopyActiveShareLinks : undefined
            }
            selectedShareBatches={selectedShareBatches}
            onCopyShareBatchLinks={handleCopyBatchLinks}
          />

          {workspaceError && (
            <div {...stylex.props(styles.workspaceErrorRegion)}>
              <div {...stylex.props(styles.workspaceErrorBanner)} role="alert">
                <div {...stylex.props(styles.workspaceErrorContent)}>
                  <IconAlertTriangle size={16} {...stylex.props(styles.workspaceErrorIcon)} />
                  <span {...stylex.props(styles.workspaceErrorText)}>{workspaceError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setWorkspaceError(null)}
                  aria-label="Dismiss error"
                  {...stylex.props(styles.workspaceErrorDismissBtn)}
                >
                  <IconClose size={14} />
                  <span>Dismiss</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <div {...stylex.props(styles.fileTableStage)}>
          {hasVisitedFiles && (
            <div
              {...stylex.props(
                styles.fileTablePane,
                currentNav !== 'files' && styles.fileTablePaneHidden
              )}
              inert={currentNav !== 'files'}
            >
              <FileTable
                files={displayedFiles}
                folders={displayedFolders}
                isLoading={isTableLoading && currentNav === 'files'}
                currentPath={currentPath}
                searchQuery={deferredSearchQuery}
                selectedIds={currentNav === 'files' ? selectedIds : EMPTY_SELECTED_IDS}
                onSelect={handleSelect}
                onSelectMultiple={handleSelectMultiple}
                onClearSelection={handleClearSelection}
                onNavigate={handleNavigatePath}
                onDownload={handleDownload}
                onTrash={handleTrash}
                onDeleteFolder={handleDeleteFolder}
                isTrashView={false}
                onRestore={handleRestoreFile}
                onPermanentDelete={handlePermanentDelete}
                onDropFiles={isSharePoolActive ? undefined : handleDropFilesToTable}
                onStageDroppedUpload={isSharePoolActive ? undefined : handleStageDroppedUpload}
                onMoveItems={isSharePoolActive ? undefined : handleMoveItems}
                onCopyItems={isSharePoolActive ? undefined : handleCopyItems}
                scrollRequest={scrollRequest}
                clipboard={isSharePoolActive ? null : clipboard}
                accounts={accountItems}
                onTransferFile={isSharePoolActive ? undefined : handleTransferFile}
                transferringFileIds={transferringFileIds}
                onShareItem={isSharePoolActive ? undefined : handleShareItem}
                isSharePoolActive={isSharePoolActive}
                shareLinksByBatch={isShareLinksReady ? shareLinksByBatch : undefined}
                onCopyShareLinks={isShareLinksReady ? handleCopyBatchLinks : undefined}
              />
            </div>
          )}

          {hasVisitedTrash && (
            <div
              {...stylex.props(
                styles.fileTablePane,
                currentNav !== 'trash' && styles.fileTablePaneHidden
              )}
              inert={currentNav !== 'trash'}
            >
              <FileTable
                files={displayedTrashedFiles}
                folders={[]}
                isLoading={isTableLoading && currentNav === 'trash'}
                currentPath={currentPath}
                searchQuery={deferredSearchQuery}
                selectedIds={currentNav === 'trash' ? selectedIds : EMPTY_SELECTED_IDS}
                onSelect={handleSelect}
                onSelectMultiple={handleSelectMultiple}
                onClearSelection={handleClearSelection}
                onNavigate={handleNavigatePath}
                onDownload={handleDownload}
                onTrash={handleTrash}
                onDeleteFolder={handleDeleteFolder}
                isTrashView={true}
                onRestore={handleRestoreFile}
                onPermanentDelete={handlePermanentDelete}
                onDropFiles={undefined}
                onStageDroppedUpload={undefined}
                onMoveItems={undefined}
                clipboard={null}
                accounts={accountItems}
                onTransferFile={undefined}
                transferringFileIds={transferringFileIds}
                onShareItem={undefined}
                isSharePoolActive={isSharePoolActive}
                shareLinksByBatch={undefined}
                onCopyShareLinks={undefined}
              />
            </div>
          )}
        </div>
      </div>

      <WorkspaceOverlays
        currentPath={currentPath}
        currentNav={currentNav}
        activePoolId={activePoolId}
        pools={pools}
        accountItems={accountItems}
        isUploadDrawerOpen={isUploadDrawerOpen}
        onCloseUploadDrawer={() => {
          setIsUploadDrawerOpen(false);
          setStagedFiles([]);
          setStagedEmptyFolders([]);
          setUploadTargetPath(undefined);
        }}
        stagedFiles={stagedFiles}
        stagedEmptyFolders={stagedEmptyFolders}
        uploadTargetPath={uploadTargetPath}
        onUploadComplete={async () => {
          invalidateShareInspectCache();
          await Promise.all([loadClusterData(), loadFiles(currentPath)]);
        }}
        onClearUploadFiles={() => {
          setStagedFiles([]);
          setStagedEmptyFolders([]);
          setUploadTargetPath(undefined);
        }}
        isExternalChangesOpen={isExternalChangesOpen}
        onCloseExternalChanges={() => {
          setIsExternalChangesOpen(false);
          setExternalChangesAccountId(undefined);
        }}
        externalChangesAccounts={externalChangesAccounts}
        externalChangesAccountId={externalChangesAccountId}
        isMobileSidebarOpen={isMobileViewport && isMobileOpen}
        onExternalChangesResolved={async (summary) => {
          invalidateShareInspectCache();
          if (summary) {
            setPendingDiscrepancies((prev) => ({
              ...prev,
              [summary.accountId]: summary.remainingCount > 0,
            }));
          }
          await Promise.all([
            loadClusterData(),
            summary?.refreshFiles !== false ? loadFiles(currentPath) : Promise.resolve(),
          ]);
        }}
        isNewFolderOpen={isNewFolderOpen}
        onCloseNewFolder={() => setIsNewFolderOpen(false)}
        onCreateFolder={handleCreateFolder}
        renameModalItem={renameModalItem}
        onCloseRenameModal={() => setRenameModalItem(null)}
        onRename={handleRename}
        movePoolTargetAccount={movePoolTargetAccount}
        onCloseMovePool={() => setMovePoolTargetAccount(null)}
        onConfirmMovePool={handleSwitchAccountPool}
        moveFilesModalGroup={moveFilesModalGroup}
        onCloseMoveFilesModal={() => setMoveFilesModalGroup(null)}
        modalFiles={modalFiles}
        onConfirmMoveFiles={handleTransferBatch}
        pendingMoveConflict={pendingMoveConflict}
        isResolvingMoveConflict={isResolvingMoveConflict}
        onCloseMoveConflict={() => {
          if (!isResolvingMoveConflict) {
            setPendingMoveConflict(null);
          }
        }}
        onResolveMoveConflict={handleResolveMoveConflict}
        confirmEmptyTrash={confirmEmptyTrash}
        onCloseEmptyTrash={() => setConfirmEmptyTrash(false)}
        onConfirmEmptyTrash={handleEmptyTrashExecute}
        trashedFilesCount={trashedFiles.length}
        trashedTotalBytes={trashedTotalBytes}
        pendingPurgeFiles={pendingPurgeFiles}
        onClosePurgeFiles={() => setPendingPurgeFiles(null)}
        onConfirmPurgeFiles={handleConfirmPurgeFiles}
        pendingPurgeTotalBytes={pendingPurgeTotalBytes}
        shareModalState={shareModalState}
        onCloseShareModal={() => setShareModalState(null)}
        onShareComplete={handleShareComplete}
        isClearSharePoolOpen={isClearSharePoolOpen}
        onCloseClearSharePool={() => setIsClearSharePoolOpen(false)}
        onConfirmClearSharePool={handleClearSharePoolConfirm}
        sharePoolTotalItemCount={sharePoolTotalItemCount}
        sharePoolTotalBytes={sharePoolTotalBytes}
        driveActionModal={driveActionModal}
        onCloseDriveAction={() => {
          if (!driveActionModal.isLoading) {
            setDriveActionModal((prev) => ({ ...prev, isOpen: false }));
          }
        }}
        onConfirmDriveAction={handleExecuteDriveAction}
        driveFilesCount={driveFilesCount}
        driveTotalBytes={driveTotalBytes}
      />
    </div>
  );
}

export default App;
