import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import fs from 'node:fs';
import path from 'node:path';

const dbDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = process.env.TSUBASA_DB_PATH || path.join(dbDir, 'tsubasa.db');

export const sqlite = new Database(dbPath);

// Performance pragmas for zero-latency local operations
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('cache_size = -64000'); // 64 MB
sqlite.pragma('temp_store = MEMORY');
sqlite.pragma('mmap_size = 268435456'); // 256 MB
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });
export type DatabaseInstance = typeof db;

export function renameAccountInDb(oldId: string, newId: string): void {
  if (!oldId || !newId || oldId.toLowerCase() === newId.toLowerCase()) {
    return;
  }

  sqlite.transaction(() => {
    sqlite.pragma('defer_foreign_keys = ON');

    const existingWithOld = sqlite.prepare('SELECT id, email FROM accounts WHERE id = ?').get(oldId) as
      | { id: string; email: string }
      | undefined;
    const existingWithNewId = sqlite.prepare('SELECT id, email FROM accounts WHERE id = ?').get(newId) as
      | { id: string; email: string }
      | undefined;
    const existingWithNewEmail = sqlite
      .prepare('SELECT id, email FROM accounts WHERE email = ? AND id != ?')
      .get(newId, oldId) as { id: string; email: string } | undefined;

    if (existingWithOld) {
      if (existingWithNewId || existingWithNewEmail) {
        sqlite.prepare('UPDATE files SET account_id = ? WHERE account_id = ?').run(newId, oldId);
        sqlite.prepare('UPDATE transfer_logs SET account_id = ? WHERE account_id = ?').run(newId, oldId);
        sqlite.prepare('DELETE FROM accounts WHERE id = ?').run(oldId);
      } else {
        sqlite.prepare('UPDATE accounts SET id = ?, email = ? WHERE id = ?').run(newId, newId, oldId);
        sqlite.prepare('UPDATE files SET account_id = ? WHERE account_id = ?').run(newId, oldId);
        sqlite.prepare('UPDATE transfer_logs SET account_id = ? WHERE account_id = ?').run(newId, oldId);
      }
    } else {
      sqlite.prepare('UPDATE files SET account_id = ? WHERE account_id = ?').run(newId, oldId);
      sqlite.prepare('UPDATE transfer_logs SET account_id = ? WHERE account_id = ?').run(newId, oldId);
    }
  })();
}


