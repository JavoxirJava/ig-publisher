import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const file = join(config.dataDir, 'ig.sqlite');
  const fresh = !existsSync(file);
  db = new DatabaseSync(file);
  if (fresh) chmodSync(file, 0o600); // holds the access token
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 10000;
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint  TEXT NOT NULL,
      type         TEXT NOT NULL,
      spec         TEXT NOT NULL,
      status       TEXT NOT NULL,
      container_id TEXT,
      children     TEXT,
      media_id     TEXT,
      permalink    TEXT,
      error        TEXT,
      queue_id     INTEGER,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS posts_fp ON posts(fingerprint);
    CREATE TABLE IF NOT EXISTS queue (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      spec       TEXT NOT NULL,
      run_at     TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      attempts   INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      post_id    INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS queue_due ON queue(status, run_at);
  `);
  return db;
}

export function kvGet<T>(key: string): T | undefined {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function kvSet(key: string, value: unknown): void {
  getDb()
    .prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function kvDelete(key: string): void {
  getDb().prepare('DELETE FROM kv WHERE key = ?').run(key);
}

export function closeDb(): void {
  db?.close();
  db = undefined;
}
