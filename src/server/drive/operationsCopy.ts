import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, sqlite, buildDirectoryPrefixBounds, bumpPoolRevision } from '../db/index.js';
import { files, folders } from '../db/schema.js';
import { eq, or, and } from 'drizzle-orm';
import { normalizeVirtualPath } from '../virtualPath.js';
import { runBoundedConcurrency } from './errors.js';
import { getDriveClient } from './client.js';
import { buildTsubasaAppProperties } from './appProperties.js';
import { getAccountRootFolderId } from './remoteTree.js';
import { copyDriveFileCrossAccount } from './crossAccountCopy.js';
import { ensureRemoteFolderHierarchy } from './mirror.js';
import { ensureLocalFolderPath, formatFolderId } from './sync.js';
import {
  FileExceedsCeilingError,
  getEligibleAccounts,
  InsufficientStorageError,
  invalidatePooledStorageOverview,
  MAX_SINGLE_FILE_BYTES,
  planBatchPlacement,
} from '../storage/index.js';
import {
  allocateUniqueVirtualPath,
  assertFolderPathNotOccupiedByFile,
  displaceTrashedFileAtPath,
  getStmts,
  type ActiveDescendantFileRow,
  type DescendantFolderRow,
  type MoveItemInput,
} from './operationsDb.js';

export interface CopyResult {
  id: string;
  kind: 'file' | 'folder';
  type?: 'file' | 'folder';
  sourcePath: string;
  destPath: string;
  success: boolean;
  error?: string;
}

function allocateAvailableCopyPath(
  targetDir: string,
  baseName: string,
  kind: 'file' | 'folder',
  occupiedPaths: Set<string>
): string {
  const candidatePath = allocateUniqueVirtualPath({
    targetDir,
    baseName,
    kind,
    style: 'copy',
    isTaken: (pathCandidate) => occupiedPaths.has(pathCandidate),
  });
  occupiedPaths.add(candidatePath);
  return candidatePath;
}

interface CopyFileTask {
  topLevelIndex: number;
  isTopLevelFile: boolean;
  sourceFileId: string;
  sourceVirtualPath: string;
  sourceAccountId: string;
  sourceDriveFileId: string;
  sizeBytes: number;
  mimeType: string;
  hash: string | null;
  destVirtualPath: string;
  destFileName: string;
  destParentDir: string;
  targetAccountId?: string;
  newFileId?: string;
  newDriveFileId?: string;
  error?: string;
}

