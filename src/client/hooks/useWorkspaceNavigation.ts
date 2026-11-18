import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ClientFileRecord, ClientFolder } from '../types.js';
import {
  isModalActive,
  runWithViewTransition,
  safeStorageGet,
  safeStorageRemove,
  safeStorageSet,
} from '../utils/workspaceHelpers.js';

function getPathUrl(targetPath: string): string {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  if (targetPath === '/' || !targetPath) {
    url.searchParams.delete('path');
  } else {
    url.searchParams.set('path', targetPath);
  }
  return url.pathname + (url.search ? url.search : '') + url.hash;
}

export interface UseWorkspaceNavigationOptions {
  activePoolId: number;
  loadedFilesPoolId: number | null;
  failedFilesLoadPoolRef: React.RefObject<number | null>;
  files: ClientFileRecord[];
  folders: ClientFolder[];
  trashedFiles: ClientFileRecord[];
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setWorkspaceError: React.Dispatch<React.SetStateAction<string | null>>;
  isPopStateBlockedRef: React.RefObject<boolean>;
  onPopStateCloseModals: () => void;
}

export function useWorkspaceNavigation({
  activePoolId,
  loadedFilesPoolId,
  failedFilesLoadPoolRef,
  files,
  folders,
  trashedFiles,
  setSelectedIds,
  setWorkspaceError,
  isPopStateBlockedRef,
  onPopStateCloseModals,
}: UseWorkspaceNavigationOptions) {
  const [currentPath, setCurrentPath] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      const urlPath = urlParams.get('path');
      if (urlPath) return urlPath;
      return safeStorageGet(window.sessionStorage, 'tsubasa-current-path') || '/';
    }
    return '/';
  });
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;

  const [currentNav, setCurrentNav] = useState<'files' | 'trash'>(() => {
    if (typeof window !== 'undefined') {
      const saved = safeStorageGet(window.sessionStorage, 'tsubasa-current-nav');
      if (saved === 'files' || saved === 'trash') return saved;
    }
    return 'files';
  });
  const currentNavRef = useRef(currentNav);
  currentNavRef.current = currentNav;

  const [hasVisitedFiles, setHasVisitedFiles] = useState<boolean>(() => currentNav === 'files');
  const [hasVisitedTrash, setHasVisitedTrash] = useState<boolean>(() => currentNav === 'trash');

  useEffect(() => {
    if (currentNav === 'files') setHasVisitedFiles(true);
    if (currentNav === 'trash') setHasVisitedTrash(true);
  }, [currentNav]);

  const [filteredAccountIds, setFilteredAccountIds] = useState<Set<string>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const raw = safeStorageGet(window.sessionStorage, 'tsubasa-filtered-account-ids');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            return new Set(parsed.filter((id) => typeof id === 'string'));
          }
        }
      } catch {
        // Ignore storage parse errors
      }
    }
    return new Set();
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (filteredAccountIds.size === 0) {
        safeStorageRemove(window.sessionStorage, 'tsubasa-filtered-account-ids');
      } else {
        safeStorageSet(
          window.sessionStorage,
          'tsubasa-filtered-account-ids',
          JSON.stringify(Array.from(filteredAccountIds))
        );
      }
    }
  }, [filteredAccountIds]);

  const handleToggleAccountFilter = useCallback(
    (accountId: string) => {
      startTransition(() => {
        setSelectedIds(new Set());
        setFilteredAccountIds((prev) => {
          const next = new Set(prev);
          if (next.has(accountId)) {
            next.delete(accountId);
          } else {
            next.add(accountId);
          }
          return next;
        });
      });
    },
    [setSelectedIds]
  );

  const handleSelectNav = useCallback(
    (nav: 'files' | 'trash') => {
      setWorkspaceError(null);
      runWithViewTransition(() => {
        flushSync(() => {
          setCurrentNav(nav);
        });
      });
    },
    [setWorkspaceError]
  );

  const handleNavigate = useCallback(
    (newPath: string) => {
      setWorkspaceError(null);
      if (typeof window !== 'undefined') {
        const nextUrl = getPathUrl(newPath);
        if (newPath !== currentPath) {
          window.history.pushState({ path: newPath }, '', nextUrl);
        }
      }
      startTransition(() => {
        setCurrentPath(newPath);
        setSelectedIds(new Set());
      });
    },
    [currentPath, setSelectedIds, setWorkspaceError]
  );

  const handleNavigatePath = useCallback(
    (path: string) => {
      if (currentNavRef.current === 'trash') {
        handleSelectNav('files');
      }
      handleNavigate(path);
    },
    [handleSelectNav, handleNavigate]
  );

  useEffect(() => {
    if (typeof window !== 'undefined') {
      safeStorageSet(window.sessionStorage, 'tsubasa-current-path', currentPath);
    }
  }, [currentPath]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      safeStorageSet(window.sessionStorage, 'tsubasa-current-nav', currentNav);
    }
  }, [currentNav]);

  useEffect(() => {
    if (currentPath === '/' || folders.length === 0) return;
    const exists = folders.some((f) => f.virtualPath === currentPath);
    if (!exists) {
      const parts = currentPath.split('/').filter(Boolean);
      let fallback = '/';
      for (let i = parts.length - 1; i >= 1; i--) {
        const ancestor = '/' + parts.slice(0, i).join('/');
        if (folders.some((f) => f.virtualPath === ancestor)) {
          fallback = ancestor;
          break;
        }
      }
      handleNavigate(fallback);
    }
  }, [folders, currentPath, handleNavigate]);

  useEffect(() => {
    if (loadedFilesPoolId !== activePoolId || failedFilesLoadPoolRef.current === activePoolId) return;
    setFilteredAccountIds((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set<string>();
      for (const id of prev) {
        if (files.some((f) => !f.isTrashed && f.accountId === id)) {
          valid.add(id);
        }
      }
      if (valid.size === prev.size) return prev;
      return valid;
    });
  }, [files, loadedFilesPoolId, activePoolId, failedFilesLoadPoolRef]);

  const popStateGuardRef = useRef({
    isPopStateBlockedRef,
    onPopStateCloseModals,
  });
  popStateGuardRef.current = {
    isPopStateBlockedRef,
    onPopStateCloseModals,
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const currentUrl = getPathUrl(currentPath);
    if (!window.history.state || window.history.state.path !== currentPath) {
      window.history.replaceState({ path: currentPath }, '', currentUrl);
    }

    function handlePopState(e: PopStateEvent) {
      if (popStateGuardRef.current.isPopStateBlockedRef.current) {
        window.history.pushState({ path: currentPath }, '', getPathUrl(currentPath));
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const targetPath = e.state?.path || params.get('path') || '/';

      popStateGuardRef.current.onPopStateCloseModals();
      setCurrentNav('files');
      setCurrentPath(targetPath);
      setSelectedIds(new Set());
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [currentPath, setSelectedIds]);

  // Prevent mouse back/forward buttons from triggering browser history navigation.
  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
      }
    }

    function handleMouseDown(e: MouseEvent) {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
      }
    }

    function handleMouseUp(e: MouseEvent) {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        e.stopPropagation();

        if (isModalActive()) return;

        if (e.button === 3) {
          window.history.back();
        } else if (e.button === 4) {
          window.history.forward();
        }
      }
    }

    function handleAuxClick(e: MouseEvent) {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    window.addEventListener('pointerdown', handlePointerDown, { capture: true });
    window.addEventListener('mousedown', handleMouseDown, { capture: true });
    window.addEventListener('mouseup', handleMouseUp, { capture: true });
    window.addEventListener('auxclick', handleAuxClick, { capture: true });

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      window.removeEventListener('mousedown', handleMouseDown, { capture: true });
      window.removeEventListener('mouseup', handleMouseUp, { capture: true });
      window.removeEventListener('auxclick', handleAuxClick, { capture: true });
    };
  }, []);

  const displayedFiles = useMemo(() => {
    if (filteredAccountIds.size === 0) return files;
    return files.filter((f) => filteredAccountIds.has(f.accountId));
  }, [files, filteredAccountIds]);

  const displayedTrashedFiles = useMemo(() => {
    if (filteredAccountIds.size === 0) return trashedFiles;
    return trashedFiles.filter((f) => filteredAccountIds.has(f.accountId));
  }, [trashedFiles, filteredAccountIds]);

  const displayedFolders = useMemo(() => {
    if (filteredAccountIds.size === 0) return folders;

    const validPaths = new Set<string>();
    const validFolderIds = new Set<string>();
    const folderById = new Map<string, ClientFolder>();
    for (const folder of folders) {
      folderById.set(folder.id, folder);
    }

    for (const f of displayedFiles) {
      if (f.isTrashed) continue;
      const vPath = f.virtualPath.startsWith('/') ? f.virtualPath : '/' + f.virtualPath;
      let slashIdx = vPath.indexOf('/', 1);
      while (slashIdx !== -1) {
        validPaths.add(vPath.slice(0, slashIdx));
        slashIdx = vPath.indexOf('/', slashIdx + 1);
      }
      if (f.folderId) {
        let currId: string | null = f.folderId;
        while (currId && folderById.has(currId)) {
          validFolderIds.add(currId);
          currId = folderById.get(currId)?.parentFolderId ?? null;
        }
      }
    }

    return folders.filter((folder) => {
      const canonical =
        folder.virtualPath === '/'
          ? '/'
          : folder.virtualPath.endsWith('/')
            ? folder.virtualPath.slice(0, -1)
            : folder.virtualPath;
      return validPaths.has(canonical) || validFolderIds.has(folder.id);
    });
  }, [folders, displayedFiles, filteredAccountIds]);

  const visibleSelectableIds = useMemo(() => {
    const validIds = new Set<string>();
    if (currentNav === 'trash') {
      for (const f of displayedTrashedFiles) validIds.add(f.id);
    } else {
      for (const f of displayedFiles) validIds.add(f.id);
      for (const folder of displayedFolders) validIds.add(folder.id);
    }
    return validIds;
  }, [currentNav, displayedTrashedFiles, displayedFiles, displayedFolders]);

  return {
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
  };
}
