import { startTransition, useCallback, useMemo, useRef } from 'react';
import { client } from '../api.js';
import type {
  AccountItem,
  ClientFileRecord,
  ClientFolder,
  DiscoveredAccount,
  ShareExecuteResult,
  ShareTargetItem,
  StoredShareLink,
} from '../types.js';
import { copyTextToClipboard } from '../utils/format.js';
import { invalidateShareInspectCache, setPoolCache } from '../utils/queryCache.js';
import { extractErrorMessage, readResponseError } from '../utils/workspaceHelpers.js';

export interface UseShareActionsOptions {
  activePoolId: number;
  activePoolIdRef: React.MutableRefObject<number>;
  isSharePoolActive: boolean;
  skipNextPoolEffectRef: React.MutableRefObject<number | null>;
  setActivePoolId: React.Dispatch<React.SetStateAction<number>>;
  accountItems: AccountItem[];
  files: ClientFileRecord[];
  setFiles: React.Dispatch<React.SetStateAction<ClientFileRecord[]>>;
  folders: ClientFolder[];
  setFolders: React.Dispatch<React.SetStateAction<ClientFolder[]>>;
  setTrashedFiles: React.Dispatch<React.SetStateAction<ClientFileRecord[]>>;
  setLoadedTrashPoolId: React.Dispatch<React.SetStateAction<number | null>>;
  trashStaleRef: React.MutableRefObject<boolean>;
  shareLinksByBatch: Record<string, StoredShareLink[]>;
  setShareLinksByBatch: React.Dispatch<React.SetStateAction<Record<string, StoredShareLink[]>>>;
  currentNav: 'files' | 'trash';
  currentNavRef: React.MutableRefObject<'files' | 'trash'>;
  setCurrentNav: React.Dispatch<React.SetStateAction<'files' | 'trash'>>;
  currentPathRef: React.RefObject<string>;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setShareModalState: React.Dispatch<
    React.SetStateAction<{ items: ShareTargetItem[]; sourcePoolId: number } | null>
  >;
  setWorkspaceError: React.Dispatch<React.SetStateAction<string | null>>;
  runPendingOp: <T>(fn: () => Promise<T>) => Promise<T>;
  loadClusterData: (targetPoolId?: number) => Promise<DiscoveredAccount[] | undefined>;
  loadFiles: (path: string, targetPoolId?: number) => Promise<void>;
  loadTrashFiles: (targetPoolId?: number) => Promise<void>;
  clearWorkspaceState: () => void;
  handleNavigate: (newPath: string) => void;
}

export function useShareActions({
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
}: UseShareActionsOptions) {
  const shareLinksByBatchRef = useRef(shareLinksByBatch);
  shareLinksByBatchRef.current = shareLinksByBatch;

  const handleShareSelected = useCallback(() => {
    if (isSharePoolActive || currentNav === 'trash') return;
    const actionableIds = new Set(Array.from(selectedIds).filter((id) => id !== '__parent__'));
    if (actionableIds.size === 0) return;

    const selectedFoldersList = folders.filter((f) => actionableIds.has(f.id));
    const selectedFilesList = files.filter((f) => actionableIds.has(f.id) && !f.isTrashed);
    const items: ShareTargetItem[] = [
      ...selectedFoldersList.map((f) => ({
        kind: 'folder' as const,
        id: f.id,
        name: f.name,
        virtualPath: f.virtualPath,
      })),
      ...selectedFilesList.map((f) => ({
        kind: 'file' as const,
        id: f.id,
        name: f.name,
        virtualPath: f.virtualPath,
      })),
    ];
    if (items.length > 0) {
      setShareModalState({ items, sourcePoolId: activePoolId });
    }
  }, [isSharePoolActive, currentNav, selectedIds, folders, files, activePoolId, setShareModalState]);

  const handleShareItem = useCallback(
    (item: ShareTargetItem) => {
      if (isSharePoolActive) return;
      setShareModalState({ items: [item], sourcePoolId: activePoolId });
    },
    [isSharePoolActive, activePoolId, setShareModalState]
  );

  const handleShareComplete = useCallback(
    async (result: ShareExecuteResult) => {
      clearWorkspaceState();
      const batchPath = '/' + result.batchFolderName;
      skipNextPoolEffectRef.current = result.sharePoolId;
      activePoolIdRef.current = result.sharePoolId;
      currentNavRef.current = 'files';
      startTransition(() => {
        setActivePoolId(result.sharePoolId);
        setCurrentNav('files');
      });
      handleNavigate(batchPath);
      await Promise.all([loadClusterData(result.sharePoolId), loadFiles(batchPath, result.sharePoolId)]);
    },
    [
      clearWorkspaceState,
      skipNextPoolEffectRef,
      activePoolIdRef,
      currentNavRef,
      setActivePoolId,
      setCurrentNav,
      handleNavigate,
      loadClusterData,
      loadFiles,
    ]
  );

  const handleClearSharePoolConfirm = useCallback(async () => {
    setWorkspaceError(null);
    const poolId = activePoolIdRef.current;

    await runPendingOp(async () => {
      try {
        const res = await client.api.pools[':id']['clear-share'].$post({
          param: { id: String(poolId) },
        });
        if (res.ok) {
          invalidateShareInspectCache();
          const nextPath = '/';
          if (activePoolIdRef.current === poolId) {
            setFiles([]);
            setFolders([]);
            setTrashedFiles([]);
            setLoadedTrashPoolId(poolId);
            trashStaleRef.current = false;
            setShareLinksByBatch({});
            setSelectedIds(new Set());
            if (currentPathRef.current !== nextPath) {
              handleNavigate(nextPath);
            }
          } else {
            setPoolCache(poolId, {
              files: [],
              folders: [],
              trashedFiles: [],
              loadedTrashPoolId: poolId,
              trashStale: false,
              shareLinksByBatch: {},
            });
          }
          if (currentNavRef.current === 'trash') {
            await Promise.all([loadFiles(nextPath, poolId), loadTrashFiles(poolId), loadClusterData(poolId)]);
          } else {
            await Promise.all([loadFiles(nextPath, poolId), loadClusterData(poolId)]);
          }
        } else {
          const msg = await readResponseError(res, 'Failed to clear Share Pool');
          throw Object.assign(new Error(msg), { handled: true });
        }
      } catch (err) {
        if (err instanceof Error && 'handled' in err) {
          throw err;
        }
        throw new Error(extractErrorMessage(err, 'Failed to clear Share Pool'));
      }
    });
  }, [
    activePoolIdRef,
    trashStaleRef,
    currentPathRef,
    currentNavRef,
    setWorkspaceError,
    setFiles,
    setFolders,
    setTrashedFiles,
    setLoadedTrashPoolId,
    setShareLinksByBatch,
    setSelectedIds,
    handleNavigate,
    loadFiles,
    loadTrashFiles,
    loadClusterData,
    runPendingOp,
  ]);

  const handleCopyBatchLinks = useCallback(async (batchFolderName: string): Promise<boolean> => {
    const links = shareLinksByBatchRef.current[batchFolderName] ?? [];
    const urls = links.map((l) => l.webViewLink).filter(Boolean);
    if (urls.length === 0) return false;

    const text = urls.join('\n');
    return await copyTextToClipboard(text);
  }, []);

  const hasLockedSharePoolAccounts = useMemo(
    () => accountItems.some((a) => !a.canSwitchPool),
    [accountItems]
  );

  return {
    handleShareSelected,
    handleShareItem,
    handleShareComplete,
    handleClearSharePoolConfirm,
    handleCopyBatchLinks,
    hasLockedSharePoolAccounts,
  };
}
