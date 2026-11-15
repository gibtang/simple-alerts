import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { Config } from './config';
import { num, tx } from './db';
import { cleanupLoginThrottles } from './auth';
import { sendTelegramMessage, type TelegramOutcome } from './telegram';
import { truncate } from './redact';

/**
 * Delivery queue owned by the worker process, with processor functions
 * exported for injected-fetch/injected-clock smoke tests.
 *
 * Invariants:
 * - Claiming uses a durable lease; stale leases are recovered on startup and
 *   every tick, so a crashed worker never strands a delivery.
 * - The 24h retry window is a hard cap: expired deliveries fail before any
 *   send attempt and can never be scheduled past the window.
 * - Telegram retry_after is honored; 5xx/network failures retry with capped
 *   exponential backoff; 4xx fails permanently.
 * - Every attempt is recorded (time, status, bounded redacted error).
 */

export const LEASE_MS = 90_000;
export const HEARTBEAT_STALE_MS = 90_000;
export const MAINTENANCE_INTERVAL_MS = 60_000;
export const RETRY_BACKOFF_BASE_MS = 30_000;
export const RETRY_BACKOFF_MAX_MS = 60 * 60 * 1000;
export const CLAIM_BATCH_LIMIT = 25;

export interface DeliveryRow {
  id: number;
  groupId: number | null;
  projectId: string;
  projectName: string;
  kind: string;
  text: string;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  attempts: number;
  failures: number;
  count: number;
  createdAt: number;
  retryStartedAt: number;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
}

interface DeliveryRowRaw extends Record<string, SQLOutputValue> {
  id: number | bigint;
  group_id: number | bigint | null;
  project_id: string;
  project_name: string;
  kind: string;
  text: string;
  status: string;
  attempts: number | bigint;
  failures: number | bigint;
  count: number | bigint;
  created_at: number | bigint;
  retry_started_at: number | bigint | null;
  next_attempt_at: number | bigint | null;
  last_attempt_at: number | bigint | null;
  lease_expires_at: number | bigint | null;
  last_error: string | null;
}

function mapDeliveryRow(raw: DeliveryRowRaw): DeliveryRow {
  return {
    id: num(raw.id),
    groupId: raw.group_id === null ? null : num(raw.group_id),
    projectId: raw.project_id,
    projectName: raw.project_name,
    kind: raw.kind,
    text: raw.text,
    status: raw.status as DeliveryRow['status'],
    attempts: num(raw.attempts),
    failures: num(raw.failures),
    count: num(raw.count),
    createdAt: num(raw.created_at),
    retryStartedAt: num(raw.retry_started_at ?? raw.created_at),
    nextAttemptAt: raw.next_attempt_at === null ? null : num(raw.next_attempt_at),
    lastAttemptAt: raw.last_attempt_at === null ? null : num(raw.last_attempt_at),
    leaseExpiresAt: raw.lease_expires_at === null ? null : num(raw.lease_expires_at),
    lastError: raw.last_error,
  };
}

const DELIVERY_COLUMNS =
  'id, group_id, project_id, project_name, kind, text, status, attempts, failures, count, created_at, retry_started_at, next_attempt_at, last_attempt_at, lease_expires_at, last_error';

export interface WorkerDeps {
  db: DatabaseSync;
  config: Config;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxPerTick?: number;
}

export function readHeartbeat(db: DatabaseSync): number | null {
  const row = db.prepare('SELECT at FROM heartbeat WHERE id = 1').get() as
    | { at: number | bigint }
    | undefined;
  if (row === undefined || Number(row.at) === 0) return null;
  return Number(row.at);
}

export function beat(db: DatabaseSync, now: number): void {
  db.prepare('UPDATE heartbeat SET at = ? WHERE id = 1').run(now);
}

function readMarker(db: DatabaseSync, id: number): number {
  const row = db.prepare('SELECT at FROM heartbeat WHERE id = ?').get(id) as
    | { at: number | bigint }
    | undefined;
  return row === undefined ? 0 : Number(row.at);
}

/** Wall-clock marker for the last retention/cleanup sweep (worker only). */
export function readLastMaintenance(db: DatabaseSync): number {
  return readMarker(db, 2);
}

export function markMaintenance(db: DatabaseSync, now: number): void {
  db.prepare('UPDATE heartbeat SET at = ? WHERE id = 2').run(now);
}

