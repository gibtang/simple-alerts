import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DatabaseSync } from 'node:sqlite';

import {
  authenticateLogin,
  clearLoginFailures,
  constantTimeEqual,
  createSession,
  credentialFingerprint,
  destroySession,
  hashPassword,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  loginThrottleStatus,
  originAllowed,
  recordLoginFailure,
  resolveSession,
  verifyPassword,
} from './auth';
import { createTestDb, makeTestConfig, TEST_BOT_TOKEN } from './test-support';

function sessionCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number };
  return row.c;
}

test('password hashes round-trip and reject wrong passwords and malformed hashes', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', hash), true);
  assert.equal(verifyPassword('wrong password', hash), false);
  assert.equal(verifyPassword('correct horse battery staple', 'not-a-hash'), false);
  assert.equal(verifyPassword('correct horse battery staple', 'scrypt:1:1:1:zz:zz'), false);
  assert.equal(verifyPassword('', hash), false);
});

test('verifyPassword rejects attacker-controlled scrypt shapes cheaply', () => {
  const salt = 'a'.repeat(32);
  const key = 'b'.repeat(128);
  // N not a power of two, N too small / too large, r/p out of bounds.
  assert.equal(verifyPassword('x', `scrypt:1000:8:1:${salt}:${key}`), false);
  assert.equal(verifyPassword('x', `scrypt:16383:8:1:${salt}:${key}`), false);
  assert.equal(verifyPassword('x', `scrypt:8388608:8:1:${salt}:${key}`), false);
  assert.equal(verifyPassword('x', `scrypt:16384:0:1:${salt}:${key}`), false);
  assert.equal(verifyPassword('x', `scrypt:16384:8:99:${salt}:${key}`), false);
  // Salt/hash hex too short or too long.
  assert.equal(verifyPassword('x', `scrypt:16384:8:1:abc:${key}`), false);
  assert.equal(verifyPassword('x', `scrypt:16384:8:1:${salt}:abc`), false);
});

test('login throttle denies after the failure budget and resets on success or window expiry', () => {
  const testDb = createTestDb();
  try {
    const db = testDb.db;
    const t0 = 1_000_000;
    assert.equal(loginThrottleStatus(db, 'ops', t0).allowed, true);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      recordLoginFailure(db, 'ops', t0 + i);
    }
    assert.equal(loginThrottleStatus(db, 'ops', t0 + 10).allowed, false);
    // Other usernames unaffected.
    assert.equal(loginThrottleStatus(db, 'nobody', t0 + 10).allowed, true);
    // Window expiry re-opens the gate.
    assert.equal(loginThrottleStatus(db, 'ops', t0 + LOGIN_WINDOW_MS + 1).allowed, true);
    // Clearing (successful login) resets immediately.
    recordLoginFailure(db, 'ops', t0);
    recordLoginFailure(db, 'ops', t0 + 1);
    recordLoginFailure(db, 'ops', t0 + 2);
    clearLoginFailures(db, 'ops');
    assert.equal(loginThrottleStatus(db, 'ops', t0 + 3).allowed, true);
  } finally {
    testDb.cleanup();
  }
});

test('sessions verify, expire, bind to current credentials, and destroy cleanly', () => {
  const testDb = createTestDb();
  try {
    const db = testDb.db;
    const config = makeTestConfig({ databasePath: testDb.dir });
    const t0 = 5_000_000;
    const session = createSession(db, config, config.auth.username, t0);
    assert.equal(resolveSession(db, config, session.cookieValue, t0 + 1)?.username, 'ops');
    assert.equal(sessionCount(db), 1);

    // Tampered signature, malformed values, unknown token.
    assert.equal(resolveSession(db, config, `${session.cookieValue}ff`, t0 + 1), null);
    assert.equal(resolveSession(db, config, 'garbage', t0 + 1), null);
    assert.equal(resolveSession(db, config, undefined, t0 + 1), null);
    assert.equal(
      resolveSession(db, config, `deadbeef.${'0'.repeat(64)}`, t0 + 1),
      null,
    );

    // Wrong session secret rejects (config from another secret).
    const otherSecret = makeTestConfig({ server: { sessionSecret: 'z'.repeat(48) } });
    assert.equal(resolveSession(db, otherSecret, session.cookieValue, t0 + 1), null);

    // Expiry removes the row and reports null.
    assert.equal(resolveSession(db, config, session.cookieValue, t0 + 12 * 60 * 60 * 1000), null);
    assert.equal(sessionCount(db), 0);

    // Changing the configured username or password hash invalidates existing sessions.
    const fresh = createSession(db, config, config.auth.username, t0);
    const renamed = makeTestConfig({ auth: { username: 'newops' }, databasePath: testDb.dir });
    assert.equal(resolveSession(db, renamed, fresh.cookieValue, t0 + 1), null);
    const rotated = makeTestConfig({ auth: { passwordHash: hashPassword('rotated secret') }, databasePath: testDb.dir });
    assert.equal(resolveSession(db, rotated, fresh.cookieValue, t0 + 1), null);
    assert.notEqual(
      credentialFingerprint(config),
      credentialFingerprint(rotated),
    );

    // Explicit destroy.
    const doomed = createSession(db, config, config.auth.username, t0);
    assert.equal(resolveSession(db, config, doomed.cookieValue, t0 + 1)?.username, 'ops');
    destroySession(db, config, doomed.cookieValue);
    assert.equal(resolveSession(db, config, doomed.cookieValue, t0 + 1), null);
  } finally {
    testDb.cleanup();
  }
});

