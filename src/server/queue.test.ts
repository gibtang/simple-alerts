import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';

import type { Config } from './config';
import { ingestReport, type IngestReport } from './ingest';
import { openDb } from './db';
import {
  claimNextDelivery,
  enqueueTestDelivery,
  expireStaleDeliveries,
  LEASE_MS,
  processDueDeliveries,
  processDelivery,
  readHeartbeat,
  readLastMaintenance,
  recoverStaleLeases,
  retryDelivery,
  runMaintenance,
  type WorkerDeps,
} from './queue';
import { runWorkerTick } from './worker';
import {
  createTestDb,
  makeTestConfig,
  scriptFetch,
  telegramResponse,
  TEST_BOT_TOKEN,
  type FetchCall,
} from './test-support';

interface Harness {
  config: Config;
  deps: WorkerDeps;
  calls: FetchCall[];
  db: WorkerDeps['db'];
  getNow: () => number;
  setNow: (ms: number) => void;
  ingest: (report?: Partial<IngestReport>, at?: number) => { id: number; groupId: number };
  latestDelivery: () => {
    id: number;
    status: string;
    attempts: number;
    failures: number;
    count: number;
    nextAttemptAt: number | null;
    lastError: string | null;
    createdAt: number;
  };
  cleanup: () => void;
}

function makeHarness(configOverrides?: Parameters<typeof makeTestConfig>[0]): Harness {
  const testDb = createTestDb();
  const config: Config = makeTestConfig({ databasePath: join(testDb.dir, 'alerts.db'), ...configOverrides });
  const db = testDb.db;
  let nowMs = 1_700_000_000_000;
  const { fetch, calls } = scriptFetch(() => telegramResponse(200, { ok: true }));
  const deps: WorkerDeps = { db, config, fetchImpl: fetch, now: () => nowMs };

  const baseReport: IngestReport = {
    name: 'TypeError',
    message: 'boom',
    stack: 'Error\n    at f (/app/x.js:1:1)',
    source: 'server',
  };

  return {
    config,
    deps,
    calls,
    db,
    getNow: () => nowMs,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    ingest: (overrides, at) =>
      ingestReport(db, config, config.projects[0]!, { ...baseReport, ...overrides }, at ?? nowMs),
    latestDelivery: () => {
      const row = db
        .prepare(
          'SELECT id, status, attempts, failures, count, next_attempt_at, last_error, created_at FROM deliveries ORDER BY id DESC LIMIT 1',
        )
        .get() as {
        id: number;
        status: string;
        attempts: number;
        failures: number;
        count: number;
        next_attempt_at: number | null;
        last_error: string | null;
        created_at: number;
      };
      return {
        id: row.id,
        status: row.status,
        attempts: row.attempts,
        failures: row.failures,
        count: row.count,
        nextAttemptAt: row.next_attempt_at,
        lastError: row.last_error,
        createdAt: row.created_at,
      };
    },
    cleanup: testDb.cleanup,
  };
}

function sentBody(call: FetchCall): { chat_id: string; text: string } {
  return JSON.parse(String(call.init.body)) as { chat_id: string; text: string };
}

function countRows(db: WorkerDeps['db'], sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as { c: number };
  return row.c;
}

test('first alert sends immediately; occurrence, group and delivery persist', async () => {
  const h = makeHarness();
  try {
    const t0 = h.getNow();
    const first = h.ingest();
    assert.equal(countRows(h.db, 'SELECT COUNT(*) AS c FROM deliveries'), 1);
    assert.equal(await processDueDeliveries(h.deps), 1);
    assert.equal(h.calls.length, 1);
    const body = sentBody(h.calls[0]!);
    assert.equal(body.chat_id, '-100999');
    assert.ok(body.text.includes('TypeError'));
    assert.ok(body.text.includes('Demo'));
    const delivery = h.latestDelivery();
    assert.equal(delivery.status, 'sent');
    assert.equal(delivery.attempts, 1);
    assert.equal(countRows(h.db, "SELECT COUNT(*) AS c FROM delivery_attempts WHERE status = 'sent'"), 1);
    assert.ok(first.groupId > 0);
    assert.ok(first.id > 0);
    assert.ok(t0 > 0);
  } finally {
    h.cleanup();
  }
});

