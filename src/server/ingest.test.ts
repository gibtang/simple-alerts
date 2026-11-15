import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DatabaseSync } from 'node:sqlite';

import { authenticateProject, consumeIngestSlot, ingestReport, INGEST_MAX_PER_WINDOW, redactReport, ReportValidationError, validateReport, type IngestReport } from './ingest';
import { createTestDb, makeTestConfig, TEST_BOT_TOKEN, TEST_PROJECT_KEY, type TestDb } from './test-support';

function requestWithKey(key: string | null): Request {
  const headers: Record<string, string> =
    key === null ? {} : { authorization: `Bearer ${key}` };
  return new Request('http://localhost:3000/api/ingest', { method: 'POST', headers });
}

function sampleReport(overrides: Partial<IngestReport> = {}): IngestReport {
  return {
    name: 'TypeError',
    message: 'Cannot read properties of undefined',
    stack: 'Error: boom\n    at doWork (/app/server.js:10:15)',
    source: 'server',
    ...overrides,
  };
}

function groupRow(db: DatabaseSync, groupId: number): { count: number; name: string; message: string } {
  const row = db.prepare('SELECT count, name, message FROM groups WHERE id = ?').get(groupId) as {
    count: number;
    name: string;
    message: string;
  };
  return row;
}

test('ingest creates group and occurrence, then coalesces identical reports', () => {
  const testDb: TestDb = createTestDb();
  try {
    const config = makeTestConfig({ databasePath: testDb.dir });
    const first = ingestReport(testDb.db, config, config.projects[0]!, sampleReport(), 1000);
    const second = ingestReport(testDb.db, config, config.projects[0]!, sampleReport(), 2000);
    assert.equal(second.groupId, first.groupId);
    assert.notEqual(second.id, first.id);
    const group = groupRow(testDb.db, first.groupId);
    assert.equal(group.count, 2);
    const occurrences = testDb.db.prepare('SELECT COUNT(*) AS c FROM occurrences').get() as { c: number };
    assert.equal(occurrences.c, 2);
    // One immediate first notification.
    const deliveries = testDb.db.prepare('SELECT COUNT(*) AS c FROM deliveries').get() as { c: number };
    assert.equal(deliveries.c, 1);
  } finally {
    testDb.cleanup();
  }
});

test('stack normalization groups frames differing only by line/column', () => {
  const testDb = createTestDb();
  try {
    const config = makeTestConfig({ databasePath: testDb.dir });
    const project = config.projects[0]!;
    const a = ingestReport(testDb.db, config, project, sampleReport({
      stack: 'Error: boom\n    at doWork (/app/server.js:10:15)\n    at main (/app/server.js:99:1)',
    }), 1000);
    const b = ingestReport(testDb.db, config, project, sampleReport({
      stack: 'Error: boom\n    at doWork (/app/server.js:41:7)\n    at main (/app/server.js:120:2)',
    }), 2000);
    assert.equal(b.groupId, a.groupId);
    const c = ingestReport(testDb.db, config, project, sampleReport({
      stack: 'Error: boom\n    at other (/app/other.js:1:1)',
    }), 3000);
    assert.notEqual(c.groupId, a.groupId);
  } finally {
    testDb.cleanup();
  }
});

test('browser and server reports with identical text stay separate groups', () => {
  const testDb = createTestDb();
  try {
    const config = makeTestConfig({ databasePath: testDb.dir });
    const project = config.projects[0]!;
    const serverGroup = ingestReport(testDb.db, config, project, sampleReport({ stack: undefined }), 1000);
    const browserGroup = ingestReport(testDb.db, config, project, sampleReport({ source: 'browser', stack: undefined }), 2000);
    assert.notEqual(serverGroup.groupId, browserGroup.groupId);
  } finally {
    testDb.cleanup();
  }
});

