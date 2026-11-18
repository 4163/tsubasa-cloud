import path from 'node:path';
import { db, buildDirectoryPrefixBounds } from '../db/index.js';
import { files, folders } from '../db/schema.js';
import { eq, or, and } from 'drizzle-orm';
import { normalizeVirtualPath } from '../virtualPath.js';
import {
  evaluateFileContentMatch,
  type FileContentMatchStatus,
  type MoveConflictItem,
} from './errors.js';
import { formatFolderId } from './sync.js';
import {
  allocateUniqueVirtualPath,
  getStmts,
  toEpochSeconds,
  type DescendantFileRow,
  type DescendantFolderRow,
  type MoveItemInput,
} from './operationsDb.js';

export type MoveConflictMode = 'reject' | 'skip' | 'keep_both' | 'overwrite';

export interface MoveResult {
  id: string;
  kind: 'file' | 'folder';
  type?: 'file' | 'folder';
  oldPath: string;
  newPath: string;
  success: boolean;
  skipped?: boolean;
  error?: string;
}

export interface PlannedFileMove {
  kind: 'file';
  fileId: string;
  accountId: string;
  driveFileId: string;
  newName: string;
  renameOnDrive: boolean;
  newVirtualPath: string;
  destFolder: string;
  folderId: string | null;
  wasTrashed: boolean;
}

export interface PlannedFolderMove {
  kind: 'folder';
  folderId: string;
  oldFolderPath: string;
  newFolderPath: string;
  parentId: string | null;
  newFolderId: string;
  descendantFolders: DescendantFolderRow[];
  descendantFiles: DescendantFileRow[];
}

export interface PlannedTrashedFileMove {
  fileId: string;
  accountId: string;
  driveFileId: string;
  newVirtualPath: string;
  destFolder: string;
  folderId: string | null;
}

export interface PlannedFolderMerge {
  kind: 'folder_merge';
  oldFolderPath: string;
  newFolderPath: string;
  sourceFolderIdsAndPaths: Array<{ id: string; oldPath: string; newPath: string }>;
  destFolderPathsToEnsure: string[];
  fileMoves: PlannedFileMove[];
  trashedFileMoves: PlannedTrashedFileMove[];
}

export type PlannedMoveOp = PlannedFileMove | PlannedFolderMove | PlannedFolderMerge;

export interface OverwriteTarget {
  id: string;
  accountId: string;
  driveFileId: string;
  sizeBytes: number;
}

export interface MovePlanResult {
  results: MoveResult[];
  plannedOps: PlannedMoveOp[];
  overwriteTargets: Map<string, OverwriteTarget>;
  conflicts: MoveConflictItem[];
  cleanCount: number;
}

export function allocateKeepBothMovePath(
  poolId: number,
  targetDir: string,
  baseName: string,
  claimedFilePaths: Set<string>,
  claimedFolderPaths: Set<string>
): string {
  const stmts = getStmts();
  return allocateUniqueVirtualPath({
    targetDir,
    baseName,
    kind: 'file',
    style: 'numbered',
    startCounter: 2,
    skipBase: true,
    isTaken: (candidatePath) => {
      if (claimedFilePaths.has(candidatePath) || claimedFolderPaths.has(candidatePath)) {
        return true;
      }
      if (stmts.selectActiveFileAtPath.get(poolId, candidatePath)) {
        return true;
      }
      const existingFolder = db
        .select({ id: folders.id })
        .from(folders)
        .where(and(eq(folders.poolId, poolId), eq(folders.virtualPath, candidatePath)))
        .get();
      return Boolean(existingFolder);
    },
  });
}

