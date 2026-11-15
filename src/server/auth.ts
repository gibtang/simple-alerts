import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { getConfig, type Config } from './config';
import { getDb } from './db';

/**
 * Authentication: scrypt password hashing, HMAC-backed persistent sessions
 * (12h expiry, invalidated when the configured username or password hash
 * changes), a persistent per-username login throttle, and same-origin
 * checking for dashboard form mutations. No IP trust anywhere.
 */

export const SESSION_COOKIE_NAME = 'sa_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** scrypt:N:r:p:saltHex:hashHex — salt participates as its literal hex string (UTF-8 bytes). */
export function hashPassword(password: string): string {
  const N = 16384;
  const r = 8;
  const p = 1;
  const keylen = 64;
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, keylen, { N, r, p });
  return `scrypt:${N}:${r}:${p}:${salt}:${key.toString('hex')}`;
}

/**
 * Verify a stored scrypt hash. The format carries attacker-controlled N/r/p,
 * so unsupported shapes are rejected cheaply before any KDF work, and the
 * scrypt maxmem is capped to bound allocation.
 */
export function verifyPassword(password: string, hash: string): boolean {
  const match = /^scrypt:(\d+):(\d+):(\d+):([0-9a-f]+):([0-9a-f]+)$/i.exec(hash);
  if (match === null) return false;
  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  const saltHex = match[4];
  const expectedHex = match[5];
  if (saltHex.length < 16 || saltHex.length > 128) return false;
  if (expectedHex.length < 64 || expectedHex.length > 256) return false;
  if (saltHex.length % 2 !== 0 || expectedHex.length % 2 !== 0) return false;
  // N must be a power of two within sane bounds; keep 128*N*r under 256 MiB.
  if (r < 1 || r > 64 || p < 1 || p > 16) return false;
  if (N < 16384 || N > 2 ** 22 || (N & (N - 1)) !== 0) return false;
  if (128 * N * r > 256 * 1024 * 1024) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  // Salt is used as its literal string, matching scripts/password.mjs.
  let actual: Buffer;
  try {
    actual = scryptSync(password, saltHex, expected.length, {
      N,
      r,
      p,
      maxmem: 2 * 128 * N * r,
    });
  } catch {
    // Parameter shapes that pass the cheap checks can still exceed maxmem.
    return false;
  }
  return timingSafeEqual(actual, expected);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time string equality via SHA-256 digests. */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256Hex(a), 'hex'), Buffer.from(sha256Hex(b), 'hex'));
}

/** Fingerprint of dashboard credentials; sessions die when this changes. */
export function credentialFingerprint(config: Config): string {
  return sha256Hex(`${config.auth.username}\n${config.auth.passwordHash}`);
}

function signTokenId(sessionSecret: string, tokenId: string): string {
  return createHmac('sha256', sessionSecret).update(tokenId, 'utf8').digest('hex');
}

export interface CreatedSession {
  tokenId: string;
  cookieValue: string;
  expiresAt: number;
}

/** Persist a session row and return the signed cookie value. */
export function createSession(
  db: DatabaseSync,
  config: Config,
  username: string,
  now: number,
): CreatedSession {
  const tokenId = randomBytes(32).toString('hex');
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare(
    'INSERT INTO sessions (token_id, username, fingerprint, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(tokenId, username, credentialFingerprint(config), now, expiresAt);
  return { tokenId, cookieValue: `${tokenId}.${signTokenId(config.server.sessionSecret, tokenId)}`, expiresAt };
}

/** Verify a cookie value against HMAC, DB row, expiry and current credentials. */
export function resolveSession(
  db: DatabaseSync,
  config: Config,
  cookieValue: string | undefined,
  now: number,
): { username: string } | null {
  if (cookieValue === undefined) return null;
  const dot = cookieValue.indexOf('.');
  if (dot <= 0) return null;
  const tokenId = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/i.test(tokenId) || !/^[0-9a-f]{64}$/i.test(signature)) return null;
  const expected = signTokenId(config.server.sessionSecret, tokenId);
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return null;

  const row = db
    .prepare('SELECT username, fingerprint, expires_at FROM sessions WHERE token_id = ?')
    .get(tokenId) as { username: string; fingerprint: string; expires_at: number | bigint } | undefined;
  if (row === undefined) return null;
  if (Number(row.expires_at) <= now) {
    db.prepare('DELETE FROM sessions WHERE token_id = ?').run(tokenId);
    return null;
  }
  if (row.username !== config.auth.username) return null;
  if (row.fingerprint !== credentialFingerprint(config)) return null;
  return { username: row.username };
}

/** Destroy a session by signed cookie value. */
export function destroySession(
  db: DatabaseSync,
  config: Config,
  cookieValue: string | undefined,
): void {
  if (cookieValue === undefined) return;
  const dot = cookieValue.indexOf('.');
  if (dot <= 0) return;
  const tokenId = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/i.test(tokenId) || !/^[0-9a-f]{64}$/i.test(signature)) return;
  const expected = signTokenId(config.server.sessionSecret, tokenId);
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
    return;
  }
  db.prepare('DELETE FROM sessions WHERE token_id = ?').run(tokenId);
}

