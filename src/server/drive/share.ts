import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite, bumpPoolRevision } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { authPool } from './auth.js';
import { getDriveClient, markAccountQuotaDecreased } from './client.js';
import { buildTsubasaAppProperties } from './appProperties.js';
import { runBoundedConcurrency, withDriveRetry } from './errors.js';
import { ensureSharePoolExistsInDb } from './poolRegistry.js';
import { getAccountRootFolderId } from './remoteTree.js';
import { switchAccountPool } from './accountHydration.js';
import { copyDriveFileCrossAccount } from './crossAccountCopy.js';
import { ensureRemoteFolderHierarchy, clearRemoteFolderCache } from './mirror.js';
import { normalizeVirtualPath } from '../virtualPath.js';
import { ensureLocalParentFolders, ensureLocalFolderPath, formatFolderId } from './sync.js';
import { enqueueDriveOutbox } from './outbox.js';
import { deleteRemoteFileIgnoreNotFound } from './outboxExecutors.js';
import { invalidatePooledStorageOverview, recordTransferSync } from '../storage/quota.js';
import { InsufficientStorageError } from '../storage/placement.js';
import {
  ShareValidationError,
  SharePoolNotFoundError,
  findSharePoolRow,
  inFlightBatchFolderNames,
  generateShareBatchFolderName,
  resolveShareTargets,
  validateShareSelectionAgainstTargets,
  type ExecuteShareParams,
  type ShareAccountLinkResult,
  type ExecuteShareResult,
  type ClearSharePoolResult,
  type StoredShareLink,
} from './sharePlanner.js';

async function ensureShareBatchPermissionsAndLinks(params: {
  batchFolderName: string;
  participatingAccountIds: string[];
  allocations: Record<string, { filesCount: number; bytesAllocated: number }>;
}): Promise<ShareAccountLinkResult[]> {
  const { batchFolderName, participatingAccountIds, allocations } = params;
  const batchVirtualPath = `/${batchFolderName}`;

  const links: ShareAccountLinkResult[] = new Array(participatingAccountIds.length);

  await runBoundedConcurrency(
    participatingAccountIds.map((accountId, index) => ({ accountId, index })),
    4,
    async ({ accountId, index }) => {
      const drive = getDriveClient(accountId);
      const accountRootFolderId = await getAccountRootFolderId(accountId);
      const batchFolderId = await ensureRemoteFolderHierarchy(drive, accountRootFolderId, batchVirtualPath);
      const accountRecord = await db.query.accounts.findFirst({
        where: eq(accounts.id, accountId),
      });
      const accountEmail = accountRecord?.email ?? accountId;
      const accountDisplayName = accountRecord?.displayName ?? accountEmail;

      const permListRes = await withDriveRetry(() =>
        drive.permissions.list({
          fileId: batchFolderId,
          fields: 'permissions(id, type, role)',
          supportsAllDrives: false,
        })
      );

      const hasAnyoneReader = (permListRes.data.permissions || []).some(
        (p) => p.type === 'anyone' && p.role === 'reader'
      );

      if (!hasAnyoneReader) {
        await withDriveRetry(() =>
          drive.permissions.create({
            fileId: batchFolderId,
            requestBody: {
              role: 'reader',
              type: 'anyone',
            },
            supportsAllDrives: false,
          })
        );
      }

      const folderRes = await withDriveRetry(() =>
        drive.files.get({
          fileId: batchFolderId,
          fields: 'id, name, webViewLink',
          supportsAllDrives: false,
        })
      );
      const webViewLink =
        folderRes.data.webViewLink || `https://drive.google.com/drive/folders/${encodeURIComponent(batchFolderId)}`;

      const alloc = allocations[accountId] ?? { filesCount: 0, bytesAllocated: 0 };
      links[index] = {
        accountId,
        accountEmail,
        accountDisplayName,
        rootFolderId: batchFolderId,
        webViewLink,
        filesCount: alloc.filesCount,
        bytesAllocated: alloc.bytesAllocated,
      };
    }
  );

  return links;
}

