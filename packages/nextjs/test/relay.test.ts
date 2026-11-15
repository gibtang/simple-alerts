import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserRelay } from '../src/relay.js';
import type { FetchLike } from '../src/shared/types.js';
import { createFetchStub, jsonBody } from './helpers.js';

const ENDPOINT = 'https://alerts.test/api/ingest';
const PROJECT_KEY = 'r'.repeat(32);

type Body = Record<string, unknown> | string;

function relayRequest(body: Body, headers: Record<string, string> = {}): Request {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://app.test/api/alerts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: payload,
  });
}

function makeRelay(extra: Record<string, unknown> = {}) {
  const stub = createFetchStub(extra.stub ?? {});
  const relay = createBrowserRelay({
    endpoint: ENDPOINT,
    projectKey: PROJECT_KEY,
    fetch: stub.fetch,
    ...extra,
  });
  return { stub, relay };
}

const sampleEvent = {
  name: 'Error',
  message: 'boom',
  source: 'server',
  url: 'https://app.test/p?token=abc#frag',
  stack: 'Error: boom\n    at x (https://cdn.test/x.js?ver=2:1:1)',
  metadata: { password: 'hunter2secret', keep: 1 },
  authorization: 'Bearer forged-token-aaaa',
  cookies: 'session=stolen',
};

test('relay forwards sanitized browser events with the server-held key', async () => {
  const { stub, relay } = makeRelay({ stub: { status: 202, body: { id: 5, groupId: 9 } } });
  const response = await relay.POST(relayRequest(sampleEvent, { origin: 'https://app.test' }));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { id: 5, groupId: 9 });

  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0];
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.headers.authorization, `Bearer ${PROJECT_KEY}`);
  const forwarded = jsonBody(call);
  assert.equal(forwarded.name, 'Error');
  assert.equal(forwarded.message, 'boom');
  assert.equal(forwarded.source, 'browser', 'browser relay must force browser source');
  assert.equal(forwarded.url, 'https://app.test/p');
  assert.equal(forwarded.stack?.includes('?'), false);
  assert.ok(forwarded.stack?.includes('https://cdn.test/x.js'));
  const metadata = forwarded.metadata as Record<string, unknown>;
  assert.equal('password' in metadata, false);
  assert.equal(metadata.keep, 1);
  assert.equal('authorization' in forwarded, false);
  assert.equal('cookies' in forwarded, false);
});

test('relay rejects invalid JSON and missing required fields with 400', async () => {
  const { stub, relay } = makeRelay();
  assert.equal(
    (await relay.POST(relayRequest('{not json', { origin: 'https://app.test' }))).status,
    400,
  );
  assert.equal(
    (await relay.POST(relayRequest({ name: 'only-name' }, { origin: 'https://app.test' }))).status,
    400,
  );
  assert.equal(stub.calls.length, 0);
});

test('relay rejects oversized bodies with 413 before any upstream call', async () => {
  const { stub, relay } = makeRelay();
  const huge = JSON.stringify({ name: 'Error', message: 'x'.repeat(70 * 1024) });
  const response = await relay.POST(relayRequest(huge, { origin: 'https://app.test' }));
  assert.equal(response.status, 413);
  assert.equal(stub.calls.length, 0);
});

test('relay rejects streamed oversize bodies without buffering or upstream call', async () => {
  const { stub, relay } = makeRelay({ maxBytes: 1024 });
  const chunk = new TextEncoder().encode('x'.repeat(256));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 8; i += 1) {
        controller.enqueue(chunk); // 2048 bytes total, cap is 1024
      }
      controller.close();
    },
  });
  const request = new Request('https://app.test/api/alerts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.test' },
    body,
    duplex: 'half',
  } as RequestInit);
  const response = await relay.POST(request);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'too_large' });
  assert.equal(stub.calls.length, 0);
});

