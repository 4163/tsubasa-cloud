import { DAILY_UPLOAD_LIMIT_BYTES, evaluateAccountTransferCandidate } from './accountTransfer.js';
import type {
  AccountItem,
  ExistingPoolFile,
  FileProgressState,
  PlacementItemPreview,
  StagedItem,
  UploadConflictAction,
  UploadContentMatchStatus,
} from '../types.js';

export const CEILING_14_25_GB = 14.25 * 1024 * 1024 * 1024;

export interface NormalizedUploadItem {
  file: File;
  virtualPath: string;
  key: string;
}

export interface UploadFolderGroup {
  key: string;
  name: string;
  folderPath: string;
  items: NormalizedUploadItem[];
  subfolderCount: number;
  totalBytes: number;
}

export interface UploadFolderSummary {
  rejectedCount: number;
  skippedCount: number;
  completedCount: number;
  uploadingCount: number;
  errorCount: number;
  identicalSkippedCount: number;
  actionableCount: number;
  actionableBytes: number;
  replacedBytes: number;
  loadedBytes: number;
  editableConflictCount: number;
  uniformFolderConflictAction: UploadConflictAction | null;
  targetAccountCount: number;
  singleTargetAccId: string | null;
  folderCanFitReplace: boolean;
  folderCanFitKeepBoth: boolean;
}

export type UploadDisplayRow =
  | { kind: 'section_header'; key: string; title: string; count: number }
  | { kind: 'loose_file'; key: string; item: NormalizedUploadItem }
  | { kind: 'folder_group'; key: string; group: UploadFolderGroup }
  | { kind: 'folder_child_file'; key: string; item: NormalizedUploadItem; parentFolderPath: string }
  | { kind: 'empty_folder'; key: string; name: string; folderPath: string };

export interface PoolTransferBudgets {
  totalPoolHeadroom: number;
  totalPoolUploadBudget: number;
  canHoldFile: (
    sizeBytes: number,
    existingFile?: Pick<ExistingPoolFile, 'accountId' | 'sizeBytes'>
  ) => boolean;
}

export function normalizeStagedFiles(
  stagedFiles: Array<File | StagedItem>,
  currentPath: string
): NormalizedUploadItem[] {
  return stagedFiles.map((item, index) => {
    if ('virtualPath' in item && 'file' in item) {
      const vPath = item.virtualPath.startsWith('/') ? item.virtualPath : '/' + item.virtualPath;
      return {
        file: item.file,
        virtualPath: vPath,
        key: `${vPath}::${index}`,
      };
    }
    const rel = (item as File & { webkitRelativePath?: string }).webkitRelativePath || item.name;
    const cleanBase = currentPath === '/' ? '' : currentPath;
    const vPath = `${cleanBase}/${rel}`.replace(/\/+/g, '/');
    return {
      file: item,
      virtualPath: vPath,
      key: `${vPath}::${index}`,
    };
  });
}

export function computePoolTransferBudgets(accounts: AccountItem[]): PoolTransferBudgets {
  if (accounts.length === 0) {
    return {
      totalPoolHeadroom: Infinity,
      totalPoolUploadBudget: Infinity,
      canHoldFile: () => true,
    };
  }

  const activeEligible = accounts.filter((acc) => !acc.isDisabled && acc.authorized);
  const headroomSum = activeEligible.reduce((sum, acc) => sum + Math.max(0, acc.headroomBytes), 0);
  const budgetSum = activeEligible.reduce(
    (sum, acc) => sum + Math.max(0, acc.transferStats?.remainingUploadBytes24h ?? DAILY_UPLOAD_LIMIT_BYTES),
    0
  );

  return {
    totalPoolHeadroom: headroomSum,
    totalPoolUploadBudget: budgetSum,
    canHoldFile: (
      sizeBytes: number,
      existingFile?: Pick<ExistingPoolFile, 'accountId' | 'sizeBytes'>
    ) =>
      activeEligible.some((acc) =>
        evaluateAccountTransferCandidate(acc, sizeBytes, {
          freedBytes:
            existingFile && acc.id === existingFile.accountId ? existingFile.sizeBytes : 0,
        }).canHold
      ),
  };
}