export async function executeShare(params: ExecuteShareParams): Promise<ExecuteShareResult> {
  const sharePoolId = ensureSharePoolExistsInDb();

  let batchFolderName: string;
  do {
    batchFolderName = generateShareBatchFolderName(sharePoolId);
  } while (inFlightBatchFolderNames.has(batchFolderName));
  inFlightBatchFolderNames.add(batchFolderName);

  try {
    const targets = await resolveShareTargets(params.sourcePoolId, params.items, batchFolderName);

    const { validation, plan, combinedCandidates, uniqueSelectedIds } =
      await validateShareSelectionAgainstTargets(targets, params.selectedAccountIds);

    if (!validation.valid) {
      throw new ShareValidationError(validation.reason || 'Selected drives cannot fit the share payload');
    }

    const accountsToSwitch: string[] = [];
    if (uniqueSelectedIds.length > 0) {
      const checkPoolStmt = sqlite.prepare('SELECT pool_id as poolId FROM accounts WHERE id = ?');
      for (const accountId of uniqueSelectedIds) {
        const row = checkPoolStmt.get(accountId) as { poolId: number | null } | undefined;
        if (!row || row.poolId !== sharePoolId) {
          accountsToSwitch.push(accountId);
        }
      }
    }

    await runBoundedConcurrency(accountsToSwitch, 4, async (accountId) => {
      await switchAccountPool(accountId, sharePoolId);
    });

    const participatingAccountIds = new Set<string>();
    const accountAllocations: Record<string, { filesCount: number; bytesAllocated: number }> = {};

    interface CopiedShareFile {
      newFileId: string;
      virtualPath: string;
      destFileName: string;
      parentDir: string;
      sizeBytes: number;
      mimeType: string;
      hash: string | null;
      accountId: string;
      newDriveFileId: string;
    }

    const copiedFiles: CopiedShareFile[] = [];
    const bytesByAccount = new Map<string, number>();
    const createdBatchFolderIds = new Map<string, { rootFolderId: string; batchFolderId: string }>();
    let links: ShareAccountLinkResult[];

    try {
      if (targets.files.length === 0 && targets.folders.length > 0) {
        if (combinedCandidates.length === 0) {
          throw new InsufficientStorageError('No active accounts available in Share Pool');
        }

        const bestAccount = [...combinedCandidates].sort((a, b) => b.headroomBytes - a.headroomBytes)[0];
        const drive = getDriveClient(bestAccount.id);
        const rootFolderId = await getAccountRootFolderId(bestAccount.id);
        const batchFolderId = await ensureRemoteFolderHierarchy(drive, rootFolderId, `/${batchFolderName}`);
        createdBatchFolderIds.set(bestAccount.id, { rootFolderId, batchFolderId });

        await runBoundedConcurrency(targets.folders, 4, async (folder) => {
          await ensureRemoteFolderHierarchy(drive, rootFolderId, folder.targetVirtualPath);
        });

        participatingAccountIds.add(bestAccount.id);
        accountAllocations[bestAccount.id] = { filesCount: 0, bytesAllocated: 0 };
      } else if (plan) {
        const fileByTargetPath = new Map(targets.files.map((f) => [f.targetVirtualPath, f]));
        Object.assign(accountAllocations, plan.accountAllocations);

        const uniqueDirPairs = new Map<string, { accountId: string; parentDir: string }>();
        for (const decision of plan.decisions) {
          participatingAccountIds.add(decision.accountId);
          const parentDir = path.posix.dirname(decision.virtualPath);
          const dirKey = `${decision.accountId}\0${parentDir}`;
          if (!uniqueDirPairs.has(dirKey)) {
            uniqueDirPairs.set(dirKey, { accountId: decision.accountId, parentDir });
          }
        }

        const accountInfoMap = new Map<string, { email: string; rootFolderId: string }>();
        await runBoundedConcurrency(Array.from(participatingAccountIds), 4, async (accountId) => {
          const acc = await db.query.accounts.findFirst({
            where: eq(accounts.id, accountId),
          });
          if (!acc) {
            throw new Error(`Target account ${accountId} not registered`);
          }
          const rootFolderId = await getAccountRootFolderId(accountId);
          accountInfoMap.set(accountId, { email: acc.email, rootFolderId });
        });

        await runBoundedConcurrency(Array.from(accountInfoMap.entries()), 4, async ([accountId, info]) => {
          const driveTarget = getDriveClient(accountId);
          const batchFolderId = await ensureRemoteFolderHierarchy(
            driveTarget,
            info.rootFolderId,
            `/${batchFolderName}`
          );
          createdBatchFolderIds.set(accountId, { rootFolderId: info.rootFolderId, batchFolderId });
        });

        const remoteFolderIdByDirKey = new Map<string, string>();
        await runBoundedConcurrency(Array.from(uniqueDirPairs.entries()), 4, async ([dirKey, pair]) => {
          const targetInfo = accountInfoMap.get(pair.accountId)!;
          const driveTarget = getDriveClient(pair.accountId);
          const folderId = await ensureRemoteFolderHierarchy(
            driveTarget,
            targetInfo.rootFolderId,
            pair.parentDir
          );
          remoteFolderIdByDirKey.set(dirKey, folderId);
        });

        const createdParentDirs = new Set<string>();
        const resultsSlot = new Array<CopiedShareFile>(plan.decisions.length);

        await runBoundedConcurrency(
          plan.decisions.map((decision, index) => ({ decision, index })),
          6,
          async ({ decision, index }) => {
            const sourceFile = fileByTargetPath.get(decision.virtualPath);
            if (!sourceFile) {
              throw new Error(`Missing source file mapping for ${decision.virtualPath}`);
            }

            const targetInfo = accountInfoMap.get(decision.accountId)!;
            const parentDir = path.posix.dirname(decision.virtualPath);
            const targetRemoteFolderId = remoteFolderIdByDirKey.get(`${decision.accountId}\0${parentDir}`)!;

            const newFileId = randomUUID();
            const destFileName = path.posix.basename(decision.virtualPath);
            const appProperties = buildTsubasaAppProperties({
              virtualPath: decision.virtualPath,
              virtualId: newFileId,
              checksum: sourceFile.hash,
              includeChecksum: true,
            });

            const newDriveFileId = await copyDriveFileCrossAccount({
              sourceAccountId: sourceFile.accountId,
              sourceDriveFileId: sourceFile.driveFileId,
              targetAccountId: decision.accountId,
              targetAccountEmail: targetInfo.email,
              targetRemoteFolderId,
              destFileName,
              appProperties,
            });

            if (parentDir !== '/' && parentDir !== '.') {
              createdParentDirs.add(parentDir);
            }

            resultsSlot[index] = {
              newFileId,
              virtualPath: decision.virtualPath,
              destFileName,
              parentDir,
              sizeBytes: decision.sizeBytes,
              mimeType: sourceFile.mimeType,
              hash: sourceFile.hash,
              accountId: decision.accountId,
              newDriveFileId,
            };
          }
        );

        copiedFiles.push(...resultsSlot);

        if (targets.folders.length > 0) {
          const missingFolders = targets.folders.filter((f) => !createdParentDirs.has(f.targetVirtualPath));
          if (missingFolders.length > 0) {
            const participatingList = Array.from(participatingAccountIds);
            const fallbackAccountId =
              combinedCandidates
                .filter((c) => participatingAccountIds.has(c.id))
                .sort((a, b) => b.headroomBytes - a.headroomBytes)[0]?.id ?? participatingList[0];

            if (fallbackAccountId) {
              const drive = getDriveClient(fallbackAccountId);
              const rootFolderId =
                accountInfoMap.get(fallbackAccountId)?.rootFolderId ??
                (await getAccountRootFolderId(fallbackAccountId));
              if (!createdBatchFolderIds.has(fallbackAccountId)) {
                const batchFolderId = await ensureRemoteFolderHierarchy(drive, rootFolderId, `/${batchFolderName}`);
                createdBatchFolderIds.set(fallbackAccountId, { rootFolderId, batchFolderId });
              }
              await runBoundedConcurrency(missingFolders, 4, async (folder) => {
                await ensureRemoteFolderHierarchy(drive, rootFolderId, folder.targetVirtualPath);
              });
            }
          }
        }
      }

      links = await ensureShareBatchPermissionsAndLinks({
        batchFolderName,
        participatingAccountIds: Array.from(participatingAccountIds),
        allocations: accountAllocations,
      });

      const transferTimestamp = Date.now();
      sqlite.transaction(() => {
        ensureLocalFolderPath(`/${batchFolderName}`, sharePoolId);

        const insertFileStmt = sqlite.prepare(
          `INSERT INTO files (id, pool_id, virtual_path, name, size_bytes, mime_type, hash, account_id, drive_file_id, folder_id, is_trashed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
        );

        for (const item of copiedFiles) {
          ensureLocalParentFolders(item.virtualPath, sharePoolId);
          const folderId =
            item.parentDir === '/' || item.parentDir === '.' ? null : formatFolderId(sharePoolId, item.parentDir);

          insertFileStmt.run(
            item.newFileId,
            sharePoolId,
            item.virtualPath,
            item.destFileName,
            item.sizeBytes,
            item.mimeType,
            item.hash,
            item.accountId,
            item.newDriveFileId,
            folderId
          );

          bytesByAccount.set(item.accountId, (bytesByAccount.get(item.accountId) ?? 0) + item.sizeBytes);
        }

        const updateQuotaStmt = sqlite.prepare(
          'UPDATE accounts SET quota_used_bytes = quota_used_bytes + ?, updated_at = unixepoch() WHERE id = ?'
        );
        for (const [accountId, bytes] of bytesByAccount.entries()) {
          updateQuotaStmt.run(bytes, accountId);
          recordTransferSync(accountId, 'upload', bytes, transferTimestamp, sharePoolId);
        }

        for (const folder of targets.folders) {
          ensureLocalFolderPath(folder.targetVirtualPath, sharePoolId);
        }

        const upsertLinkStmt = sqlite.prepare(
          `INSERT INTO share_links (id, pool_id, batch_folder_name, account_id, drive_folder_id, web_view_link, files_count, bytes_allocated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(pool_id, batch_folder_name, account_id) DO UPDATE SET
             drive_folder_id = excluded.drive_folder_id,
             web_view_link = excluded.web_view_link,
             files_count = excluded.files_count,
             bytes_allocated = excluded.bytes_allocated`
        );

        for (const link of links) {
          if (!link.webViewLink) continue;
          upsertLinkStmt.run(
            randomUUID(),
            sharePoolId,
            batchFolderName,
            link.accountId,
            link.rootFolderId,
            link.webViewLink,
            link.filesCount,
            link.bytesAllocated
          );
        }
      }).immediate();
    } catch (err) {
      for (const [accountId, info] of createdBatchFolderIds.entries()) {
        try {
          const drive = getDriveClient(accountId);
          await deleteRemoteFileIgnoreNotFound(drive, info.batchFolderId);
          clearRemoteFolderCache(info.rootFolderId);
        } catch (cleanupErr) {
          console.warn(
            `Best-effort share batch cleanup failed for account ${accountId}:`,
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          );
        }
      }
      throw err;
    }

    invalidatePooledStorageOverview(sharePoolId);
    bumpPoolRevision(sharePoolId);

    return {
      sharePoolId,
      batchFolderName,
      totalBytes: targets.totalBytes,
      fileCount: targets.fileCount,
      folderCount: targets.folderCount,
      links,
    };
  } finally {
    inFlightBatchFolderNames.delete(batchFolderName);
  }
}

export async function clearSharePool(sharePoolId: number): Promise<ClearSharePoolResult> {
  const poolRow = sqlite
    .prepare('SELECT id, is_share_pool as isSharePool FROM pools WHERE id = ?')
    .get(sharePoolId) as { id: number; isSharePool: number } | undefined;

  if (!poolRow) {
    throw new SharePoolNotFoundError(`Pool ${sharePoolId} not found`);
  }
  if (!poolRow.isSharePool) {
    throw new ShareValidationError(`Pool ${sharePoolId} is not the Share Pool`);
  }

  const poolAccounts = await db
    .select()
    .from(accounts)
    .where(eq(accounts.poolId, sharePoolId));

  const warnings: string[] = [];

  const summary = sqlite.transaction(() => {
    const fileStats = sqlite
      .prepare('SELECT COUNT(*) as cnt, COALESCE(SUM(size_bytes), 0) as totalBytes FROM files WHERE pool_id = ?')
      .get(sharePoolId) as { cnt: number; totalBytes: number };
    const folderStats = sqlite
      .prepare('SELECT COUNT(*) as cnt FROM folders WHERE pool_id = ?')
      .get(sharePoolId) as { cnt: number };

    const bytesByAccount = sqlite
      .prepare('SELECT account_id as accountId, COALESCE(SUM(size_bytes), 0) as bytes FROM files WHERE pool_id = ? GROUP BY account_id')
      .all(sharePoolId) as Array<{ accountId: string; bytes: number }>;

    const shareLinkRows = sqlite
      .prepare(
        'SELECT account_id as accountId, drive_folder_id as driveFolderId, batch_folder_name as batchFolderName FROM share_links WHERE pool_id = ?'
      )
      .all(sharePoolId) as Array<{ accountId: string; driveFolderId: string; batchFolderName: string }>;
    const topFolderRows = sqlite
      .prepare('SELECT name, virtual_path as virtualPath FROM folders WHERE pool_id = ? AND parent_folder_id IS NULL')
      .all(sharePoolId) as Array<{ name: string; virtualPath: string }>;
    const allFileRows = sqlite
      .prepare('SELECT account_id as accountId, virtual_path as virtualPath FROM files WHERE pool_id = ?')
      .all(sharePoolId) as Array<{ accountId: string; virtualPath: string }>;

    const folderIdsByAccount = new Map<string, Set<string>>();
    const folderNamesByAccount = new Map<string, Set<string>>();
    const poolWideTopNames = new Set<string>();

    for (const row of shareLinkRows) {
      if (row.driveFolderId) {
        let ids = folderIdsByAccount.get(row.accountId);
        if (!ids) {
          ids = new Set<string>();
          folderIdsByAccount.set(row.accountId, ids);
        }
        ids.add(row.driveFolderId);
      }
      if (row.batchFolderName) {
        let names = folderNamesByAccount.get(row.accountId);
        if (!names) {
          names = new Set<string>();
          folderNamesByAccount.set(row.accountId, names);
        }
        names.add(row.batchFolderName);
      }
    }

    for (const row of topFolderRows) {
      const topName = row.name || normalizeVirtualPath(row.virtualPath).split('/').filter(Boolean)[0];
      if (topName) {
        poolWideTopNames.add(topName);
      }
    }

    for (const row of allFileRows) {
      const topName = normalizeVirtualPath(row.virtualPath).split('/').filter(Boolean)[0];
      if (topName) {
        let names = folderNamesByAccount.get(row.accountId);
        if (!names) {
          names = new Set<string>();
          folderNamesByAccount.set(row.accountId, names);
        }
        names.add(topName);
        poolWideTopNames.add(topName);
      }
    }

    const outboxEntries: Array<{
      accountId: string;
      poolId: number;
      opType: 'clear_share_account';
      payload: {
        sharePoolId: number;
        rootFolderId: string | null;
        batchFolderIds: string[];
        batchFolderNames: string[];
      };
    }> = [];

    for (const acc of poolAccounts) {
      const isAuthorized = Boolean(authPool.getRecord(acc.id)?.authorized);
      if (!isAuthorized) {
        warnings.push(
          `Skipped remote Drive cleanup for unauthorized account ${acc.email || acc.id}; local index entries were removed.`
        );
        continue;
      }
      if (!acc.rootFolderId) {
        warnings.push(
          `Skipped remote Drive cleanup for account ${acc.email || acc.id} without a root folder; local index entries were removed.`
        );
        continue;
      }

      const batchFolderIds = Array.from(folderIdsByAccount.get(acc.id) ?? []);
      const batchFolderNames = Array.from(
        new Set([...(folderNamesByAccount.get(acc.id) ?? []), ...poolWideTopNames])
      );

      if (batchFolderIds.length === 0 && batchFolderNames.length === 0) {
        continue;
      }

      outboxEntries.push({
        accountId: acc.id,
        poolId: sharePoolId,
        opType: 'clear_share_account' as const,
        payload: {
          sharePoolId,
          rootFolderId: acc.rootFolderId,
          batchFolderIds,
          batchFolderNames,
        },
      });
    }

    sqlite.prepare('DELETE FROM files WHERE pool_id = ?').run(sharePoolId);
    sqlite.prepare('DELETE FROM folders WHERE pool_id = ?').run(sharePoolId);
    sqlite.prepare('DELETE FROM share_links WHERE pool_id = ?').run(sharePoolId);

    const updateQuotaStmt = sqlite.prepare(
      'UPDATE accounts SET quota_used_bytes = MAX(0, quota_used_bytes - ?), updated_at = unixepoch() WHERE id = ?'
    );
    for (const row of bytesByAccount) {
      updateQuotaStmt.run(row.bytes, row.accountId);
    }

    if (outboxEntries.length > 0) {
      enqueueDriveOutbox(outboxEntries);
    }

    return {
      filesRemoved: Number(fileStats?.cnt ?? 0),
      foldersRemoved: Number(folderStats?.cnt ?? 0),
      bytesReclaimed: Number(fileStats?.totalBytes ?? 0),
      affectedAccountIds: bytesByAccount.map((row) => row.accountId),
      enqueuedAccountIds: outboxEntries.map((entry) => entry.accountId),
    };
  }).immediate();

  for (const acc of poolAccounts) {
    if (acc.rootFolderId) {
      clearRemoteFolderCache(acc.rootFolderId);
    }
  }

  const affectedAccounts = new Set<string>(summary.affectedAccountIds);
  for (const accountId of summary.enqueuedAccountIds) {
    affectedAccounts.add(accountId);
  }
  for (const accountId of affectedAccounts) {
    markAccountQuotaDecreased(accountId);
  }

  invalidatePooledStorageOverview(sharePoolId);
  bumpPoolRevision(sharePoolId);

  return {
    sharePoolId,
    filesRemoved: summary.filesRemoved,
    foldersRemoved: summary.foldersRemoved,
    bytesReclaimed: summary.bytesReclaimed,
    warnings,
  };
}

export function listSharePoolLinks(poolId?: number): StoredShareLink[] {
  const resolvedPoolId = poolId ?? findSharePoolRow()?.id;
  if (resolvedPoolId === undefined) return [];

  return sqlite
    .prepare(
      `SELECT
         sl.batch_folder_name as batchFolderName,
         sl.account_id as accountId,
         a.email as accountEmail,
         a.display_name as accountDisplayName,
         sl.drive_folder_id as driveFolderId,
         sl.web_view_link as webViewLink,
         CASE WHEN sl.files_count = 0 THEN 0 ELSE COUNT(fi.id) END as filesCount,
         CASE WHEN sl.files_count = 0 THEN 0 ELSE COALESCE(SUM(fi.size_bytes), 0) END as bytesAllocated
       FROM share_links sl
       INNER JOIN accounts a ON a.id = sl.account_id
       LEFT JOIN files fi
         ON sl.files_count > 0
        AND fi.pool_id = sl.pool_id
        AND fi.account_id = sl.account_id
        AND fi.is_trashed = 0
        AND (
          fi.virtual_path = '/' || sl.batch_folder_name
          OR (
            fi.virtual_path >= '/' || sl.batch_folder_name || '/'
            AND fi.virtual_path < '/' || sl.batch_folder_name || '0'
          )
        )
       WHERE sl.pool_id = ?
         AND EXISTS (
           SELECT 1 FROM folders f
           WHERE f.pool_id = sl.pool_id
             AND f.virtual_path = '/' || sl.batch_folder_name
         )
       GROUP BY sl.id
       HAVING sl.files_count = 0 OR COUNT(fi.id) > 0
       ORDER BY sl.batch_folder_name DESC, a.email ASC`
    )
    .all(resolvedPoolId) as StoredShareLink[];
}