test('origin check accepts only the configured base URL origin and rejects absent origins', () => {
  const config = makeTestConfig({ server: { baseUrl: 'https://alerts.example.com' } });
  const req = (origin: string | null): Request =>
    new Request('https://alerts.example.com/api/auth/logout', {
      method: 'POST',
      headers: origin === null ? {} : { origin },
    });
  assert.equal(originAllowed(req('https://alerts.example.com'), config), true);
  assert.equal(originAllowed(req('https://evil.example.net'), config), false);
  assert.equal(originAllowed(req('http://alerts.example.com'), config), false);
  assert.equal(originAllowed(req(null), config), false);
  assert.equal(originAllowed(req('null'), config), false);
});

test('constantTimeEqual compares without leaking length differences', () => {
  assert.equal(constantTimeEqual('same', 'same'), true);
  assert.equal(constantTimeEqual('short', 'longer string'), false);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual(TEST_BOT_TOKEN, TEST_BOT_TOKEN), true);
});

test('verifyPassword returns false, never throws, on odd-length hex or unusable scrypt shapes', () => {
  const hash = hashPassword('pw');
  // Odd-length salt and hash hex parse lossily but must not throw.
  assert.equal(verifyPassword('pw', `${hash}7`), false);
  const parts = hash.split(':');
  parts[4] += '7';
  assert.equal(verifyPassword('pw', parts.join(':')), false);
  assert.equal(verifyPassword('pw', 'scrypt:16384:8:1:abcdefabcdefabcdefab:0123456789abcdef'), false);
});

test('destroySession never throws on malformed token or signature hex', () => {
  const testDb = createTestDb();
  try {
    const db = testDb.db;
    const config = makeTestConfig({ databasePath: testDb.dir });
    // Odd-length signature hex and non-hex tails must not throw.
    destroySession(db, config, `${'a'.repeat(64)}.${'b'.repeat(63)}`);
    destroySession(db, config, `${'a'.repeat(64)}.zzzz`);
    destroySession(db, config, `short.${'b'.repeat(64)}`);
    destroySession(db, config, '');
    destroySession(db, config, undefined);
    assert.equal(sessionCount(db), 0);
  } finally {
    testDb.cleanup();
  }
});

test('username rotation cannot bypass the 5-per-15-minute operator budget', () => {
  const testDb = createTestDb();
  try {
    const db = testDb.db;
    const config = makeTestConfig({ databasePath: testDb.dir });
    const t0 = 9_000_000;

    // Failures under attacker-named usernames all land on the operator row.
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      const result = authenticateLogin(db, config, { username: `attacker${i}`, password: 'guess' }, t0 + i);
      assert.equal(result, 'invalid');
    }
    const rows = db.prepare('SELECT username FROM login_throttle').all() as { username: string }[];
    assert.deepEqual(rows.map((r) => r.username), [config.auth.username]);

    // Correct credentials are denied by the shared budget despite fresh usernames.
    assert.equal(
      authenticateLogin(db, config, { username: config.auth.username, password: 'wrong' }, t0 + 10),
      'rate',
    );

    // Oversized malformed credentials also record against the operator before KDF.
    clearLoginFailures(db, config.auth.username);
    assert.equal(
      authenticateLogin(db, config, { username: config.auth.username, password: 'p'.repeat(1025) }, t0 + 20),
      'invalid',
    );

    // Window expiry reopens the budget and a correct login succeeds and clears.
    assert.equal(
      authenticateLogin(
        db,
        config,
        { username: config.auth.username, password: 'correct horse battery staple' },
        t0 + 20 + LOGIN_WINDOW_MS,
      ),
      'success',
    );
    assert.equal(loginThrottleStatus(db, config.auth.username, t0 + 20 + LOGIN_WINDOW_MS).allowed, true);
  } finally {
    testDb.cleanup();
  }
});
