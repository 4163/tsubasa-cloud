import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

// Runtime DDL and migrations live in src/server/db/init.ts; keep these Drizzle definitions synchronized with init.ts.
export const pools = sqliteTable('pools', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  driveFolderName: text('drive_folder_name').notNull().unique(),
  isSharePool: integer('is_share_pool', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('pools_slug_idx').on(table.slug),
  index('pools_sort_order_idx').on(table.isSharePool, table.sortOrder, table.id),
]);

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  poolId: integer('pool_id').notNull().default(1).references(() => pools.id),
  quotaLimitBytes: integer('quota_limit_bytes').notNull().default(16106127360), // 15 GB default
  quotaUsedBytes: integer('quota_used_bytes').notNull().default(0),
  syncState: text('sync_state', { enum: ['idle', 'syncing', 'error'] }).notNull().default('idle'),
  isDisabled: integer('is_disabled', { mode: 'boolean' }).notNull().default(false),
  lastSyncToken: text('last_sync_token'),
  rootFolderId: text('root_folder_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('accounts_pool_idx').on(table.poolId),
]);

export const folders = sqliteTable('folders', {
  id: text('id').primaryKey(),
  poolId: integer('pool_id').notNull().default(1).references(() => pools.id, { onDelete: 'cascade' }),
  virtualPath: text('virtual_path').notNull(),
  name: text('name').notNull(),
  parentFolderId: text('parent_folder_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('folders_pool_path_idx').on(table.poolId, table.virtualPath),
  index('folders_pool_parent_idx').on(table.poolId, table.parentFolderId),
]);

export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  poolId: integer('pool_id').notNull().default(1).references(() => pools.id, { onDelete: 'cascade' }),
  virtualPath: text('virtual_path').notNull(),
  name: text('name').notNull(),
  sizeBytes: integer('size_bytes').notNull().default(0),
  mimeType: text('mime_type').notNull().default('application/octet-stream'),
  hash: text('hash'),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  driveFileId: text('drive_file_id').notNull(),
  folderId: text('folder_id').references(() => folders.id, { onDelete: 'set null' }),
  isTrashed: integer('is_trashed', { mode: 'boolean' }).notNull().default(false),
  trashedAt: integer('trashed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('files_pool_path_idx').on(table.poolId, table.virtualPath),
  index('files_pool_trashed_path_idx').on(table.poolId, table.isTrashed, table.virtualPath, table.accountId, table.sizeBytes),
  index('files_pool_trashed_account_size_idx').on(table.poolId, table.isTrashed, table.accountId, table.sizeBytes),
  index('files_pool_trashed_hash_idx').on(table.poolId, table.isTrashed, table.hash),
  index('files_account_idx').on(table.accountId),
  index('files_account_drive_file_idx').on(table.accountId, table.driveFileId),
  index('files_account_pool_trashed_idx').on(table.accountId, table.poolId, table.isTrashed),
  index('files_folder_idx').on(table.folderId),
  index('files_path_idx').on(table.virtualPath),
]);

export const transferLogs = sqliteTable('transfer_logs', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  transferType: text('transfer_type', { enum: ['upload', 'download'] }).notNull(),
  byteCount: integer('byte_count').notNull(),
  timestamp: integer('timestamp').notNull(), // epoch ms for high-precision 24-hour rolling aggregation
}, (table) => [
  index('transfer_account_type_ts_bytes_idx').on(table.accountId, table.transferType, table.timestamp, table.byteCount),
  index('transfer_ts_idx').on(table.timestamp),
]);

export const shareLinks = sqliteTable('share_links', {
  id: text('id').primaryKey(),
  poolId: integer('pool_id').notNull().references(() => pools.id, { onDelete: 'cascade' }),
  batchFolderName: text('batch_folder_name').notNull(),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  driveFolderId: text('drive_folder_id').notNull(),
  webViewLink: text('web_view_link').notNull(),
  filesCount: integer('files_count').notNull().default(0),
  bytesAllocated: integer('bytes_allocated').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('share_links_pool_batch_account_idx').on(table.poolId, table.batchFolderName, table.accountId),
  index('share_links_pool_batch_idx').on(table.poolId, table.batchFolderName),
  index('share_links_account_idx').on(table.accountId),
]);

export const pendingDriveSync = sqliteTable('pending_drive_sync', {
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  driveFileId: text('drive_file_id').notNull(),
  virtualPath: text('virtual_path').notNull(),
  fileId: text('file_id').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextRetryAt: integer('next_retry_at').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.driveFileId] }),
  index('pending_drive_sync_retry_idx').on(table.accountId, table.nextRetryAt),
]);

