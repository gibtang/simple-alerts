import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { getConfig } from './config';
import { ingestReport } from './ingest';
import { openDb } from './db';
import { beat } from './queue';
import { getGroup, getOverview } from './store';

/**
 * Store read-model tests run against a real temporary database and a real
 * (temporary) YAML config via ALERTS_CONFIG, exercising getConfig end to end.
 */

const SALT = 'a'.repeat(32);
const KEY = 'b'.repeat(128);

function writeTempConfig(databasePath: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'simple-alerts-store-'));
  const yamlPath = join(dir, 'alerts.yaml');
  const yaml = [
    'server:',
    '  baseUrl: https://alerts.example.com',
    `  databasePath: ${databasePath}`,
    '  sessionSecret: abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
    'auth:',
    '  username: ops',
    `  passwordHash: scrypt:16384:8:1:${SALT}:${KEY}`,
    'telegram:',
    '  botToken: "123456789:AAE_TestToken_ABCDEFGHIJKLMNOPQRSTUVWX"',
    'projects:',
    '  - id: demo',
    '    name: Demo',
    `    key: ${'k'.repeat(40)}`,
    '    chatId: "-100999"',
    '  - id: empty',
    '    name: Empty',
    `    key: ${'j'.repeat(40)}`,
    '    chatId: "-100888"',
  ].join('\n');
  writeFileSync(yamlPath, yaml, 'utf8');
  return { path: yamlPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('getOverview includes configured projects with zero errors and caps lists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'simple-alerts-store-db-'));
  const dbPath = join(dir, 'alerts.db');
  const tempConfig = writeTempConfig(dbPath);
  process.env.ALERTS_CONFIG = tempConfig.path;
  try {
    const db = openDb(dbPath);
    const config = getConfig();
    const ingested = ingestReport(
      db,
      config,
      config.projects[0]!,
      {
        name: 'TypeError',
        message: 'boom',
        stack: 'Error\n    at f (/app/x.js:1:1)',
        source: 'server',
        url: 'https://app.example.com/x',
        metadata: { detail: 'kept' },
      },
      1_000_000,
    );

    // Enough groups and deliveries to exceed the list caps.
    for (let i = 0; i < 101; i++) {
      db.prepare(
        "INSERT INTO groups (project_id, project_name, name, message, message_key, source, stack_key, count, first_seen, last_seen) VALUES ('demo', 'Demo', ?, 'm', ?, 'server', '', 1, ?, ?)",
      ).run(`g${i}`, `mk${i}`, 1_000_000 + i, 1_000_000 + i);
    }
    for (let i = 0; i < 52; i++) {
      db.prepare(
        "INSERT INTO deliveries (group_id, project_id, project_name, kind, text, status, attempts, failures, count, created_at, next_attempt_at) VALUES (NULL, 'demo', 'Demo', 'test', 't', 'failed', 1, 1, 0, ?, NULL)",
      ).run(1_000_000 + i);
    }
    beat(db, 1_100_000);

    const overview = getOverview();
    assert.deepEqual(overview.projects.map((project) => project.id), ['demo', 'empty']);
    const empty = overview.projects.find((project) => project.id === 'empty');
    assert.deepEqual(empty, { id: 'empty', name: 'Empty', groups: 0, occurrences: 0, failed: 0 });
    const demo = overview.projects.find((project) => project.id === 'demo');
    assert.equal(demo?.groups, 102);
    assert.equal(demo?.occurrences, 102);
    assert.equal(demo?.failed, 52);

    assert.equal(overview.groups.length, 100, 'group list capped at 100');
    assert.equal(overview.deliveries.length, 50, 'delivery list capped at 50');
    assert.equal(overview.totals.groups, 102);
    assert.equal(overview.totals.occurrences, 102);
    assert.equal(overview.totals.pending, 1, 'the ingested first notification is pending');
    assert.equal(overview.totals.failed, 52);
    assert.equal(overview.worker.lastHeartbeat, 1_100_000);

    const top = overview.groups[0]!;
    assert.equal(top.projectId, 'demo');
    assert.equal(top.projectName, 'Demo');
    assert.equal(top.deliveryStatus, 'none', 'newest group has no deliveries yet');
    assert.equal(top.source, 'server');

    // Project filter narrows lists AND totals; unknown filters degrade to all.
    const filtered = getOverview('empty');
    assert.equal(filtered.groups.length, 0);
    assert.equal(filtered.deliveries.length, 0);
    assert.equal(filtered.projects.length, 2);
    assert.equal(filtered.totals.groups, 0, 'totals follow the project filter');
    assert.equal(filtered.totals.pending, 0);
    assert.equal(filtered.totals.failed, 0);

    const all = getOverview('not-a-configured-project');
    assert.equal(all.groups.length, 100);
    assert.equal(all.totals.groups, 102, 'unknown filter falls back to the global view');

    const detail = getGroup(ingested.groupId);
    assert.notEqual(detail, null);
    assert.equal(detail?.group.id, ingested.groupId);
    assert.equal(detail?.occurrences.length, 1);
    assert.equal(detail?.occurrences[0]?.receivedAt, 1_000_000);
    assert.equal(detail?.occurrences[0]?.url, 'https://app.example.com/x');
    const metadata = JSON.parse(detail?.occurrences[0]?.metadata ?? '{}') as Record<string, unknown>;
    assert.equal(metadata.detail, 'kept');
    assert.equal(detail?.deliveries.length, 1);
    assert.equal(detail?.deliveries[0]?.status, 'pending');
    assert.equal(getGroup(999_999_999), null);
  } finally {
    delete process.env.ALERTS_CONFIG;
    tempConfig.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