export function computeUploadByteStats(
  normalizedItems: NormalizedUploadItem[],
  actionableItems: NormalizedUploadItem[],
  conflictsByPath: Record<string, ExistingPoolFile>,
  conflictActions: Record<string, UploadConflictAction>
) {
  let totalBytes = 0;
  for (const it of normalizedItems) {
    totalBytes += it.file.size;
  }
  let actionableBytes = 0;
  let replacedBytes = 0;
  for (const it of actionableItems) {
    actionableBytes += it.file.size;
    const existing = conflictsByPath[it.virtualPath];
    if (existing && conflictActions[it.key] === 'replace') {
      replacedBytes += existing.sizeBytes;
    }
  }
  const allRejected =
    normalizedItems.length > 0 && normalizedItems.every((it) => it.file.size > CEILING_14_25_GB);

  return {
    totalBytes,
    actionableBytes,
    replacedBytes,
    netDeltaBytes: actionableBytes - replacedBytes,
    allRejected,
  };
}

export function buildUploadDisplayModel(
  normalizedItems: NormalizedUploadItem[],
  stagedEmptyFolders: string[],
  currentPath: string,
  expandedFolders: Record<string, boolean>
): { folderGroupByKey: Map<string, UploadFolderGroup>; displayRows: UploadDisplayRow[] } {
  const normalizedBase = currentPath === '/' ? '' : currentPath.replace(/\/+$/, '');
  const getRelAndBase = (vPath: string) => {
    if (normalizedBase && vPath.startsWith(`${normalizedBase}/`)) {
      return { rel: vPath.slice(normalizedBase.length + 1), base: normalizedBase };
    }
    return { rel: vPath.replace(/^\/+/, ''), base: '' };
  };

  type MutableGroup = UploadFolderGroup & { subfolders: Set<string> };
  const topEntries: Array<
    | { kind: 'loose_file'; item: NormalizedUploadItem }
    | { kind: 'folder'; group: MutableGroup }
  > = [];
  const groupByPath = new Map<string, MutableGroup>();

  const recordNestedDirs = (group: MutableGroup, relWithinFolder: string) => {
    const parts = relWithinFolder.split('/').filter(Boolean);
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      group.subfolders.add(acc);
    }
  };

  for (const item of normalizedItems) {
    const { rel, base } = getRelAndBase(item.virtualPath);
    const slashIdx = rel.indexOf('/');
    if (slashIdx === -1) {
      topEntries.push({ kind: 'loose_file', item });
      continue;
    }

    const topFolderName = rel.slice(0, slashIdx);
    const folderPath = base ? `${base}/${topFolderName}` : `/${topFolderName}`;
    let group = groupByPath.get(folderPath);
    if (!group) {
      group = {
        key: `folder::${folderPath}`,
        name: topFolderName,
        folderPath,
        items: [],
        subfolderCount: 0,
        totalBytes: 0,
        subfolders: new Set<string>(),
      };
      groupByPath.set(folderPath, group);
      topEntries.push({ kind: 'folder', group });
    }
    group.items.push(item);
    group.totalBytes += item.file.size;

    const remainder = rel.slice(slashIdx + 1);
    const lastSlash = remainder.lastIndexOf('/');
    if (lastSlash > 0) {
      recordNestedDirs(group, remainder.slice(0, lastSlash));
    }
  }

  const seenEmptyPaths = new Set<string>();
  const standaloneEmptyFolders: Array<{ key: string; name: string; folderPath: string }> = [];
  for (const rawEmptyPath of stagedEmptyFolders) {
    const emptyPath = rawEmptyPath.startsWith('/') ? rawEmptyPath : `/${rawEmptyPath}`;
    const normalizedEmptyPath = emptyPath.replace(/\/+$/, '') || '/';
    if (seenEmptyPaths.has(normalizedEmptyPath)) continue;
    seenEmptyPaths.add(normalizedEmptyPath);
    const { rel, base } = getRelAndBase(normalizedEmptyPath);
    const parts = rel.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    const topFolderName = parts[0];
    const topFolderPath = base ? `${base}/${topFolderName}` : `/${topFolderName}`;
    const existingGroup = groupByPath.get(topFolderPath);
    if (existingGroup) {
      if (parts.length > 1) {
        recordNestedDirs(existingGroup, parts.slice(1).join('/'));
      }
    } else {
      standaloneEmptyFolders.push({
        key: `empty::${normalizedEmptyPath}`,
        name: parts.join('/'),
        folderPath: normalizedEmptyPath,
      });
    }
  }

  const folderGroupByKey = new Map<string, UploadFolderGroup>();
  const looseEntries: NormalizedUploadItem[] = [];
  const folderEntries: UploadFolderGroup[] = [];

  for (const entry of topEntries) {
    if (entry.kind === 'loose_file') {
      looseEntries.push(entry.item);
      continue;
    }

    const finalizedGroup: UploadFolderGroup = {
      key: entry.group.key,
      name: entry.group.name,
      folderPath: entry.group.folderPath,
      items: entry.group.items,
      subfolderCount: entry.group.subfolders.size,
      totalBytes: entry.group.totalBytes,
    };
    folderGroupByKey.set(finalizedGroup.key, finalizedGroup);
    folderEntries.push(finalizedGroup);
  }

  const displayRows: UploadDisplayRow[] = [];
  const totalFolderItems = folderEntries.length + standaloneEmptyFolders.length;

  if (totalFolderItems > 0) {
    displayRows.push({
      kind: 'section_header',
      key: 'section::folders',
      title: 'Folders',
      count: totalFolderItems,
    });

    for (const finalizedGroup of folderEntries) {
      displayRows.push({
        kind: 'folder_group',
        key: finalizedGroup.key,
        group: finalizedGroup,
      });

      if (expandedFolders[finalizedGroup.key]) {
        for (const child of finalizedGroup.items) {
          displayRows.push({
            kind: 'folder_child_file',
            key: child.key,
            item: child,
            parentFolderPath: finalizedGroup.folderPath,
          });
        }
      }
    }

    for (const emptyEntry of standaloneEmptyFolders) {
      displayRows.push({
        kind: 'empty_folder',
        key: emptyEntry.key,
        name: emptyEntry.name,
        folderPath: emptyEntry.folderPath,
      });
    }
  }

  if (looseEntries.length > 0) {
    displayRows.push({
      kind: 'section_header',
      key: 'section::files',
      title: 'Files',
      count: looseEntries.length,
    });

    for (const item of looseEntries) {
      displayRows.push({
        kind: 'loose_file',
        key: item.key,
        item,
      });
    }
  }

  return { folderGroupByKey, displayRows };
}