export interface LoginThrottleStatus {
  allowed: boolean;
}

/** Persistent per-username failure window; no forwarded-IP trust. */
export function loginThrottleStatus(
  db: DatabaseSync,
  username: string,
  now: number,
): LoginThrottleStatus {
  const row = db
    .prepare('SELECT failures, window_start FROM login_throttle WHERE username = ?')
    .get(username) as { failures: number | bigint; window_start: number | bigint } | undefined;
  if (row === undefined) return { allowed: true };
  if (now - Number(row.window_start) >= LOGIN_WINDOW_MS) return { allowed: true };
  return { allowed: Number(row.failures) < LOGIN_MAX_FAILURES };
}

export function recordLoginFailure(
  db: DatabaseSync,
  username: string,
  now: number,
): void {
  const row = db
    .prepare('SELECT failures, window_start FROM login_throttle WHERE username = ?')
    .get(username) as { failures: number | bigint; window_start: number | bigint } | undefined;
  const expired = row === undefined || now - Number(row.window_start) >= LOGIN_WINDOW_MS;
  if (expired) {
    db.prepare(
      `INSERT INTO login_throttle (username, failures, window_start, last_failure) VALUES (?, 1, ?, ?)
       ON CONFLICT(username) DO UPDATE SET failures = 1, window_start = excluded.window_start, last_failure = excluded.last_failure`,
    ).run(username, now, now);
  } else {
    db.prepare(
      'UPDATE login_throttle SET failures = failures + 1, last_failure = ? WHERE username = ?',
    ).run(now, username);
  }
}

export function clearLoginFailures(db: DatabaseSync, username: string): void {
  db.prepare('DELETE FROM login_throttle WHERE username = ?').run(username);
}

/** Credential field caps enforced before any KDF work. */
export const LOGIN_USERNAME_MAX = 200;
export const LOGIN_PASSWORD_MAX = 1024;

export type LoginAttemptResult = 'rate' | 'invalid' | 'success';

export interface LoginCredentials {
  username: string;
  password: string;
}

/**
 * Pure dashboard login decision for one attempt. Every failure — including
 * malformed or oversized credentials and wrong usernames — is recorded
 * against the CONFIGURED operator username, never an attacker-named row, so
 * rotating the submitted username cannot open a fresh 5-per-15-minute budget.
 * The password KDF runs only when the username matches.
 */
export function authenticateLogin(
  db: DatabaseSync,
  config: Config,
  credentials: LoginCredentials,
  now: number,
): LoginAttemptResult {
  const operator = config.auth.username;
  if (!loginThrottleStatus(db, operator, now).allowed) return 'rate';

  const oversized =
    credentials.username.length > LOGIN_USERNAME_MAX || credentials.password.length > LOGIN_PASSWORD_MAX;
  const usernameOk =
    !oversized &&
    credentials.username.length > 0 &&
    constantTimeEqual(credentials.username, operator);
  const passwordOk =
    !oversized &&
    usernameOk &&
    credentials.password.length > 0 &&
    verifyPassword(credentials.password, config.auth.passwordHash);

  if (usernameOk && passwordOk) {
    clearLoginFailures(db, operator);
    return 'success';
  }
  recordLoginFailure(db, operator, now);
  return 'invalid';
}

/** Delete throttle rows whose window can no longer deny anyone. */
export function cleanupLoginThrottles(db: DatabaseSync, now: number): void {
  db.prepare('DELETE FROM login_throttle WHERE window_start < ?').run(now - LOGIN_WINDOW_MS);
}

/** Same-origin check for authenticated dashboard form mutations. */
export function originAllowed(req: Request, config: Config): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return false;
  try {
    return new URL(origin).origin === new URL(config.server.baseUrl).origin;
  } catch {
    return false;
  }
}

/** Cookie attributes; Secure everywhere except plain-HTTP localhost dev. */
export function sessionCookieOptions(
  config: Config,
  expiresAt: number,
): {
  httpOnly: true;
  sameSite: 'strict';
  secure: boolean;
  path: '/';
  expires: Date;
} {
  const base = new URL(config.server.baseUrl);
  const secure = base.protocol === 'https:';
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    expires: new Date(expiresAt),
  };
}

/** Current session from the request cookie, or null. */
export async function getSession(): Promise<{ username: string } | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE_NAME)?.value;
  if (raw === undefined) return null;
  return resolveSession(getDb(), getConfig(), raw, Date.now());
}

/** Current session or redirect to /login. */
export async function requireSession(): Promise<{ username: string }> {
  const session = await getSession();
  if (session === null) redirect('/login');
  return session;
}