test('repeats coalesce into the pending delivery without new rows', async () => {
  const h = makeHarness();
  try {
    const t0 = h.getNow();
    h.ingest(undefined, t0);
    h.ingest(undefined, t0 + 1000);
    h.ingest(undefined, t0 + 1500);
    assert.equal(countRows(h.db, 'SELECT COUNT(*) AS c FROM deliveries'), 1);
    assert.equal(h.latestDelivery().count, 3);
    await processDueDeliveries(h.deps);
    assert.ok(sentBody(h.calls[0]!).text.includes('Occurrences: 3'));
  } finally {
    h.cleanup();
  }
});

test('repeat after a send schedules a digest at the interval boundary that survives restart', async () => {
  const h = makeHarness();
  try {
    const t0 = h.getNow();
    h.ingest(undefined, t0);
    assert.equal(await processDueDeliveries(h.deps), 1); // sent at t0
    assert.equal(h.calls.length, 1);

    h.ingest(undefined, t0 + 100_000); // inside the 300s coalesce window
    const digest = h.latestDelivery();
    assert.equal(digest.status, 'pending');
    assert.equal(digest.nextAttemptAt, t0 + 300_000);

    // Restart-safe: a fresh deps object over the same database, clock before due.
    h.setNow(t0 + 100_000);
    const restartDeps: WorkerDeps = { ...h.deps, now: () => h.getNow() };
    assert.equal(await processDueDeliveries(restartDeps), 0);
    assert.equal(h.calls.length, 1);
    assert.equal(h.latestDelivery().status, 'pending');

    // At the boundary the digest fires even with zero new events since t0+100s.
    h.setNow(t0 + 300_000);
    assert.equal(await processDueDeliveries(restartDeps), 1);
    assert.equal(h.calls.length, 2);
    assert.ok(sentBody(h.calls[1]!).text.includes('Occurrences: 1'));
    assert.equal(h.latestDelivery().status, 'sent');
  } finally {
    h.cleanup();
  }
});

test('events arriving during in-flight delivery are never merged into the claim', async () => {
  const h = makeHarness();
  try {
    const t0 = h.getNow();
    h.ingest(undefined, t0);
    const claimed = claimNextDelivery(h.db, h.config, t0);
    assert.equal(claimed?.status, 'sending');
    assert.ok(claimed);

    h.ingest(undefined, t0 + 100); // arrives while the first alert is in flight
    const rows = h.db
      .prepare('SELECT id, status, count, next_attempt_at FROM deliveries ORDER BY id')
      .all() as Array<{ id: number; status: string; count: number; next_attempt_at: number | null }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.status, 'sending');
    assert.equal(rows[0]?.count, 1, 'claimed alert is never merged into');
    assert.equal(rows[1]?.status, 'pending');
    assert.equal(rows[1]?.count, 1);
    // Follow-up is scheduled one repeat interval out from arrival.
    assert.equal(rows[1]?.next_attempt_at, t0 + 100 + 300_000);

    // The in-flight send completes; the follow-up waits for its own slot.
    await processDelivery(claimed, h.deps);
    assert.equal(h.calls.length, 1);
    h.setNow(t0 + 100 + 300_000);
    assert.equal(await processDueDeliveries(h.deps), 1);
    assert.equal(h.calls.length, 2);
    assert.ok(sentBody(h.calls[1]!).text.includes('Occurrences: 1'));
  } finally {
    h.cleanup();
  }
});


