import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client } from '../api.js';
import type { AccountItem, ClientFileRecord, DiscoveredAccount } from '../types.js';
import { copyTextToClipboard } from '../utils/format.js';
import { invalidateShareInspectCache } from '../utils/queryCache.js';
import { readResponseError, reportDevError } from '../utils/workspaceHelpers.js';

export interface DriveActionModalState {
  isOpen: boolean;
  account: AccountItem | null;
  isLoading: boolean;
  errorMessage: string | null;
}

export interface UseAccountLifecycleOptions {
  activePoolIdRef: React.MutableRefObject<number>;
  accountItems: AccountItem[];
  files: ClientFileRecord[];
  trashedFiles: ClientFileRecord[];
  loadedTrashPoolIdRef: React.RefObject<number | null>;
  trashStaleRef: React.MutableRefObject<boolean>;
  currentPathRef: React.RefObject<string>;
  setWorkspaceError: React.Dispatch<React.SetStateAction<string | null>>;
  surfaceWorkspaceError: (context: string, err: unknown, fallback: string) => void;
  loadClusterData: (targetPoolId?: number) => Promise<DiscoveredAccount[] | undefined>;
  loadFiles: (path: string, targetPoolId?: number) => Promise<void>;
  loadTrashFiles: (targetPoolId?: number) => Promise<void>;
  presentAuthorizedAccount: (opts: {
    accountFilterId?: string;
    targetPool: number;
    conflictsCount: number;
  }) => Promise<void>;
}

