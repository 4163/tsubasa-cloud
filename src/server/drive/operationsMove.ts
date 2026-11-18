import path from 'node:path';
import { sqlite, buildDirectoryPrefixBounds, bumpPoolRevision } from '../db/index.js';
import { normalizeVirtualPath } from '../virtualPath.js';
import { MoveConflictError } from './errors.js';
import { markAccountQuotaDecreased } from './client.js';
import { ensureLocalFolderPath, formatFolderId } from './sync.js';
import { enqueueDriveOutbox } from './outbox.js';
import type {
  EnqueueOutboxEntry,
  FileDeleteOutboxPayload,
  FileMoveOutboxPayload,
  FolderMergeAccountOutboxPayload,
  FolderMoveAccountOutboxPayload,
} from './outboxQueue.js';
import { invalidatePooledStorageOverview } from '../storage/index.js';
import {
  assertFolderPathNotOccupiedByFile,
  displaceTrashedFileAtPath,
  enqueuePoolAccountOutbox,
  getStmts,
  type MoveItemInput,
} from './operationsDb.js';
import {
  planMoveItems,
  type MoveConflictMode,
  type MoveResult,
  type PlannedFileMove,
} from './operationsMovePlan.js';

export async function moveItems(
  items: MoveItemInput[],
  targetFolderPath: string,
  poolId = 1,
  conflictMode: MoveConflictMode = 'reject'
): Promise<MoveResult[]> {
  const destFolder = normalizeVirtualPath(targetFolderPath);
  assertFolderPathNotOccupiedByFile(destFolder, poolId);
  const stmts = getStmts();

  const plan = await planMoveItems(items, destFolder, poolId, conflictMode);

  if (conflictMode === 'reject' && plan.conflicts.length > 0) {
    throw new MoveConflictError(plan.conflicts, plan.cleanCount);
  }

  const hasDestFolderChanges =
    plan.plannedOps.length > 0 || plan.overwriteTargets.size > 0;

  if (hasDestFolderChanges) {
    const accountsWithOverwrites = new Set<string>();

    sqlite.transaction(() => {
      sqlite.pragma('defer_foreign_keys = ON');
      if (destFolder !== '/') {
        ensureLocalFolderPath(destFolder, poolId);
      }

      const outboxEntries: EnqueueOutboxEntry[] = [];

      // Permanently delete overwritten destination files first so Drive deletes precede incoming moves.
      for (const target of plan.overwriteTargets.values()) {
        stmts.deleteFileById.run(target.id);
        stmts.decrementAccountQuotaUsed.run(target.sizeBytes, target.accountId);
        accountsWithOverwrites.add(target.accountId);
        outboxEntries.push({
          accountId: target.accountId,
          poolId,
          opType: 'file_delete',
          driveFileId: target.driveFileId,
          payload: {
            fileId: target.id,
            driveFileId: target.driveFileId,
          } satisfies FileDeleteOutboxPayload,
        });
      }

      const commitFileMove = (op: PlannedFileMove) => {
        if (op.destFolder !== '/' && op.destFolder !== '.') {
          assertFolderPathNotOccupiedByFile(op.destFolder, poolId);
          ensureLocalFolderPath(op.destFolder, poolId);
        }
        displaceTrashedFileAtPath(poolId, op.newVirtualPath, { excludeFileId: op.fileId });
        stmts.updateMovedOrRenamedFile.run(op.newName, op.newVirtualPath, op.folderId, op.fileId);
      };

      for (const op of plan.plannedOps) {
        if (op.kind === 'file') {
          commitFileMove(op);
          outboxEntries.push({
            accountId: op.accountId,
            poolId,
            opType: 'file_move',
            driveFileId: op.driveFileId,
            payload: {
              fileId: op.fileId,
              driveFileId: op.driveFileId,
              newVirtualPath: op.newVirtualPath,
              destFolder: op.destFolder,
              wasTrashed: op.wasTrashed,
              ...(op.renameOnDrive ? { newName: op.newName } : {}),
            } satisfies FileMoveOutboxPayload,
          });
        } else if (op.kind === 'folder') {
          stmts.updateFolderMove.run(op.newFolderId, op.newFolderPath, op.parentId, op.folderId);

          for (const sub of op.descendantFolders) {
            const subNewPath = op.newFolderPath + sub.virtual_path.slice(op.oldFolderPath.length);
            const subParent = path.posix.dirname(subNewPath);
            const subParentId = subParent === '/' ? null : formatFolderId(poolId, subParent);
            const subNewId = formatFolderId(poolId, subNewPath);
            stmts.updateFolderMove.run(subNewId, subNewPath, subParentId, sub.id);
          }

          const filesByAccount = new Map<
            string,
            Array<{ id: string; driveFileId: string; newVirtualPath: string }>
          >();

          for (const f of op.descendantFiles) {
            const fileNewPath = f.virtual_path.startsWith(op.oldFolderPath + '/')
              ? op.newFolderPath + f.virtual_path.slice(op.oldFolderPath.length)
              : path.posix.join(op.newFolderPath, f.name);
            const fileParent = path.posix.dirname(fileNewPath);
            const fileParentId = fileParent === '/' ? null : formatFolderId(poolId, fileParent);
            displaceTrashedFileAtPath(poolId, fileNewPath, { excludeFileId: f.id });
            stmts.updateDescendantFilePath.run(fileNewPath, fileParentId, f.id);

            if (!f.is_trashed) {
              let list = filesByAccount.get(f.account_id);
              if (!list) {
                list = [];
                filesByAccount.set(f.account_id, list);
              }
              list.push({
                id: f.id,
                driveFileId: f.drive_file_id,
                newVirtualPath: fileNewPath,
              });
            }
          }

          enqueuePoolAccountOutbox(
            poolId,
            'folder_move_account',
            filesByAccount,
            (filesForAccount): FolderMoveAccountOutboxPayload => ({
              oldFolderPath: op.oldFolderPath,
              newFolderPath: op.newFolderPath,
              destFolder,
              files: filesForAccount,
            }),
            outboxEntries
          );
        } else {
          for (const destPath of op.destFolderPathsToEnsure) {
            assertFolderPathNotOccupiedByFile(destPath, poolId);
            ensureLocalFolderPath(destPath, poolId);
          }

          const filesByAccount = new Map<
            string,
            Array<{
              id: string;
              driveFileId: string;
              newVirtualPath: string;
              destFolder: string;
              wasTrashed: boolean;
              newName?: string;
            }>
          >();

          for (const fm of op.fileMoves) {
            commitFileMove(fm);
            let list = filesByAccount.get(fm.accountId);
            if (!list) {
              list = [];
              filesByAccount.set(fm.accountId, list);
            }
            list.push({
              id: fm.fileId,
              driveFileId: fm.driveFileId,
              newVirtualPath: fm.newVirtualPath,
              destFolder: fm.destFolder,
              wasTrashed: fm.wasTrashed,
              ...(fm.renameOnDrive ? { newName: fm.newName } : {}),
            });
          }

          for (const tf of op.trashedFileMoves) {
            if (tf.destFolder !== '/' && tf.destFolder !== '.') {
              assertFolderPathNotOccupiedByFile(tf.destFolder, poolId);
              ensureLocalFolderPath(tf.destFolder, poolId);
            }
            let finalPath = tf.newVirtualPath;
            const existing = stmts.selectFileIdByPath.get(poolId, finalPath) as
              | { id: string }
              | undefined;
            if (existing && existing.id !== tf.fileId) {
              finalPath = `${tf.newVirtualPath}.trashed-${Date.now()}-${tf.fileId.slice(0, 8)}`;
            }
            stmts.updateDescendantFilePath.run(finalPath, tf.folderId, tf.fileId);

            let list = filesByAccount.get(tf.accountId);
            if (!list) {
              list = [];
              filesByAccount.set(tf.accountId, list);
            }
            list.push({
              id: tf.fileId,
              driveFileId: tf.driveFileId,
              newVirtualPath: finalPath,
              destFolder: tf.destFolder,
              wasTrashed: false,
            });
          }

          // Delete source folders bottom-up only if zero active or trashed files remain under them.
          const sortedSourceFolders = [...op.sourceFolderIdsAndPaths].sort(
            (a, b) => b.oldPath.length - a.oldPath.length
          );
          const prunedSourcePaths: string[] = [];
          for (const sf of sortedSourceFolders) {
            const bounds = buildDirectoryPrefixBounds(sf.oldPath);
            const row = stmts.countAllFilesInSubtree.get(
              poolId,
              bounds.lower,
              bounds.upper,
              sf.id
            ) as { cnt: number } | undefined;
            if ((row?.cnt ?? 0) === 0) {
              stmts.deleteFolderById.run(sf.id);
              prunedSourcePaths.push(sf.oldPath);
            }
          }

          enqueuePoolAccountOutbox(
            poolId,
            'folder_merge_account',
            filesByAccount,
            (filesForAccount): FolderMergeAccountOutboxPayload => ({
              oldFolderPath: op.oldFolderPath,
              sourceFolderPathsToPrune: prunedSourcePaths,
              ensuredFolderPaths: op.destFolderPathsToEnsure,
              files: filesForAccount,
            }),
            outboxEntries
          );
        }
      }

      enqueueDriveOutbox(outboxEntries);
    }).immediate();

    for (const accountId of accountsWithOverwrites) {
      markAccountQuotaDecreased(accountId);
    }
    if (accountsWithOverwrites.size > 0) {
      invalidatePooledStorageOverview(poolId);
    }
    bumpPoolRevision(poolId);
  }

  return plan.results;
}