test('stale leases are recovered and the delivery is retried, not lost', async () => {
  const h = makeHarness();
  try {
    const t0 = h.getNow();
    h.ingest(undefined, t0);
    const claimed = claimNextDelivery(h.db, h.config, t0);
    assert.equal(claimed?.status, 'sending');
    h.setNow(t0 + LEASE_MS + 1); // simulate a crashed worker
    assert.equal(recoverStaleLeases(h.db, h.getNow()), 1);
    const delivery = h.latestDelivery();
    assert.equal(delivery.status, 'pending');
    await processDueDeliveries(h.deps);
    assert.equal(h.calls.length, 1);
    assert.equal(h.latestDelivery().status, 'sent');
  } finally {
    h.cleanup();
  }
});

test('the 24h window is a hard cap enforced before any send', async () => {
  const h = makeHarness();
  try {
    h.ingest(undefined, h.getNow());
    h.db
      .prepare('UPDATE deliveries SET created_at = ?')
      .run(h.getNow() - 25 * 60 * 60 * 1000);
    const quiet = scriptFetch(() => telegramResponse(200, { ok: true }));
    assert.equal(await processDueDeliveries({ ...h.deps, fetchImpl: quiet.fetch }), 0);
    assert.equal(quiet.calls.length, 0);
    const delivery = h.latestDelivery();
    assert.equal(delivery.status, 'failed');
    assert.ok(delivery.lastError?.includes('expired'));
    assert.equal(countRows(h.db, 'SELECT COUNT(*) AS c FROM delivery_attempts'), 0);
  } finally {
    h.cleanup();
  }
});

test('telegram retry_after is honored and cannot schedule past the window', async () => {
  const h = makeHarness();
  try {
    const t0 = h.getNow();
    h.ingest(undefined, t0);
    const limited = scriptFetch(() =>
      telegramResponse(429, { ok: false, parameters: { retry_after: 90 } }),
    );
    assert.equal(await processDueDeliveries({ ...h.deps, fetchImpl: limited.fetch }), 1);
    assert.equal(limited.calls.length, 1);
    let delivery = h.latestDelivery();
    assert.equal(delivery.status, 'pending');
    assert.equal(delivery.attempts, 1);
    assert.equal(delivery.nextAttemptAt, t0 + 90_000);
    assert.equal(
      countRows(h.db, "SELECT COUNT(*) AS c FROM delivery_attempts WHERE status = 'rate_limited'"),
      1,
    );

    // A retry_after that lands past created_at + 24h expires instead of scheduling.
    h.setNow(t0 + 90_000);
    h.db
      .prepare('UPDATE deliveries SET created_at = ?')
      .run(h.getNow() - 23 * 60 * 60 * 1000); // window ends in ~1h
    const longLimited = scriptFetch(() =>
      telegramResponse(429, { ok: false, parameters: { retry_after: 7200 } }),
    );
    assert.equal(await processDueDeliveries({ ...h.deps, fetchImpl: longLimited.fetch }), 1);
    delivery = h.latestDelivery();
    assert.equal(delivery.status, 'failed');
    assert.ok(delivery.lastError?.includes('expired'));
    assert.equal(delivery.nextAttemptAt, null);
  } finally {
    h.cleanup();
  }
});

test('5xx and network errors retry with backoff; 4xx fails permanently', async () => {
  const h = makeHarness();
  try {
    const t0 = h.getNow();
    h.ingest(undefined, t0);
    const flaky = scriptFetch(() => telegramResponse(502, { ok: false }));
    assert.equal(await processDueDeliveries({ ...h.deps, fetchImpl: flaky.fetch }), 1);
    let delivery = h.latestDelivery();
    assert.equal(delivery.status, 'pending');
    assert.equal(delivery.attempts, 1);
    assert.equal(delivery.failures, 1);
    assert.ok((delivery.nextAttemptAt ?? 0) > h.getNow());
    assert.equal(flaky.calls.length, 1);

    // Retry arrives due, hits a permanent 4xx this time.
    h.db.prepare('UPDATE deliveries SET next_attempt_at = ?').run(h.getNow());
    const permanent = scriptFetch(() =>
      telegramResponse(400, { ok: false, description: 'bad chat_id' }),
    );
    assert.equal(await processDueDeliveries({ ...h.deps, fetchImpl: permanent.fetch }), 1);
    delivery = h.latestDelivery();
    assert.equal(delivery.status, 'failed');
    assert.ok(delivery.lastError?.includes('400'));
    assert.equal(permanent.calls.length, 1);

    // Permanent failures are never retried.
    assert.equal(await processDueDeliveries({ ...h.deps, fetchImpl: permanent.fetch }), 0);
    assert.equal(permanent.calls.length, 1);
  } finally {
    h.cleanup();
  }
});