/** Enqueue a test delivery for a configured project; returns the delivery id. */
export function enqueueTestDelivery(
  db: DatabaseSync,
  config: Config,
  projectId: string,
  now: number,
): number {
  const project = config.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) throw new Error(`unknown project: ${projectId}`);
  const text = [
    `✅ Simple Alerts test notification`,
    `Project ${project.name}: the Telegram delivery pipeline works.`,
  ].join('\n');
  const inserted = db
    .prepare(
      `INSERT INTO deliveries (group_id, project_id, project_name, kind, text, status, attempts, failures, count, created_at, next_attempt_at)
       VALUES (NULL, ?, ?, 'test', ?, 'pending', 0, 0, 0, ?, ?)`,
    )
    .run(project.id, project.name, text, now, now);
  return num(inserted.lastInsertRowid);
}

export type RetryResult = 'retried' | 'not-found' | 'not-failed';

/** Manual retry: FAILED deliveries only; resets the 24h window and backoff. */
export function retryDelivery(db: DatabaseSync, deliveryId: number, now: number): RetryResult {
  const row = db.prepare('SELECT status FROM deliveries WHERE id = ?').get(deliveryId) as
    | { status: string }
    | undefined;
  if (row === undefined) return 'not-found';
  if (row.status !== 'failed') return 'not-failed';
  const updated = db
    .prepare(
      `UPDATE deliveries
       SET status = 'pending', next_attempt_at = ?, retry_started_at = ?, failures = 0, lease_expires_at = NULL, last_error = NULL
       WHERE id = ? AND status = 'failed'`,
    )
    .run(now, now, deliveryId);
  return num(updated.changes) === 1 ? 'retried' : 'not-failed';
}

/** Requeue deliveries whose claim lease expired (crashed worker recovery). */
export function recoverStaleLeases(db: DatabaseSync, now: number): number {
  const updated = db
    .prepare(
      `UPDATE deliveries
       SET status = 'pending', next_attempt_at = ?, lease_expires_at = NULL
       WHERE status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    )
    .run(now, now);
  return num(updated.changes);
}

/** Hard-fail deliveries whose 24h retry window elapsed without success. */
export function expireStaleDeliveries(db: DatabaseSync, config: Config, now: number): number {
  const windowMs = config.alerts.retryWindowHours * 60 * 60 * 1000;
  const updated = db
    .prepare(
      `UPDATE deliveries
       SET status = 'failed', last_error = 'expired: retry window elapsed', next_attempt_at = NULL, lease_expires_at = NULL
       WHERE status IN ('pending', 'sending') AND COALESCE(retry_started_at, created_at) + ? <= ?`,
    )
    .run(windowMs, now);
  return num(updated.changes);
}

/**
 * Atomically claim the next due delivery inside BEGIN IMMEDIATE, moving it to
 * 'sending' with a lease. Returns the full row or null when nothing is due.
 */
export function claimNextDelivery(
  db: DatabaseSync,
  config: Config,
  now: number,
): DeliveryRow | null {
  const windowMs = config.alerts.retryWindowHours * 60 * 60 * 1000;
  return tx(db, () => {
    const candidate = db
      .prepare(
        `SELECT id FROM deliveries
         WHERE status = 'pending'
           AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
           AND COALESCE(retry_started_at, created_at) + ? > ?
         ORDER BY next_attempt_at ASC, id ASC LIMIT 1`,
      )
      .get(now, windowMs, now) as { id: number | bigint } | undefined;
    if (candidate === undefined) return null;
    const claimed = db
      .prepare(
        `UPDATE deliveries SET status = 'sending', lease_expires_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now + LEASE_MS, num(candidate.id));
    if (num(claimed.changes) !== 1) return null;
    const row = db
      .prepare(`SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE id = ?`)
      .get(num(candidate.id)) as DeliveryRowRaw;
    return mapDeliveryRow(row);
  });
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** Compose the final Telegram text from the delivery snapshot and live group. */
export function composeDeliveryText(db: DatabaseSync, row: DeliveryRow): string {
  const group =
    row.groupId === null
      ? undefined
      : (db
          .prepare('SELECT first_seen, last_seen FROM groups WHERE id = ?')
          .get(row.groupId) as { first_seen: number | bigint; last_seen: number | bigint } | undefined);
  const lines: string[] = [row.text, '', `Project: ${row.projectName}`];
  if (row.kind === 'alert') {
    lines.push(`Occurrences: ${row.count}`);
    if (group !== undefined) {
      const first = iso(num(group.first_seen));
      const last = iso(num(group.last_seen));
      if (first !== null) lines.push(`First seen: ${first}`);
      if (last !== null) lines.push(`Last seen: ${last}`);
    }
  }
  return truncate(lines.join('\n'), 3800);
}

function backoffDelayMs(failures: number): number {
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), RETRY_BACKOFF_MAX_MS);
}

