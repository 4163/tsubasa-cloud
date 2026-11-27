import { useEffect, useState, useCallback, useRef } from 'react';
import { client } from '../api.js';
import { runDemoUpload } from '../demo/index.js';
import { CEILING_14_25_GB, type NormalizedUploadItem } from '../utils/uploadQueueModel.js';
import { extractErrorMessage } from '../utils/workspaceHelpers.js';
import type {
  UploadConflictAction,
  ExistingPoolFile,
  PlacementItemPreview,
  FileProgressState,
} from '../types.js';

export const PROGRESS_THROTTLE_MS = 120;
export const MAX_CONCURRENT_UPLOADS = 3;

export interface UseUploadRunnerParams {
  poolId: number;
  stagedEmptyFolders: string[];
  conflictsByPath: Record<string, ExistingPoolFile>;
  conflictActions: Record<string, UploadConflictAction>;
  selectedAccounts: Record<string, string>;
  previewByPath: Map<string, PlacementItemPreview>;
  onUploadComplete: () => Promise<void>;
  onFolderError: (error: string | null) => void;
}

export function useUploadRunner({
  poolId,
  stagedEmptyFolders,
  conflictsByPath,
  conflictActions,
  selectedAccounts,
  previewByPath,
  onUploadComplete,
  onFolderError,
}: UseUploadRunnerParams) {
  const [hasCreatedEmptyFolders, setHasCreatedEmptyFolders] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [fileProgress, setFileProgress] = useState<Record<string, FileProgressState>>({});

  const progressRef = useRef<Record<string, FileProgressState>>({});
  const hasCreatedEmptyFoldersRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);
  const lastFlushRef = useRef<number>(0);
  const xhrMapRef = useRef<Map<string, XMLHttpRequest>>(new Map());
  const demoAbortMapRef = useRef<Map<string, AbortController>>(new Map());
  const abortedRef = useRef(false);

  const flushProgressImmediate = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    lastFlushRef.current = performance.now();
    setFileProgress({ ...progressRef.current });
  }, []);

  const scheduleProgressFlush = useCallback(() => {
    if (rafIdRef.current !== null) return;
    const tick = (now: number) => {
      if (now - lastFlushRef.current >= PROGRESS_THROTTLE_MS) {
        rafIdRef.current = null;
        lastFlushRef.current = now;
        setFileProgress({ ...progressRef.current });
      } else {
        rafIdRef.current = requestAnimationFrame(tick);
      }
    };
    rafIdRef.current = requestAnimationFrame(tick);
  }, []);

  const clearActiveXhrs = useCallback(() => {
    for (const xhr of xhrMapRef.current.values()) {
      xhr.abort();
    }
    xhrMapRef.current.clear();
    for (const controller of demoAbortMapRef.current.values()) {
      controller.abort();
    }
    demoAbortMapRef.current.clear();
  }, []);

  useEffect(() => {
    return () => {
      abortedRef.current = true;
      clearActiveXhrs();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [clearActiveXhrs]);

  const reset = useCallback(() => {
    progressRef.current = {};
    hasCreatedEmptyFoldersRef.current = false;
    setHasCreatedEmptyFolders(false);
    setFileProgress({});
  }, []);

  const runUploadQueue = useCallback(
    async (itemsToUpload: NormalizedUploadItem[], createEmptyFolders: boolean) => {
      const shouldCreateEmptyFolders = createEmptyFolders && stagedEmptyFolders.length > 0;
      if (isUploading || (itemsToUpload.length === 0 && !shouldCreateEmptyFolders)) return;

      abortedRef.current = false;
      setIsUploading(true);

      let succeededCount = 0;

      try {
        if (shouldCreateEmptyFolders) {
          onFolderError(null);
          let folderError: string | null = null;
          for (const folderPath of stagedEmptyFolders) {
            if (abortedRef.current) break;
            try {
              const name = folderPath.split('/').filter(Boolean).pop() || folderPath;
              const res = await client.api.folders.$post({
                json: { virtualPath: folderPath, name, poolId },
              });
              if (res.ok) {
                succeededCount += 1;
              } else {
                const fallbackMsg = `Failed to create folder "${folderPath}" (${res.status})`;
                const errData: unknown = await res.json().catch(() => null);
                const errCode: string | null =
                  errData && typeof errData === 'object' && 'code' in errData && typeof errData.code === 'string'
                    ? errData.code
                    : null;
                if (res.status === 409 && errCode === 'FOLDER_EXISTS') {
                  succeededCount += 1;
                } else {
                  folderError = folderError ?? extractErrorMessage(errData, fallbackMsg);
                }
              }
            } catch (err) {
              const errMsg = extractErrorMessage(err, `Failed to create folder "${folderPath}"`);
              folderError = folderError ?? errMsg;
            }
          }
          if (folderError) {
            onFolderError(folderError);
          }
          if (!abortedRef.current && !folderError) {
            hasCreatedEmptyFoldersRef.current = true;
            setHasCreatedEmptyFolders(true);
          }
        }

        if (itemsToUpload.length > 0) {
          const wasAborted = abortedRef.current;
          const nextProgress = { ...progressRef.current };
          for (const it of itemsToUpload) {
            nextProgress[it.key] = wasAborted
              ? {
                  loaded: 0,
                  total: it.file.size,
                  status: 'error',
                  error: 'Cancelled',
                }
              : {
                  loaded: 0,
                  total: it.file.size,
                  status: it.file.size > CEILING_14_25_GB ? 'error' : 'pending',
                };
          }
          progressRef.current = nextProgress;
          flushProgressImmediate();

          if (!wasAborted) {
            const eligibleQueue = itemsToUpload.filter((it) => {
              if (it.file.size > CEILING_14_25_GB) return false;
              if (conflictsByPath[it.virtualPath] && (conflictActions[it.key] ?? 'skip') === 'skip') {
                return false;
              }
              return true;
            });

            // Group items by target accountId for per-account fairness across the concurrency-3 pool
            const accountQueues = new Map<string, Array<{ item: NormalizedUploadItem; accountId?: string }>>();
            for (const item of eligibleQueue) {
              const chosenAccountId =
                selectedAccounts[item.key] || previewByPath.get(item.virtualPath)?.targetAccountId;
              const bucketKey = chosenAccountId || '__auto__';
              let bucket = accountQueues.get(bucketKey);
              if (!bucket) {
                bucket = [];
                accountQueues.set(bucketKey, bucket);
              }
              bucket.push({ item, accountId: chosenAccountId });
            }

            const accountKeys = Array.from(accountQueues.keys());
            const activePerAccount = new Map<string, number>();
            let roundRobinCursor = 0;

            const dequeueNext = (): { bucketKey: string; item: NormalizedUploadItem; accountId?: string } | null => {
              if (abortedRef.current || accountKeys.length === 0) return null;

              let bestKey: string | null = null;
              let bestActive = Infinity;

              for (let offset = 0; offset < accountKeys.length; offset++) {
                const idx = (roundRobinCursor + offset) % accountKeys.length;
                const k = accountKeys[idx];
                const q = accountQueues.get(k);
                if (!q || q.length === 0) continue;
                const active = activePerAccount.get(k) ?? 0;
                if (active < bestActive) {
                  bestActive = active;
                  bestKey = k;
                  if (active === 0) break;
                }
              }

              if (!bestKey) return null;
              roundRobinCursor = (accountKeys.indexOf(bestKey) + 1) % accountKeys.length;
              const q = accountQueues.get(bestKey)!;
              const next = q.shift()!;
              activePerAccount.set(bestKey, (activePerAccount.get(bestKey) ?? 0) + 1);
              return { bucketKey: bestKey, item: next.item, accountId: next.accountId };
            };

            const uploadSingleItem = (item: NormalizedUploadItem, chosenAccountId?: string) => {
              const accountParam = chosenAccountId ? `&accountId=${encodeURIComponent(chosenAccountId)}` : '';
              const conflict = conflictsByPath[item.virtualPath];
              const chosenAction = conflict ? conflictActions[item.key] ?? 'skip' : undefined;
              const conflictMode =
                chosenAction === 'replace'
                  ? 'replace'
                  : chosenAction === 'keep_both'
                  ? 'keep_both'
                  : 'reject';

              progressRef.current[item.key] = {
                loaded: 0,
                total: item.file.size,
                status: 'uploading',
              };
              flushProgressImmediate();

              if (__DEMO_MODE__) {
                if (abortedRef.current) {
                  progressRef.current[item.key] = {
                    loaded: 0,
                    total: item.file.size,
                    status: 'error',
                    error: 'Cancelled',
                  };
                  flushProgressImmediate();
                  return Promise.resolve();
                }

                const controller = new AbortController();
                demoAbortMapRef.current.set(item.key, controller);

                return runDemoUpload({
                  virtualPath: item.virtualPath,
                  sizeBytes: item.file.size,
                  mimeType: item.file.type || 'application/octet-stream',
                  lastModified: item.file.lastModified,
                  poolId,
                  accountId: chosenAccountId,
                  conflictMode,
                  signal: controller.signal,
                  onProgress: (loaded, total) => {
                    progressRef.current[item.key] = {
                      loaded,
                      total,
                      status: 'uploading',
                    };
                    scheduleProgressFlush();
                  },
                })
                  .then((result) => {
                    demoAbortMapRef.current.delete(item.key);
                    if (result.ok) {
                      progressRef.current[item.key] = {
                        loaded: item.file.size,
                        total: item.file.size,
                        status: 'complete',
                      };
                      succeededCount += 1;
                    } else if (result.aborted) {
                      progressRef.current[item.key] = {
                        loaded: 0,
                        total: item.file.size,
                        status: 'error',
                        error: 'Cancelled',
                      };
                    } else {
                      progressRef.current[item.key] = {
                        loaded: 0,
                        total: item.file.size,
                        status: 'error',
                        error: result.error || 'Upload failed',
                      };
                    }
                    flushProgressImmediate();
                  })
                  .catch((err) => {
                    demoAbortMapRef.current.delete(item.key);
                    progressRef.current[item.key] = {
                      loaded: 0,
                      total: item.file.size,
                      status: 'error',
                      error: err instanceof Error ? err.message : 'Upload failed',
                    };
                    flushProgressImmediate();
                  });
              }

              return new Promise<void>((resolve) => {
                if (abortedRef.current) {
                  progressRef.current[item.key] = {
                    loaded: 0,
                    total: item.file.size,
                    status: 'error',
                    error: 'Cancelled',
                  };
                  flushProgressImmediate();
                  resolve();
                  return;
                }

                const xhr = new XMLHttpRequest();
                xhrMapRef.current.set(item.key, xhr);

                const uploadUrl = `/api/files/upload?virtualPath=${encodeURIComponent(item.virtualPath)}&sizeBytes=${item.file.size}&mimeType=${encodeURIComponent(item.file.type || 'application/octet-stream')}${accountParam}&poolId=${encodeURIComponent(String(poolId))}&conflictMode=${encodeURIComponent(conflictMode)}`;

                xhr.upload.onprogress = (e) => {
                  if (e.lengthComputable) {
                    progressRef.current[item.key] = {
                      loaded: e.loaded,
                      total: e.total,
                      status: 'uploading',
                    };
                    scheduleProgressFlush();
                  }
                };

                xhr.onload = () => {
                  xhrMapRef.current.delete(item.key);
                  if (xhr.status >= 200 && xhr.status < 300) {
                    progressRef.current[item.key] = {
                      loaded: item.file.size,
                      total: item.file.size,
                      status: 'complete',
                    };
                    succeededCount += 1;
                  } else {
                    let errMsg = `Upload failed (${xhr.status})`;
                    try {
                      const parsed = JSON.parse(xhr.responseText);
                      if (parsed.error) errMsg = parsed.error;
                    } catch {}
                    progressRef.current[item.key] = {
                      loaded: 0,
                      total: item.file.size,
                      status: 'error',
                      error: errMsg,
                    };
                  }
                  flushProgressImmediate();
                  resolve();
                };

                xhr.onerror = () => {
                  xhrMapRef.current.delete(item.key);
                  progressRef.current[item.key] = {
                    loaded: 0,
                    total: item.file.size,
                    status: 'error',
                    error: 'Network stream error',
                  };
                  flushProgressImmediate();
                  resolve();
                };

                xhr.onabort = () => {
                  xhrMapRef.current.delete(item.key);
                  progressRef.current[item.key] = {
                    loaded: 0,
                    total: item.file.size,
                    status: 'error',
                    error: 'Cancelled',
                  };
                  flushProgressImmediate();
                  resolve();
                };

                try {
                  xhr.open('POST', uploadUrl, true);
                  xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');
                  xhr.send(item.file);
                } catch (err) {
                  xhrMapRef.current.delete(item.key);
                  progressRef.current[item.key] = {
                    loaded: 0,
                    total: item.file.size,
                    status: 'error',
                    error: err instanceof Error ? err.message : 'Failed to start upload',
                  };
                  flushProgressImmediate();
                  resolve();
                }
              });
            };

            const workerCount = Math.min(MAX_CONCURRENT_UPLOADS, eligibleQueue.length);
            const workers = Array.from({ length: workerCount }, async () => {
              while (!abortedRef.current) {
                const entry = dequeueNext();
                if (!entry) break;
                try {
                  await uploadSingleItem(entry.item, entry.accountId);
                } finally {
                  activePerAccount.set(entry.bucketKey, Math.max(0, (activePerAccount.get(entry.bucketKey) ?? 1) - 1));
                }
              }
            });

            await Promise.all(workers);
          }
        }
      } finally {
        xhrMapRef.current.clear();
        demoAbortMapRef.current.clear();
        setIsUploading(false);
      }

      if (succeededCount > 0) {
        await onUploadComplete();
      }
    },
    [
      isUploading,
      stagedEmptyFolders,
      poolId,
      conflictsByPath,
      conflictActions,
      flushProgressImmediate,
      scheduleProgressFlush,
      selectedAccounts,
      previewByPath,
      onUploadComplete,
      onFolderError,
    ]
  );

  const startUpload = useCallback(
    (itemsToUpload: NormalizedUploadItem[]) => {
      const shouldCreateEmpty = !hasCreatedEmptyFoldersRef.current && stagedEmptyFolders.length > 0;
      if (itemsToUpload.length === 0 && !shouldCreateEmpty) return;
      void runUploadQueue(itemsToUpload, shouldCreateEmpty);
    },
    [runUploadQueue, stagedEmptyFolders.length]
  );

  const retryFailed = useCallback(
    (itemsToRetry: NormalizedUploadItem[]) => {
      if (itemsToRetry.length === 0) return;
      void runUploadQueue(itemsToRetry, false);
    },
    [runUploadQueue]
  );

  const handleAbortUpload = useCallback(() => {
    abortedRef.current = true;
    clearActiveXhrs();
    const nextProgress = { ...progressRef.current };
    for (const key of Object.keys(nextProgress)) {
      const entry = nextProgress[key];
      if (entry && (entry.status === 'pending' || entry.status === 'uploading')) {
        nextProgress[key] = {
          loaded: 0,
          total: entry.total,
          status: 'error',
          error: 'Cancelled',
        };
      }
    }
    progressRef.current = nextProgress;
    flushProgressImmediate();
  }, [clearActiveXhrs, flushProgressImmediate]);

  return {
    hasCreatedEmptyFolders,
    isUploading,
    fileProgress,
    reset,
    clearActiveXhrs,
    startUpload,
    retryFailed,
    handleAbortUpload,
  };
}
