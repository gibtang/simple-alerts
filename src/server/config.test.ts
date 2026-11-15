import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseConfig } from './config';

function baseDocument(): Record<string, unknown> {
  return {
    server: {
      baseUrl: 'https://alerts.example.com',
      databasePath: '/data/alerts.db',
      sessionSecret: '${ALERTS_SESSION_SECRET}',
    },
    auth: {
      username: 'ops',
      passwordHash: 'scrypt:16384:8:1:abcdef0123456789abcdef0123456789:' + 'ab'.repeat(64),
    },
    telegram: { botToken: '${TELEGRAM_BOT_TOKEN}' },
    projects: [
      { id: 'demo', name: 'Demo', key: '${DEMO_PROJECT_KEY}', chatId: '-100123456' },
    ],
  };
}

function withEnv(extra: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ALERTS_SESSION_SECRET: 's'.repeat(48),
    TELEGRAM_BOT_TOKEN: '123456789:AAE_TestToken_ABCDEFGHIJKLMNOPQRSTUVWX',
    DEMO_PROJECT_KEY: 'k'.repeat(40),
    ...extra,
  };
}

test('parses a minimal document, applying only the allowed defaults', () => {
  const config = parseConfig(baseDocument(), withEnv({}));
  assert.equal(config.server.baseUrl, 'https://alerts.example.com');
  assert.equal(config.server.sessionSecret, 's'.repeat(48));
  assert.equal(config.telegram.botToken, '123456789:AAE_TestToken_ABCDEFGHIJKLMNOPQRSTUVWX');
  assert.deepEqual(config.alerts, { repeatIntervalSeconds: 300, retryWindowHours: 24 });
  assert.equal(config.retentionDays, 30);
  assert.equal(config.projects[0]?.key, 'k'.repeat(40));
  assert.equal(config.projects[0]?.chatId, '-100123456');
});

test('accepts explicit alerts and retention values', () => {
  const doc = {
    ...baseDocument(),
    alerts: { repeatIntervalSeconds: 60, retryWindowHours: 6 },
    retentionDays: 7,
  };
  const config = parseConfig(doc, withEnv({}));
  assert.deepEqual(config.alerts, { repeatIntervalSeconds: 60, retryWindowHours: 6 });
  assert.equal(config.retentionDays, 7);
});

test('expands embedded env references', () => {
  const doc = baseDocument();
  const server = doc.server as Record<string, unknown>;
  server.databasePath = '/data/${NODE_ENV}/alerts.db';
  const config = parseConfig(doc, withEnv({ NODE_ENV: 'production' }));
  assert.equal(config.server.databasePath, '/data/production/alerts.db');
});

test('fails when an env reference is undefined and names the variable', () => {
  assert.throws(
    () => parseConfig(baseDocument(), withEnv({ ALERTS_SESSION_SECRET: undefined })),
    (error: Error) => error.message.includes('ALERTS_SESSION_SECRET'),
  );
});

test('rejects missing required sections (no defaults beyond alerts/retention)', () => {
  const doc = baseDocument();
  delete doc.telegram;
  assert.throws(() => parseConfig(doc, withEnv({})));
  const doc2 = baseDocument();
  delete (doc2.server as Record<string, unknown>).sessionSecret;
  assert.throws(() => parseConfig(doc2, withEnv({})));
});

test('rejects HTTP base URLs outside localhost and accepts localhost HTTP', () => {
  const bad = baseDocument();
  (bad.server as Record<string, unknown>).baseUrl = 'http://alerts.example.com';
  assert.throws(() => parseConfig(bad, withEnv({})));
  const local = baseDocument();
  (local.server as Record<string, unknown>).baseUrl = 'http://localhost:3000/';
  const config = parseConfig(local, withEnv({}));
  assert.equal(config.server.baseUrl, 'http://localhost:3000');
  const loopback = baseDocument();
  (loopback.server as Record<string, unknown>).baseUrl = 'http://127.0.0.1:3000';
  assert.doesNotThrow(() => parseConfig(loopback, withEnv({})));
});

test('rejects duplicate project ids and keys', () => {
  const doc = baseDocument();
  doc.projects = [
    { id: 'demo', name: 'A', key: 'k'.repeat(40), chatId: '-100' },
    { id: 'demo', name: 'B', key: 'j'.repeat(40), chatId: '-101' },
  ];
  assert.throws(
    () => parseConfig(doc, withEnv({})),
    (error: Error) => error.message.includes('duplicate project id'),
  );
  const doc2 = baseDocument();
  doc2.projects = [
    { id: 'a', name: 'A', key: 'k'.repeat(40), chatId: '-100' },
    { id: 'b', name: 'B', key: 'k'.repeat(40), chatId: '-101' },
  ];
  assert.throws(
    () => parseConfig(doc2, withEnv({})),
    (error: Error) => error.message.includes('duplicate project keys'),
  );
});

test('rejects unknown keys, bad slugs, non-string chat ids and bad hashes', () => {
  const strict = { ...baseDocument(), extra: true };
  assert.throws(() => parseConfig(strict, withEnv({})));

  const slug = baseDocument();
  (slug.projects as Array<Record<string, unknown>>)[0]!.id = 'Demo App';
  assert.throws(() => parseConfig(slug, withEnv({})));

  const chat = baseDocument();
  (chat.projects as Array<Record<string, unknown>>)[0]!.chatId = -100123;
  assert.throws(() => parseConfig(chat, withEnv({})));

  const hash = baseDocument();
  (hash.auth as Record<string, unknown>).passwordHash = 'bcrypt$whatever';
  assert.throws(() => parseConfig(hash, withEnv({})));

  const shortKey = baseDocument();
  (shortKey.projects as Array<Record<string, unknown>>)[0]!.key = 'short';
  assert.throws(() => parseConfig(shortKey, withEnv({})));
});

test('rejects unknown keys nested inside any section', () => {
  const serverTypo = baseDocument();
  (serverTypo.server as Record<string, unknown>).baseUrrl = 'https://alerts.example.com';
  assert.throws(
    () => parseConfig(serverTypo, withEnv({})),
    (error: Error) => error.message.includes('server'),
  );

  const authTypo = baseDocument();
  (authTypo.auth as Record<string, unknown>).passwordhash = 'scrypt:1:1:1:aa:bb';
  assert.throws(() => parseConfig(authTypo, withEnv({})));

  const telegramTypo = baseDocument();
  (telegramTypo.telegram as Record<string, unknown>).bottoken = 'x';
  assert.throws(() => parseConfig(telegramTypo, withEnv({})));

  const projectTypo = baseDocument();
  (projectTypo.projects as Array<Record<string, unknown>>)[0]!.chatid = '-100';
  assert.throws(() => parseConfig(projectTypo, withEnv({})));

  const alertsTypo = baseDocument();
  alertsTypo.alerts = { repeatIntervalSeconds: 60, retryWindowHours: 6, extra: true };
  assert.throws(() => parseConfig(alertsTypo, withEnv({})));
});
