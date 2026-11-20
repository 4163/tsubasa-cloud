import { sqlite } from './index.js';
import {
  deriveUniquePoolSlug,
  isValidPoolSlug,
  SHARE_POOL_SLUG,
  SHARE_POOL_SORT_ORDER,
} from '../storage/poolSlug.js';

// init.ts owns runtime DDL and migrations; keep all table, column, and index definitions synchronized with src/server/db/schema.ts.
const CURRENT_SCHEMA_VERSION = 6;

export function initializeDatabase(): void {
  const currentVersion = sqlite.pragma('user_version', { simple: true }) as number;
  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return;
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pools (
      id INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      slug TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      drive_folder_name TEXT NOT NULL UNIQUE,
      is_share_pool INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      pool_id INTEGER NOT NULL DEFAULT 1 REFERENCES pools(id),
      quota_limit_bytes INTEGER NOT NULL DEFAULT 16106127360,
      quota_used_bytes INTEGER NOT NULL DEFAULT 0,
      sync_state TEXT NOT NULL DEFAULT 'idle',
      is_disabled INTEGER NOT NULL DEFAULT 0,
      last_sync_token TEXT,
      root_folder_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY NOT NULL,
      pool_id INTEGER NOT NULL DEFAULT 1 REFERENCES pools(id) ON DELETE CASCADE,
      virtual_path TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_folder_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY NOT NULL,
      pool_id INTEGER NOT NULL DEFAULT 1 REFERENCES pools(id) ON DELETE CASCADE,
      virtual_path TEXT NOT NULL,
      name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      hash TEXT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      drive_file_id TEXT NOT NULL,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      is_trashed INTEGER NOT NULL DEFAULT 0,
      trashed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS transfer_logs (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      transfer_type TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS share_links (
      id TEXT PRIMARY KEY NOT NULL,
      pool_id INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
      batch_folder_name TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      drive_folder_id TEXT NOT NULL,
      web_view_link TEXT NOT NULL,
      files_count INTEGER NOT NULL DEFAULT 0,
      bytes_allocated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS pending_drive_sync (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      drive_file_id TEXT NOT NULL,
      virtual_path TEXT NOT NULL,
      file_id TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_retry_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (account_id, drive_file_id)
    );

    CREATE TABLE IF NOT EXISTS drive_outbox (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      pool_id INTEGER,
      op_type TEXT NOT NULL,
      drive_file_id TEXT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS transfer_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      pool_id INTEGER REFERENCES pools(id) ON DELETE SET NULL,
      source_pool_id INTEGER REFERENCES pools(id) ON DELETE SET NULL,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      conflict_policy TEXT NOT NULL DEFAULT 'reject',
      mode TEXT,
      total_items INTEGER NOT NULL DEFAULT 0,
      completed_items INTEGER NOT NULL DEFAULT 0,
      failed_items INTEGER NOT NULL DEFAULT 0,
      skipped_items INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      transferred_bytes INTEGER NOT NULL DEFAULT 0,
      pause_reason TEXT,
      last_error TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS transfer_job_items (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL REFERENCES transfer_jobs(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      source_account_id TEXT,
      target_account_id TEXT,
      source_file_id TEXT,
      source_drive_file_id TEXT,
      source_parent_id TEXT,
      dest_drive_file_id TEXT,
      local_path TEXT,
      virtual_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      transferred_bytes INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER,
      expected_hash TEXT,
      verified_hash TEXT,
      drive_session_uri TEXT,
      transfer_mode TEXT,
      skip_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS transfer_job_shares (
      job_id TEXT NOT NULL REFERENCES transfer_jobs(id) ON DELETE CASCADE,
      source_folder_id TEXT NOT NULL,
      target_account_id TEXT NOT NULL,
      permission_id TEXT NOT NULL,
      source_account_id TEXT,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (job_id, source_folder_id, target_account_id, permission_id)
    );

    CREATE INDEX IF NOT EXISTS accounts_pool_idx ON accounts(pool_id);
    CREATE UNIQUE INDEX IF NOT EXISTS folders_pool_path_idx ON folders(pool_id, virtual_path);
    CREATE INDEX IF NOT EXISTS folders_pool_parent_idx ON folders(pool_id, parent_folder_id);
    CREATE UNIQUE INDEX IF NOT EXISTS files_pool_path_idx ON files(pool_id, virtual_path);
    CREATE INDEX IF NOT EXISTS files_pool_trashed_path_idx ON files(pool_id, is_trashed, virtual_path, account_id, size_bytes);
    CREATE INDEX IF NOT EXISTS files_pool_trashed_account_size_idx ON files(pool_id, is_trashed, account_id, size_bytes);
    CREATE INDEX IF NOT EXISTS files_pool_trashed_hash_idx ON files(pool_id, is_trashed, hash);
    CREATE INDEX IF NOT EXISTS files_account_idx ON files(account_id);
    CREATE INDEX IF NOT EXISTS files_account_drive_file_idx ON files(account_id, drive_file_id);
    CREATE INDEX IF NOT EXISTS files_account_pool_trashed_idx ON files(account_id, pool_id, is_trashed);
    CREATE INDEX IF NOT EXISTS files_folder_idx ON files(folder_id);
    CREATE INDEX IF NOT EXISTS files_path_idx ON files(virtual_path);
    CREATE INDEX IF NOT EXISTS transfer_account_type_ts_bytes_idx ON transfer_logs(account_id, transfer_type, timestamp, byte_count);
    CREATE INDEX IF NOT EXISTS transfer_ts_idx ON transfer_logs(timestamp);
    CREATE UNIQUE INDEX IF NOT EXISTS share_links_pool_batch_account_idx ON share_links(pool_id, batch_folder_name, account_id);
    CREATE INDEX IF NOT EXISTS share_links_pool_batch_idx ON share_links(pool_id, batch_folder_name);
    CREATE INDEX IF NOT EXISTS share_links_account_idx ON share_links(account_id);
    CREATE INDEX IF NOT EXISTS pending_drive_sync_retry_idx ON pending_drive_sync(account_id, next_retry_at);
    CREATE INDEX IF NOT EXISTS drive_outbox_status_retry_idx ON drive_outbox(status, next_retry_at, created_at);
    CREATE INDEX IF NOT EXISTS drive_outbox_account_status_idx ON drive_outbox(account_id, status);
    CREATE INDEX IF NOT EXISTS drive_outbox_account_drive_op_idx ON drive_outbox(account_id, drive_file_id, op_type, status);
    CREATE INDEX IF NOT EXISTS transfer_jobs_status_idx ON transfer_jobs(status, updated_at);
    CREATE INDEX IF NOT EXISTS transfer_jobs_kind_status_idx ON transfer_jobs(kind, status);
    CREATE INDEX IF NOT EXISTS transfer_jobs_pool_idx ON transfer_jobs(pool_id);
    CREATE INDEX IF NOT EXISTS transfer_jobs_account_idx ON transfer_jobs(account_id);
    CREATE INDEX IF NOT EXISTS transfer_job_items_job_status_idx ON transfer_job_items(job_id, status);
    CREATE INDEX IF NOT EXISTS transfer_job_items_job_path_idx ON transfer_job_items(job_id, virtual_path);
    CREATE INDEX IF NOT EXISTS transfer_job_shares_job_revoked_idx ON transfer_job_shares(job_id, revoked_at);

    DROP INDEX IF EXISTS folders_parent_idx;
    DROP INDEX IF EXISTS folders_path_idx;
    DROP INDEX IF EXISTS files_pool_trashed_idx;
    DROP INDEX IF EXISTS files_trashed_idx;
    DROP INDEX IF EXISTS transfer_account_ts_idx;
  `);

  const poolColumns = sqlite.pragma('table_info(pools)') as Array<{ name: string }>;
  const hasIsSharePool = poolColumns.some((col) => col.name === 'is_share_pool');
  const hasSlug = poolColumns.some((col) => col.name === 'slug');
  const hasSortOrder = poolColumns.some((col) => col.name === 'sort_order');

  if (!hasIsSharePool) {
    sqlite.exec('ALTER TABLE pools ADD COLUMN is_share_pool INTEGER NOT NULL DEFAULT 0;');
  }
  if (!hasSlug) {
    sqlite.exec('ALTER TABLE pools ADD COLUMN slug TEXT;');
  }
  if (!hasSortOrder) {
    sqlite.exec('ALTER TABLE pools ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;');
  }

  // Move any Share Pool created with a low sequential ID (< 1_000_000) to reserved ID 1_000_000
  // so regular pools keep consecutive numbering (Pool 2, Pool 3, ...) and match Drive cold recovery.
  const SHARE_POOL_RESERVE_ID = 1_000_000;
  const legacySharePool = sqlite
    .prepare('SELECT id FROM pools WHERE is_share_pool = 1 AND id < ? LIMIT 1')
    .get(SHARE_POOL_RESERVE_ID) as { id: number } | undefined;

  if (legacySharePool) {
    const reserveTaken = sqlite
      .prepare('SELECT 1 FROM pools WHERE id = ? LIMIT 1')
      .get(SHARE_POOL_RESERVE_ID);

    if (!reserveTaken) {
      const oldId = legacySharePool.id;
      const oldPrefix = `${oldId}:`;
      const newPrefix = `${SHARE_POOL_RESERVE_ID}:`;
      const fkWasEnabled = Boolean(sqlite.pragma('foreign_keys', { simple: true }));

      sqlite.pragma('foreign_keys = OFF');
      try {
        sqlite.transaction(() => {
          sqlite
            .prepare(
              `UPDATE folders
               SET id = ? || substr(id, ?),
                   pool_id = ?,
                   parent_folder_id = CASE
                     WHEN parent_folder_id IS NOT NULL AND parent_folder_id LIKE ?
                     THEN ? || substr(parent_folder_id, ?)
                     ELSE parent_folder_id
                   END
               WHERE pool_id = ? AND id LIKE ?`
            )
            .run(
              newPrefix,
              oldPrefix.length + 1,
              SHARE_POOL_RESERVE_ID,
              `${oldPrefix}%`,
              newPrefix,
              oldPrefix.length + 1,
              oldId,
              `${oldPrefix}%`
            );

          sqlite
            .prepare('UPDATE folders SET pool_id = ? WHERE pool_id = ?')
            .run(SHARE_POOL_RESERVE_ID, oldId);

          sqlite
            .prepare(
              `UPDATE files
               SET pool_id = ?,
                   folder_id = CASE
                     WHEN folder_id IS NOT NULL AND folder_id LIKE ?
                     THEN ? || substr(folder_id, ?)
                     ELSE folder_id
                   END
               WHERE pool_id = ?`
            )
            .run(
              SHARE_POOL_RESERVE_ID,
              `${oldPrefix}%`,
              newPrefix,
              oldPrefix.length + 1,
              oldId
            );

          sqlite
            .prepare('UPDATE accounts SET pool_id = ? WHERE pool_id = ?')
            .run(SHARE_POOL_RESERVE_ID, oldId);

          sqlite
            .prepare('UPDATE share_links SET pool_id = ? WHERE pool_id = ?')
            .run(SHARE_POOL_RESERVE_ID, oldId);

          sqlite
            .prepare('UPDATE drive_outbox SET pool_id = ? WHERE pool_id = ?')
            .run(SHARE_POOL_RESERVE_ID, oldId);

          sqlite
            .prepare('UPDATE transfer_jobs SET pool_id = ? WHERE pool_id = ?')
            .run(SHARE_POOL_RESERVE_ID, oldId);

          sqlite
            .prepare('UPDATE transfer_jobs SET source_pool_id = ? WHERE source_pool_id = ?')
            .run(SHARE_POOL_RESERVE_ID, oldId);

          sqlite
            .prepare('UPDATE pools SET id = ? WHERE id = ?')
            .run(SHARE_POOL_RESERVE_ID, oldId);
        }).immediate();
      } finally {
        sqlite.pragma(`foreign_keys = ${fkWasEnabled ? 'ON' : 'OFF'}`);
      }
    } else {
      console.warn(
        `[db/init] Legacy share pool ${legacySharePool.id} could not be migrated because reserved pool ID ${SHARE_POOL_RESERVE_ID} already exists.`
      );
    }
  }

  sqlite
    .prepare(
      `INSERT OR IGNORE INTO pools (id, name, slug, sort_order, drive_folder_name)
       VALUES (1, 'Pool 1', 'pool-1', 1, '_Tsubasa~ Pool 1')`
    )
    .run();

  // Backfill pool slugs and sort_order inside a single transaction before creating the unique slug index.
  sqlite.transaction(() => {
    const rows = sqlite
      .prepare(
        `SELECT id, name, slug, sort_order as sortOrder, is_share_pool as isSharePool
         FROM pools
         ORDER BY is_share_pool DESC, id ASC`
      )
      .all() as Array<{
      id: number;
      name: string;
      slug: string | null;
      sortOrder: number;
      isSharePool: number;
    }>;

    const usedSlugs = new Set<string>();
    const updatePoolStmt = sqlite.prepare('UPDATE pools SET slug = ?, sort_order = ? WHERE id = ?');

    for (const row of rows) {
      if (Boolean(row.isSharePool)) {
        const nextSlug = SHARE_POOL_SLUG;
        const nextSortOrder = SHARE_POOL_SORT_ORDER;
        usedSlugs.add(nextSlug);
        if (row.slug !== nextSlug || row.sortOrder !== nextSortOrder) {
          updatePoolStmt.run(nextSlug, nextSortOrder, row.id);
        }
        continue;
      }

      const existingSlug = row.slug?.trim();
      const nextSlug =
        existingSlug && isValidPoolSlug(existingSlug) && !usedSlugs.has(existingSlug)
          ? existingSlug
          : deriveUniquePoolSlug(row.name, usedSlugs, row.id);
      usedSlugs.add(nextSlug);

      const nextSortOrder =
        (!hasSortOrder || currentVersion < 6) && row.sortOrder === 0 ? row.id : row.sortOrder;

      if (row.slug !== nextSlug || row.sortOrder !== nextSortOrder) {
        updatePoolStmt.run(nextSlug, nextSortOrder, row.id);
      }
    }
  }).immediate();

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS pools_slug_idx ON pools(slug);
    CREATE INDEX IF NOT EXISTS pools_sort_order_idx ON pools(is_share_pool, sort_order, id);
  `);

  sqlite.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
}
