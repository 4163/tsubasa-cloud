import {
  DemoHttpError,
  handleAcceptAllExternalFiles,
  handleAcceptExternalFile,
  handleAccountTransferStats,
  handleAutoRebalance,
  handleClearSharePool,
  handleCopyItems,
  handleCreateFolder,
  handleCreatePool,
  handleDeleteFolder,
  handleDeletePool,
  handleEjectAllExternalFiles,
  handleEmptyTrash,
  handleGetAccounts,
  handleGetAuthUrl,
  handleGetExternalChanges,
  handleImportOAuth,
  handleListFiles,
  handleListFolders,
  handleListPools,
  handleListShareLinks,
  handleListTrash,
  handleMoveItems,
  handleMoveToRoot,
  handlePlacementBatch,
  handlePlacementFile,
  handlePurgeFile,
  handleRebalanceBatch,
  handleRebalanceFile,
  handleRemoveAccount,
  handleRemoveMissing,
  handleRenameItem,
  handleRenamePool,
  handleResolveConflict,
  handleResolveConflictsBatch,
  handleRestoreFile,
  handleSetAccountDisabled,
  handleShareExecute,
  handleShareInspect,
  handleShareValidate,
  handleStorageOverview,
  handleSwitchAccountPool,
  handleSyncAll,
  handleTrashFile,
  mapDemoErrorToHttp,
} from './handlers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function parseStrictPoolId(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function parsePoolIdWithDefault(raw: unknown, defaultValue = 1): number {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return defaultValue;
  }
  const parsed = parseStrictPoolId(raw);
  if (parsed === null) {
    throw new DemoHttpError(400, 'poolId must be a positive integer');
  }
  return parsed;
}

function parseOptionalPoolId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return undefined;
  }
  const parsed = parseStrictPoolId(raw);
  if (parsed === null) {
    throw new DemoHttpError(400, 'poolId must be a positive integer');
  }
  return parsed;
}

async function readJsonBody(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, unknown>> {
  let rawText = '';
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body === 'string') {
      rawText = init.body;
    } else if (init.body instanceof URLSearchParams) {
      rawText = init.body.toString();
    } else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) {
      rawText = new TextDecoder().decode(init.body as ArrayBuffer);
    } else if (typeof (init.body as Blob).text === 'function') {
      rawText = await (init.body as Blob).text();
    }
  } else if (input instanceof Request) {
    rawText = await input.clone().text();
  }

  if (!rawText.trim()) return {};
  try {
    const parsed = JSON.parse(rawText);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new DemoHttpError(400, 'Invalid JSON payload');
  }
}

function resolveRequestMeta(input: RequestInfo | URL, init?: RequestInit): {
  method: string;
  url: URL;
  signal: AbortSignal | undefined;
} {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const rawUrl =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const baseOrigin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost';
  const url = new URL(rawUrl, baseOrigin);
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  return { method, url, signal };
}

