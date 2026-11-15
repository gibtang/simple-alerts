import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { getConfig } from './config';

/**
 * SQLite storage (node:sqlite DatabaseSync, WAL) shared by the Next.js
 * server process and the separate worker process. All statements use
 * bound parameters. Schema is created idempotently on open.
 */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  message_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('server','browser')),
  stack_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS groups_identity
  ON groups(project_id, source, name, message_key, stack_key);
CREATE INDEX IF NOT EXISTS groups_last_seen ON groups(last_seen DESC, id DESC);
CREATE INDEX IF NOT EXISTS groups_project ON groups(project_id);

CREATE TABLE IF NOT EXISTS occurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  received_at INTEGER NOT NULL,
  stack TEXT,
  url TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS occurrences_group
  ON occurrences(group_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS occurrences_received ON occurrences(received_at);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  retry_started_at INTEGER,
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  lease_expires_at INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS deliveries_group ON deliveries(group_id, id);
CREATE INDEX IF NOT EXISTS deliveries_project ON deliveries(project_id, id);
CREATE INDEX IF NOT EXISTS deliveries_created ON deliveries(created_at);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS delivery_attempts_delivery
  ON delivery_attempts(delivery_id, at);

CREATE TABLE IF NOT EXISTS heartbeat (
  id INTEGER PRIMARY KEY CHECK (id IN (1, 2)),
  at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO heartbeat (id, at) VALUES (1, 0);
INSERT OR IGNORE INTO heartbeat (id, at) VALUES (2, 0);

CREATE TABLE IF NOT EXISTS sessions (
  token_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_throttle (
  username TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  last_failure INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_throttle (
  project_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
`;

/** Open (creating schema) a SQLite database at an explicit path. */
export function openDb(databasePath: string): DatabaseSync {
  mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  return db;
}

let cachedDb: { path: string; db: DatabaseSync } | null = null;

/** Per-process singleton connection to the configured database. */
export function getDb(): DatabaseSync {
  const path = resolve(getConfig().server.databasePath);
  if (cachedDb !== null && cachedDb.path === path) return cachedDb.db;
  const db = openDb(path);
  cachedDb = { path, db };
  return db;
}

/** Run fn inside a BEGIN IMMEDIATE transaction; rolls back on throw. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // connection already unwound the transaction
    }
    throw error;
  }
}

/** Coerce a possible bigint SQLite integer to number. */
export function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}
