import { useCallback } from 'react';
import { client } from '../api.js';
import type { ClientFileRecord } from '../types.js';
import { invalidateShareInspectCache, runWithConcurrency, setPoolCache, getPoolCache } from '../utils/queryCache.js';
import { extractErrorMessage, readResponseError } from '../utils/workspaceHelpers.js';

export async function trashFileRequest(
  file: ClientFileRecord
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await client.api.files[':id'].trash.$post({ param: { id: file.id } });
    if (res.ok) return { ok: true };
    return { ok: false, error: await readResponseError(res, 'Trash failed') };
  } catch (err) {
    return { ok: false, error: `Trash error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function restoreFileRequest(
  file: ClientFileRecord
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await client.api.files[':id'].restore.$post({ param: { id: file.id } });
    if (res.ok) return { ok: true };
    return { ok: false, error: await readResponseError(res, 'Restore failed') };
  } catch (err) {
    return { ok: false, error: `Restore error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function permanentDeleteFileRequest(
  file: ClientFileRecord
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await client.api.files[':id'].permanent.$delete({ param: { id: file.id } });
    if (res.ok) return { ok: true };
    return { ok: false, error: await readResponseError(res, 'Delete failed') };
  } catch (err) {
    return { ok: false, error: `Delete error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface UseTrashMutationsOptions {
  activePoolIdRef: React.RefObject<number>;
  filesRef: React.RefObject<ClientFileRecord[]>;
  setFiles: React.Dispatch<React.SetStateAction<ClientFileRecord[]>>;
  trashedFilesRef: React.RefObject<ClientFileRecord[]>;
  setTrashedFiles: React.Dispatch<React.SetStateAction<ClientFileRecord[]>>;
  trashStaleRef: React.MutableRefObject<boolean>;
  currentNav: 'files' | 'trash';
  currentNavRef: React.RefObject<'files' | 'trash'>;
  currentPathRef: React.RefObject<string>;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  pendingPurgeFiles: ClientFileRecord[] | null;
  setPendingPurgeFiles: React.Dispatch<React.SetStateAction<ClientFileRecord[] | null>>;
  setConfirmEmptyTrash: React.Dispatch<React.SetStateAction<boolean>>;
  setWorkspaceError: React.Dispatch<React.SetStateAction<string | null>>;
  surfaceWorkspaceError: (context: string, err: unknown, fallback: string) => void;
  markTrashStale: (poolId?: number) => void;
  runPendingOp: <T>(fn: () => Promise<T>) => Promise<T>;
  loadFiles: (path: string, targetPoolId?: number) => Promise<void>;
  loadTrashFiles: (targetPoolId?: number) => Promise<void>;
  loadClusterData: (targetPoolId?: number) => Promise<unknown>;
}

export function useTrashMutations({
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
}: UseTrashMutationsOptions) {
  const handleTrash = useCallback(
    async (file: ClientFileRecord) => {
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      const wasTrashView = currentNavRef.current === 'trash';
      setFiles((prev) => prev.filter((f) => f.id !== file.id));
      if (wasTrashView) {
        setTrashedFiles((prev) => [{ ...file, isTrashed: true }, ...prev]);
      } else {
        markTrashStale(poolId);
      }

      await runPendingOp(async () => {
        const result = await trashFileRequest(file);
        if (result.ok) {
          invalidateShareInspectCache();
          await Promise.all([
            loadFiles(currentPathRef.current, poolId),
            currentNavRef.current === 'trash' ? loadTrashFiles(poolId) : Promise.resolve(),
            loadClusterData(poolId),
          ]);
        } else if (activePoolIdRef.current === poolId) {
          setFiles((prev) => (prev.some((f) => f.id === file.id) ? prev : [...prev, file]));
          if (wasTrashView) {
            setTrashedFiles((prev) => prev.filter((f) => f.id !== file.id));
          }
          surfaceWorkspaceError('handleTrash', result.error, 'Failed to move file to trash');
        } else {
          const cached = getPoolCache(poolId);
          if (cached) {
            setPoolCache(poolId, {
              files: cached.files.some((f) => f.id === file.id) ? cached.files : [...cached.files, file],
              trashedFiles: wasTrashView
                ? cached.trashedFiles.filter((f) => f.id !== file.id)
                : cached.trashedFiles,
            });
          }
        }
      });
    },
    [
      activePoolIdRef,
      currentNavRef,
      currentPathRef,
      setFiles,
      setTrashedFiles,
      setWorkspaceError,
      markTrashStale,
      runPendingOp,
      loadFiles,
      loadTrashFiles,
      loadClusterData,
      surfaceWorkspaceError,
    ]
  );

  const handleRestoreFile = useCallback(
    async (file: ClientFileRecord) => {
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      setTrashedFiles((prev) => prev.filter((f) => f.id !== file.id));
      setFiles((prev) => [...prev, { ...file, isTrashed: false }]);

      await runPendingOp(async () => {
        const result = await restoreFileRequest(file);
        if (result.ok) {
          invalidateShareInspectCache();
          await Promise.all([
            currentNavRef.current === 'trash' ? loadTrashFiles(poolId) : Promise.resolve(),
            loadFiles(currentPathRef.current, poolId),
            loadClusterData(poolId),
          ]);
        } else if (activePoolIdRef.current === poolId) {
          setTrashedFiles((prev) => (prev.some((f) => f.id === file.id) ? prev : [file, ...prev]));
          setFiles((prev) => prev.filter((f) => f.id !== file.id));
          surfaceWorkspaceError('handleRestoreFile', result.error, 'Restore failed');
        } else {
          const cached = getPoolCache(poolId);
          if (cached) {
            setPoolCache(poolId, {
              trashedFiles: cached.trashedFiles.some((f) => f.id === file.id)
                ? cached.trashedFiles
                : [file, ...cached.trashedFiles],
              files: cached.files.filter((f) => f.id !== file.id),
            });
          }
        }
      });
    },
    [
      activePoolIdRef,
      currentNavRef,
      currentPathRef,
      setTrashedFiles,
      setFiles,
      setWorkspaceError,
      runPendingOp,
      loadTrashFiles,
      loadFiles,
      loadClusterData,
      surfaceWorkspaceError,
    ]
  );

  const handlePermanentDelete = useCallback(
    (file: ClientFileRecord) => {
      setConfirmEmptyTrash(false);
      setPendingPurgeFiles([file]);
    },
    [setConfirmEmptyTrash, setPendingPurgeFiles]
  );

  const handleConfirmPurgeFiles = useCallback(async () => {
    if (!pendingPurgeFiles || pendingPurgeFiles.length === 0) return;
    setWorkspaceError(null);
    const poolId = activePoolIdRef.current;
    const toPurge = pendingPurgeFiles;

    await runPendingOp(async () => {
      try {
        const results = await runWithConcurrency(toPurge, 6, (f) =>
          permanentDeleteFileRequest(f)
        );
        const succeededIds = new Set<string>();
        let firstError: string | undefined;
        for (let i = 0; i < results.length; i++) {
          if (results[i].ok) {
            succeededIds.add(toPurge[i].id);
          } else if (!firstError) {
            firstError = results[i].error;
          }
        }

        if (succeededIds.size > 0) {
          invalidateShareInspectCache();
          if (activePoolIdRef.current === poolId) {
            setTrashedFiles((prev) => prev.filter((f) => !succeededIds.has(f.id)));
            setSelectedIds((prev) => {
              const next = new Set(prev);
              for (const id of succeededIds) next.delete(id);
              return next;
            });
          } else {
            const cached = getPoolCache(poolId);
            if (cached) {
              setPoolCache(poolId, {
                trashedFiles: cached.trashedFiles.filter((f) => !succeededIds.has(f.id)),
              });
            }
          }
        }

        await Promise.all([loadTrashFiles(poolId), loadClusterData(poolId)]);

        if (firstError) {
          if (activePoolIdRef.current === poolId && succeededIds.size > 0) {
            setPendingPurgeFiles((prev) =>
              prev ? prev.filter((f) => !succeededIds.has(f.id)) : null
            );
          }
          throw Object.assign(
            new Error(firstError || 'Some files could not be permanently deleted'),
            { handled: true }
          );
        }
      } catch (err) {
        if (err instanceof Error && 'handled' in err) {
          throw err;
        }
        throw new Error(extractErrorMessage(err, 'Some files could not be permanently deleted'));
      }
    });
  }, [
    pendingPurgeFiles,
    activePoolIdRef,
    setTrashedFiles,
    setSelectedIds,
    setPendingPurgeFiles,
    setWorkspaceError,
    runPendingOp,
    loadTrashFiles,
    loadClusterData,
  ]);

  const executeBatchRestore = useCallback(
    async (toRestore: ClientFileRecord[]) => {
      if (toRestore.length === 0) return;
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      const prevTrashed = trashedFilesRef.current;
      const prevFiles = filesRef.current;
      const prevSelected = selectedIds;
      const restoreIds = new Set(toRestore.map((f) => f.id));

      setTrashedFiles((prev) => prev.filter((f) => !restoreIds.has(f.id)));
      setFiles((prev) => [...prev, ...toRestore.map((f) => ({ ...f, isTrashed: false }))]);
      setSelectedIds(new Set());

      await runPendingOp(async () => {
        const results = await runWithConcurrency(toRestore, 6, (file) => restoreFileRequest(file));
        const failed = results.filter((r) => !r.ok);
        if (results.some((r) => r.ok)) {
          invalidateShareInspectCache();
        }
        if (failed.length > 0) {
          if (activePoolIdRef.current === poolId) {
            setTrashedFiles(prevTrashed);
            setFiles(prevFiles);
            setSelectedIds(prevSelected);
            surfaceWorkspaceError(
              'executeBatchRestore',
              failed[0].error,
              'Some files could not be restored'
            );
          } else {
            setPoolCache(poolId, { trashedFiles: prevTrashed, files: prevFiles });
          }
        }
        await Promise.all([
          loadTrashFiles(poolId),
          loadFiles(currentPathRef.current, poolId),
          loadClusterData(poolId),
        ]);
      });
    },
    [
      activePoolIdRef,
      trashedFilesRef,
      filesRef,
      currentPathRef,
      selectedIds,
      setTrashedFiles,
      setFiles,
      setSelectedIds,
      setWorkspaceError,
      runPendingOp,
      loadTrashFiles,
      loadFiles,
      loadClusterData,
      surfaceWorkspaceError,
    ]
  );

  const handleBatchRestore = useCallback(async () => {
    const actionableIds = Array.from(selectedIds).filter((id) => id !== '__parent__');
    if (actionableIds.length === 0 || currentNav !== 'trash') return;
    const toRestore = trashedFilesRef.current.filter((f) => actionableIds.includes(f.id));
    await executeBatchRestore(toRestore);
  }, [selectedIds, currentNav, trashedFilesRef, executeBatchRestore]);

  const handleEmptyTrashExecute = useCallback(async () => {
    setWorkspaceError(null);
    const poolId = activePoolIdRef.current;

    await runPendingOp(async () => {
      try {
        const res = await client.api.trash.empty.$delete({
          query: { poolId: String(poolId) },
        });
        if (res.ok) {
          invalidateShareInspectCache();
          if (activePoolIdRef.current === poolId) {
            setTrashedFiles([]);
            setSelectedIds(new Set());
            trashStaleRef.current = false;
          } else {
            setPoolCache(poolId, { trashedFiles: [], trashStale: false });
          }
          await Promise.all([loadTrashFiles(poolId), loadClusterData(poolId)]);
        } else {
          const msg = await readResponseError(res, 'Empty trash failed');
          throw Object.assign(new Error(msg), { handled: true });
        }
      } catch (err) {
        if (err instanceof Error && 'handled' in err) {
          throw err;
        }
        throw new Error(extractErrorMessage(err, 'Empty trash failed'));
      }
    });
  }, [
    activePoolIdRef,
    trashStaleRef,
    setTrashedFiles,
    setSelectedIds,
    setWorkspaceError,
    runPendingOp,
    loadTrashFiles,
    loadClusterData,
  ]);

  return {
    handleTrash,
    handleRestoreFile,
    handlePermanentDelete,
    handleConfirmPurgeFiles,
    executeBatchRestore,
    handleBatchRestore,
    handleEmptyTrashExecute,
  };
}
