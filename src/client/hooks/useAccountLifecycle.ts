import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client } from '../api.js';
import { authorizeDemoAccount } from '../demo/index.js';
import type { AccountItem, ClientFileRecord, DiscoveredAccount } from '../types.js';
import { copyTextToClipboard } from '../utils/format.js';
import { invalidateShareInspectCache } from '../utils/queryCache.js';
import { extractErrorMessage, readResponseError, reportDevError } from '../utils/workspaceHelpers.js';

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
  loadClusterData,
  loadFiles,
  loadTrashFiles,
  presentAuthorizedAccount,
}: UseAccountLifecycleOptions) {
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [sidebarError, setSidebarError] = useState<string | null>(null);
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
  const [authorizingAccountId, setAuthorizingAccountId] = useState<string | null>(null);
  const authorizingRef = useRef(false);
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

  const clearSidebarError = useCallback(() => {
    setSidebarError(null);
  }, []);

  const surfaceSidebarError = useCallback(
    (context: string, err: unknown, fallback: string, formatMessage?: (message: string) => string) => {
      const extracted = extractErrorMessage(err, fallback);
      setSidebarError(formatMessage ? formatMessage(extracted) : extracted);
      reportDevError(context, err instanceof Error ? err : extracted);
    },
    []
  );

  const handleImportOAuth = useCallback(
    async (file: File) => {
      setSidebarError(null);
      setIsImporting(true);
      const poolId = activePoolIdRef.current;
      try {
        if (__DEMO_MODE__) {
          if (!file.name.toLowerCase().endsWith('.json')) {
            const msg = 'Select a .json file to import an account.';
            if (activePoolIdRef.current === poolId) {
              surfaceSidebarError('importOAuth', msg, msg);
            }
            return;
          }

          const res = await client.api.accounts.oauth.import.$post({
            json: {
              filename: file.name,
              content: '',
              poolId,
            },
          });

          if (res.ok) {
            invalidateShareInspectCache();
            await loadClusterData(poolId);
          } else {
            const msg = await readResponseError(res, 'Failed to import OAuth credentials');
            if (activePoolIdRef.current === poolId) {
              surfaceSidebarError('importOAuth', msg, 'Failed to import OAuth credentials');
            }
          }
          return;
        }

        const text = await file.text();

        if (file.name.toLowerCase().endsWith('.json') || text.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(text);
            if (parsed.web && !parsed.installed) {
              const msg = "Uploaded credential is 'Web application'; Tsubasa requires 'Desktop app' credentials.";
              if (activePoolIdRef.current === poolId) {
                surfaceSidebarError('importOAuth', msg, msg);
              }
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
            poolId,
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
          if (activePoolIdRef.current === poolId) {
            surfaceSidebarError('importOAuth', msg, 'Failed to import OAuth credentials');
          }
        }
      } catch (err) {
        if (activePoolIdRef.current === poolId) {
          surfaceSidebarError('importOAuth', err, 'Failed to import OAuth credentials');
        }
      } finally {
        setIsImporting(false);
      }
    },
    [activePoolIdRef, presentAuthorizedAccount, loadClusterData, surfaceSidebarError]
  );

  const handleAuthorizeDemoAccount = useCallback(
    async (accountId: string) => {
      if (!__DEMO_MODE__ || authorizingRef.current) return;
      authorizingRef.current = true;
      setSidebarError(null);
      setAuthorizingAccountId(accountId);
      const poolId = activePoolIdRef.current;
      try {
        const result = await authorizeDemoAccount(accountId);
        if (!result.ok) {
          throw new Error(result.error || 'Failed to authorize account');
        }
        invalidateShareInspectCache();
        setAuthUrls((prev) => {
          if (!(accountId in prev)) return prev;
          const next = { ...prev };
          delete next[accountId];
          return next;
        });
        setAuthUrlErrors((prev) => {
          if (!(accountId in prev)) return prev;
          const next = { ...prev };
          delete next[accountId];
          return next;
        });
        await presentAuthorizedAccount({
          accountFilterId: result.accountId ?? accountId,
          targetPool: result.poolId ?? poolId,
          conflictsCount: result.conflictsCount ?? 0,
        });
      } catch (err) {
        if (activePoolIdRef.current === poolId) {
          surfaceSidebarError('authorizeDemoAccount', err, 'Failed to authorize account');
        }
      } finally {
        authorizingRef.current = false;
        setAuthorizingAccountId((prev) => (prev === accountId ? null : prev));
      }
    },
    [activePoolIdRef, presentAuthorizedAccount, surfaceSidebarError]
  );

  const setAccountEnabled = useCallback(
    async (accountId: string, enabled: boolean) => {
      const context = enabled ? 'handleEnableAccount' : 'handleDisableAccount';
      const fallback = enabled ? 'Failed to enable drive' : 'Failed to disable drive';
      const acc = accountItems.find((a) => a.id === accountId);
      const rawEmail = acc?.email;
      const accountLabel =
        (acc?.displayName && acc.displayName !== rawEmail ? acc.displayName : undefined) ||
        rawEmail ||
        accountId;
      const formatError = (msg: string) => {
        const lower = msg.toLowerCase();
        const mentionsAccount =
          lower.includes(accountId.toLowerCase()) ||
          lower.includes(accountLabel.toLowerCase()) ||
          Boolean(rawEmail && lower.includes(rawEmail.toLowerCase()));

        return mentionsAccount ? msg : `${accountLabel} ${msg}`;
      };

      setSidebarError(null);
      const poolId = activePoolIdRef.current;
      try {
        const res = enabled
          ? await client.api.accounts[':id'].enable.$post({ param: { id: accountId } })
          : await client.api.accounts[':id'].disable.$post({ param: { id: accountId } });
        if (res.ok) {
          invalidateShareInspectCache();
          await loadClusterData(poolId);
        } else {
          const msg = await readResponseError(res, fallback);
          if (activePoolIdRef.current === poolId) {
            surfaceSidebarError(context, msg, fallback, formatError);
          }
        }
      } catch (err) {
        if (activePoolIdRef.current === poolId) {
          surfaceSidebarError(context, err, fallback, formatError);
        }
      }
    },
    [activePoolIdRef, accountItems, loadClusterData, surfaceSidebarError]
  );

  const handleDisableAccount = useCallback(
    (accountId: string) => setAccountEnabled(accountId, false),
    [setAccountEnabled]
  );

  const handleEnableAccount = useCallback(
    (accountId: string) => setAccountEnabled(accountId, true),
    [setAccountEnabled]
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
    sidebarError,
    clearSidebarError,
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
    authorizingAccountId,
    handleAuthorizeDemoAccount,
  };
}