export async function copyItems(
  items: MoveItemInput[],
  targetFolderPath: string,
  poolId = 1
): Promise<CopyResult[]> {
  const destFolder = normalizeVirtualPath(targetFolderPath);
  if (destFolder !== '/') {
    assertFolderPathNotOccupiedByFile(destFolder, poolId);
    ensureLocalFolderPath(destFolder, poolId);
  }

  const stmts = getStmts();

  const existingFilePaths = new Set<string>();
  const existingFolderPaths = new Set<string>();

  if (destFolder === '/') {
    const fileRows = stmts.selectAllActiveFilePathsInPool.all(poolId) as Array<{ virtual_path: string }>;
    for (const row of fileRows) {
      existingFilePaths.add(row.virtual_path);
    }
    const folderRows = stmts.selectAllFolderPathsInPool.all(poolId) as Array<{ virtual_path: string }>;
    for (const row of folderRows) {
      existingFolderPaths.add(row.virtual_path);
    }
  } else {
    const destBounds = buildDirectoryPrefixBounds(destFolder);
    const fileRows = stmts.selectActiveFilePathsUnderPrefix.all(
      poolId,
      destBounds.lower,
      destBounds.upper
    ) as Array<{ virtual_path: string }>;
    for (const row of fileRows) {
      existingFilePaths.add(row.virtual_path);
    }
    const folderRows = stmts.selectFolderPathsUnderPrefix.all(
      poolId,
      destBounds.lower,
      destBounds.upper
    ) as Array<{ virtual_path: string }>;
    for (const row of folderRows) {
      existingFolderPaths.add(row.virtual_path);
    }
  }

  const copyFolderPaths: string[] = [];
  const copySeenIds = new Set<string>();
  const resolvedCopyKinds: Array<'file' | 'folder'> = new Array(items.length);
  const resolvedCopyPaths: Array<string | null> = new Array(items.length).fill(null);
  const resolvedFolders: Array<typeof folders.$inferSelect | undefined> = new Array(items.length);
  const resolvedFiles: Array<typeof files.$inferSelect | undefined> = new Array(items.length);
  const duplicateInputIndices = new Set<number>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let resolvedKind = item.kind || item.type;
    let prefetchedFolder: typeof folders.$inferSelect | undefined;
    if (!resolvedKind) {
      prefetchedFolder = await db.query.folders.findFirst({
        where: and(
          eq(folders.poolId, poolId),
          or(eq(folders.id, item.id), eq(folders.virtualPath, item.id))
        ),
      });
      resolvedKind = prefetchedFolder ? 'folder' : 'file';
    }
    resolvedCopyKinds[i] = resolvedKind;
    if (resolvedKind === 'folder') {
      const f =
        prefetchedFolder ??
        (await db.query.folders.findFirst({
          where: and(
            eq(folders.poolId, poolId),
            or(eq(folders.id, item.id), eq(folders.virtualPath, item.id))
          ),
        }));
      resolvedFolders[i] = f;
      if (f) {
        if (copySeenIds.has(f.id)) {
          duplicateInputIndices.add(i);
        } else {
          copySeenIds.add(f.id);
          copyFolderPaths.push(f.virtualPath);
          resolvedCopyPaths[i] = f.virtualPath;
        }
      }
    } else {
      const f = await db.query.files.findFirst({
        where: and(
          eq(files.poolId, poolId),
          or(eq(files.id, item.id), eq(files.virtualPath, item.id))
        ),
      });
      resolvedFiles[i] = f;
      if (f) {
        if (copySeenIds.has(f.id)) {
          duplicateInputIndices.add(i);
        } else {
          copySeenIds.add(f.id);
          resolvedCopyPaths[i] = f.virtualPath;
        }
      }
    }
  }

  const results: CopyResult[] = [];
  const fileCopyTasks: CopyFileTask[] = [];
  const foldersToEnsure: string[] = [];

  for (let i = 0; i < items.length; i++) {
    if (duplicateInputIndices.has(i)) continue;
    const itemPath = resolvedCopyPaths[i];
    if (
      itemPath &&
      copyFolderPaths.some((anc) => anc !== itemPath && itemPath.startsWith(`${anc}/`))
    ) {
      continue;
    }
    const item = items[i];
    const resolvedKind = resolvedCopyKinds[i];
    const resultIndex = results.length;
    results.push({
      id: item.id,
      kind: resolvedKind,
      type: resolvedKind,
      sourcePath: item.id,
      destPath: '',
      success: false,
    });

    if (resolvedKind === 'file') {
      const file = resolvedFiles[i];

      if (!file) {
        results[resultIndex] = {
          id: item.id,
          kind: 'file',
          sourcePath: item.id,
          destPath: '',
          success: false,
          error: 'File not found',
        };
        continue;
      }

      const destVirtualPath = allocateAvailableCopyPath(destFolder, file.name, 'file', existingFilePaths);
      const destFileName = path.posix.basename(destVirtualPath);

      fileCopyTasks.push({
        topLevelIndex: resultIndex,
        isTopLevelFile: true,
        sourceFileId: file.id,
        sourceVirtualPath: file.virtualPath,
        sourceAccountId: file.accountId,
        sourceDriveFileId: file.driveFileId,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
        hash: file.hash,
        destVirtualPath,
        destFileName,
        destParentDir: destFolder,
      });

      results[resultIndex] = {
        id: file.id,
        kind: 'file',
        type: 'file',
        sourcePath: file.virtualPath,
        destPath: '',
        success: false,
      };
    } else if (resolvedKind === 'folder') {
      const folder = resolvedFolders[i];

      if (!folder) {
        results[resultIndex] = {
          id: item.id,
          kind: 'folder',
          type: 'folder',
          sourcePath: item.id,
          destPath: '',
          success: false,
          error: 'Folder not found',
        };
        continue;
      }

      const destVirtualPath = allocateAvailableCopyPath(
        destFolder,
        folder.name,
        'folder',
        existingFolderPaths
      );
      foldersToEnsure.push(destVirtualPath);

      const folderBounds = buildDirectoryPrefixBounds(folder.virtualPath);
      const subFolders = stmts.selectDescendantFolders.all(
        poolId,
        folderBounds.lower,
        folderBounds.upper
      ) as DescendantFolderRow[];

      for (const sub of subFolders) {
        const subRelative = sub.virtual_path.slice(folder.virtualPath.length);
        const destSubPath = normalizeVirtualPath(destVirtualPath + subRelative);
        existingFolderPaths.add(destSubPath);
        foldersToEnsure.push(destSubPath);
      }

      const subFiles = stmts.selectActiveDescendantFiles.all(
        poolId,
        folderBounds.lower,
        folderBounds.upper,
        formatFolderId(poolId, folder.virtualPath)
      ) as ActiveDescendantFileRow[];

      for (const subFile of subFiles) {
        const subRelative = subFile.virtual_path.startsWith(folder.virtualPath + '/')
          ? subFile.virtual_path.slice(folder.virtualPath.length)
          : `/${subFile.name}`;
        const destSubFilePath = normalizeVirtualPath(destVirtualPath + subRelative);
        const destSubFileDir = normalizeVirtualPath(path.posix.dirname(destSubFilePath));
        existingFilePaths.add(destSubFilePath);

        fileCopyTasks.push({
          topLevelIndex: resultIndex,
          isTopLevelFile: false,
          sourceFileId: subFile.id,
          sourceVirtualPath: subFile.virtual_path,
          sourceAccountId: subFile.account_id,
          sourceDriveFileId: subFile.drive_file_id,
          sizeBytes: subFile.size_bytes,
          mimeType: subFile.mime_type,
          hash: subFile.hash,
          destVirtualPath: destSubFilePath,
          destFileName: path.posix.basename(destSubFilePath),
          destParentDir: destSubFileDir,
        });
      }

      results[resultIndex] = {
        id: destVirtualPath,
        kind: 'folder',
        type: 'folder',
        sourcePath: folder.virtualPath,
        destPath: destVirtualPath,
        success: true,
      };
    } else {
      results[resultIndex] = {
        id: item.id,
        kind: 'file',
        type: 'file',
        sourcePath: item.id,
        destPath: '',
        success: false,
        error: `Item not found or invalid kind: ${item.id}`,
      };
    }
  }

  for (const folderPath of foldersToEnsure) {
    assertFolderPathNotOccupiedByFile(folderPath, poolId);
    ensureLocalFolderPath(folderPath, poolId);
  }

  if (fileCopyTasks.length > 0) {
    const nowMs = Date.now();
    try {
      const plan = await planBatchPlacement(
        fileCopyTasks.map((task) => ({
          virtualPath: task.destVirtualPath,
          sizeBytes: task.sizeBytes,
        })),
        nowMs,
        poolId
      );

      const decisionByPath = new Map<string, string>();
      for (const decision of plan.decisions) {
        decisionByPath.set(decision.virtualPath, decision.accountId);
      }

      for (const task of fileCopyTasks) {
        const accountId = decisionByPath.get(task.destVirtualPath);
        if (accountId) {
          task.targetAccountId = accountId;
        } else {
          task.error = new InsufficientStorageError().message;
        }
      }
    } catch {
      const candidates = await getEligibleAccounts(poolId, nowMs);
      const simulatedHeadrooms = new Map<string, number>();
      const simulatedBudgets = new Map<string, number>();
      for (const c of candidates) {
        simulatedHeadrooms.set(c.id, c.headroomBytes);
        simulatedBudgets.set(c.id, c.transferStats.remainingUploadBytes24h);
      }

      for (const task of fileCopyTasks) {
        if (task.sizeBytes > MAX_SINGLE_FILE_BYTES) {
          task.error = new FileExceedsCeilingError(task.sizeBytes).message;
          continue;
        }

        let bestCandidateId: string | null = null;
        let minDiff = Infinity;
        for (const c of candidates) {
          const headroom = simulatedHeadrooms.get(c.id) ?? 0;
          const budget = simulatedBudgets.get(c.id) ?? 0;
          if (headroom >= task.sizeBytes && budget >= task.sizeBytes) {
            const diff = headroom - task.sizeBytes;
            if (diff < minDiff) {
              minDiff = diff;
              bestCandidateId = c.id;
            }
          }
        }

        if (!bestCandidateId) {
          task.error = new InsufficientStorageError().message;
          continue;
        }

        simulatedHeadrooms.set(bestCandidateId, (simulatedHeadrooms.get(bestCandidateId) ?? 0) - task.sizeBytes);
        simulatedBudgets.set(bestCandidateId, (simulatedBudgets.get(bestCandidateId) ?? 0) - task.sizeBytes);
        task.targetAccountId = bestCandidateId;
      }
    }

    const accountRows = stmts.selectPoolAccountsForCopy.all(poolId) as Array<{
      id: string;
      email: string;
      root_folder_id: string | null;
    }>;
    const accountMap = new Map(accountRows.map((acc) => [acc.id, acc]));
    const remoteFolderCache = new Map<string, Promise<string>>();

    const getRemoteFolderId = (
      accountId: string,
      driveTarget: ReturnType<typeof getDriveClient>,
      rootFolderId: string,
      folderPath: string
    ): Promise<string> => {
      const key = `${accountId}:${folderPath}`;
      let pending = remoteFolderCache.get(key);
      if (!pending) {
        pending = ensureRemoteFolderHierarchy(driveTarget, rootFolderId, folderPath);
        remoteFolderCache.set(key, pending);
      }
      return pending;
    };

    const placedTasks = fileCopyTasks.filter((task) => !task.error && task.targetAccountId);

    await runBoundedConcurrency(placedTasks, 6, async (task) => {
      try {
        const targetAccountId = task.targetAccountId!;
        const targetAccount = accountMap.get(targetAccountId);
        if (!targetAccount) {
          throw new Error(`Target account ${targetAccountId} not registered`);
        }

        const driveTarget = getDriveClient(targetAccountId);
        const targetRootId = targetAccount.root_folder_id || (await getAccountRootFolderId(targetAccountId));
        const targetRemoteFolderId = await getRemoteFolderId(
          targetAccountId,
          driveTarget,
          targetRootId,
          task.destParentDir
        );

        const newFileId = randomUUID();
        const newDriveFileId = await copyDriveFileCrossAccount({
          sourceAccountId: task.sourceAccountId,
          sourceDriveFileId: task.sourceDriveFileId,
          targetAccountId,
          targetAccountEmail: targetAccount.email,
          targetRemoteFolderId,
          destFileName: task.destFileName,
          appProperties: buildTsubasaAppProperties({
            virtualPath: task.destVirtualPath,
            virtualId: newFileId,
            checksum: task.hash,
            includeChecksum: true,
          }),
          fields: 'id, name, size',
        });

        task.newFileId = newFileId;
        task.newDriveFileId = newDriveFileId;
      } catch (err) {
        task.error = err instanceof Error ? err.message : String(err);
      }
    });

    const succeededTasks = placedTasks.filter(
      (task) => !task.error && task.newFileId && task.newDriveFileId && task.targetAccountId
    );

    if (succeededTasks.length > 0) {
      const commitMs = Date.now();
      sqlite.transaction(() => {
        const bytesByAccount = new Map<string, number>();

        for (const task of succeededTasks) {
          const parentDir = path.posix.dirname(task.destVirtualPath);
          const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);

          displaceTrashedFileAtPath(poolId, task.destVirtualPath, {
            suffix: `.trashed-${commitMs}`,
          });

          stmts.insertCopiedFile.run(
            task.newFileId!,
            poolId,
            task.destVirtualPath,
            task.destFileName,
            task.sizeBytes,
            task.mimeType,
            task.hash,
            task.targetAccountId!,
            task.newDriveFileId!,
            folderId
          );

          stmts.insertTransferLog.run(randomUUID(), task.targetAccountId!, task.sizeBytes, commitMs);
          bytesByAccount.set(
            task.targetAccountId!,
            (bytesByAccount.get(task.targetAccountId!) ?? 0) + task.sizeBytes
          );
        }

        for (const [accountId, addedBytes] of bytesByAccount) {
          if (addedBytes > 0) {
            stmts.incrementAccountQuotaUsed.run(addedBytes, accountId);
          }
        }
      }).immediate();

      invalidatePooledStorageOverview(poolId);
      bumpPoolRevision(poolId);
    }

    for (const task of fileCopyTasks) {
      const result = results[task.topLevelIndex];
      if (!result) continue;

      if (task.isTopLevelFile) {
        if (!task.error && task.newFileId) {
          result.id = task.newFileId;
          result.destPath = task.destVirtualPath;
          result.success = true;
        } else {
          result.success = false;
          result.error = task.error || 'Copy failed';
        }
      } else if (task.error && result.success) {
        result.success = false;
        result.error = task.error;
      }
    }
  } else if (foldersToEnsure.length > 0) {
    bumpPoolRevision(poolId);
  }

  return results;
}
