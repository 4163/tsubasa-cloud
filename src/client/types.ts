import type { InferResponseType } from 'hono/client';
import type { client, FileRecord, FolderRecord } from './api.js';
import type { FileContentVerification } from './utils/fileHash.js';

export interface AccountTransferStats {
  accountId: string;
  rollingWindowMs: number;
  uploadedBytes24h: number;
  remainingUploadBytes24h: number;
  dailyUploadLimitBytes: number;
  isUploadRateLimited: boolean;
  downloadedBytes24h: number;
  oldestTransferTimestamp: number | null;
  latestTransferTimestamp: number | null;
  nextResetMs: number | null;
  fullResetMs: number | null;
  nextExpiringBytes: number | null;
  activeTransferCount24h: number;
}

export interface ClusterTransferOverview {
  totalUploadedBytes24h: number;
  totalRemainingUploadBytes24h: number;
  dailyUploadLimitBytes: number;
  rateLimitedAccountsCount: number;
}

export interface PoolSummary {
  id: number;
  name: string;
  driveFolderName: string;
  accountCount: number;
  fileCount: number;
  totalBytes: number;
  isSharePool?: boolean;
}

export interface AccountItem {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  usableLimitBytes: number;
  headroomBytes: number;
  tsubasaUsedBytes?: number;
  syncState: string;
  isDisabled?: boolean;
  authorized: boolean;
  transferStats?: AccountTransferStats;
  hasPendingChanges?: boolean;
  hasDiscrepancy?: boolean;
  mtimeMs?: number;
  poolId?: number;
  canSwitchPool?: boolean;
  fileCount?: number;
}

export type ClientFileRecord = Omit<FileRecord, 'createdAt' | 'updatedAt' | 'trashedAt'> & {
  createdAt: string | Date;
  updatedAt: string | Date;
  trashedAt?: string | Date | null;
};

export type ClientFolder = Omit<FolderRecord, 'createdAt' | 'updatedAt'> & {
  createdAt: string | Date;
  updatedAt: string | Date;
};

export type SortColumn = 'name' | 'account' | 'size' | 'date';
export type SortDirection = 'asc' | 'desc';

export interface ExternalDiscrepancyItem {
  driveFileId: string;
  name: string;
  virtualPath: string;
  sizeBytes: number;
  mimeType: string;
  hash: string | null;
  accountId: string;
  discrepancyType: 'unindexed' | 'modified' | 'over_ceiling';
}

export interface PathConflictItem {
  driveFileId: string;
  name: string;
  virtualPath: string;
  sizeBytes: number;
  mimeType: string;
  hash: string | null;
  modifiedTime: string | null;
  accountId: string;
  accountEmail: string;
  accountDisplayName: string;
  discrepancyType: 'conflict';
  isExactDuplicate: boolean;
  existingFile: {
    fileId: string;
    driveFileId: string;
    accountId: string;
    accountEmail: string;
    accountDisplayName: string;
    sizeBytes: number;
    hash: string | null;
    updatedAt: string | null;
  };
}

export interface DiscrepancyReport {
  accountId: string;
  poolFolderName: string;
  scannedFiles: number;
  conflicts: PathConflictItem[];
  unindexed: ExternalDiscrepancyItem[];
  modified: ExternalDiscrepancyItem[];
  overCeiling: ExternalDiscrepancyItem[];
  missingRemote: Array<{
    fileId: string;
    driveFileId: string;
    virtualPath: string;
    accountId: string;
  }>;
}

export type UploadConflictAction = 'skip' | 'replace' | 'keep_both';
export type UploadContentMatchStatus = FileContentVerification | 'checking';

export interface ExistingPoolFile {
  id: string;
  virtualPath: string;
  name: string;
  sizeBytes: number;
  hash: string | null;
  accountId: string;
  updatedAt: number;
}

export interface StagedItem {
  file: File;
  virtualPath: string;
}

export interface PlacementItemPreview {
  virtualPath: string;
  sizeBytes: number;
  targetAccountId?: string;
  rejected?: boolean;
  rejectReason?: string;
}

export interface FileProgressState {
  loaded: number;
  total: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
}

export interface ActionPortalClipboard {
  mode: 'cut' | 'copy';
  items: Array<{
    kind: 'file' | 'folder';
    id: string;
    name: string;
    virtualPath: string;
  }>;
}

export interface SelectedAccountGroup {
  accountId: string;
  accountName: string;
  fileIds: string[];
  totalBytes: number;
}

export interface SelectedShareBatch {
  batchFolderName: string;
  linksCount: number;
}

export type ShareTargetItem = {
  kind: 'file' | 'folder';
  id: string;
  name: string;
  virtualPath: string;
};

export type ShareExecuteResult = InferResponseType<typeof client.api.share.execute.$post, 200>;

export interface RenameTarget {
  kind: 'file' | 'folder' | 'pool';
  id: string;
  name: string;
}

export type MoveConflictContentMatch = 'identical' | 'different' | 'unverified';

export interface MoveConflictItem {
  sourceFileId: string;
  sourcePath: string;
  sourceName: string;
  sourceSizeBytes: number;
  sourceUpdatedAt: number;
  destPath: string;
  existingFileId?: string;
  existingSizeBytes?: number;
  existingUpdatedAt?: number;
  contentMatch?: MoveConflictContentMatch;
  canOverwrite?: boolean;
}

export type MoveConflictResolutionMode = 'skip' | 'keep_both' | 'overwrite';

export interface MoveFileItem {
  id: string;
  name: string;
  virtualPath?: string;
  sizeBytes: number;
}

export interface AccountSummary {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  usableLimitBytes: number;
  headroomBytes: number;
  tsubasaUsedBytes?: number;
  syncState: string;
  isDisabled?: boolean;
  transferStats?: AccountTransferStats;
  poolId?: number;
  canSwitchPool?: boolean;
}

export interface StorageOverview {
  totalAccounts: number;
  totalLimitBytes: number;
  totalUsedBytes: number;
  totalHeadroomBytes: number;
  totalTsubasaUsedBytes?: number;
  systemStorage?: {
    systemFilesCount: number;
    systemBytesTotal: number;
  };
  clusterTransfer?: {
    totalUploadedBytes24h: number;
    totalRemainingUploadBytes24h: number;
    dailyUploadLimitBytes: number;
    rateLimitedAccountsCount: number;
  };
  accounts: AccountSummary[];
}

export interface DiscoveredAccount {
  accountId: string;
  clientId: string;
  authorized: boolean;
  sourceFile: string;
  isDisabled?: boolean;
  mtimeMs?: number;
  poolId?: number;
  canSwitchPool?: boolean;
}

export type StoredShareLink = InferResponseType<typeof client.api.share.links.$get, 200>['links'][number];
export type ShareInspectResponse = InferResponseType<typeof client.api.share.inspect.$post, 200>;
