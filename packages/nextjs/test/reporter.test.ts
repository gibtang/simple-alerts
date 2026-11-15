import assert from 'node:assert/strict';
import test from 'node:test';
import type { FetchLike } from '../src/shared/types.js';
import { createReporter, type ReporterOptions } from '../src/index.js';
import { createFetchStub, delay, jsonBody, type RecordedCall } from './helpers.js';

const ENDPOINT = 'https://alerts.test/api/ingest';
const PROJECT_KEY = 'k'.repeat(32);

function makeReporter(overrides: Partial<ReporterOptions> = {}) {
  const stub = createFetchStub(overrides.stub ?? {});
  const options: ReporterOptions = {
    endpoint: ENDPOINT,
    projectKey: PROJECT_KEY,
    fetch: stub.fetch,
    ...overrides,
  };
  return { stub, reporter: createReporter(options) };
}

test('captureException posts a sanitized event and returns true on 2xx', async () => {
  const { stub, reporter } = makeReporter({ stub: { status: 202, body: { id: 1, groupId: 2 } } });
  const result = await reporter.captureException(new Error('boom'), {
    url: 'https://app.test/checkout?secret=abc#top',
    metadata: { userId: 7, password: 'hunter2secret' },
  });
  assert.equal(result, true);
  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0];
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.authorization, `Bearer ${PROJECT_KEY}`);
  const body = jsonBody(call);
  assert.equal(body.name, 'Error');
  assert.equal(body.message, 'boom');
  assert.equal(body.source, 'server');
  assert.equal(body.url, 'https://app.test/checkout');
  assert.equal(typeof body.stack, 'string');
  const metadata = body.metadata as Record<string, unknown>;
  assert.equal(metadata.userId, 7);
  assert.equal('password' in metadata, false);
});

test('captureException returns false on non-2xx without throwing', async () => {
  const { reporter } = makeReporter({ stub: { status: 500 } });
  assert.equal(await reporter.captureException(new Error('boom')), false);
});

test('captureException returns false when fetch rejects', async () => {
  const { reporter } = makeReporter({ stub: { rejectWith: new Error('network down') } });
  assert.equal(await reporter.captureException(new Error('boom')), false);
});

test('captureException honors the finite timeout via abort signal', async () => {
  const { stub, reporter } = makeReporter({
    stub: { hangUntilAbort: true },
    timeoutMs: 25,
  });
  const startedAt = Date.now();
  const result = await reporter.captureException(new Error('boom'));
  assert.equal(result, false);
  assert.ok(stub.calls[0].signal instanceof AbortSignal, 'request must carry an abort signal');
  assert.ok(Date.now() - startedAt < 1000, 'timeout must be finite and short');
});

test('captureException stays under the payload ceiling by dropping metadata', async () => {
  const big: Record<string, string> = {};
  for (let i = 0; i < 40; i += 1) {
    big[`k${i}`] = 'y'.repeat(2000);
  }
  const { stub, reporter } = makeReporter({ stub: { status: 202 } });
  const result = await reporter.captureException(new Error('boom'), { metadata: big });
  assert.equal(result, true);
  const call = stub.calls[0];
  assert.ok(call.body !== undefined && call.body.length <= 64 * 1024);
  const body = jsonBody(call);
  assert.equal('metadata' in body, false);
  assert.equal(body.message, 'boom');
});

test('captureException round-trips unicode, quotes, and backslashes in metadata', async () => {
  const { stub, reporter } = makeReporter({ stub: { status: 202 } });
  const label = 'café ☕ 日本語 → 箭头 "quoted" \\ backslash \n newline 💥';
  const result = await reporter.captureException(new Error('déluge 💥 crashed'), {
    metadata: { label, path: '/café/naïve/文件' },
  });
  assert.equal(result, true);
  const body = jsonBody(stub.calls[0]);
  assert.equal(body.message, 'déluge 💥 crashed');
  const metadata = body.metadata as Record<string, unknown>;
  assert.equal(metadata.label, label);
  assert.equal(metadata.path, '/café/naïve/文件');
});

test('captureException survives circular and hostile metadata', async () => {
  const { stub, reporter } = makeReporter({ stub: { status: 202 } });
  const circular: Record<string, unknown> = { password: 'hunter2secret', note: 'Bearer abcdef123456' };
  circular.self = circular;
  const result = await reporter.captureException(new Error('boom'), { metadata: circular });
  assert.equal(result, true);
  const body = jsonBody(stub.calls[0]);
  const metadata = body.metadata as Record<string, unknown>;
  assert.equal(metadata.self, '[circular]');
  assert.equal('password' in metadata, false);
  assert.equal(String(metadata.note).includes('abcdef123456'), false);
});

test('captureException never throws for hostile error inputs', async () => {
  const { stub, reporter } = makeReporter({ stub: { status: 202 } });
  const hostile: Record<string, unknown> = {};
  Object.defineProperty(hostile, 'message', {
    get() {
      throw new Error('getter bomb');
    },
  });
  assert.equal(await reporter.captureException(hostile), true);
  assert.equal(await reporter.captureException(undefined), true);
  assert.equal(jsonBody(stub.calls[0]).message, 'Unknown error');
  assert.equal(jsonBody(stub.calls[1]).message, 'Unknown error');
});

test('onRequestError awaits the report before resolving', async () => {
  const { promise: pending, resolve: resolveUpstream } = Promise.withResolvers<Response>();
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: { ...((init?.headers ?? {}) as Record<string, unknown>) },
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: init?.signal ?? undefined,
    });
    return pending;
  };
  const reporter = createReporter({ endpoint: ENDPOINT, projectKey: PROJECT_KEY, fetch });

  const request = { path: '/api/users?token=abc', method: 'GET', headers: { cookie: 'private-cookie' } };
  const done = reporter.onRequestError(new Error('render failed'), request, {
    routerKind: 'App Router',
    routePath: '/api/users/[id]/page',
    routeType: 'route',
    revalidateReason: 'on-demand',
  });
  let settled = false;
  void done.then(() => {
    settled = true;
  });
  await delay(10);
  assert.equal(settled, false, 'onRequestError must await the upstream report');
  assert.equal(calls.length, 1);
  resolveUpstream(new Response('{}', { status: 202 }));
  await done;
  assert.equal(settled, true);

  const body = JSON.parse(calls[0].body ?? '{}') as Record<string, unknown>;
  assert.equal(body.url, '/api/users', 'query string must be stripped from the Next.js request path');
  assert.deepEqual(body.metadata, {
    routerKind: 'App Router',
    routePath: '/api/users/[id]/page',
    routeType: 'route',
    revalidateReason: 'on-demand',
  });
  assert.equal('headers' in body, false);
  assert.equal(calls[0].headers.authorization, `Bearer ${PROJECT_KEY}`);
});

test('onRequestError never rejects when reporting fails', async () => {
  const { reporter } = makeReporter({ stub: { rejectWith: new Error('down') } });
  const request = { path: '/x?secret=1', method: 'GET', headers: {} };
  await assert.doesNotReject(() =>
    reporter.onRequestError(new Error('boom'), request, { routerKind: 'App Router', routePath: '/x', routeType: 'route' }),
  );
});
