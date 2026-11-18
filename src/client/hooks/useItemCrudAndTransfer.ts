import { useCallback, useRef, useState } from 'react';
import { client } from '../api.js';
import type {
  ActionPortalClipboard,
  ClientFileRecord,
  ClientFolder,
  MoveConflictItem,
  MoveConflictResolutionMode,
  PoolSummary,
} from '../types.js';
import {
  getPoolCache,
  invalidateShareInspectCache,
  runWithConcurrency,
  setPoolCache,
} from '../utils/queryCache.js';
import {
  filterMovableItemsToPath,
  getParentDir,
  normalizeVirtualPath,
} from '../utils/virtualPath.js';
import {
  applyMoveResultsToClipboard,
  extractErrorMessage,
  isMoveConflictPayload,
  parseItemOperationResults,
  readResponseError,
  remapPathPrefix,
  reportDevError,
} from '../utils/workspaceHelpers.js';
import { trashFileRequest } from './useTrashMutations.js';

export interface PendingMoveConflict {
  items: Array<{ kind: 'file' | 'folder'; id: string }>;
  targetFolderPath: string;
  poolId: number;
  conflicts: MoveConflictItem[];
  cleanCount: number;
  errorMessage?: string | null;
}

async function deleteFolderRequest(
  folder: ClientFolder,
  poolId: number,
  currentPath: string
): Promise<{ ok: boolean; navigateParent?: string; error?: string }> {
  try {
    const res = await client.api.folders.$delete({
      query: { virtualPath: folder.virtualPath, poolId: String(poolId) },
    });
    if (res.ok) {
      let navigateParent: string | undefined;
      if (currentPath === folder.virtualPath || currentPath.startsWith(folder.virtualPath + '/')) {
        navigateParent = getParentDir(folder.virtualPath);
      }
      return { ok: true, navigateParent };
    }
    return { ok: false, error: await readResponseError(res, 'Failed to delete folder') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface UseItemCrudAndTransferOptions {
  isSharePoolActive: boolean;
  activePoolIdRef: React.RefObject<number>;
  poolsRef: React.RefObject<PoolSummary[]>;
  setPools: React.Dispatch<React.SetStateAction<PoolSummary[]>>;
  filesRef: React.RefObject<ClientFileRecord[]>;
  setFiles: React.Dispatch<React.SetStateAction<ClientFileRecord[]>>;
  foldersRef: React.RefObject<ClientFolder[]>;
  setFolders: React.Dispatch<React.SetStateAction<ClientFolder[]>>;
  trashedFilesRef: React.RefObject<ClientFileRecord[]>;
  setTrashedFiles: React.Dispatch<React.SetStateAction<ClientFileRecord[]>>;
  currentNavRef: React.RefObject<'files' | 'trash'>;
  currentPathRef: React.RefObject<string>;
  filteredAccountIds: Set<string>;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  clipboard: ActionPortalClipboard | null;
  setClipboard: React.Dispatch<React.SetStateAction<ActionPortalClipboard | null>>;
  setPendingPurgeFiles: React.Dispatch<React.SetStateAction<ClientFileRecord[] | null>>;
  setConfirmEmptyTrash: React.Dispatch<React.SetStateAction<boolean>>;
  setScrollRequest: React.Dispatch<React.SetStateAction<{ id: string; seq: number } | null>>;
  setWorkspaceError: React.Dispatch<React.SetStateAction<string | null>>;
  surfaceWorkspaceError: (context: string, err: unknown, fallback: string) => void;
  markTrashStale: (poolId?: number) => void;
  handleNavigate: (newPath: string) => void;
  loadFiles: (path: string, targetPoolId?: number) => Promise<void>;
  loadTrashFiles: (targetPoolId?: number) => Promise<void>;
  loadClusterData: (targetPoolId?: number) => Promise<unknown>;
}

export function useItemCrudAndTransfer({
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
}: UseItemCrudAndTransferOptions) {
  const [pendingOpsCount, setPendingOpsCount] = useState<number>(0);
  const pendingOpsCountRef = useRef(pendingOpsCount);
  pendingOpsCountRef.current = pendingOpsCount;

  const [pendingMoveConflict, setPendingMoveConflict] = useState<PendingMoveConflict | null>(null);
  const [isResolvingMoveConflict, setIsResolvingMoveConflict] = useState(false);
  const resolvingMoveConflictRef = useRef(false);

  const runPendingOp = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setPendingOpsCount((c) => c + 1);
    try {
      return await fn();
    } finally {
      setPendingOpsCount((c) => Math.max(0, c - 1));
    }
  }, []);

  const handleCreateFolder = useCallback(
    async (folderName: string) => {
      if (isSharePoolActive) return;
      setWorkspaceError(null);
      const targetPath = currentPathRef.current;
      const poolId = activePoolIdRef.current;
      const newPath = normalizeVirtualPath((targetPath === '/' ? '' : targetPath) + '/' + folderName);
      const prevFolders = foldersRef.current;
      const prevFiles = filesRef.current;
      if (prevFolders.some((f) => f.virtualPath === newPath)) {
        throw new Error(`A folder named "${folderName}" already exists in this directory`);
      }
      if (prevFiles.some((f) => !f.isTrashed && f.virtualPath === newPath)) {
        throw new Error(`A file named "${folderName}" already exists in this directory`);
      }

      const parentFolder = prevFolders.find((f) => f.virtualPath === targetPath) ?? null;
      const nowIso = new Date().toISOString();
      const optimisticFolder: ClientFolder = {
        id: `optimistic-folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: folderName,
        virtualPath: newPath,
        parentFolderId: parentFolder?.id ?? null,
        poolId,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      setFolders((prev) => [...prev, optimisticFolder]);

      const rollbackFolder = () => {
        if (activePoolIdRef.current === poolId) {
          setFolders((prev) => prev.filter((f) => f.id !== optimisticFolder.id));
        } else {
          const cached = getPoolCache(poolId);
          if (cached) {
            setPoolCache(poolId, {
              folders: cached.folders.filter((f) => f.id !== optimisticFolder.id),
            });
          }
        }
      };

      try {
        return await runPendingOp(async () => {
          const res = await client.api.folders.$post({
            json: { virtualPath: newPath, name: folderName, poolId },
          });
          if (res.ok) {
            invalidateShareInspectCache();
            const created = (await res.json().catch(() => null)) as { id?: string } | null;
            const createdId = created?.id || `${poolId}:${newPath}`;
            await loadFiles(targetPath, poolId);
            if (activePoolIdRef.current === poolId && currentPathRef.current === targetPath) {
              setSelectedIds(new Set([createdId]));
              setScrollRequest((prev) => ({ id: createdId, seq: (prev?.seq ?? 0) + 1 }));
            }
            return;
          }
          rollbackFolder();
          const msg = await readResponseError(res, 'Failed to create folder');
          if (res.status !== 409) {
            surfaceWorkspaceError('createFolder', msg, 'Failed to create folder');
          }
          throw Object.assign(new Error(msg), { handled: true });
        });
      } catch (err) {
        rollbackFolder();
        if (!(err instanceof Error && 'handled' in err)) {
          surfaceWorkspaceError('createFolder', err, 'Failed to create folder');
        }
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    [
      isSharePoolActive,
      activePoolIdRef,
      currentPathRef,
      foldersRef,
      filesRef,
      setFolders,
      setSelectedIds,
      setScrollRequest,
      setWorkspaceError,
      loadFiles,
      runPendingOp,
      surfaceWorkspaceError,
    ]
  );

  const handleDownload = useCallback((file: ClientFileRecord) => {
    const url = `/api/files/${encodeURIComponent(file.id)}/download`;
    const win = window.open(url, '_blank');
    if (!win) {
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name || '';
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  }, []);

  const handleDeleteFolder = useCallback(
    async (folder: ClientFolder) => {
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      const folderPrefix = folder.virtualPath === '/' ? '/' : `${folder.virtualPath}/`;
      const removedFolders = foldersRef.current.filter(
        (f) => f.id === folder.id || f.virtualPath.startsWith(folderPrefix)
      );
      const removedFiles = filesRef.current.filter((f) => f.virtualPath.startsWith(folderPrefix));
      const removedFolderIds = new Set(removedFolders.map((f) => f.id));
      const removedFileIds = new Set(removedFiles.map((f) => f.id));
      const prevClipboard = clipboard;
      const prevSelected = selectedIds;

      setFolders((prev) =>
        prev.filter((f) => f.id !== folder.id && !f.virtualPath.startsWith(folderPrefix))
      );
      setFiles((prev) => prev.filter((f) => !f.virtualPath.startsWith(folderPrefix)));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of removedFolderIds) next.delete(id);
        for (const id of removedFileIds) next.delete(id);
        return next;
      });
      setClipboard((prev) => {
        if (!prev || prev.mode !== 'cut') return prev;
        const remaining = prev.items.filter(
          (i) => !(i.kind === 'folder' ? removedFolderIds.has(i.id) : removedFileIds.has(i.id))
        );
        return remaining.length > 0 ? { ...prev, items: remaining } : null;
      });

      await runPendingOp(async () => {
        const result = await deleteFolderRequest(folder, poolId, currentPathRef.current);
        if (result.ok) {
          invalidateShareInspectCache();
          const targetLoadPath =
            result.navigateParent !== undefined ? result.navigateParent : currentPathRef.current;
          if (result.navigateParent !== undefined && activePoolIdRef.current === poolId) {
            handleNavigate(result.navigateParent);
          }
          if (currentNavRef.current === 'trash') {
            await Promise.all([
              loadFiles(targetLoadPath, poolId),
              loadTrashFiles(poolId),
              loadClusterData(poolId),
            ]);
          } else {
            markTrashStale(poolId);
            await Promise.all([loadFiles(targetLoadPath, poolId), loadClusterData(poolId)]);
          }
        } else if (activePoolIdRef.current === poolId) {
          setFolders((prev) => {
            const existingIds = new Set(prev.map((f) => f.id));
            const toRestore = removedFolders.filter((f) => !existingIds.has(f.id));
            return toRestore.length > 0 ? [...prev, ...toRestore] : prev;
          });
          setFiles((prev) => {
            const existingIds = new Set(prev.map((f) => f.id));
            const toRestore = removedFiles.filter((f) => !existingIds.has(f.id));
            return toRestore.length > 0 ? [...prev, ...toRestore] : prev;
          });
          setSelectedIds(prevSelected);
          setClipboard(prevClipboard);
          surfaceWorkspaceError('handleDeleteFolder', result.error, 'Failed to delete folder');
        } else {
          const cached = getPoolCache(poolId);
          if (cached) {
            const existingFolderIds = new Set(cached.folders.map((f) => f.id));
            const existingFileIds = new Set(cached.files.map((f) => f.id));
            setPoolCache(poolId, {
              folders: [...cached.folders, ...removedFolders.filter((f) => !existingFolderIds.has(f.id))],
              files: [...cached.files, ...removedFiles.filter((f) => !existingFileIds.has(f.id))],
            });
          }
        }
      });
    },
    [
      activePoolIdRef,
      foldersRef,
      filesRef,
      currentPathRef,
      currentNavRef,
      selectedIds,
      setSelectedIds,
      clipboard,
      setClipboard,
      setFolders,
      setFiles,
      setWorkspaceError,
      runPendingOp,
      handleNavigate,
      loadFiles,
      markTrashStale,
      loadTrashFiles,
      loadClusterData,
      surfaceWorkspaceError,
    ]
  );

  const executeDeleteBatch = useCallback(
    async (selectedFolders: ClientFolder[], selectedFilesList: ClientFileRecord[]) => {
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      const prevFiles = filesRef.current;
      const prevFolders = foldersRef.current;
      const prevSelected = selectedIds;
      const prevClipboard = clipboard;

      const folderIds = new Set(selectedFolders.map((f) => f.id));
      const fileIds = new Set(selectedFilesList.map((f) => f.id));
      const deletedPrefixes = selectedFolders.map((f) =>
        f.virtualPath === '/' ? '/' : `${f.virtualPath}/`
      );
      setSelectedIds(new Set());

      setFolders((prev) => prev.filter((f) => !folderIds.has(f.id)));
      setFiles((prev) => prev.filter((f) => !fileIds.has(f.id)));
      setClipboard((prev) => {
        if (!prev || prev.mode !== 'cut') return prev;
        const remaining = prev.items.filter((i) => {
          if (i.kind === 'folder' ? folderIds.has(i.id) : fileIds.has(i.id)) {
            return false;
          }
          return !deletedPrefixes.some((prefix) => i.virtualPath.startsWith(prefix));
        });
        return remaining.length > 0 ? { ...prev, items: remaining } : null;
      });
      markTrashStale(poolId);

      await runPendingOp(async () => {
        let nextPath = currentPathRef.current;
        const folderResults = await runWithConcurrency(selectedFolders, 6, (folder) =>
          deleteFolderRequest(folder, poolId, currentPathRef.current)
        );
        const fileResults = await runWithConcurrency(selectedFilesList, 6, (file) =>
          trashFileRequest(file)
        );

        for (const res of folderResults) {
          if (res.ok && res.navigateParent !== undefined) {
            nextPath = res.navigateParent;
          }
        }
        const failedFolder = folderResults.find((r) => !r.ok);
        const failedFile = fileResults.find((r) => !r.ok);
        if (folderResults.some((r) => r.ok) || fileResults.some((r) => r.ok)) {
          invalidateShareInspectCache();
        }

        if (failedFolder || failedFile) {
          if (activePoolIdRef.current === poolId) {
            setFiles(prevFiles);
            setFolders(prevFolders);
            setSelectedIds(prevSelected);
            setClipboard(prevClipboard);
            surfaceWorkspaceError(
              'executeDeleteBatch',
              failedFolder?.error || failedFile?.error,
              'Some items could not be deleted'
            );
          } else {
            setPoolCache(poolId, { files: prevFiles, folders: prevFolders });
          }
        } else if (nextPath !== currentPathRef.current && activePoolIdRef.current === poolId) {
          handleNavigate(nextPath);
        }
        await Promise.all([loadFiles(nextPath, poolId), loadClusterData(poolId)]);
      });
    },
    [
      activePoolIdRef,
      filesRef,
      foldersRef,
      currentPathRef,
      selectedIds,
      setSelectedIds,
      clipboard,
      setClipboard,
      setFolders,
      setFiles,
      setWorkspaceError,
      markTrashStale,
      runPendingOp,
      loadClusterData,
      handleNavigate,
      loadFiles,
      surfaceWorkspaceError,
    ]
  );

  const handleDeleteSelected = useCallback(async () => {
    const idsToDelete = new Set(Array.from(selectedIds).filter((id) => id !== '__parent__'));
    if (idsToDelete.size === 0) return;

    if (currentNavRef.current === 'trash') {
      const selectedTrashFiles = trashedFilesRef.current.filter(
        (f) => idsToDelete.has(f.id) && (filteredAccountIds.size === 0 || filteredAccountIds.has(f.accountId))
      );
      if (selectedTrashFiles.length > 0) {
        setConfirmEmptyTrash(false);
        setPendingPurgeFiles(selectedTrashFiles);
      }
      return;
    }

    const selectedFolders = foldersRef.current.filter((f) => idsToDelete.has(f.id));
    const selectedFilesList = filesRef.current.filter((f) => idsToDelete.has(f.id));
    await executeDeleteBatch(selectedFolders, selectedFilesList);
  }, [
    selectedIds,
    currentNavRef,
    trashedFilesRef,
    foldersRef,
    filesRef,
    filteredAccountIds,
    setConfirmEmptyTrash,
    setPendingPurgeFiles,
    executeDeleteBatch,
  ]);

  const refreshAfterMove = useCallback(
    async (poolId: number) => {
      if (currentNavRef.current === 'trash') {
        await Promise.all([
          loadFiles(currentPathRef.current, poolId),
          loadTrashFiles(poolId),
          loadClusterData(poolId),
        ]);
      } else {
        markTrashStale(poolId);
        await Promise.all([loadFiles(currentPathRef.current, poolId), loadClusterData(poolId)]);
      }
    },
    [currentNavRef, currentPathRef, loadFiles, loadTrashFiles, loadClusterData, markTrashStale]
  );

  const handleMoveItems = useCallback(
    async (itemsToMove: Array<{ kind: 'file' | 'folder'; id: string }>, targetFolderPath: string) => {
      if (isSharePoolActive || itemsToMove.length === 0) return;
      const poolId = activePoolIdRef.current;
      const prevFiles = filesRef.current;
      const prevFolders = foldersRef.current;
      const prevClipboard = clipboard;
      const prevSelected = selectedIds;

      const fileById = new Map(prevFiles.map((f) => [f.id, f]));
      const folderById = new Map(prevFolders.map((f) => [f.id, f]));
      const { normalizedTarget: normTarget, validItems } = filterMovableItemsToPath(
        itemsToMove,
        targetFolderPath,
        (item) => (item.kind === 'folder' ? folderById.get(item.id) : fileById.get(item.id))?.virtualPath
      );
      if (validItems.length === 0) return;
      setWorkspaceError(null);

      const movedIds = new Set(validItems.map((i) => i.id));
      const destPrefix = normTarget === '/' ? '' : normTarget;
      setFiles((prev) =>
        prev.map((f) => (movedIds.has(f.id) ? { ...f, virtualPath: `${destPrefix}/${f.name}` } : f))
      );
      setFolders((prev) =>
        prev.map((f) => (movedIds.has(f.id) ? { ...f, virtualPath: `${destPrefix}/${f.name}` } : f))
      );
      setClipboard((prev) => {
        if (!prev || prev.mode !== 'cut') return prev;
        const remaining = prev.items.filter((i) => !movedIds.has(i.id));
        return remaining.length > 0 ? { ...prev, items: remaining } : null;
      });
      setSelectedIds(new Set());

      await runPendingOp(async () => {
        try {
          const res = await client.api.items.move.$post({
            json: { items: validItems, targetFolderPath: normTarget, poolId, conflictMode: 'reject' },
          });
          const data: unknown = await res.json().catch(() => ({}));
          const isStillActive = activePoolIdRef.current === poolId;
          if (res.status === 409 && isMoveConflictPayload(data)) {
            if (isStillActive) {
              setFiles(prevFiles);
              setFolders(prevFolders);
              setClipboard(prevClipboard);
              setSelectedIds(prevSelected);
              setPendingMoveConflict({
                items: validItems,
                targetFolderPath: normTarget,
                poolId,
                conflicts: data.conflicts,
                cleanCount: typeof data.cleanCount === 'number' ? data.cleanCount : 0,
              });
            } else {
              setPoolCache(poolId, { files: prevFiles, folders: prevFolders });
            }
            return;
          }
          if (res.ok) {
            invalidateShareInspectCache();
            const results = parseItemOperationResults(data);
            const failed = results.filter((r) => !r.success);
            const anySucceeded = results.some((r) => r.success && !r.skipped);
            if (anySucceeded && isStillActive) {
              setClipboard(applyMoveResultsToClipboard(prevClipboard, poolId, results));
            }
            if (failed.length > 0) {
              if (!anySucceeded && isStillActive) {
                setClipboard(prevClipboard);
              }
              if (isStillActive) {
                setFiles(prevFiles);
                setFolders(prevFolders);
                setSelectedIds(prevSelected);
                surfaceWorkspaceError('handleMoveItems', failed[0].error, 'Some items could not be moved');
              } else {
                setPoolCache(poolId, { files: prevFiles, folders: prevFolders });
              }
            }
            await refreshAfterMove(poolId);
          } else if (isStillActive) {
            setFiles(prevFiles);
            setFolders(prevFolders);
            setClipboard(prevClipboard);
            setSelectedIds(prevSelected);
            surfaceWorkspaceError('handleMoveItems', data, 'Failed to move items');
          } else {
            setPoolCache(poolId, { files: prevFiles, folders: prevFolders });
          }
        } catch (err) {
          if (activePoolIdRef.current === poolId) {
            setFiles(prevFiles);
            setFolders(prevFolders);
            setClipboard(prevClipboard);
            setSelectedIds(prevSelected);
            surfaceWorkspaceError('handleMoveItems', err, 'Failed to move items');
          } else {
            setPoolCache(poolId, { files: prevFiles, folders: prevFolders });
          }
        }
      });
    },
    [
      isSharePoolActive,
      activePoolIdRef,
      filesRef,
      foldersRef,
      clipboard,
      setClipboard,
      selectedIds,
      setSelectedIds,
      setFiles,
      setFolders,
      setWorkspaceError,
      runPendingOp,
      refreshAfterMove,
      surfaceWorkspaceError,
    ]
  );

  const handleDropItemsToRoot = useCallback(
    (items: Array<{ kind: 'file' | 'folder'; id: string }>) => {
      void handleMoveItems(items, '/');
    },
    [handleMoveItems]
  );

  const handleResolveMoveConflict = useCallback(
    async (mode: MoveConflictResolutionMode) => {
      if (!pendingMoveConflict || resolvingMoveConflictRef.current) return;
      resolvingMoveConflictRef.current = true;
      const { items, targetFolderPath, poolId } = pendingMoveConflict;
      setIsResolvingMoveConflict(true);
      setPendingMoveConflict((prev) => (prev ? { ...prev, errorMessage: null } : prev));
      setWorkspaceError(null);

      await runPendingOp(async () => {
        try {
          const res = await client.api.items.move.$post({
            json: { items, targetFolderPath, poolId, conflictMode: mode },
          });
          const isStillActive = activePoolIdRef.current === poolId;
          if (res.ok) {
            invalidateShareInspectCache();
            const data = await res.json().catch(() => ({}));
            const results = parseItemOperationResults(data);
            const failed = results.filter((r) => !r.success);
            if (isStillActive) {
              setClipboard((prev) => applyMoveResultsToClipboard(prev, poolId, results));
              setSelectedIds(new Set());
              if (failed.length > 0) {
                surfaceWorkspaceError(
                  'handleResolveMoveConflict',
                  failed[0].error,
                  'Some items could not be moved'
                );
              }
              setPendingMoveConflict(null);
            }
            await refreshAfterMove(poolId);
          } else if (isStillActive) {
            const msg = await readResponseError(res, 'Failed to move items');
            setPendingMoveConflict((prev) => (prev ? { ...prev, errorMessage: msg } : prev));
          }
        } catch (err) {
          if (activePoolIdRef.current === poolId) {
            const msg = extractErrorMessage(err, 'Failed to move items');
            setPendingMoveConflict((prev) => (prev ? { ...prev, errorMessage: msg } : prev));
          }
        } finally {
          resolvingMoveConflictRef.current = false;
          setIsResolvingMoveConflict(false);
        }
      });
    },
    [
      pendingMoveConflict,
      activePoolIdRef,
      setClipboard,
      setSelectedIds,
      setWorkspaceError,
      runPendingOp,
      refreshAfterMove,
      surfaceWorkspaceError,
    ]
  );

  const handleTrashItems = useCallback(
    async (
      itemsToTrash: Array<{
        kind: 'file' | 'folder';
        id: string;
        name?: string;
        virtualPath?: string;
        isTrashed?: boolean;
      }>
    ) => {
      const activeItems = itemsToTrash.filter((item) => !item.isTrashed);
      if (activeItems.length === 0) return;
      setWorkspaceError(null);

      const poolId = activePoolIdRef.current;
      const prevFiles = filesRef.current;
      const prevFolders = foldersRef.current;
      const prevSelected = selectedIds;
      const prevClipboard = clipboard;

      const trashedFolders = activeItems.filter((i) => i.kind === 'folder');
      const trashedFilesList = activeItems.filter((i) => i.kind === 'file');
      const activeIds = new Set(activeItems.map((i) => i.id));

      setFiles((prev) => prev.filter((f) => !activeIds.has(f.id)));
      setFolders((prev) => prev.filter((f) => !activeIds.has(f.id)));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of activeIds) next.delete(id);
        return next;
      });
      setClipboard((prev) => {
        if (!prev || prev.mode !== 'cut') return prev;
        const remaining = prev.items.filter((i) => !activeIds.has(i.id));
        return remaining.length > 0 ? { ...prev, items: remaining } : null;
      });

      let effectivePath = currentPathRef.current;

      await runPendingOp(async () => {
        try {
          const folderResults = await runWithConcurrency(trashedFolders, 6, async (folder) => {
            const fPath = folder.virtualPath || folder.id;
            const res = await client.api.folders.$delete({
              query: { virtualPath: fPath, poolId: String(poolId) },
            });
            const error = res.ok ? undefined : await readResponseError(res, 'Failed to delete folder');
            return { ok: res.ok, error, folder, fPath };
          });

          const fileResults = await runWithConcurrency(trashedFilesList, 6, async (file) => {
            const res = await client.api.files[':id'].trash.$post({
              param: { id: file.id },
            });
            const error = res.ok ? undefined : await readResponseError(res, 'Failed to move file to trash');
            return { ok: res.ok, error, file };
          });

          const trashedIds = new Set<string>();
          let firstError: string | undefined;
          for (const fr of folderResults) {
            if (fr.ok) {
              trashedIds.add(fr.folder.id);
              if (
                fr.fPath &&
                (effectivePath === fr.fPath || effectivePath.startsWith(fr.fPath + '/'))
              ) {
                effectivePath = getParentDir(fr.fPath);
              }
            } else if (!firstError) {
              firstError = fr.error;
            }
          }
          for (const fr of fileResults) {
            if (fr.ok) {
              trashedIds.add(fr.file.id);
            } else if (!firstError) {
              firstError = fr.error;
            }
          }

          const isStillActive = activePoolIdRef.current === poolId;
          if (trashedIds.size > 0) {
            invalidateShareInspectCache();
          }
          if (trashedIds.size < activeItems.length) {
            if (isStillActive) {
              setFiles(prevFiles);
              setFolders(prevFolders);
              setSelectedIds(prevSelected);
              setClipboard(prevClipboard);
              surfaceWorkspaceError(
                'handleTrashItems',
                firstError ?? null,
                'Some items could not be moved to trash'
              );
            } else {
              setPoolCache(poolId, { files: prevFiles, folders: prevFolders });
            }
          } else if (trashedIds.size > 0 && effectivePath !== currentPathRef.current && isStillActive) {
            handleNavigate(effectivePath);
          }

          if (currentNavRef.current === 'trash') {
            await Promise.all([loadFiles(effectivePath, poolId), loadTrashFiles(poolId), loadClusterData(poolId)]);
          } else {
            markTrashStale(poolId);
            await Promise.all([loadFiles(effectivePath, poolId), loadClusterData(poolId)]);
          }
        } catch (err) {
          if (activePoolIdRef.current === poolId) {
            setFiles(prevFiles);
            setFolders(prevFolders);
            setSelectedIds(prevSelected);
            setClipboard(prevClipboard);
            surfaceWorkspaceError('handleTrashItems', err, 'Some items could not be moved to trash');
          } else {
            setPoolCache(poolId, { files: prevFiles, folders: prevFolders });
          }
        }
      });
    },
    [
      activePoolIdRef,
      filesRef,
      foldersRef,
      currentPathRef,
      currentNavRef,
      selectedIds,
      setSelectedIds,
      clipboard,
      setClipboard,
      setFiles,
      setFolders,
      setWorkspaceError,
      runPendingOp,
      handleNavigate,
      loadFiles,
      loadTrashFiles,
      loadClusterData,
      markTrashStale,
      surfaceWorkspaceError,
    ]
  );

  const handleCopyItems = useCallback(
    async (itemsToCopy: Array<{ kind: 'file' | 'folder'; id: string }>, targetFolderPath: string) => {
      if (itemsToCopy.length === 0) return;
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      await runPendingOp(async () => {
        try {
          const res = await client.api.items.copy.$post({
            json: { items: itemsToCopy, targetFolderPath, poolId },
          });
          const data = await res.json().catch(() => ({}));
          const isStillActive = activePoolIdRef.current === poolId;
          if (res.ok) {
            invalidateShareInspectCache();
            const results = parseItemOperationResults(data);
            const failed = results.filter((r) => !r.success);
            if (isStillActive) {
              if (failed.length > 0) {
                surfaceWorkspaceError('handleCopyItems', failed[0].error, 'Some items could not be copied');
              }
              setSelectedIds(new Set());
            }
            await Promise.all([loadFiles(currentPathRef.current, poolId), loadClusterData(poolId)]);
          } else if (isStillActive) {
            surfaceWorkspaceError('handleCopyItems', data, 'Failed to copy items');
          }
        } catch (err) {
          if (activePoolIdRef.current === poolId) {
            surfaceWorkspaceError('handleCopyItems', err, 'Failed to copy items');
          }
        }
      });
    },
    [
      activePoolIdRef,
      currentPathRef,
      setSelectedIds,
      setWorkspaceError,
      loadFiles,
      loadClusterData,
      runPendingOp,
      surfaceWorkspaceError,
    ]
  );

  const handleRename = useCallback(
    async (kind: 'file' | 'folder' | 'pool', id: string, newName: string) => {
      const poolId = activePoolIdRef.current;

      if (kind === 'pool') {
        const targetPoolId = Number(id);
        const prevPoolName = poolsRef.current.find((p) => p.id === targetPoolId)?.name;
        setPools((prev) => prev.map((p) => (p.id === targetPoolId ? { ...p, name: newName } : p)));
        return await runPendingOp(async () => {
          try {
            const res = await client.api.pools[':id'].$patch({
              param: { id },
              json: { name: newName },
            });
            if (res.ok) {
              invalidateShareInspectCache();
              await loadClusterData(poolId);
              return;
            }
            if (prevPoolName !== undefined) {
              setPools((prev) => prev.map((p) => (p.id === targetPoolId ? { ...p, name: prevPoolName } : p)));
            }
            const errMsg = await readResponseError(res, 'Failed to rename pool');
            reportDevError('handleRename.pool', errMsg);
            throw Object.assign(new Error(errMsg), { handled: true });
          } catch (err) {
            if (prevPoolName !== undefined) {
              setPools((prev) => prev.map((p) => (p.id === targetPoolId ? { ...p, name: prevPoolName } : p)));
            }
            if (!(err instanceof Error && 'handled' in err)) {
              reportDevError('handleRename.pool', err);
            }
            throw err instanceof Error ? err : new Error(String(err));
          }
        });
      }

      const prevFiles = filesRef.current;
      const prevFolders = foldersRef.current;
      const prevTrashed = trashedFilesRef.current;
      const targetPath = currentPathRef.current;
      const wasTrashView = currentNavRef.current === 'trash';

      const prevFolder = kind === 'folder' ? prevFolders.find((f) => f.id === id) : undefined;
      const prevFile =
        kind === 'file'
          ? prevFiles.find((f) => f.id === id) ?? prevTrashed.find((f) => f.id === id)
          : undefined;

      if (kind === 'folder') {
        if (prevFolder) {
          const parentPath = getParentDir(prevFolder.virtualPath);
          const candidatePath = (parentPath === '/' ? '' : parentPath) + '/' + newName;
          if (prevFolders.some((f) => f.id !== id && f.virtualPath === candidatePath)) {
            throw new Error(`A folder named "${newName}" already exists in this directory`);
          }
          if (prevFiles.some((f) => !f.isTrashed && f.virtualPath === candidatePath)) {
            throw new Error(`A file named "${newName}" already exists in this directory`);
          }
        }
      } else if (prevFile && !prevFile.isTrashed) {
        const parentPath = getParentDir(prevFile.virtualPath);
        const candidatePath = (parentPath === '/' ? '' : parentPath) + '/' + newName;
        if (prevFolders.some((f) => f.virtualPath === candidatePath)) {
          throw new Error(`A folder named "${newName}" already exists in this directory`);
        }
        if (prevFiles.some((f) => !f.isTrashed && f.id !== id && f.virtualPath === candidatePath)) {
          throw new Error(`A file named "${newName}" already exists in this directory`);
        }
      }

      if (kind === 'file') {
        setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, name: newName } : f)));
        setTrashedFiles((prev) => prev.map((f) => (f.id === id ? { ...f, name: newName } : f)));
      } else {
        setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name: newName } : f)));
      }

      const rollbackItemRename = () => {
        if (activePoolIdRef.current === poolId) {
          if (kind === 'file' && prevFile) {
            setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, name: prevFile.name } : f)));
            setTrashedFiles((prev) => prev.map((f) => (f.id === id ? { ...f, name: prevFile.name } : f)));
          } else if (kind === 'folder' && prevFolder) {
            setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name: prevFolder.name } : f)));
          }
        } else {
          const cached = getPoolCache(poolId);
          if (cached) {
            if (kind === 'file' && prevFile) {
              setPoolCache(poolId, {
                files: cached.files.map((f) => (f.id === id ? { ...f, name: prevFile.name } : f)),
                trashedFiles: cached.trashedFiles.map((f) =>
                  f.id === id ? { ...f, name: prevFile.name } : f
                ),
              });
            } else if (kind === 'folder' && prevFolder) {
              setPoolCache(poolId, {
                folders: cached.folders.map((f) => (f.id === id ? { ...f, name: prevFolder.name } : f)),
              });
            }
          }
        }
      };

      return await runPendingOp(async () => {
        try {
          const res = await client.api.items.rename.$post({
            json: { kind, id, name: newName, poolId },
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok) {
            invalidateShareInspectCache();
            const oldFolderP =
              ('oldPath' in data ? (data.oldPath as string) : null) ||
              ('oldVirtualPath' in data ? (data.oldVirtualPath as string) : null);
            const newFolderP =
              ('newPath' in data ? (data.newPath as string) : null) ||
              ('newVirtualPath' in data ? (data.newVirtualPath as string) : null);
            const renamedId = kind === 'folder' && newFolderP ? `${poolId}:${newFolderP}` : id;

            if (kind === 'folder' && oldFolderP && newFolderP) {
              if (activePoolIdRef.current === poolId) {
                setClipboard((prev) => {
                  if (!prev) return prev;
                  let changed = false;
                  const nextItems = prev.items.map((item) => {
                    const remapped = remapPathPrefix(item.virtualPath, oldFolderP, newFolderP);
                    if (remapped === null) return item;
                    changed = true;
                    const isExactFolder = item.kind === 'folder' && item.virtualPath === oldFolderP;
                    return {
                      ...item,
                      virtualPath: remapped,
                      ...(isExactFolder ? { name: newName } : {}),
                      ...(item.kind === 'folder' ? { id: `${poolId}:${remapped}` } : {}),
                    };
                  });
                  return changed ? { ...prev, items: nextItems } : prev;
                });
              }
            } else if (kind === 'file') {
              if (activePoolIdRef.current === poolId) {
                setClipboard((prev) => {
                  if (!prev) return prev;
                  let changed = false;
                  const nextItems = prev.items.map((item) => {
                    if (item.kind !== 'file' || item.id !== id) return item;
                    changed = true;
                    const parentPath = getParentDir(item.virtualPath);
                    const nextVirtualPath =
                      newFolderP || (parentPath === '/' ? '' : parentPath) + '/' + newName;
                    return {
                      ...item,
                      name: newName,
                      virtualPath: nextVirtualPath,
                    };
                  });
                  return changed ? { ...prev, items: nextItems } : prev;
                });
              }
            }

            const isInsideRenamedFolder =
              kind === 'folder' &&
              Boolean(oldFolderP) &&
              (targetPath === oldFolderP || targetPath.startsWith(oldFolderP + '/'));

            if (isInsideRenamedFolder && oldFolderP) {
              const relativeSuffix = targetPath.slice(oldFolderP.length);
              const nextPath = `${newFolderP}${relativeSuffix}`;
              if (activePoolIdRef.current === poolId) {
                handleNavigate(nextPath);
              }
              await loadFiles(nextPath, poolId);
            } else {
              await Promise.all([
                loadFiles(targetPath, poolId),
                wasTrashView || currentNavRef.current === 'trash' ? loadTrashFiles(poolId) : Promise.resolve(),
              ]);
              if (activePoolIdRef.current === poolId && currentPathRef.current === targetPath) {
                setSelectedIds(new Set([renamedId]));
                setScrollRequest((prev) => ({ id: renamedId, seq: (prev?.seq ?? 0) + 1 }));
              }
            }
            return;
          }
          rollbackItemRename();
          const errMsg = extractErrorMessage(data, 'Failed to rename item');
          if (res.status !== 409) {
            reportDevError('handleRename', errMsg);
          }
          throw Object.assign(new Error(errMsg), { handled: true });
        } catch (err) {
          rollbackItemRename();
          if (!(err instanceof Error && 'handled' in err)) {
            reportDevError('handleRename', err);
          }
          throw err instanceof Error ? err : new Error(String(err));
        }
      });
    },
    [
      activePoolIdRef,
      poolsRef,
      setPools,
      filesRef,
      foldersRef,
      trashedFilesRef,
      currentPathRef,
      currentNavRef,
      setFiles,
      setTrashedFiles,
      setFolders,
      setClipboard,
      setSelectedIds,
      setScrollRequest,
      runPendingOp,
      loadFiles,
      loadTrashFiles,
      handleNavigate,
      loadClusterData,
    ]
  );

  return {
    pendingOpsCount,
    pendingOpsCountRef,
    runPendingOp,
    pendingMoveConflict,
    setPendingMoveConflict,
    isResolvingMoveConflict,
    setIsResolvingMoveConflict,
    handleCreateFolder,
    handleDownload,
    handleDeleteFolder,
    executeDeleteBatch,
    handleDeleteSelected,
    handleMoveItems,
    handleDropItemsToRoot,
    handleResolveMoveConflict,
    handleTrashItems,
    handleCopyItems,
    handleRename,
  };
}