test('stored errors are bounded and the bot token never appears', async () => {
  const h = makeHarness();
  try {
    h.ingest(undefined, h.getNow());
    const leaky = scriptFetch(() =>
      telegramResponse(401, { ok: false, description: `unauthorized for bot ${TEST_BOT_TOKEN}` }),
    );
    assert.equal(await processDueDeliveries({ ...h.deps, fetchImpl: leaky.fetch }), 1);
    const delivery = h.latestDelivery();
    assert.equal(delivery.status, 'failed');
    assert.ok(delivery.lastError !== null);
    assert.ok(!delivery.lastError.includes(TEST_BOT_TOKEN));
    const attempts = h.db.prepare('SELECT error FROM delivery_attempts').all() as Array<{
      error: string | null;
    }>;
    for (const row of attempts) {
      assert.ok(row.error === null || !row.error.includes(TEST_BOT_TOKEN));
    }
  } finally {
    h.cleanup();
  }
});

test('manual retry requeues only failed deliveries and resets the 24h window', async () => {
  const h = makeHarness();
  try {
    const t0 = h.getNow();
    h.ingest(undefined, t0);
    const forbidden = scriptFetch(() =>
      telegramResponse(403, { ok: false, description: 'forbidden' }),
    );
    assert.equal(await processDueDeliveries({ ...h.deps, fetchImpl: forbidden.fetch }), 1);
    const failedId = h.latestDelivery().id;
    assert.equal(h.latestDelivery().status, 'failed');

    assert.equal(retryDelivery(h.db, failedId, t0 + 3_600_000), 'retried');
    const delivery = h.latestDelivery();
    assert.equal(delivery.status, 'pending');
    assert.equal(delivery.createdAt, t0, 'manual retry must not extend error-data retention');
    assert.equal(delivery.attempts, 1, 'aggregate attempt count is preserved');

    assert.equal(retryDelivery(h.db, failedId, t0 + 3_600_000), 'not-failed');
    assert.equal(retryDelivery(h.db, 999_999, t0), 'not-found');

    h.setNow(t0 + 3_600_000);
    const ok = scriptFetch(() => telegramResponse(200, { ok: true }));
    assert.equal(await processDueDeliveries({ ...h.deps, fetchImpl: ok.fetch }), 1);
    assert.equal(ok.calls.length, 1);
    assert.equal(h.latestDelivery().status, 'sent');
    assert.equal(h.latestDelivery().attempts, 2);
  } finally {
    h.cleanup();
  }
});

test('test deliveries send to the project chat with count zero', async () => {
  const h = makeHarness();
  try {
    const id = enqueueTestDelivery(h.db, h.config, 'demo', h.getNow());
    assert.ok(id > 0);
    const delivery = h.latestDelivery();
    assert.equal(delivery.status, 'pending');
    assert.equal(delivery.count, 0);
    assert.equal(await processDueDeliveries(h.deps), 1);
    const body = sentBody(h.calls[0]!);
    assert.ok(body.text.toLowerCase().includes('test'));
    assert.ok(!body.text.includes('Occurrences'));
    assert.equal(h.latestDelivery().status, 'sent');
  } finally {
    h.cleanup();
  }
});

