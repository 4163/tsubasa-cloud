import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  quotaLimitBytes: integer('quota_limit_bytes').notNull().default(16106127360), // 15 GB default
  quotaUsedBytes: integer('quota_used_bytes').notNull().default(0),
  syncState: text('sync_state', { enum: ['idle', 'syncing', 'error'] }).notNull().default('idle'),
  lastSyncToken: text('last_sync_token'),
  rootFolderId: text('root_folder_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export const folders = sqliteTable('folders', {
  id: text('id').primaryKey(),
  virtualPath: text('virtual_path').notNull().unique(),
  name: text('name').notNull(),
  parentFolderId: text('parent_folder_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('folders_parent_idx').on(table.parentFolderId),
  index('folders_path_idx').on(table.virtualPath),
]);

export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  virtualPath: text('virtual_path').notNull().unique(),
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
  index('files_account_idx').on(table.accountId),
  index('files_folder_idx').on(table.folderId),
  index('files_path_idx').on(table.virtualPath),
  index('files_trashed_idx').on(table.isTrashed),
]);

export const transferLogs = sqliteTable('transfer_logs', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  transferType: text('transfer_type', { enum: ['upload', 'download'] }).notNull(),
  byteCount: integer('byte_count').notNull(),
  timestamp: integer('timestamp').notNull(), // epoch ms for high-precision 24-hour rolling aggregation
}, (table) => [
  index('transfer_account_ts_idx').on(table.accountId, table.timestamp),
  index('transfer_ts_idx').on(table.timestamp),
]);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;

export type FileRecord = typeof files.$inferSelect;
export type NewFileRecord = typeof files.$inferInsert;

export type TransferLog = typeof transferLogs.$inferSelect;
export type NewTransferLog = typeof transferLogs.$inferInsert;