test('redaction runs before disk: sensitive keys, inline secrets, url queries', () => {
  const testDb = createTestDb();
  try {
    const config = makeTestConfig({ databasePath: testDb.dir });
    const project = config.projects[0]!;
    const result = ingestReport(testDb.db, config, project, sampleReport({
      message: `auth failed with ${TEST_BOT_TOKEN} and Bearer sk-live-abcdefghijklmnopqrst`,
      stack: 'Error\n    at fetch (https://api.example.com/v1/send?token=abc&user=x:1:1)',
      url: 'https://app.example.com/checkout?secret=zzz#step2',
      metadata: { password: 'hunter2', api_key: 'AKIAIOSFODNN7EXAMPLE', note: 'keep me', nested: { sessionCookie: 'sid=123' } },
    }), 1000);

    const occurrence = testDb.db.prepare('SELECT url, metadata, stack FROM occurrences WHERE id = ?').get(result.id) as {
      url: string;
      metadata: string;
      stack: string;
    };
    assert.equal(occurrence.url, 'https://app.example.com/checkout');
    const metadata = JSON.parse(occurrence.metadata) as Record<string, unknown>;
    assert.equal(metadata.password, '[redacted]');
    assert.equal(metadata.api_key, '[redacted]');
    assert.equal(metadata.note, 'keep me');
    const nested = metadata.nested as Record<string, unknown>;
    assert.equal(nested.sessionCookie, '[redacted]');
    assert.ok(!occurrence.stack.includes('token=abc'));

    const group = testDb.db.prepare('SELECT message FROM groups WHERE id = ?').get(result.groupId) as { message: string };
    assert.ok(!group.message.includes(TEST_BOT_TOKEN), 'bot token must never reach disk');
    assert.ok(group.message.includes('[redacted]'));
    assert.ok(!group.message.includes('Bearer '));
  } finally {
    testDb.cleanup();
  }
});

test('validateReport rejects malformed payloads', () => {
  assert.throws(() => validateReport({ name: '', message: 'y', source: 'browser' }), ReportValidationError);
  assert.throws(() => validateReport({ name: 'x', message: 'y', source: 'client' }), ReportValidationError);
  assert.throws(() => validateReport({ name: 'x', message: 'y', source: 'browser', metadata: 5 }), ReportValidationError);
  assert.throws(() => validateReport('nope'), ReportValidationError);
  const ok = validateReport({ name: 'x', message: 'y', source: 'browser' });
  assert.equal(ok.source, 'browser');
  const unicode = validateReport({ name: '💥 Boom', message: '🚨 failed ✅', source: 'server' });
  assert.equal(unicode.name, '💥 Boom');
});

test('authenticateProject accepts only exact configured bearer keys', () => {
  const config = makeTestConfig();
  assert.equal(authenticateProject(config, requestWithKey(TEST_PROJECT_KEY))?.id, 'demo');
  assert.equal(authenticateProject(config, requestWithKey('k'.repeat(39))), null);
  assert.equal(authenticateProject(config, requestWithKey(`${TEST_PROJECT_KEY}extra`)), null);
  assert.equal(authenticateProject(config, requestWithKey(null)), null);
  const noHeader = new Request('http://localhost:3000/api/ingest', { method: 'POST' });
  assert.equal(authenticateProject(config, noHeader), null);
});

test('ingest rate limit consumes a persistent fixed window', () => {
  const testDb = createTestDb();
  try {
    const db = testDb.db;
    for (let i = 0; i < INGEST_MAX_PER_WINDOW; i++) {
      assert.equal(consumeIngestSlot(db, 'demo', 1000), true);
    }
    assert.equal(consumeIngestSlot(db, 'demo', 2000), false);
    // Other projects are unaffected.
    assert.equal(consumeIngestSlot(db, 'other', 2000), true);
    // A new window resets the counter.
    assert.equal(consumeIngestSlot(db, 'demo', 1000 + 60_000), true);
  } finally {
    testDb.cleanup();
  }
});

