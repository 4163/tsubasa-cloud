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

