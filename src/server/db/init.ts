import { sqlite } from './index.js';

export function initializeDatabase(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pools (
      id INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      drive_folder_name TEXT NOT NULL UNIQUE,
      is_share_pool INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    INSERT OR IGNORE INTO pools (id, name, drive_folder_name) VALUES (1, 'Pool 1', '_Tsubasa~ Pool 1');

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

    CREATE INDEX IF NOT EXISTS accounts_pool_idx ON accounts(pool_id);
    CREATE UNIQUE INDEX IF NOT EXISTS folders_pool_path_idx ON folders(pool_id, virtual_path);
    CREATE INDEX IF NOT EXISTS folders_pool_parent_idx ON folders(pool_id, parent_folder_id);
    CREATE INDEX IF NOT EXISTS folders_parent_idx ON folders(parent_folder_id);
    CREATE INDEX IF NOT EXISTS folders_path_idx ON folders(virtual_path);
    CREATE UNIQUE INDEX IF NOT EXISTS files_pool_path_idx ON files(pool_id, virtual_path);
    CREATE INDEX IF NOT EXISTS files_pool_trashed_idx ON files(pool_id, is_trashed);
    CREATE INDEX IF NOT EXISTS files_account_idx ON files(account_id);
    CREATE INDEX IF NOT EXISTS files_folder_idx ON files(folder_id);
    CREATE INDEX IF NOT EXISTS files_path_idx ON files(virtual_path);
    CREATE INDEX IF NOT EXISTS files_trashed_idx ON files(is_trashed);
    CREATE INDEX IF NOT EXISTS transfer_account_ts_idx ON transfer_logs(account_id, timestamp);
    CREATE INDEX IF NOT EXISTS transfer_ts_idx ON transfer_logs(timestamp);
    CREATE UNIQUE INDEX IF NOT EXISTS share_links_pool_batch_account_idx ON share_links(pool_id, batch_folder_name, account_id);
    CREATE INDEX IF NOT EXISTS share_links_pool_batch_idx ON share_links(pool_id, batch_folder_name);
  `);

  const poolColumns = sqlite.pragma('table_info(pools)') as Array<{ name: string }>;
  if (!poolColumns.some((col) => col.name === 'is_share_pool')) {
    sqlite.exec('ALTER TABLE pools ADD COLUMN is_share_pool INTEGER NOT NULL DEFAULT 0;');
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
            .prepare('UPDATE pools SET id = ? WHERE id = ?')
            .run(SHARE_POOL_RESERVE_ID, oldId);
        })();
      } finally {
        sqlite.pragma(`foreign_keys = ${fkWasEnabled ? 'ON' : 'OFF'}`);
      }
    }
  }
}