test('redactReport bounds oversized fields with visible truncation', () => {
  const config = makeTestConfig();
  const longMessage = 'x'.repeat(20_000);
  const redacted = redactReport(
    {
      name: 'E',
      message: longMessage,
      source: 'server',
      metadata: { blob: 'y'.repeat(40_000) },
    },
    config.telegram.botToken,
  );
  assert.ok(redacted.message.length <= 8000);
  assert.ok(redacted.message.endsWith('…[truncated]'));
  assert.ok(redacted.metadataJson.length <= 16_000);
  assert.doesNotThrow(() => JSON.parse(redacted.metadataJson));
});

test('forbidden request/response containers are dropped at any depth', () => {
  const config = makeTestConfig();
  const redacted = redactReport(
    {
      name: 'E',
      message: 'boom',
      source: 'server',
      metadata: {
        body: { password: 'hunter2' },
        nested: { headers: { authorization: 'Bearer x' }, keep: 'safe value' },
        deep: { list: [{ responseBody: 'secret html', ok: 1 }] },
      },
    },
    config.telegram.botToken,
  );
  const metadata = JSON.parse(redacted.metadataJson) as Record<string, unknown>;
  assert.ok(!('body' in metadata));
  const nested = metadata.nested as Record<string, unknown>;
  assert.ok(!('headers' in nested));
  assert.equal(nested.keep, 'safe value');
  const list = (metadata.deep as Record<string, unknown>).list as Array<Record<string, unknown>>;
  assert.ok(!('responseBody' in list[0]!));
  assert.equal(list[0]!.ok, 1);
  assert.ok(!redacted.metadataJson.includes('hunter2'));
  assert.ok(!redacted.metadataJson.includes('Bearer x'));
});

test('bot token never survives neutral metadata strings or URL paths', () => {
  const testDb = createTestDb();
  try {
    const config = makeTestConfig({ databasePath: testDb.dir });
    const project = config.projects[0]!;
    const token = config.telegram.botToken;
    const result = ingestReport(testDb.db, config, project, sampleReport({
      url: `https://api.telegram.org/bot${token}/sendMessage`,
      metadata: { note: `failed calling https://api.telegram.org/bot${token}/sendMessage`, count: 3 },
    }), 1000);

    const occurrence = testDb.db.prepare('SELECT url, metadata FROM occurrences WHERE id = ?').get(result.id) as {
      url: string;
      metadata: string;
    };
    assert.ok(!occurrence.url.includes(token));
    assert.ok(occurrence.url.includes('/bot[redacted]/sendMessage'));
    assert.ok(!occurrence.metadata.includes(token));
    const metadata = JSON.parse(occurrence.metadata) as Record<string, unknown>;
    assert.equal((metadata.note as string).includes(token), false);
    assert.equal(metadata.count, 3);

    const delivery = testDb.db.prepare('SELECT text FROM deliveries WHERE group_id = ?').get(result.groupId) as {
      text: string;
    };
    assert.ok(!delivery.text.includes(token));
  } finally {
    testDb.cleanup();
  }
});

test('oversized Unicode metadata stays valid bounded JSON', () => {
  const config = makeTestConfig();
  const emojiBlob = '🚨🎉💥'.repeat(12_000); // ~108k chars, multi-unit surrogates
  const redacted = redactReport(
    {
      name: 'E',
      message: 'boom',
      source: 'server',
      metadata: { blob: emojiBlob, tail: '🇦🇺'.repeat(9_000) },
    },
    config.telegram.botToken,
  );
  assert.ok(redacted.metadataJson.length <= 16_000);
  const metadata = JSON.parse(redacted.metadataJson) as Record<string, unknown>;
  assert.equal(typeof metadata.blob, 'string');
  assert.ok((metadata.blob as string).length <= 200);
  assert.equal(typeof metadata.tail, 'string');
  assert.ok(!redacted.metadataJson.includes('\\uD83D\\uD')); // no cut escape sequences
});