function recordAttempt(
  db: DatabaseSync,
  deliveryId: number,
  now: number,
  status: string,
  error: string | null,
): void {
  db.prepare(
    'INSERT INTO delivery_attempts (delivery_id, at, status, error) VALUES (?, ?, ?, ?)',
  ).run(deliveryId, now, status, error);
}

/**
 * Send one claimed delivery and persist the classified outcome:
 * sent, scheduled retry (rate/retryable within the 24h window), or permanent
 * failure. The attempt count aggregates every send attempt.
 */
export async function processDelivery(row: DeliveryRow, deps: WorkerDeps): Promise<void> {
  const { db, config } = deps;
  const now = deps.now ?? Date.now;
  const project = config.projects.find((candidate) => candidate.id === row.projectId);
  if (project === undefined) {
    failDelivery(db, row, now(), 'failed: project removed from configuration');
    return;
  }

  const outcome = await sendTelegramMessage({
    botToken: config.telegram.botToken,
    chatId: project.chatId,
    text: composeDeliveryText(db, row),
    fetchImpl: deps.fetchImpl ?? fetch,
  });
  const at = now();
  tx(db, () => {
    if (outcome.class === 'sent') {
      db.prepare(
        `UPDATE deliveries
         SET status = 'sent', attempts = attempts + 1, failures = 0, last_attempt_at = ?,
             next_attempt_at = NULL, lease_expires_at = NULL, last_error = NULL
         WHERE id = ?`,
      ).run(at, row.id);
      recordAttempt(db, row.id, at, 'sent', null);
      return;
    }

    const failures = row.failures + 1;
    const delay = outcome.class === 'rate' ? outcome.retryAfterMs : backoffDelayMs(failures);
    const nextAttemptAt = at + delay;
    const expired = nextAttemptAt >= row.retryStartedAt + config.alerts.retryWindowHours * 3_600_000;
    const terminal = outcome.class === 'permanent' || expired;
    const error = expired && outcome.class !== 'permanent'
      ? 'expired: retry window elapsed'
      : outcome.error;
    db.prepare(
      `UPDATE deliveries
       SET status = ?, attempts = attempts + 1, failures = ?, last_attempt_at = ?,
           next_attempt_at = ?, lease_expires_at = NULL, last_error = ?
       WHERE id = ?`,
    ).run(terminal ? 'failed' : 'pending', failures, at, terminal ? null : nextAttemptAt, error, row.id);
    recordAttempt(db, row.id, at, outcome.class === 'rate' ? 'rate_limited' : 'failed', outcome.error);
  });
}

function failDelivery(db: DatabaseSync, row: DeliveryRow, now: number, error: string): void {
  tx(db, () => {
    db.prepare(
      `UPDATE deliveries
       SET status = 'failed', last_error = ?, next_attempt_at = NULL, lease_expires_at = NULL, last_attempt_at = ?
       WHERE id = ?`,
    ).run(error, now, row.id);
    recordAttempt(db, row.id, now, 'failed', error);
  });
}

/**
 * Process every delivery currently due (bounded per tick), recovering stale
 * leases and expiring out-of-window deliveries first. Returns the number of
 * deliveries processed. Suitable for injected-fetch/clock smoke tests.
 */
export async function processDueDeliveries(deps: WorkerDeps): Promise<number> {
  const { db, config } = deps;
  const now = deps.now ?? Date.now;
  const max = deps.maxPerTick ?? CLAIM_BATCH_LIMIT;
  recoverStaleLeases(db, now());
  expireStaleDeliveries(db, config, now());
  let processed = 0;
  beat(db, now());
  while (processed < max) {
    const row = claimNextDelivery(db, config, now());
    if (row === null) break;
    await processDelivery(row, deps);
    beat(db, now());
    processed++;
  }
  return processed;
}

/**
 * Retention and cleanup: 30d (configurable) data retention for groups,
 * occurrences, deliveries and attempt records; expired sessions and login
 * throttle windows. Runs on the worker; the dashboard never deletes.
 */
export function runMaintenance(db: DatabaseSync, config: Config, now: number): void {
  const retentionCutoff = now - config.retentionDays * 24 * 60 * 60 * 1000;
  tx(db, () => {
    db.prepare('DELETE FROM occurrences WHERE received_at < ?').run(retentionCutoff);
    db.prepare('DELETE FROM delivery_attempts WHERE at < ?').run(retentionCutoff);
    db.prepare('DELETE FROM deliveries WHERE created_at < ?').run(retentionCutoff);
    db.prepare('DELETE FROM groups WHERE last_seen < ?').run(retentionCutoff);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    cleanupLoginThrottles(db, now);
  });
}