export const driveOutbox = sqliteTable('drive_outbox', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  poolId: integer('pool_id'),
  opType: text('op_type').notNull(),
  driveFileId: text('drive_file_id'),
  payloadJson: text('payload_json').notNull(),
  status: text('status', { enum: ['pending', 'processing', 'failed', 'dead'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextRetryAt: integer('next_retry_at').notNull().default(0),
  lastError: text('last_error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('drive_outbox_status_retry_idx').on(table.status, table.nextRetryAt, table.createdAt),
  index('drive_outbox_account_status_idx').on(table.accountId, table.status),
  index('drive_outbox_account_drive_op_idx').on(table.accountId, table.driveFileId, table.opType, table.status),
]);

export const transferJobs = sqliteTable('transfer_jobs', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['upload', 'import_drive', 'cross_pool_move', 'account_evacuate'] }).notNull(),
  status: text('status', { enum: ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'] }).notNull().default('pending'),
  poolId: integer('pool_id').references(() => pools.id, { onDelete: 'set null' }),
  sourcePoolId: integer('source_pool_id').references(() => pools.id, { onDelete: 'set null' }),
  accountId: text('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  conflictPolicy: text('conflict_policy', { enum: ['reject', 'replace', 'keep_both', 'skip', 'overwrite'] }).notNull().default('reject'),
  mode: text('mode'),
  totalItems: integer('total_items').notNull().default(0),
  completedItems: integer('completed_items').notNull().default(0),
  failedItems: integer('failed_items').notNull().default(0),
  skippedItems: integer('skipped_items').notNull().default(0),
  totalBytes: integer('total_bytes').notNull().default(0),
  transferredBytes: integer('transferred_bytes').notNull().default(0),
  pauseReason: text('pause_reason'),
  lastError: text('last_error'),
  metadataJson: text('metadata_json'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
}, (table) => [
  index('transfer_jobs_status_idx').on(table.status, table.updatedAt),
  index('transfer_jobs_kind_status_idx').on(table.kind, table.status),
  index('transfer_jobs_pool_idx').on(table.poolId),
  index('transfer_jobs_account_idx').on(table.accountId),
]);

export const transferJobItems = sqliteTable('transfer_job_items', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => transferJobs.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['pending', 'running', 'paused', 'completed', 'failed', 'skipped', 'cancelled'] }).notNull().default('pending'),
  sourceAccountId: text('source_account_id'),
  targetAccountId: text('target_account_id'),
  sourceFileId: text('source_file_id'),
  sourceDriveFileId: text('source_drive_file_id'),
  sourceParentId: text('source_parent_id'),
  destDriveFileId: text('dest_drive_file_id'),
  localPath: text('local_path'),
  virtualPath: text('virtual_path').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull().default('application/octet-stream'),
  sizeBytes: integer('size_bytes').notNull().default(0),
  transferredBytes: integer('transferred_bytes').notNull().default(0),
  mtimeMs: integer('mtime_ms'),
  expectedHash: text('expected_hash'),
  verifiedHash: text('verified_hash'),
  driveSessionUri: text('drive_session_uri'),
  transferMode: text('transfer_mode'),
  skipReason: text('skip_reason'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('transfer_job_items_job_status_idx').on(table.jobId, table.status),
  index('transfer_job_items_job_path_idx').on(table.jobId, table.virtualPath),
]);

export const transferJobShares = sqliteTable('transfer_job_shares', {
  jobId: text('job_id').notNull().references(() => transferJobs.id, { onDelete: 'cascade' }),
  sourceFolderId: text('source_folder_id').notNull(),
  targetAccountId: text('target_account_id').notNull(),
  permissionId: text('permission_id').notNull(),
  sourceAccountId: text('source_account_id'),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.sourceFolderId, table.targetAccountId, table.permissionId] }),
  index('transfer_job_shares_job_revoked_idx').on(table.jobId, table.revokedAt),
]);

export type Pool = typeof pools.$inferSelect;
export type NewPool = typeof pools.$inferInsert;

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;

export type FileRecord = typeof files.$inferSelect;
export type NewFileRecord = typeof files.$inferInsert;

export type TransferLog = typeof transferLogs.$inferSelect;
export type NewTransferLog = typeof transferLogs.$inferInsert;

export type ShareLink = typeof shareLinks.$inferSelect;
export type NewShareLink = typeof shareLinks.$inferInsert;

export type PendingDriveSync = typeof pendingDriveSync.$inferSelect;
export type NewPendingDriveSync = typeof pendingDriveSync.$inferInsert;

export type DriveOutboxRecord = typeof driveOutbox.$inferSelect;
export type NewDriveOutboxRecord = typeof driveOutbox.$inferInsert;

export type TransferJob = typeof transferJobs.$inferSelect;
export type NewTransferJob = typeof transferJobs.$inferInsert;

export type TransferJobItem = typeof transferJobItems.$inferSelect;
export type NewTransferJobItem = typeof transferJobItems.$inferInsert;

export type TransferJobShare = typeof transferJobShares.$inferSelect;
export type NewTransferJobShare = typeof transferJobShares.$inferInsert;


