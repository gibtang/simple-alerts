import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openDb } from './db';
import { hashPassword } from './auth';
import type { Config } from './config';

/**
 * Shared helpers for permanent behavioral tests: temporary databases and a
 * minimal valid Config. No production config alternatives are introduced.
 */

export const TEST_BOT_TOKEN = '123456789:AAE_TestToken_ABCDEFGHIJKLMNOPQRSTUVWX';
export const TEST_PROJECT_KEY = 'k'.repeat(40);
export const TEST_SESSION_SECRET = 's'.repeat(48);

export function makeTestConfig(overrides?: {
  server?: Partial<Config['server']>;
  auth?: Partial<Config['auth']>;
  telegram?: Partial<Config['telegram']>;
  projects?: Config['projects'];
  alerts?: Partial<Config['alerts']>;
  retentionDays?: number;
  databasePath?: string;
}): Config {
  const base: Config = {
    server: {
      baseUrl: 'http://localhost:3000',
      databasePath: '',
      sessionSecret: TEST_SESSION_SECRET,
    },
    auth: {
      username: 'ops',
      passwordHash: hashPassword('correct horse battery staple'),
    },
    telegram: { botToken: TEST_BOT_TOKEN },
    projects: [{ id: 'demo', name: 'Demo', key: TEST_PROJECT_KEY, chatId: '-100999' }],
    alerts: { repeatIntervalSeconds: 300, retryWindowHours: 24 },
    retentionDays: 30,
  };
  return {
    server: {
      ...base.server,
      ...overrides?.server,
      databasePath: overrides?.databasePath ?? overrides?.server?.databasePath ?? '',
    },
    auth: { ...base.auth, ...overrides?.auth },
    telegram: { ...base.telegram, ...overrides?.telegram },
    projects: overrides?.projects ?? base.projects,
    alerts: { ...base.alerts, ...overrides?.alerts },
    retentionDays: overrides?.retentionDays ?? base.retentionDays,
  };
}

export interface TestDb {
  db: DatabaseSync;
  dir: string;
  cleanup: () => void;
}

export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'simple-alerts-test-'));
  const db = openDb(join(dir, 'alerts.db'));
  return {
    db,
    dir,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface FetchCall {
  url: string;
  init: RequestInit;
}

export function scriptFetch(
  handler: (url: string, init: RequestInit) => Response,
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (input: URL | RequestInfo, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(handler(url, init ?? {}));
  };
  return { fetch: fetchImpl, calls };
}

export function telegramResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