test('relay enforces a finite read deadline on streams that never close', async () => {
  const { stub, relay } = makeRelay({ timeoutMs: 50 });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"name":"a"'));
      // Deliberately never closes: the relay must time out, not hang.
    },
  });
  const request = new Request('https://app.test/api/alerts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.test' },
    body,
    duplex: 'half',
  } as RequestInit);
  const started = Date.now();
  const response = await relay.POST(request);
  assert.ok(Date.now() - started < 5000, 'stalled request stream must resolve finitely');
  assert.equal(response.status, 400);
  assert.equal(stub.calls.length, 0);
});

test('relay enforces same-origin by default and allows listed origins', async () => {
  const { stub, relay } = makeRelay({ allowedOrigins: ['https://partner.test'] });

  const rejected = await relay.POST(relayRequest({ name: 'a', message: 'b' }, { origin: 'https://evil.test' }));
  assert.equal(rejected.status, 403);
  assert.equal(stub.calls.length, 0);

  const partner = await relay.POST(relayRequest({ name: 'a', message: 'b' }, { origin: 'https://partner.test' }));
  assert.equal(partner.status, 202);
  assert.equal(stub.calls.length, 1);

  const sameOrigin = await relay.POST(relayRequest({ name: 'a', message: 'b' }, { origin: 'https://app.test' }));
  assert.equal(sameOrigin.status, 202);
  assert.equal(stub.calls.length, 2);
});

test('relay requires an Origin header and rejects opaque null origins', async () => {
  const { stub, relay } = makeRelay();
  const missing = await relay.POST(relayRequest({ name: 'a', message: 'b' }));
  assert.equal(missing.status, 403);
  assert.deepEqual(await missing.json(), { error: 'forbidden' });

  const opaque = await relay.POST(relayRequest({ name: 'a', message: 'b' }, { origin: 'null' }));
  assert.equal(opaque.status, 403);

  assert.equal(stub.calls.length, 0, 'origin failures must never reach upstream');
});

test('relay falls back to the referer header for the page URL and strips it', async () => {
  const { stub, relay } = makeRelay();
  await relay.POST(
    relayRequest(
      { name: 'a', message: 'b' },
      { origin: 'https://app.test', referer: 'https://app.test/page?x=1#top' },
    ),
  );
  assert.equal(jsonBody(stub.calls[0]).url, 'https://app.test/page');
});

test('relay collapses upstream auth failures to 502 without leaking the key', async () => {
  const { relay } = makeRelay({ stub: { status: 401 } });
  const response = await relay.POST(relayRequest({ name: 'a', message: 'b' }, { origin: 'https://app.test' }));
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.equal(text.includes(PROJECT_KEY), false);
  assert.deepEqual(JSON.parse(text), { error: 'upstream' });
});

test('relay maps upstream status codes for the browser', async () => {
  const origin = { origin: 'https://app.test' };
  const rateLimited = makeRelay({ stub: { status: 429 } });
  assert.equal(
    (await rateLimited.relay.POST(relayRequest({ name: 'a', message: 'b' }, origin))).status,
    429,
  );
  assert.deepEqual(
    await (await rateLimited.relay.POST(relayRequest({ name: 'a', message: 'b' }, origin))).json(),
    { error: 'rate_limited' },
  );

  const invalid = makeRelay({ stub: { status: 400 } });
  assert.equal(
    (await invalid.relay.POST(relayRequest({ name: 'a', message: 'b' }, origin))).status,
    400,
  );

  const down = makeRelay({ stub: { rejectWith: new Error('connection refused') } });
  const response = await down.relay.POST(relayRequest({ name: 'a', message: 'b' }, origin));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'upstream' });
});

test('relay rate limit is a bounded fixed window', async () => {
  const { stub, relay } = makeRelay({ rateLimitPerMinute: 2 });
  const origin = { origin: 'https://app.test' };
  assert.equal((await relay.POST(relayRequest({ name: 'a', message: 'b' }, origin))).status, 202);
  assert.equal((await relay.POST(relayRequest({ name: 'a', message: 'b' }, origin))).status, 202);
  const third = await relay.POST(relayRequest({ name: 'a', message: 'b' }, origin));
  assert.equal(third.status, 429);
  assert.deepEqual(await third.json(), { error: 'rate_limited' });
  assert.equal(stub.calls.length, 2, 'rate-limited requests must not reach upstream');
});