export function computeFolderSummaries(params: {
  folderGroupByKey: Map<string, UploadFolderGroup>;
  accountsCount: number;
  accountById: Map<string, AccountItem>;
  previewByPath: Map<string, PlacementItemPreview>;
  conflictsByPath: Record<string, ExistingPoolFile>;
  conflictActions: Record<string, UploadConflictAction>;
  fileProgress: Record<string, FileProgressState>;
  contentMatchByKey: Record<string, UploadContentMatchStatus>;
  selectedAccounts: Record<string, string>;
  budgets: PoolTransferBudgets;
}): Map<string, UploadFolderSummary> {
  const {
    folderGroupByKey,
    accountsCount,
    accountById,
    previewByPath,
    conflictsByPath,
    conflictActions,
    fileProgress,
    contentMatchByKey,
    selectedAccounts,
    budgets,
  } = params;
  const { totalPoolHeadroom, totalPoolUploadBudget, canHoldFile } = budgets;
  const map = new Map<string, UploadFolderSummary>();

  const isEligibleAccount = (accId: string) => {
    if (accountsCount === 0) return true;
    const acc = accountById.get(accId);
    return Boolean(acc && !acc.isDisabled && acc.authorized);
  };

  for (const [groupKey, group] of folderGroupByKey.entries()) {
    let rejectedCount = 0;
    let skippedCount = 0;
    let completedCount = 0;
    let uploadingCount = 0;
    let errorCount = 0;
    let identicalSkippedCount = 0;
    let actionableCount = 0;
    let actionableBytes = 0;
    let replacedBytes = 0;
    let loadedBytes = 0;
    let basePendingBytes = 0;
    let editableConflictBytes = 0;
    let editableConflictCount = 0;
    let uniformAction: UploadConflictAction | null = null;
    let uniformMismatch = false;
    let canHoldAllReplace = true;
    let canHoldAllKeepBoth = true;
    let freedReplaceHeadroom = 0;
    let firstTargetAccId: string | null = null;
    let hasMultipleTargets = false;
    const seenTargets = new Set<string>();

    for (const item of group.items) {
      const preview = previewByPath.get(item.virtualPath);
      const isRejected = item.file.size > CEILING_14_25_GB || Boolean(preview?.rejected);
      if (isRejected) {
        rejectedCount += 1;
        continue;
      }

      const existingFile = conflictsByPath[item.virtualPath];
      const effectiveAction: UploadConflictAction | undefined = existingFile
        ? conflictActions[item.key] ?? 'skip'
        : undefined;
      const progress = fileProgress[item.key];
      const isComplete = progress?.status === 'complete';

      if (existingFile && !isComplete) {
        editableConflictCount += 1;
        editableConflictBytes += item.file.size;
        const actionChoice = conflictActions[item.key] ?? 'skip';
        if (uniformAction === null) {
          uniformAction = actionChoice;
        } else if (uniformAction !== actionChoice) {
          uniformMismatch = true;
        }
        if (canHoldAllReplace && !canHoldFile(item.file.size, existingFile)) {
          canHoldAllReplace = false;
        }
        if (canHoldAllKeepBoth && !canHoldFile(item.file.size)) {
          canHoldAllKeepBoth = false;
        }
        if (isEligibleAccount(existingFile.accountId)) {
          freedReplaceHeadroom += existingFile.sizeBytes;
        }
      } else if (!isComplete) {
        basePendingBytes += item.file.size;
      }

      if (effectiveAction === 'skip') {
        skippedCount += 1;
        if (contentMatchByKey[item.key] === 'identical') {
          identicalSkippedCount += 1;
        }
        continue;
      }

      actionableCount += 1;
      actionableBytes += item.file.size;
      if (existingFile && effectiveAction === 'replace') {
        replacedBytes += existingFile.sizeBytes;
      }

      const chosenAccountId = selectedAccounts[item.key] || preview?.targetAccountId;
      if (chosenAccountId) {
        if (firstTargetAccId === null) {
          firstTargetAccId = chosenAccountId;
        } else if (chosenAccountId !== firstTargetAccId) {
          hasMultipleTargets = true;
        }
        seenTargets.add(chosenAccountId);
      }

      if (progress?.status === 'complete') {
        completedCount += 1;
        loadedBytes += item.file.size;
      } else if (progress?.status === 'uploading') {
        uploadingCount += 1;
        loadedBytes += progress.loaded;
      } else if (progress?.status === 'error') {
        errorCount += 1;
      }
    }

    const neededTransferBytes = basePendingBytes + editableConflictBytes;
    const neededReplaceHeadroom = neededTransferBytes - freedReplaceHeadroom;

    map.set(groupKey, {
      rejectedCount,
      skippedCount,
      completedCount,
      uploadingCount,
      errorCount,
      identicalSkippedCount,
      actionableCount,
      actionableBytes,
      replacedBytes,
      loadedBytes,
      editableConflictCount,
      uniformFolderConflictAction: uniformMismatch ? null : uniformAction,
      targetAccountCount: seenTargets.size,
      singleTargetAccId: !hasMultipleTargets ? firstTargetAccId : null,
      folderCanFitReplace:
        canHoldAllReplace &&
        neededReplaceHeadroom <= totalPoolHeadroom &&
        neededTransferBytes <= totalPoolUploadBudget,
      folderCanFitKeepBoth:
        canHoldAllKeepBoth &&
        neededTransferBytes <= totalPoolHeadroom &&
        neededTransferBytes <= totalPoolUploadBudget,
    });
  }

  return map;
}