test('maintenance sweeps retention, sessions, throttle rows and old deliveries', () => {
  const h = makeHarness({ retentionDays: 30 });
  try {
    const db = h.db;
    const now = h.getNow();
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    const oldGroupId = Number(
      db
        .prepare(
          "INSERT INTO groups (project_id, project_name, name, message, message_key, source, stack_key, count, first_seen, last_seen) VALUES ('demo', 'Demo', 'old', 'm', 'k1', 'server', '', 1, ?, ?)",
        )
        .run(cutoff - 1000, cutoff - 1000).lastInsertRowid,
    );
    db.prepare(
      'INSERT INTO occurrences (group_id, received_at, stack, url, metadata) VALUES (?, ?, NULL, NULL, ?)',
    ).run(oldGroupId, cutoff - 1000, '{}');
    db.prepare(
      "INSERT INTO deliveries (group_id, project_id, project_name, kind, text, status, attempts, failures, count, created_at, next_attempt_at) VALUES (?, 'demo', 'Demo', 'alert', 't', 'sent', 1, 0, 1, ?, NULL)",
    ).run(oldGroupId, cutoff - 1000);
    h.ingest(undefined, now); // fresh data must survive
    db.prepare(
      'INSERT INTO sessions (token_id, username, fingerprint, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run('stale', 'ops', 'fp', cutoff, cutoff);
    db.prepare(
      'INSERT INTO login_throttle (username, failures, window_start, last_failure) VALUES (?, 5, ?, ?)',
    ).run('ghost', now - 16 * 60_000, now - 16 * 60_000);

    runMaintenance(db, h.config, now);

    assert.equal(countRows(db, 'SELECT COUNT(*) AS c FROM groups WHERE id = ?', oldGroupId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS c FROM occurrences WHERE group_id = ?', oldGroupId), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS c FROM deliveries WHERE created_at < ?', cutoff), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS c FROM groups WHERE first_seen = ?', now), 1);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS c FROM sessions'), 0);
    assert.equal(countRows(db, 'SELECT COUNT(*) AS c FROM login_throttle'), 0);
  } finally {
    h.cleanup();
  }
});

test('worker tick beats, processes, and sweeps maintenance on interval', async () => {
  const h = makeHarness();
  try {
    assert.equal(readLastMaintenance(h.db), 0);
    h.ingest(undefined, h.getNow());
    const first = await runWorkerTick(h.deps);
    assert.equal(first.processed, 1);
    assert.equal(first.maintenance, true, 'first tick sweeps because the marker is unset');
    assert.equal(readLastMaintenance(h.db), h.getNow());
    h.setNow(h.getNow() + 1000);
    const second = await runWorkerTick(h.deps);
    assert.equal(second.maintenance, false);
    assert.equal(second.processed, 0);
    assert.ok(readHeartbeat(h.db)! >= h.getNow() - 1000);
  } finally {
    h.cleanup();
  }
});

test('expireStaleDeliveries hard-fails expired pending work outside the claim path', () => {
  const h = makeHarness();
  try {
    h.ingest(undefined, h.getNow());
    h.db.prepare('UPDATE deliveries SET created_at = ?').run(h.getNow() - 25 * 60 * 60 * 1000);
    assert.equal(expireStaleDeliveries(h.db, h.config, h.getNow()), 1);
    assert.equal(h.latestDelivery().status, 'failed');
  } finally {
    h.cleanup();
  }
});

test('a second independent connection sees the same persisted queue state', () => {
  const h = makeHarness();
  try {
    h.ingest(undefined, h.getNow());
    const second = openDb(h.config.server.databasePath);
    assert.equal(countRows(second, 'SELECT COUNT(*) AS c FROM deliveries'), 1);
    second.close();
  } finally {
    h.cleanup();
  }
});

