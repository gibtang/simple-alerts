import { createHash, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { Config, ProjectConfig } from './config';
import { tx } from './db';
import type { DatabaseSync } from 'node:sqlite';
import { maskInlineSecrets, normalizeStack, redactDeep, sanitizeUrl, truncate } from './redact';

/**
 * Safe ingestion: bearer-key authentication, strict payload validation,
 * redaction before disk, persistent per-project rate limiting, and one
 * durable transaction capturing occurrence + group + first notification.
 */

export const REPORT_MAX_BYTES = 64 * 1024;
export const NAME_MAX = 300;
export const MESSAGE_MAX = 8000;
export const STACK_MAX = 32000;
export const URL_MAX = 2048;
export const METADATA_MAX = 16000;
export const INGEST_WINDOW_MS = 60_000;
export const INGEST_MAX_PER_WINDOW = 300;

export interface IngestReport {
  name: string;
  message: string;
  stack?: string;
  source: 'server' | 'browser';
  url?: string;
  metadata?: Record<string, unknown>;
}

const reportSchema = z.object({
  name: z.string().min(1).max(NAME_MAX),
  message: z.string().min(1).max(MESSAGE_MAX),
  stack: z.string().max(2 * STACK_MAX).optional(),
  source: z.enum(['server', 'browser']),
  url: z.string().max(2 * URL_MAX).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export class ReportValidationError extends Error {}

/** Strict shape validation; unknown keys are dropped, wrong shapes rejected. */
export function validateReport(input: unknown): IngestReport {
  const result = reportSchema.safeParse(input);
  if (!result.success) {
    throw new ReportValidationError('report payload does not match the required shape');
  }
  return result.data;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Resolve the configured project for an ingest request by comparing a SHA-256
 * digest of the presented bearer key against each configured key digest in
 * constant time. Returns null when the Authorization header is absent,
 * malformed, or matches no project.
 */
export function authenticateProject(config: Config, req: Request): ProjectConfig | null {
  const header = req.headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null) return null;
  const presented = match[1].trim();
  if (presented.length < 32 || presented.length > 128) return null;
  const digest = Buffer.from(sha256Hex(presented), 'hex');
  for (const project of config.projects) {
    if (timingSafeEqual(digest, Buffer.from(sha256Hex(project.key), 'hex'))) {
      return project;
    }
  }
  return null;
}

/**
 * Persistent fixed-window per-project ingest rate limit. Consumes one slot
 * and reports whether the request is allowed.
 */
export function consumeIngestSlot(db: DatabaseSync, projectId: string, now: number): boolean {
  const row = db
    .prepare('SELECT count, window_start FROM ingest_throttle WHERE project_id = ?')
    .get(projectId) as { count: number | bigint; window_start: number | bigint } | undefined;
  const expired = row === undefined || now - Number(row.window_start) >= INGEST_WINDOW_MS;
  if (expired) {
    db.prepare(
      `INSERT INTO ingest_throttle (project_id, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(project_id) DO UPDATE SET count = 1, window_start = excluded.window_start`,
    ).run(projectId, now);
    return true;
  }
  const next = Number(row.count) + 1;
  db.prepare('UPDATE ingest_throttle SET count = ? WHERE project_id = ?').run(next, projectId);
  return next <= INGEST_MAX_PER_WINDOW;
}

export interface RedactedReport {
  name: string;
  message: string;
  stack: string | null;
  stackKey: string;
  url: string | null;
  metadataJson: string;
}

/**
 * Redact and bound every persisted field; runs before any disk write.
 * Stack frames keep their line/column detail for display but lose URL
 * query strings and fragments, which are never retained.
 */
export function redactReport(report: IngestReport, botToken: string): RedactedReport {
  const name = truncate(maskInlineSecrets(report.name, [botToken]), NAME_MAX);
  const message = truncate(maskInlineSecrets(report.message, [botToken]), MESSAGE_MAX);
  let stack: string | null = null;
  if (report.stack !== undefined) {
    const masked = maskInlineSecrets(report.stack, [botToken]);
    stack = truncate(
      masked
        .split(/\r?\n/)
        .map((line) => line.replace(/[?#].*$/, ''))
        .join('\n'),
      STACK_MAX,
    );
  }
  const stackKey = stack === null ? '' : sha256Hex(normalizeStack(stack));
  const url = report.url === undefined ? null : truncate(maskInlineSecrets(sanitizeUrl(report.url), [botToken]), URL_MAX);
  const redactedMetadata = report.metadata === undefined ? {} : redactDeep(report.metadata, 0, [botToken]);
  const metadataJson = boundMetadataJson(redactedMetadata, METADATA_MAX);
  return { name, message, stack, stackKey, url, metadataJson };
}

function stringifyMetadata(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    return '{"redacted":"unserializable metadata"}';
  }
}

/** Cut a string without splitting a Unicode surrogate pair at the boundary. */
function surrogateSafeSlice(text: string, max: number): string {
  const cut = text.slice(0, max);
  const units = [...cut];
  const last = units[units.length - 1];
  if (
    cut.length === max &&
    typeof last === 'string' &&
    last.codePointAt(0)! >= 0xd800 &&
    last.codePointAt(0)! <= 0xdbff
  ) {
    return cut.slice(0, -1);
  }
  return cut;
}

/** Bound every string in the tree so re-serialization has a chance to fit. */
function shrinkStrings(value: unknown, max: number): unknown {
  if (typeof value === 'string') {
    return value.length <= max ? value : surrogateSafeSlice(value, max);
  }
  if (Array.isArray(value)) return value.map((item) => shrinkStrings(item, max));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = shrinkStrings(item, max);
    }
    return out;
  }
  return value;
}

/**
 * Serialize metadata to JSON that is always valid and always within bounds:
 * shrinking oversized strings is tried first, and metadata that still does
 * not fit is replaced by a small valid placeholder object. Truncating the
 * serialized text is never used: a mid-escape or mid-surrogate cut would
 * produce invalid JSON.
 */
function boundMetadataJson(value: unknown, max: number): string {
  let json = stringifyMetadata(value);
  if (json.length <= max) return json;
  json = stringifyMetadata(shrinkStrings(value, 200));
  if (json.length <= max) return json;
  return JSON.stringify({ redacted: 'metadata too large', bytes: json.length });
}

export interface IngestResult {
  id: number;
  groupId: number;
}

/**
 * Persist one occurrence inside a single durable transaction that also
 * updates the group and schedules the first/coalesced notification:
 *
 * - no delivery yet, or the latest one's effective retry origin
 *   (COALESCE(retry_started_at, created_at)) is outside the retry window
 *   (left for worker expiry): immediate pending delivery;
 * - latest delivery pending (not yet claimed, inside window): coalesce into it;
 * - latest delivery sending (claimed, in flight): never merged; a follow-up
 *   pending delivery is scheduled one repeat interval out;
 * - latest delivery sent within the repeat interval: a digest delivery is
 *   scheduled at the interval boundary so repeats are never lost, survives
 *   restarts, and sends even if no further events arrive.
 */
export function ingestReport(
  db: DatabaseSync,
  config: Config,
  project: ProjectConfig,
  report: IngestReport,
  now: number,
): IngestResult {
  const redacted = redactReport(report, config.telegram.botToken);
  const messageKey = sha256Hex(redacted.message);
  const repeatMs = config.alerts.repeatIntervalSeconds * 1000;
  const retryWindowMs = config.alerts.retryWindowHours * 3_600_000;

  return tx(db, () => {
    let groupId: number;
    const existing = db
      .prepare(
        `SELECT id FROM groups
         WHERE project_id = ? AND source = ? AND name = ? AND message_key = ? AND stack_key = ?`,
      )
      .get(project.id, report.source, redacted.name, messageKey, redacted.stackKey) as
      | { id: number | bigint }
      | undefined;
    if (existing !== undefined) {
      groupId = Number(existing.id);
      db.prepare('UPDATE groups SET count = count + 1, last_seen = ? WHERE id = ?').run(
        now,
        groupId,
      );
    } else {
      const inserted = db
        .prepare(
          `INSERT INTO groups (project_id, project_name, name, message, message_key, source, stack_key, count, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          project.id,
          project.name,
          redacted.name,
          redacted.message,
          messageKey,
          report.source,
          redacted.stackKey,
          now,
          now,
        );
      groupId = Number(inserted.lastInsertRowid);
    }

    const occurrence = db
      .prepare(
        'INSERT INTO occurrences (group_id, received_at, stack, url, metadata) VALUES (?, ?, ?, ?, ?)',
      )
      .run(groupId, now, redacted.stack, redacted.url, redacted.metadataJson);
    const occurrenceId = Number(occurrence.lastInsertRowid);

    const latest = db
      .prepare(
        `SELECT status, last_attempt_at,
                COALESCE(retry_started_at, created_at) AS effective_origin
         FROM deliveries WHERE group_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(groupId) as
      | { status: string; last_attempt_at: number | bigint | null; effective_origin: number | bigint }
      | undefined;

    let nextAttemptAt = now;
    let mergeInto: number | null = null;
    // Only coalesce into, or schedule around, a latest delivery whose
    // effective retry origin is still inside the retry window; an expired
    // latest stays untouched for worker expiry handling and the new
    // occurrence gets a fresh immediate delivery.
    if (latest !== undefined && Number(latest.effective_origin) + retryWindowMs > now) {
      if (latest.status === 'pending') {
        const open = db
          .prepare(
            "SELECT id FROM deliveries WHERE group_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
          )
          .get(groupId) as { id: number | bigint } | undefined;
        if (open !== undefined) {
          mergeInto = Number(open.id);
          db.prepare('UPDATE deliveries SET count = count + 1 WHERE id = ?').run(mergeInto);
        }
      } else if (latest.status === 'sending') {
        // Never merge into a claimed in-flight alert; schedule a follow-up.
        nextAttemptAt = now + repeatMs;
      } else if (latest.status === 'sent') {
        const lastSentAt = latest.last_attempt_at === null ? 0 : Number(latest.last_attempt_at);
        if (lastSentAt + repeatMs > now) {
          nextAttemptAt = lastSentAt + repeatMs;
        }
      }
    }

    if (mergeInto !== null) {
      return { id: occurrenceId, groupId };
    }

    const baseText = buildAlertBaseText(redacted, report.source);
    db.prepare(
      `INSERT INTO deliveries (group_id, project_id, project_name, kind, text, status, attempts, failures, count, created_at, next_attempt_at)
       VALUES (?, ?, ?, 'alert', ?, 'pending', 0, 0, 1, ?, ?)`,
    ).run(groupId, project.id, project.name, baseText, now, nextAttemptAt);

    return { id: occurrenceId, groupId };
  });
}

/** Immutable snapshot body for an alert delivery (dynamic lines added at send time). */
export function buildAlertBaseText(redacted: RedactedReport, source: string): string {
  const lines: string[] = [`⛔ ${redacted.name}`, redacted.message, '', `Source: ${source}`];
  if (redacted.url !== null) lines.push(`URL: ${redacted.url}`);
  if (redacted.stack !== null && redacted.stack.length > 0) {
    lines.push('', 'Stack:', truncate(redacted.stack, 1500));
  }
  return truncate(lines.join('\n'), 3200);
}