export async function planMoveItems(
  items: MoveItemInput[],
  destFolder: string,
  poolId: number,
  conflictMode: MoveConflictMode
): Promise<MovePlanResult> {
  const stmts = getStmts();

  type ResolvedInput =
    | { kind: 'file'; file: typeof files.$inferSelect }
    | { kind: 'folder'; folder: typeof folders.$inferSelect }
    | { kind: 'missing'; item: MoveItemInput; resolvedKind: 'file' | 'folder' };

  const resolvedInputs: ResolvedInput[] = [];
  const selectedFolderPaths: string[] = [];
  const selectedFileIds = new Set<string>();
  const seenIds = new Set<string>();

  for (const item of items) {
    let resolvedKind = item.kind || item.type;
    if (!resolvedKind) {
      const folderExists = await db.query.folders.findFirst({
        where: and(
          eq(folders.poolId, poolId),
          or(eq(folders.id, item.id), eq(folders.virtualPath, item.id))
        ),
      });
      resolvedKind = folderExists ? 'folder' : 'file';
    }

    if (resolvedKind === 'file') {
      const file = await db.query.files.findFirst({
        where: and(
          eq(files.poolId, poolId),
          or(eq(files.id, item.id), eq(files.virtualPath, item.id))
        ),
      });
      if (!file) {
        resolvedInputs.push({ kind: 'missing', item, resolvedKind: 'file' });
        continue;
      }
      if (seenIds.has(file.id)) continue;
      seenIds.add(file.id);
      selectedFileIds.add(file.id);
      resolvedInputs.push({ kind: 'file', file });
    } else {
      const folder = await db.query.folders.findFirst({
        where: and(
          eq(folders.poolId, poolId),
          or(eq(folders.id, item.id), eq(folders.virtualPath, item.id))
        ),
      });
      if (!folder) {
        resolvedInputs.push({ kind: 'missing', item, resolvedKind: 'folder' });
        continue;
      }
      if (seenIds.has(folder.id)) continue;
      seenIds.add(folder.id);
      selectedFolderPaths.push(folder.virtualPath);
      resolvedInputs.push({ kind: 'folder', folder });
    }
  }

  // Prune items whose ancestor folder is already included in this batch.
  const prunedInputs = resolvedInputs.filter((entry) => {
    if (entry.kind === 'missing') return true;
    const itemPath = entry.kind === 'file' ? entry.file.virtualPath : entry.folder.virtualPath;
    return !selectedFolderPaths.some(
      (ancestorPath) => ancestorPath !== itemPath && itemPath.startsWith(`${ancestorPath}/`)
    );
  });

  const results: MoveResult[] = [];
  const plannedOps: PlannedMoveOp[] = [];
  const claimedFilePaths = new Set<string>();
  const claimedSourceByPath = new Map<
    string,
    { id: string; sizeBytes: number; updatedAt: number; hash: string | null }
  >();
  const claimedFolderPaths = new Set<string>();
  const overwriteTargets = new Map<string, OverwriteTarget>();
  const conflicts: MoveConflictItem[] = [];
  let cleanCount = 0;

  async function planSingleFileMove(
    source: {
      id: string;
      name: string;
      virtualPath: string;
      accountId: string;
      driveFileId: string;
      sizeBytes: number;
      hash: string | null;
      updatedAt: number;
      isTrashed: boolean;
    },
    targetDir: string
  ): Promise<{
    status: 'noop' | 'move' | 'skip' | 'conflict' | 'error';
    op?: PlannedFileMove;
    error?: string;
  }> {
    const desiredPath = normalizeVirtualPath(path.posix.join(targetDir, source.name));
    if (desiredPath === source.virtualPath && !source.isTrashed) {
      claimedFilePaths.add(desiredPath);
      claimedSourceByPath.set(desiredPath, {
        id: source.id,
        sizeBytes: source.sizeBytes,
        updatedAt: source.updatedAt,
        hash: source.hash,
      });
      return { status: 'noop' };
    }

    const folderBlocking = claimedFolderPaths.has(desiredPath)
      ? true
      : Boolean(
          await db.query.folders.findFirst({
            where: and(eq(folders.poolId, poolId), eq(folders.virtualPath, desiredPath)),
          })
        );

    if (folderBlocking) {
      return {
        status: 'error',
        error: `A folder named "${source.name}" already exists in the destination folder`,
      };
    }

    const existingActive = await db.query.files.findFirst({
      where: and(
        eq(files.poolId, poolId),
        eq(files.virtualPath, desiredPath),
        eq(files.isTrashed, false)
      ),
    });

    const isExistingCollision = Boolean(existingActive && existingActive.id !== source.id);
    const isBatchCollision = claimedFilePaths.has(desiredPath);

    if (!isExistingCollision && !isBatchCollision) {
      claimedFilePaths.add(desiredPath);
      claimedSourceByPath.set(desiredPath, {
        id: source.id,
        sizeBytes: source.sizeBytes,
        updatedAt: source.updatedAt,
        hash: source.hash,
      });
      cleanCount++;
      const parentDir = path.posix.dirname(desiredPath);
      const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);
      return {
        status: 'move',
        op: {
          kind: 'file',
          fileId: source.id,
          accountId: source.accountId,
          driveFileId: source.driveFileId,
          newName: source.name,
          renameOnDrive: false,
          newVirtualPath: desiredPath,
          destFolder: parentDir === '.' ? '/' : parentDir,
          folderId,
          wasTrashed: source.isTrashed,
        },
      };
    }

    if (conflictMode === 'reject') {
      const batchClaimed = isBatchCollision ? claimedSourceByPath.get(desiredPath) : undefined;
      const preExisting =
        !isBatchCollision && existingActive && existingActive.id !== source.id ? existingActive : undefined;
      const compareTarget = preExisting
        ? {
            id: preExisting.id,
            sizeBytes: preExisting.sizeBytes,
            updatedAt: toEpochSeconds(preExisting.updatedAt),
            hash: preExisting.hash,
          }
        : batchClaimed;

      const contentMatch: FileContentMatchStatus = compareTarget
        ? evaluateFileContentMatch(
            source.sizeBytes,
            [source.hash],
            compareTarget.sizeBytes,
            compareTarget.hash
          )
        : 'unverified';
      const canOverwrite = Boolean(preExisting && !selectedFileIds.has(preExisting.id));

      conflicts.push({
        sourceFileId: source.id,
        sourcePath: source.virtualPath,
        sourceName: source.name,
        sourceSizeBytes: source.sizeBytes,
        sourceUpdatedAt: source.updatedAt,
        destPath: desiredPath,
        ...(preExisting ? { existingFileId: preExisting.id } : {}),
        ...(compareTarget
          ? {
              existingSizeBytes: compareTarget.sizeBytes,
              existingUpdatedAt: compareTarget.updatedAt,
            }
          : {}),
        contentMatch,
        canOverwrite,
      });
      return { status: 'conflict' };
    }

    if (conflictMode === 'skip') {
      return { status: 'skip' };
    }

    if (
      conflictMode === 'overwrite' &&
      existingActive &&
      existingActive.id !== source.id &&
      !selectedFileIds.has(existingActive.id) &&
      !claimedFilePaths.has(desiredPath)
    ) {
      overwriteTargets.set(existingActive.id, {
        id: existingActive.id,
        accountId: existingActive.accountId,
        driveFileId: existingActive.driveFileId,
        sizeBytes: existingActive.sizeBytes,
      });
      claimedFilePaths.add(desiredPath);
      const parentDir = path.posix.dirname(desiredPath);
      const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);
      return {
        status: 'move',
        op: {
          kind: 'file',
          fileId: source.id,
          accountId: source.accountId,
          driveFileId: source.driveFileId,
          newName: source.name,
          renameOnDrive: false,
          newVirtualPath: desiredPath,
          destFolder: parentDir === '.' ? '/' : parentDir,
          folderId,
          wasTrashed: source.isTrashed,
        },
      };
    }

    // Keep both (or same-batch name collision during overwrite where no pre-existing target remains).
    const keepBothPath = allocateKeepBothMovePath(
      poolId,
      targetDir,
      source.name,
      claimedFilePaths,
      claimedFolderPaths
    );
    claimedFilePaths.add(keepBothPath);
    const keepBothName = path.posix.basename(keepBothPath);
    const parentDir = path.posix.dirname(keepBothPath);
    const folderId = parentDir === '/' || parentDir === '.' ? null : formatFolderId(poolId, parentDir);
    return {
      status: 'move',
      op: {
        kind: 'file',
        fileId: source.id,
        accountId: source.accountId,
        driveFileId: source.driveFileId,
        newName: keepBothName,
        renameOnDrive: keepBothName !== source.name,
        newVirtualPath: keepBothPath,
        destFolder: parentDir === '.' ? '/' : parentDir,
        folderId,
        wasTrashed: source.isTrashed,
      },
    };
  }

  for (const entry of prunedInputs) {
    if (entry.kind === 'missing') {
      results.push({
        id: entry.item.id,
        kind: entry.resolvedKind,
        type: entry.resolvedKind,
        oldPath: entry.item.id,
        newPath: '',
        success: false,
        error: entry.resolvedKind === 'folder' ? 'Folder not found' : 'File not found',
      });
      continue;
    }

    if (entry.kind === 'file') {
      const file = entry.file;
      const plan = await planSingleFileMove(
        {
          id: file.id,
          name: file.name,
          virtualPath: file.virtualPath,
          accountId: file.accountId,
          driveFileId: file.driveFileId,
          sizeBytes: file.sizeBytes,
          hash: file.hash ?? null,
          updatedAt: toEpochSeconds(file.updatedAt),
          isTrashed: Boolean(file.isTrashed),
        },
        destFolder
      );

      if (plan.status === 'noop') {
        results.push({
          id: file.id,
          kind: 'file',
          type: 'file',
          oldPath: file.virtualPath,
          newPath: file.virtualPath,
          success: true,
        });
      } else if (plan.status === 'move' && plan.op) {
        plannedOps.push(plan.op);
        results.push({
          id: file.id,
          kind: 'file',
          type: 'file',
          oldPath: file.virtualPath,
          newPath: plan.op.newVirtualPath,
          success: true,
        });
      } else if (plan.status === 'skip') {
        results.push({
          id: file.id,
          kind: 'file',
          type: 'file',
          oldPath: file.virtualPath,
          newPath: file.virtualPath,
          success: true,
          skipped: true,
        });
      } else if (plan.status === 'error') {
        results.push({
          id: file.id,
          kind: 'file',
          type: 'file',
          oldPath: file.virtualPath,
          newPath: normalizeVirtualPath(path.posix.join(destFolder, file.name)),
          success: false,
          error: plan.error,
        });
      }
      continue;
    }

    const folder = entry.folder;
    const oldFolderPath = folder.virtualPath;
    if (destFolder === oldFolderPath || destFolder.startsWith(`${oldFolderPath}/`)) {
      results.push({
        id: folder.id,
        kind: 'folder',
        type: 'folder',
        oldPath: oldFolderPath,
        newPath: '',
        success: false,
        error: 'Cannot move a folder into itself or a subfolder',
      });
      continue;
    }

    const newFolderPath = normalizeVirtualPath(path.posix.join(destFolder, folder.name));
    if (newFolderPath === oldFolderPath) {
      results.push({
        id: folder.id,
        kind: 'folder',
        type: 'folder',
        oldPath: oldFolderPath,
        newPath: newFolderPath,
        success: true,
      });
      continue;
    }

    const activeFileAtFolderTarget = await db.query.files.findFirst({
      where: and(
        eq(files.poolId, poolId),
        eq(files.virtualPath, newFolderPath),
        eq(files.isTrashed, false)
      ),
    });
    if (activeFileAtFolderTarget || claimedFilePaths.has(newFolderPath)) {
      results.push({
        id: folder.id,
        kind: 'folder',
        type: 'folder',
        oldPath: oldFolderPath,
        newPath: newFolderPath,
        success: false,
        error: `A file named "${folder.name}" already exists in the destination folder`,
      });
      continue;
    }

    const oldFolderBounds = buildDirectoryPrefixBounds(oldFolderPath);
    const descendantFiles = stmts.selectDescendantFiles.all(
      poolId,
      oldFolderBounds.lower,
      oldFolderBounds.upper,
      formatFolderId(poolId, oldFolderPath)
    ) as DescendantFileRow[];

    const descendantFolders = stmts.selectDescendantFolders.all(
      poolId,
      oldFolderBounds.lower,
      oldFolderBounds.upper
    ) as DescendantFolderRow[];

    const existingDestFolder = await db.query.folders.findFirst({
      where: and(eq(folders.poolId, poolId), eq(folders.virtualPath, newFolderPath)),
    });
    const isMerge = Boolean(
      (existingDestFolder && existingDestFolder.id !== folder.id) || claimedFolderPaths.has(newFolderPath)
    );

    if (!isMerge) {
      const plannedSubFolderPaths: string[] = [];
      let nonMergeTypeError: string | null = null;

      for (const sub of descendantFolders) {
        const subDestPath = normalizeVirtualPath(newFolderPath + sub.virtual_path.slice(oldFolderPath.length));
        const subFileBlocking = claimedFilePaths.has(subDestPath)
          ? true
          : Boolean(
              await db.query.files.findFirst({
                where: and(
                  eq(files.poolId, poolId),
                  eq(files.virtualPath, subDestPath),
                  eq(files.isTrashed, false)
                ),
              })
            );
        if (subFileBlocking) {
          nonMergeTypeError = `A file named "${sub.name}" already exists at "${subDestPath}"`;
          break;
        }
        plannedSubFolderPaths.push(subDestPath);
      }

      if (nonMergeTypeError) {
        results.push({
          id: folder.id,
          kind: 'folder',
          type: 'folder',
          oldPath: oldFolderPath,
          newPath: newFolderPath,
          success: false,
          error: nonMergeTypeError,
        });
        continue;
      }

      const plannedDescendantFiles: Array<{
        path: string;
        source: { id: string; sizeBytes: number; updatedAt: number; hash: string | null };
      }> = [];
      let hasFileConflict = false;

      for (const f of descendantFiles) {
        if (f.is_trashed) continue;
        const relative = f.virtual_path.startsWith(oldFolderPath + '/')
          ? f.virtual_path.slice(oldFolderPath.length)
          : `/${f.name}`;
        const fileDestPath = normalizeVirtualPath(newFolderPath + relative);

        const folderBlocking =
          claimedFolderPaths.has(fileDestPath) ||
          plannedSubFolderPaths.includes(fileDestPath) ||
          Boolean(
            await db.query.folders.findFirst({
              where: and(eq(folders.poolId, poolId), eq(folders.virtualPath, fileDestPath)),
            })
          );
        if (folderBlocking) {
          nonMergeTypeError = `A folder named "${f.name}" already exists at "${fileDestPath}"`;
          break;
        }

        const existingActive = await db.query.files.findFirst({
          where: and(
            eq(files.poolId, poolId),
            eq(files.virtualPath, fileDestPath),
            eq(files.isTrashed, false)
          ),
        });
        const isExistingCollision = Boolean(existingActive && existingActive.id !== f.id);
        const isBatchCollision = claimedFilePaths.has(fileDestPath);

        if (isExistingCollision || isBatchCollision) {
          hasFileConflict = true;
          const batchClaimed = isBatchCollision ? claimedSourceByPath.get(fileDestPath) : undefined;
          const preExisting =
            !isBatchCollision && existingActive && existingActive.id !== f.id ? existingActive : undefined;
          const compareTarget = preExisting
            ? {
                id: preExisting.id,
                sizeBytes: preExisting.sizeBytes,
                updatedAt: toEpochSeconds(preExisting.updatedAt),
                hash: preExisting.hash,
              }
            : batchClaimed;

          const contentMatch: FileContentMatchStatus = compareTarget
            ? evaluateFileContentMatch(
                f.size_bytes,
                [f.hash ?? null],
                compareTarget.sizeBytes,
                compareTarget.hash
              )
            : 'unverified';
          const canOverwrite = Boolean(preExisting && !selectedFileIds.has(preExisting.id));

          conflicts.push({
            sourceFileId: f.id,
            sourcePath: f.virtual_path,
            sourceName: f.name,
            sourceSizeBytes: f.size_bytes,
            sourceUpdatedAt: f.updated_at,
            destPath: fileDestPath,
            ...(preExisting ? { existingFileId: preExisting.id } : {}),
            ...(compareTarget
              ? {
                  existingSizeBytes: compareTarget.sizeBytes,
                  existingUpdatedAt: compareTarget.updatedAt,
                }
              : {}),
            contentMatch,
            canOverwrite,
          });
          continue;
        }

        plannedDescendantFiles.push({
          path: fileDestPath,
          source: {
            id: f.id,
            sizeBytes: f.size_bytes,
            updatedAt: f.updated_at,
            hash: f.hash ?? null,
          },
        });
      }

      if (nonMergeTypeError) {
        results.push({
          id: folder.id,
          kind: 'folder',
          type: 'folder',
          oldPath: oldFolderPath,
          newPath: newFolderPath,
          success: false,
          error: nonMergeTypeError,
        });
        continue;
      }

      if (hasFileConflict) {
        results.push({
          id: folder.id,
          kind: 'folder',
          type: 'folder',
          oldPath: oldFolderPath,
          newPath: newFolderPath,
          success: false,
          error: 'Destination has conflicting files',
        });
        continue;
      }

      claimedFolderPaths.add(newFolderPath);
      for (const subDestPath of plannedSubFolderPaths) {
        claimedFolderPaths.add(subDestPath);
      }
      for (const plannedFile of plannedDescendantFiles) {
        claimedFilePaths.add(plannedFile.path);
        claimedSourceByPath.set(plannedFile.path, plannedFile.source);
      }

      cleanCount++;
      const parentId = destFolder === '/' ? null : formatFolderId(poolId, destFolder);
      const newFolderId = formatFolderId(poolId, newFolderPath);

      plannedOps.push({
        kind: 'folder',
        folderId: folder.id,
        oldFolderPath,
        newFolderPath,
        parentId,
        newFolderId,
        descendantFolders,
        descendantFiles,
      });

      results.push({
        id: folder.id,
        kind: 'folder',
        type: 'folder',
        oldPath: oldFolderPath,
        newPath: newFolderPath,
        success: true,
      });
      continue;
    }

    // Destination folder already exists: plan a silent folder merge.
    claimedFolderPaths.add(newFolderPath);
    const destFolderPathsToEnsure: string[] = [newFolderPath];
    const sourceFolderIdsAndPaths: Array<{ id: string; oldPath: string; newPath: string }> = [
      { id: folder.id, oldPath: oldFolderPath, newPath: newFolderPath },
    ];
    let folderTypeMismatchError: string | null = null;

    for (const sub of descendantFolders) {
      const subDestPath = normalizeVirtualPath(newFolderPath + sub.virtual_path.slice(oldFolderPath.length));
      const subFileBlocking = claimedFilePaths.has(subDestPath)
        ? true
        : Boolean(
            await db.query.files.findFirst({
              where: and(
                eq(files.poolId, poolId),
                eq(files.virtualPath, subDestPath),
                eq(files.isTrashed, false)
              ),
            })
          );
      if (subFileBlocking) {
        folderTypeMismatchError = `A file named "${sub.name}" already exists at "${subDestPath}"`;
        break;
      }
      claimedFolderPaths.add(subDestPath);
      destFolderPathsToEnsure.push(subDestPath);
      sourceFolderIdsAndPaths.push({ id: sub.id, oldPath: sub.virtual_path, newPath: subDestPath });
    }

    if (folderTypeMismatchError) {
      results.push({
        id: folder.id,
        kind: 'folder',
        type: 'folder',
        oldPath: oldFolderPath,
        newPath: newFolderPath,
        success: false,
        error: folderTypeMismatchError,
      });
      continue;
    }

    const mergeFileMoves: PlannedFileMove[] = [];
    const mergeTrashedFileMoves: PlannedTrashedFileMove[] = [];
    let mergeFileTypeError: string | null = null;
    let mergeSkippedCount = 0;

    for (const f of descendantFiles) {
      const relative = f.virtual_path.startsWith(oldFolderPath + '/')
        ? f.virtual_path.slice(oldFolderPath.length)
        : `/${f.name}`;
      const targetFilePath = normalizeVirtualPath(newFolderPath + relative);
      const targetFileDir = path.posix.dirname(targetFilePath);
      const targetDirNormalized = targetFileDir === '.' ? '/' : targetFileDir;

      if (f.is_trashed) {
        const folderId =
          targetDirNormalized === '/' ? null : formatFolderId(poolId, targetDirNormalized);
        mergeTrashedFileMoves.push({
          fileId: f.id,
          accountId: f.account_id,
          driveFileId: f.drive_file_id,
          newVirtualPath: targetFilePath,
          destFolder: targetDirNormalized,
          folderId,
        });
        continue;
      }

      const filePlan = await planSingleFileMove(
        {
          id: f.id,
          name: f.name,
          virtualPath: f.virtual_path,
          accountId: f.account_id,
          driveFileId: f.drive_file_id,
          sizeBytes: f.size_bytes,
          hash: f.hash ?? null,
          updatedAt: f.updated_at,
          isTrashed: false,
        },
        targetDirNormalized
      );

      if (filePlan.status === 'move' && filePlan.op) {
        mergeFileMoves.push(filePlan.op);
      } else if (filePlan.status === 'skip') {
        mergeSkippedCount++;
      } else if (filePlan.status === 'error') {
        mergeFileTypeError = filePlan.error || `Cannot move "${f.name}"`;
        break;
      }
    }

    if (mergeFileTypeError) {
      results.push({
        id: folder.id,
        kind: 'folder',
        type: 'folder',
        oldPath: oldFolderPath,
        newPath: newFolderPath,
        success: false,
        error: mergeFileTypeError,
      });
      continue;
    }

    if (descendantFiles.filter((f) => !f.is_trashed).length === 0) {
      cleanCount++;
    }

    plannedOps.push({
      kind: 'folder_merge',
      oldFolderPath,
      newFolderPath,
      sourceFolderIdsAndPaths,
      destFolderPathsToEnsure,
      fileMoves: mergeFileMoves,
      trashedFileMoves: mergeTrashedFileMoves,
    });

    results.push({
      id: folder.id,
      kind: 'folder',
      type: 'folder',
      oldPath: oldFolderPath,
      newPath: newFolderPath,
      success: true,
      ...(mergeSkippedCount > 0 ? { skipped: true } : {}),
    });
  }

  return {
    results,
    plannedOps,
    overwriteTargets,
    conflicts,
    cleanCount,
  };
}