async function dispatchDemoRequest(
  method: string,
  url: URL,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const pathname = url.pathname;
  const query = url.searchParams;

  // --- Health & instance (safe fallbacks; multi-tab lock is bypassed in demo mode) ---
  if (method === 'GET' && pathname === '/api/health') {
    return jsonResponse({
      status: 'ok',
      service: 'tsubasa-demo',
      dbFingerprint: 'demo-v1',
      timestamp: Date.now(),
      sqlite: { journalMode: 'indexeddb' },
    });
  }
  if (method === 'POST' && pathname === '/api/instance/claim') {
    return jsonResponse({ acquired: true, ownerKind: 'browser', leaseTtlMs: 15_000 });
  }
  if (method === 'POST' && pathname === '/api/instance/heartbeat') {
    return jsonResponse({ active: true, ownerKind: 'browser', leaseTtlMs: 15_000 });
  }
  if (method === 'POST' && pathname === '/api/instance/release') {
    return jsonResponse({ released: true });
  }

  // --- Pools ---
  if (method === 'GET' && pathname === '/api/pools') {
    return jsonResponse(await handleListPools());
  }
  if (method === 'POST' && pathname === '/api/pools') {
    const body = await readJsonBody(input, init);
    const created = await handleCreatePool({
      name: typeof body.name === 'string' ? body.name : undefined,
      slug: typeof body.slug === 'string' ? body.slug : undefined,
    });
    return jsonResponse(created, 201);
  }
  const clearShareMatch = /^\/api\/pools\/([^/]+)\/clear-share$/.exec(pathname);
  if (method === 'POST' && clearShareMatch) {
    const poolId = parsePoolIdWithDefault(decodeURIComponent(clearShareMatch[1]), 0);
    return jsonResponse(await handleClearSharePool(poolId));
  }
  const poolIdMatch = /^\/api\/pools\/([^/]+)$/.exec(pathname);
  if (poolIdMatch) {
    const poolId = parseStrictPoolId(decodeURIComponent(poolIdMatch[1]));
    if (poolId === null) {
      throw new DemoHttpError(400, 'poolId must be a positive integer');
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(input, init);
      return jsonResponse(
        await handleRenamePool(poolId, {
          name: typeof body.name === 'string' ? body.name : '',
          slug: typeof body.slug === 'string' ? body.slug : undefined,
        })
      );
    }
    if (method === 'DELETE') {
      return jsonResponse(await handleDeletePool(poolId));
    }
  }

  // --- Storage & Placement ---
  if (method === 'GET' && (pathname === '/api/storage' || pathname === '/api/storage/overview')) {
    const poolId = parsePoolIdWithDefault(query.get('poolId'), 1);
    return jsonResponse(await handleStorageOverview(poolId));
  }
  const transferStatsMatch = /^\/api\/storage\/transfer-stats\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && transferStatsMatch) {
    return jsonResponse(await handleAccountTransferStats(decodeURIComponent(transferStatsMatch[1])));
  }
  if (method === 'POST' && pathname === '/api/storage/placement/file') {
    const body = await readJsonBody(input, init);
    if (typeof body.virtualPath !== 'string' || typeof body.sizeBytes !== 'number') {
      throw new DemoHttpError(400, 'Invalid payload: virtualPath (string) and sizeBytes (number) required');
    }
    return jsonResponse(
      await handlePlacementFile({
        virtualPath: body.virtualPath,
        sizeBytes: body.sizeBytes,
        poolId: parseOptionalPoolId(body.poolId),
      })
    );
  }
  if (method === 'POST' && pathname === '/api/storage/placement/batch') {
    const body = await readJsonBody(input, init);
    if (!Array.isArray(body.items)) {
      throw new DemoHttpError(400, 'Invalid payload: items (array) required');
    }
    return jsonResponse(
      await handlePlacementBatch({
        items: body.items as Parameters<typeof handlePlacementBatch>[0]['items'],
        poolId: parseOptionalPoolId(body.poolId),
      })
    );
  }

  // --- Accounts ---
  if (method === 'GET' && (pathname === '/api/accounts' || pathname === '/api/accounts/pool')) {
    const poolId = parseOptionalPoolId(query.get('poolId'));
    return jsonResponse(await handleGetAccounts(poolId));
  }
  if (method === 'POST' && pathname === '/api/accounts/oauth/import') {
    const body = await readJsonBody(input, init);
    if (typeof body.filename !== 'string') {
      throw new DemoHttpError(400, 'filename (string) is required');
    }
    return jsonResponse(
      await handleImportOAuth({
        filename: body.filename,
        content: typeof body.content === 'string' ? body.content : '',
        poolId: parseOptionalPoolId(body.poolId),
      }),
      201
    );
  }
  const authUrlMatch = /^\/api\/accounts\/auth-url\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && authUrlMatch) {
    return jsonResponse(handleGetAuthUrl(decodeURIComponent(authUrlMatch[1])));
  }
  const accountActionMatch = /^\/api\/accounts\/([^/]+)\/(disable|enable|pool)$/.exec(pathname);
  if (method === 'POST' && accountActionMatch) {
    const accountId = decodeURIComponent(accountActionMatch[1]);
    const action = accountActionMatch[2];
    if (action === 'disable') {
      return jsonResponse(await handleSetAccountDisabled(accountId, true));
    }
    if (action === 'enable') {
      return jsonResponse(await handleSetAccountDisabled(accountId, false));
    }
    const body = await readJsonBody(input, init);
    const poolId = parseStrictPoolId(body.poolId);
    if (poolId === null) {
      throw new DemoHttpError(400, 'poolId must be a positive integer');
    }
    return jsonResponse(await handleSwitchAccountPool(accountId, poolId));
  }
  const deleteAccountMatch = /^\/api\/accounts\/([^/]+)$/.exec(pathname);
  if (method === 'DELETE' && deleteAccountMatch) {
    return jsonResponse(await handleRemoveAccount(decodeURIComponent(deleteAccountMatch[1])));
  }

  // --- Files & Folders ---
  if (method === 'GET' && pathname === '/api/files') {
    const poolId = parsePoolIdWithDefault(query.get('poolId'), 1);
    const folderPath = query.get('path') || '/';
    const mode = query.get('mode') === 'dir' ? 'dir' : 'tree';
    return jsonResponse(await handleListFiles(poolId, folderPath, mode));
  }
  if (method === 'GET' && pathname === '/api/folders') {
    const poolId = parsePoolIdWithDefault(query.get('poolId'), 1);
    return jsonResponse(await handleListFolders(poolId));
  }
  if (method === 'POST' && pathname === '/api/folders') {
    const body = await readJsonBody(input, init);
    if (typeof body.virtualPath !== 'string' || typeof body.name !== 'string') {
      throw new DemoHttpError(400, 'virtualPath (string) and name (string) are required');
    }
    return jsonResponse(
      await handleCreateFolder({
        virtualPath: body.virtualPath,
        name: body.name,
        poolId: parseOptionalPoolId(body.poolId),
      }),
      201
    );
  }
  if (method === 'DELETE' && pathname === '/api/folders') {
    const poolId = parsePoolIdWithDefault(query.get('poolId'), 1);
    return jsonResponse(
      await handleDeleteFolder({
        virtualPath: query.get('virtualPath') ?? undefined,
        path: query.get('path') ?? undefined,
        id: query.get('id') ?? undefined,
        poolId,
      })
    );
  }

  // --- Items (Move, Copy, Rename) ---
  if (method === 'POST' && pathname === '/api/items/move') {
    const body = await readJsonBody(input, init);
    if (!Array.isArray(body.items) || typeof body.targetFolderPath !== 'string') {
      throw new DemoHttpError(400, 'items and targetFolderPath are required');
    }
    return jsonResponse(
      await handleMoveItems({
        items: body.items as Array<{ kind: 'file' | 'folder'; id: string }>,
        targetFolderPath: body.targetFolderPath,
        poolId: parseOptionalPoolId(body.poolId),
        conflictMode:
          body.conflictMode === 'skip' ||
          body.conflictMode === 'keep_both' ||
          body.conflictMode === 'overwrite'
            ? body.conflictMode
            : 'reject',
      })
    );
  }
  if (method === 'POST' && pathname === '/api/items/copy') {
    const body = await readJsonBody(input, init);
    if (!Array.isArray(body.items) || typeof body.targetFolderPath !== 'string') {
      throw new DemoHttpError(400, 'items and targetFolderPath are required');
    }
    return jsonResponse(
      await handleCopyItems({
        items: body.items as Array<{ kind: 'file' | 'folder'; id: string }>,
        targetFolderPath: body.targetFolderPath,
        poolId: parseOptionalPoolId(body.poolId),
      })
    );
  }
  if (method === 'POST' && pathname === '/api/items/rename') {
    const body = await readJsonBody(input, init);
    const name =
      typeof body.name === 'string'
        ? body.name
        : typeof body.newName === 'string'
          ? body.newName
          : undefined;
    if ((body.kind !== 'file' && body.kind !== 'folder') || typeof body.id !== 'string' || !name) {
      throw new DemoHttpError(400, 'kind, id, and name are required');
    }
    return jsonResponse(
      await handleRenameItem({
        kind: body.kind,
        id: body.id,
        name,
        poolId: parseOptionalPoolId(body.poolId),
      })
    );
  }

  // --- Trash & Permanent Purge ---
  if (method === 'GET' && pathname === '/api/trash') {
    const poolId = parsePoolIdWithDefault(query.get('poolId'), 1);
    return jsonResponse(await handleListTrash(poolId));
  }
  if (method === 'DELETE' && pathname === '/api/trash/empty') {
    const poolId = parsePoolIdWithDefault(query.get('poolId'), 1);
    return jsonResponse(await handleEmptyTrash(poolId));
  }
  const fileTrashMatch = /^\/api\/files\/([^/]+)\/(trash|restore|permanent)$/.exec(pathname);
  if (fileTrashMatch) {
    const fileId = decodeURIComponent(fileTrashMatch[1]);
    const action = fileTrashMatch[2];
    if (method === 'POST' && action === 'trash') {
      return jsonResponse(await handleTrashFile(fileId));
    }
    if (method === 'POST' && action === 'restore') {
      return jsonResponse(await handleRestoreFile(fileId));
    }
    if (method === 'DELETE' && action === 'permanent') {
      return jsonResponse(await handlePurgeFile(fileId));
    }
  }

  // --- Sync, External Changes & Rebalance ---
  if (method === 'POST' && pathname === '/api/sync/all') {
    const poolId = parsePoolIdWithDefault(query.get('poolId'), 1);
    return jsonResponse(await handleSyncAll(poolId));
  }
  const externalChangesMatch = /^\/api\/sync\/external-changes\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && externalChangesMatch) {
    return jsonResponse(await handleGetExternalChanges(decodeURIComponent(externalChangesMatch[1])));
  }
  if (method === 'POST' && pathname === '/api/sync/resolve/accept') {
    const body = await readJsonBody(input, init);
    if (typeof body.accountId !== 'string' || typeof body.driveFileId !== 'string') {
      throw new DemoHttpError(400, 'accountId and driveFileId required');
    }
    return jsonResponse(
      await handleAcceptExternalFile({
        accountId: body.accountId,
        driveFileId: body.driveFileId,
        targetVirtualPath: typeof body.targetVirtualPath === 'string' ? body.targetVirtualPath : undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
        sizeBytes: typeof body.sizeBytes === 'number' ? body.sizeBytes : undefined,
        mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
        hash: typeof body.hash === 'string' || body.hash === null ? body.hash : undefined,
      })
    );
  }
  if (method === 'POST' && pathname === '/api/sync/resolve/accept-all') {
    const body = await readJsonBody(input, init);
    if (typeof body.accountId !== 'string') {
      throw new DemoHttpError(400, 'accountId required');
    }
    return jsonResponse(
      await handleAcceptAllExternalFiles({
        accountId: body.accountId,
        items: Array.isArray(body.items)
          ? (body.items as Parameters<typeof handleAcceptAllExternalFiles>[0]['items'])
          : undefined,
      })
    );
  }
  if (method === 'POST' && pathname === '/api/sync/resolve/eject-all') {
    const body = await readJsonBody(input, init);
    if (typeof body.accountId !== 'string') {
      throw new DemoHttpError(400, 'accountId required');
    }
    return jsonResponse(await handleEjectAllExternalFiles(body.accountId));
  }
  if (method === 'POST' && pathname === '/api/sync/resolve/move-to-root') {
    const body = await readJsonBody(input, init);
    if (typeof body.accountId !== 'string' || typeof body.driveFileId !== 'string') {
      throw new DemoHttpError(400, 'accountId and driveFileId required');
    }
    return jsonResponse(await handleMoveToRoot(body.accountId, body.driveFileId));
  }
  if (method === 'POST' && pathname === '/api/sync/resolve/remove-missing') {
    const body = await readJsonBody(input, init);
    if (typeof body.accountId !== 'string' || typeof body.driveFileId !== 'string') {
      throw new DemoHttpError(400, 'accountId and driveFileId required');
    }
    return jsonResponse(await handleRemoveMissing(body.accountId, body.driveFileId));
  }
  if (method === 'POST' && pathname === '/api/sync/resolve/conflict') {
    const body = await readJsonBody(input, init);
    if (
      typeof body.accountId !== 'string' ||
      typeof body.driveFileId !== 'string' ||
      (body.resolution !== 'keep_both' &&
        body.resolution !== 'deduplicate' &&
        body.resolution !== 'replace_existing' &&
        body.resolution !== 'eject')
    ) {
      throw new DemoHttpError(400, 'accountId, driveFileId, and valid resolution required');
    }
    return jsonResponse(
      await handleResolveConflict({
        accountId: body.accountId,
        driveFileId: body.driveFileId,
        resolution: body.resolution,
        targetVirtualPath: typeof body.targetVirtualPath === 'string' ? body.targetVirtualPath : undefined,
      })
    );
  }
  if (method === 'POST' && pathname === '/api/sync/resolve/conflicts-batch') {
    const body = await readJsonBody(input, init);
    if (
      typeof body.accountId !== 'string' ||
      !Array.isArray(body.items) ||
      (body.resolution !== 'keep_both' && body.resolution !== 'deduplicate')
    ) {
      throw new DemoHttpError(400, 'accountId, items, and valid resolution required');
    }
    return jsonResponse(
      await handleResolveConflictsBatch({
        accountId: body.accountId,
        items: body.items as Array<{ driveFileId: string; targetVirtualPath?: string }>,
        resolution: body.resolution,
      })
    );
  }
  if (method === 'POST' && pathname === '/api/sync/rebalance/file') {
    const body = await readJsonBody(input, init);
    if (typeof body.fileId !== 'string' || typeof body.targetAccountId !== 'string') {
      throw new DemoHttpError(400, 'fileId and targetAccountId required');
    }
    return jsonResponse(await handleRebalanceFile(body.fileId, body.targetAccountId));
  }
  if (method === 'POST' && pathname === '/api/sync/rebalance/batch') {
    const body = await readJsonBody(input, init);
    if (!Array.isArray(body.fileIds) || typeof body.targetAccountId !== 'string') {
      throw new DemoHttpError(400, 'fileIds and targetAccountId required');
    }
    return jsonResponse(
      await handleRebalanceBatch(body.fileIds as string[], body.targetAccountId)
    );
  }
  const autoRebalanceMatch = /^\/api\/sync\/rebalance\/auto\/([^/]+)$/.exec(pathname);
  if (method === 'POST' && autoRebalanceMatch) {
    return jsonResponse(await handleAutoRebalance(decodeURIComponent(autoRebalanceMatch[1])));
  }

  // --- Public Sharing & Share Pool ---
  if (method === 'POST' && pathname === '/api/share/inspect') {
    const body = await readJsonBody(input, init);
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new DemoHttpError(400, 'items array is required');
    }
    const sourcePoolId = parsePoolIdWithDefault(body.sourcePoolId ?? body.poolId, 1);
    return jsonResponse(
      await handleShareInspect(
        sourcePoolId,
        body.items as Array<{ kind: 'file' | 'folder'; id: string }>
      )
    );
  }
  if (method === 'POST' && pathname === '/api/share/validate') {
    const body = await readJsonBody(input, init);
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new DemoHttpError(400, 'items array is required');
    }
    const sourcePoolId = parsePoolIdWithDefault(body.sourcePoolId ?? body.poolId, 1);
    const selectedAccountIds = Array.isArray(body.selectedAccountIds)
      ? (body.selectedAccountIds as string[])
      : [];
    return jsonResponse(
      await handleShareValidate(
        sourcePoolId,
        body.items as Array<{ kind: 'file' | 'folder'; id: string }>,
        selectedAccountIds
      )
    );
  }
  if (method === 'POST' && pathname === '/api/share/execute') {
    const body = await readJsonBody(input, init);
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new DemoHttpError(400, 'items array is required');
    }
    const sourcePoolId = parsePoolIdWithDefault(body.sourcePoolId ?? body.poolId, 1);
    const selectedAccountIds = Array.isArray(body.selectedAccountIds)
      ? (body.selectedAccountIds as string[])
      : [];
    return jsonResponse(
      await handleShareExecute({
        sourcePoolId,
        items: body.items as Array<{ kind: 'file' | 'folder'; id: string }>,
        selectedAccountIds,
      })
    );
  }
  if (method === 'GET' && pathname === '/api/share/links') {
    const poolId = parseOptionalPoolId(query.get('poolId'));
    return jsonResponse(await handleListShareLinks(poolId));
  }

  return jsonResponse({ error: `Unhandled demo endpoint: ${method} ${pathname}` }, 404);
}

export function createDemoFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { method, url, signal } = resolveRequestMeta(input, init);

    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    try {
      const response = await dispatchDemoRequest(method, url, input, init);
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return response;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      const mapped = mapDemoErrorToHttp(err);
      return jsonResponse(mapped.body, mapped.status);
    }
  };
}