export function useAccountLifecycle({
  activePoolIdRef,
  accountItems,
  files,
  trashedFiles,
  loadedTrashPoolIdRef,
  trashStaleRef,
  currentPathRef,
  setWorkspaceError,
  surfaceWorkspaceError,
  loadClusterData,
  loadFiles,
  loadTrashFiles,
  presentAuthorizedAccount,
}: UseAccountLifecycleOptions) {
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [driveActionModal, setDriveActionModal] = useState<DriveActionModalState>({
    isOpen: false,
    account: null,
    isLoading: false,
    errorMessage: null,
  });
  const executingDriveActionRef = useRef(false);

  const [authUrls, setAuthUrls] = useState<Record<string, string>>({});
  const authUrlsRef = useRef(authUrls);
  authUrlsRef.current = authUrls;
  const [authUrlErrors, setAuthUrlErrors] = useState<Record<string, boolean>>({});
  const authUrlErrorsRef = useRef(authUrlErrors);
  authUrlErrorsRef.current = authUrlErrors;
  const pendingAuthRequestsRef = useRef<Set<string>>(new Set());
  const [copiedAuthUrlId, setCopiedAuthUrlId] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    for (const acc of accountItems) {
      if (
        !acc.authorized &&
        !authUrlsRef.current[acc.id] &&
        !authUrlErrorsRef.current[acc.id] &&
        !pendingAuthRequestsRef.current.has(acc.id)
      ) {
        pendingAuthRequestsRef.current.add(acc.id);
        client.api.accounts['auth-url'][':id']
          .$get({ param: { id: acc.id }, query: {} })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (data && 'url' in data && data.url) {
              setAuthUrls((prev) => (prev[acc.id] === data.url ? prev : { ...prev, [acc.id]: data.url }));
              setAuthUrlErrors((prev) => (prev[acc.id] ? { ...prev, [acc.id]: false } : prev));
            } else {
              setAuthUrlErrors((prev) => (prev[acc.id] ? prev : { ...prev, [acc.id]: true }));
            }
          })
          .catch(() => {
            setAuthUrlErrors((prev) => (prev[acc.id] ? prev : { ...prev, [acc.id]: true }));
          })
          .finally(() => {
            pendingAuthRequestsRef.current.delete(acc.id);
          });
      }
    }
  }, [accountItems]);

  const handleCopyAuthUrl = useCallback(async (accountId: string) => {
    let url = authUrlsRef.current[accountId];
    if (!url) {
      setAuthUrlErrors((prev) => (prev[accountId] ? { ...prev, [accountId]: false } : prev));
      try {
        const res = await client.api.accounts['auth-url'][':id'].$get({
          param: { id: accountId },
          query: {},
        });
        if (res.ok) {
          const data = await res.json();
          if ('url' in data && data.url) {
            url = data.url;
            setAuthUrls((prev) => ({ ...prev, [accountId]: data.url }));
          } else {
            setAuthUrlErrors((prev) => ({ ...prev, [accountId]: true }));
          }
        } else {
          setAuthUrlErrors((prev) => ({ ...prev, [accountId]: true }));
        }
      } catch (err) {
        setAuthUrlErrors((prev) => ({ ...prev, [accountId]: true }));
        reportDevError('fetch auth URL failed', err);
      }
    }

    if (url) {
      const copied = await copyTextToClipboard(url);
      if (!copied) return;
      setCopiedAuthUrlId(accountId);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopiedAuthUrlId((prev) => (prev === accountId ? null : prev));
      }, 3000);
    }
  }, []);

  const handleImportOAuth = useCallback(
    async (file: File) => {
      setWorkspaceError(null);
      setIsImporting(true);
      try {
        const text = await file.text();

        if (file.name.toLowerCase().endsWith('.json') || text.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(text);
            if (parsed.web && !parsed.installed) {
              surfaceWorkspaceError(
                'importOAuth',
                "Uploaded credential is 'Web application'; Tsubasa requires 'Desktop app' credentials.",
                "Uploaded credential is 'Web application'; Tsubasa requires 'Desktop app' credentials."
              );
              return;
            }
          } catch {
            // If JSON parse fails here, server will handle it with validation error
          }
        }

        const res = await client.api.accounts.oauth.import.$post({
          json: {
            filename: file.name,
            content: text,
            poolId: activePoolIdRef.current,
          },
        });

        if (res.ok) {
          invalidateShareInspectCache();
          const result = await res.json();
          if (result.authorized && result.accountId) {
            const targetPool =
              'poolId' in result && typeof result.poolId === 'number'
                ? result.poolId
                : activePoolIdRef.current;
            const conflictsCount =
              'conflictsCount' in result && typeof result.conflictsCount === 'number'
                ? result.conflictsCount
                : 0;
            await presentAuthorizedAccount({
              accountFilterId: result.accountId,
              targetPool,
              conflictsCount,
            });
          } else {
            await loadClusterData();
          }
        } else {
          const msg = await readResponseError(res, 'Failed to import OAuth credentials');
          surfaceWorkspaceError('importOAuth', msg, 'Failed to import OAuth credentials');
        }
      } catch (err) {
        surfaceWorkspaceError('importOAuth', err, 'Failed to import OAuth credentials');
      } finally {
        setIsImporting(false);
      }
    },
    [activePoolIdRef, setWorkspaceError, presentAuthorizedAccount, loadClusterData, surfaceWorkspaceError]
  );

  const handleDisableAccount = useCallback(
    async (accountId: string) => {
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      try {
        const res = await client.api.accounts[':id'].disable.$post({
          param: { id: accountId },
        });
        if (res.ok) {
          invalidateShareInspectCache();
          await loadClusterData(poolId);
        } else {
          const msg = await readResponseError(res, 'Failed to disable drive');
          if (activePoolIdRef.current === poolId) {
            surfaceWorkspaceError('handleDisableAccount', msg, 'Failed to disable drive');
          }
        }
      } catch (err) {
        if (activePoolIdRef.current === poolId) {
          surfaceWorkspaceError('handleDisableAccount', err, 'Failed to disable drive');
        }
      }
    },
    [activePoolIdRef, setWorkspaceError, loadClusterData, surfaceWorkspaceError]
  );

  const handleEnableAccount = useCallback(
    async (accountId: string) => {
      setWorkspaceError(null);
      const poolId = activePoolIdRef.current;
      try {
        const res = await client.api.accounts[':id'].enable.$post({
          param: { id: accountId },
        });
        if (res.ok) {
          invalidateShareInspectCache();
          await loadClusterData(poolId);
        } else {
          const msg = await readResponseError(res, 'Failed to enable drive');
          if (activePoolIdRef.current === poolId) {
            surfaceWorkspaceError('handleEnableAccount', msg, 'Failed to enable drive');
          }
        }
      } catch (err) {
        if (activePoolIdRef.current === poolId) {
          surfaceWorkspaceError('handleEnableAccount', err, 'Failed to enable drive');
        }
      }
    },
    [activePoolIdRef, setWorkspaceError, loadClusterData, surfaceWorkspaceError]
  );

  const handleOpenDriveAction = useCallback(
    (account: AccountItem) => {
      const poolId = activePoolIdRef.current;
      if (loadedTrashPoolIdRef.current !== poolId || trashStaleRef.current) {
        void loadTrashFiles(poolId);
      }
      setDriveActionModal({
        isOpen: true,
        account,
        isLoading: false,
        errorMessage: null,
      });
    },
    [activePoolIdRef, loadedTrashPoolIdRef, trashStaleRef, loadTrashFiles]
  );

  const handleDisableAccountItem = useCallback(
    (acc: AccountItem) => {
      void handleDisableAccount(acc.id);
    },
    [handleDisableAccount]
  );

  const handleRemoveAccountItem = useCallback(
    (acc: AccountItem) => {
      handleOpenDriveAction(acc);
    },
    [handleOpenDriveAction]
  );

  const handleConfirmDriveAction = useCallback(async () => {
    const { account } = driveActionModal;
    if (!account || executingDriveActionRef.current) return;
    executingDriveActionRef.current = true;
    const poolId = activePoolIdRef.current;

    setDriveActionModal((prev) => ({ ...prev, isLoading: true, errorMessage: null }));

    try {
      const res = await client.api.accounts[':id'].$delete({
        param: { id: account.id },
      });
      const data = await res.json().catch(() => ({}));
      const isStillActive = activePoolIdRef.current === poolId;
      if (res.ok) {
        invalidateShareInspectCache();
        setDriveActionModal((prev) => ({ ...prev, isOpen: false, isLoading: false }));
        if (isStillActive) {
          await Promise.all([loadClusterData(poolId), loadFiles(currentPathRef.current, poolId)]);
        } else {
          await Promise.all([loadClusterData(poolId), loadFiles('/', poolId)]);
        }
      } else if (isStillActive) {
        setDriveActionModal((prev) => ({
          ...prev,
          isLoading: false,
          errorMessage: ('error' in data ? (data.error as string) : null) || 'Failed to remove drive',
        }));
      } else {
        setDriveActionModal((prev) => ({ ...prev, isLoading: false }));
      }
    } catch (err) {
      if (activePoolIdRef.current === poolId) {
        setDriveActionModal((prev) => ({
          ...prev,
          isLoading: false,
          errorMessage: err instanceof Error ? err.message : String(err),
        }));
      } else {
        setDriveActionModal((prev) => ({ ...prev, isLoading: false }));
      }
    } finally {
      executingDriveActionRef.current = false;
    }
  }, [driveActionModal, activePoolIdRef, currentPathRef, loadClusterData, loadFiles]);

  const driveFiles = useMemo(() => {
    const targetAccountId = driveActionModal.account?.id;
    if (!targetAccountId) return [];
    const byId = new Map<string, ClientFileRecord>();
    for (const f of files) {
      if (f.accountId === targetAccountId) byId.set(f.id, f);
    }
    for (const f of trashedFiles) {
      if (f.accountId === targetAccountId && !byId.has(f.id)) byId.set(f.id, f);
    }
    return Array.from(byId.values());
  }, [files, trashedFiles, driveActionModal.account?.id]);
  const driveFilesCount = driveFiles.length;
  const driveTotalBytes = driveFiles.reduce((sum, f) => sum + (f.sizeBytes || 0), 0);

  return {
    isImporting,
    driveActionModal,
    setDriveActionModal,
    handleImportOAuth,
    handleDisableAccount,
    handleEnableAccount,
    handleOpenDriveAction,
    handleDisableAccountItem,
    handleRemoveAccountItem,
    handleConfirmDriveAction,
    driveFiles,
    driveFilesCount,
    driveTotalBytes,
    authUrls,
    authUrlErrors,
    copiedAuthUrlId,
    handleCopyAuthUrl,
  };
}
