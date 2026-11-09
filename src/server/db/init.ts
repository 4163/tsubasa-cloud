import { sqlite } from './index.js';

export function initializeDatabase(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
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
      virtual_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      parent_folder_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY NOT NULL,
      virtual_path TEXT NOT NULL UNIQUE,
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

    CREATE INDEX IF NOT EXISTS folders_parent_idx ON folders(parent_folder_id);
    CREATE INDEX IF NOT EXISTS folders_path_idx ON folders(virtual_path);
    CREATE INDEX IF NOT EXISTS files_account_idx ON files(account_id);
    CREATE INDEX IF NOT EXISTS files_folder_idx ON files(folder_id);
    CREATE INDEX IF NOT EXISTS files_path_idx ON files(virtual_path);
    CREATE INDEX IF NOT EXISTS files_trashed_idx ON files(is_trashed);
    CREATE INDEX IF NOT EXISTS transfer_account_ts_idx ON transfer_logs(account_id, timestamp);
    CREATE INDEX IF NOT EXISTS transfer_ts_idx ON transfer_logs(timestamp);
  `);

  try {
    sqlite.exec('ALTER TABLE accounts ADD COLUMN is_disabled INTEGER NOT NULL DEFAULT 0;');
  } catch {}
}