test('new occurrences after the old retry window create deliverable fresh work', async () => {
  const h = makeHarness();
  try {
    h.ingest();
    h.setNow(h.getNow() + 25 * 3_600_000);
    h.ingest();
    assert.equal(countRows(h.db, 'SELECT COUNT(*) AS c FROM deliveries'), 2);
    assert.equal(await processDueDeliveries(h.deps), 1);
    assert.equal(h.latestDelivery().status, 'sent');
    assert.equal(h.latestDelivery().count, 1);
    assert.equal(countRows(h.db, "SELECT COUNT(*) AS c FROM deliveries WHERE status='failed'"), 1);
    assert.equal(countRows(h.db, 'SELECT COUNT(*) AS c FROM occurrences'), 2);
  } finally {
    h.cleanup();
  }
});

test('Telegram delays longer than an hour remain authoritative even with a long error description', async () => {
  const h = makeHarness();
  try {
    const t0 = h.getNow();
    h.ingest();
    const limited = scriptFetch(() => telegramResponse(429, {
      ok: false, description: 'x'.repeat(1000), parameters: { retry_after: 7200 },
    }));
    await processDueDeliveries({ ...h.deps, fetchImpl: limited.fetch });
    assert.equal(h.latestDelivery().nextAttemptAt, t0 + 7_200_000);
    h.setNow(t0 + 3_600_000);
    assert.equal(await processDueDeliveries(h.deps), 0);
    assert.equal(h.calls.length, 0);
    h.setNow(t0 + 7_200_000);
    assert.equal(await processDueDeliveries(h.deps), 1);
    assert.equal(h.latestDelivery().status, 'sent');
  } finally {
    h.cleanup();
  }
});

test('manual retry cannot extend retention of the original error snapshot', async () => {
  const h = makeHarness();
  try {
    const t0 = h.getNow();
    h.ingest();
    const denied = scriptFetch(() => telegramResponse(403, { ok: false }));
    await processDueDeliveries({ ...h.deps, fetchImpl: denied.fetch });
    const id = h.latestDelivery().id;
    assert.equal(retryDelivery(h.db, id, t0 + 29 * 86_400_000), 'retried');
    runMaintenance(h.db, h.config, t0 + 31 * 86_400_000);
    assert.equal(countRows(h.db, 'SELECT COUNT(*) AS c FROM deliveries'), 0);
    assert.equal(countRows(h.db, 'SELECT COUNT(*) AS c FROM occurrences'), 0);
  } finally {
    h.cleanup();
  }
});

test('delivery status and attempt history roll back together on storage failure', async () => {
  const h = makeHarness();
  try {
    h.ingest();
    h.db.exec("CREATE TRIGGER unavailable_audit BEFORE INSERT ON delivery_attempts BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    await assert.rejects(processDueDeliveries(h.deps), /audit unavailable/);
    assert.equal(h.latestDelivery().status, 'sending');
    assert.equal(h.latestDelivery().attempts, 0);
    assert.equal(countRows(h.db, 'SELECT COUNT(*) AS c FROM delivery_attempts'), 0);
    h.db.exec('DROP TRIGGER unavailable_audit');
    h.setNow(h.getNow() + LEASE_MS + 1);
    await processDueDeliveries(h.deps);
    assert.equal(h.latestDelivery().status, 'sent');
    assert.equal(h.latestDelivery().attempts, 1);
    assert.equal(countRows(h.db, 'SELECT COUNT(*) AS c FROM delivery_attempts'), 1);
  } finally {
    h.cleanup();
  }
});

test('worker heartbeat stays fresh between slow sends in a long batch', async () => {
  const h = makeHarness();
  try {
    for (let i = 0; i < 3; i++) h.ingest({ message: `failure ${i}` });
    const slow = scriptFetch(() => {
      assert.equal(readHeartbeat(h.db), h.getNow());
      h.setNow(h.getNow() + 60_000);
      return telegramResponse(200, { ok: true });
    });
    assert.equal(await processDueDeliveries({ ...h.deps, fetchImpl: slow.fetch }), 3);
    assert.equal(readHeartbeat(h.db), h.getNow());
  } finally {
    h.cleanup();
  }
});