export function computeBatchFit(params: {
  normalizedItems: NormalizedUploadItem[];
  fileProgress: Record<string, FileProgressState>;
  conflictsByPath: Record<string, ExistingPoolFile>;
  accountsCount: number;
  accountById: Map<string, AccountItem>;
  budgets: PoolTransferBudgets;
}): { batchCanFitReplace: boolean; batchCanFitKeepBoth: boolean } {
  const {
    normalizedItems,
    fileProgress,
    conflictsByPath,
    accountsCount,
    accountById,
    budgets,
  } = params;
  const { totalPoolHeadroom, totalPoolUploadBudget, canHoldFile } = budgets;
  let neededTransferBytes = 0;
  let freedReplaceHeadroom = 0;
  let canHoldAllReplace = true;
  let canHoldAllKeepBoth = true;

  for (const it of normalizedItems) {
    if (it.file.size > CEILING_14_25_GB) continue;
    if (fileProgress[it.key]?.status === 'complete') continue;
    const existing = conflictsByPath[it.virtualPath];
    if (existing) {
      if (canHoldAllReplace && !canHoldFile(it.file.size, existing)) {
        canHoldAllReplace = false;
      }
      if (canHoldAllKeepBoth && !canHoldFile(it.file.size)) {
        canHoldAllKeepBoth = false;
      }
      const existingAccount = accountsCount === 0 ? null : accountById.get(existing.accountId);
      if (
        accountsCount === 0 ||
        (existingAccount && !existingAccount.isDisabled && existingAccount.authorized)
      ) {
        freedReplaceHeadroom += existing.sizeBytes;
      }
    }
    neededTransferBytes += it.file.size;
  }

  const neededReplaceHeadroom = neededTransferBytes - freedReplaceHeadroom;
  return {
    batchCanFitReplace:
      canHoldAllReplace &&
      neededReplaceHeadroom <= totalPoolHeadroom &&
      neededTransferBytes <= totalPoolUploadBudget,
    batchCanFitKeepBoth:
      canHoldAllKeepBoth &&
      neededTransferBytes <= totalPoolHeadroom &&
      neededTransferBytes <= totalPoolUploadBudget,
  };
}