test('relay masks inline secrets in client-provided text', async () => {
  const { stub, relay } = makeRelay();
  await relay.POST(
    relayRequest(
      { name: 'Error', message: 'login failed with Bearer abcdef123456' },
      { origin: 'https://app.test' },
    ),
  );
  assert.equal(jsonBody(stub.calls[0]).message, 'login failed with Bearer [redacted]');
});

test('relay masks secrets repeated inside stacks before forwarding', async () => {
  const { stub, relay } = makeRelay();
  await relay.POST(
    relayRequest(
      {
        name: 'Error',
        message: 'upload failed',
        stack:
          'Error: upload failed with Bearer abcdef123456\n    at send (https://app.test/u.js?ver=1:1:2)',
      },
      { origin: 'https://app.test' },
    ),
  );
  const stack = String(jsonBody(stub.calls[0]).stack);
  assert.equal(stack.includes('abcdef123456'), false, 'stack secrets must not reach transport');
  assert.ok(stack.includes('Bearer [redacted]'));
  assert.ok(stack.includes('https://app.test/u.js:1:2'));
});

test('relay drops function metadata before forwarding', async () => {
  const { stub, relay } = makeRelay();
  await relay.POST(
    relayRequest(
      { name: 'Error', message: 'boom', metadata: { fn: () => 1, keep: 1 } },
      { origin: 'https://app.test' },
    ),
  );
  const metadata = jsonBody(stub.calls[0]).metadata as Record<string, unknown>;
  assert.equal('fn' in metadata, false, 'functions must never be serialized');
  assert.equal(metadata.keep, 1);
});

test('relay returns only validated numeric id and groupId from upstream', async () => {
  const noisy = makeRelay({
    stub: { status: 202, body: { id: 5, groupId: 9, token: 'leak-me-12345678', internal: { x: 1 } } },
  });
  const response = await noisy.relay.POST(
    relayRequest({ name: 'a', message: 'b' }, { origin: 'https://app.test' }),
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { id: 5, groupId: 9 });

  const nonNumeric = makeRelay({ stub: { status: 202, body: { id: 'not-a-number', groupId: 9 } } });
  const partial = await nonNumeric.relay.POST(
    relayRequest({ name: 'a', message: 'b' }, { origin: 'https://app.test' }),
  );
  assert.deepEqual(await partial.json(), { groupId: 9 });

  const empty = makeRelay({ stub: { status: 202, body: { hello: 'world' } } });
  const fallback = await empty.relay.POST(
    relayRequest({ name: 'a', message: 'b' }, { origin: 'https://app.test' }),
  );
  assert.deepEqual(await fallback.json(), { ok: true });
});

test('relay does not hang on a stalled or partial upstream 202 body', async () => {
  const stalledFetch: FetchLike = () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":1,"group'));
        // Deliberately never closes: the relay must time out, not hang.
      },
    });
    return Promise.resolve(new Response(body, { status: 202 }));
  };
  const stalled = createBrowserRelay({
    endpoint: ENDPOINT,
    projectKey: PROJECT_KEY,
    fetch: stalledFetch,
    timeoutMs: 50,
  });
  const started = Date.now();
  const response = await stalled.POST(
    relayRequest({ name: 'a', message: 'b' }, { origin: 'https://app.test' }),
  );
  assert.ok(Date.now() - started < 5000, 'stalled upstream body must resolve finitely');
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true });

  const truncated = makeRelay({ stub: { status: 202, body: '{"id":' } });
  const closed = await truncated.relay.POST(
    relayRequest({ name: 'a', message: 'b' }, { origin: 'https://app.test' }),
  );
  assert.equal(closed.status, 202);
  assert.deepEqual(await closed.json(), { ok: true });
});
