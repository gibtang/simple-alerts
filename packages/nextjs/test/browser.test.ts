import assert from 'node:assert/strict';
import test from 'node:test';
import { captureException, captureMessage, installAlerts } from '../src/browser.js';
import type { FetchLike } from '../src/shared/types.js';
import { createFetchStub, delay, jsonBody } from './helpers.js';

interface FakeWindow {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  dispatch(type: string, event: unknown): void;
}

function createFakeWindow(): { target: FakeWindow; listeners: Map<string, Array<(event: unknown) => void>> } {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const target: FakeWindow = {
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) {
        list.splice(index, 1);
      }
    },
    dispatch(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener(event);
      }
    },
  };
  return { target, listeners };
}

function listenerCount(listeners: Map<string, Array<unknown>>, type: string): number {
  return (listeners.get(type) ?? []).length;
}

test('browser SDK lifecycle, privacy, and failure boundaries', async (t) => {
  const fake = createFakeWindow();
  Object.assign(globalThis, { window: fake.target });
  Object.assign(globalThis, { location: { href: 'https://app.test/dashboard?token=abc&x=1' } });
  const originalFetch = globalThis.fetch;

  t.after(() => {
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'location');
    Object.assign(globalThis, { fetch: originalFetch });
  });

  await t.test('capture before install uses default same-origin path with no key', async (st) => {
    const stub = createFetchStub({ status: 202 });
    Object.assign(globalThis, { fetch: stub.fetch });
    st.after(() => {
      Object.assign(globalThis, { fetch: originalFetch });
    });

    const queued = captureException(new Error('early boom'));
    assert.equal(queued, true);
    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    assert.equal(call.url, '/api/alerts');
    assert.equal(call.method, 'POST');
    assert.deepEqual(Object.keys(call.headers), ['content-type']);
    const body = jsonBody(call);
    assert.equal(body.source, 'browser');
    assert.equal(body.message, 'early boom');
    assert.equal(body.url, 'https://app.test/dashboard', 'location query must be stripped');
    assert.equal(JSON.stringify(body).includes('token'), false);
  });

  await t.test('install is idempotent and dispatch reports once per error', async (st) => {
    const stub = createFetchStub({ status: 202 });
    const cleanup1 = installAlerts({ fetch: stub.fetch });
    st.after(cleanup1);
    const cleanup2 = installAlerts({ fetch: stub.fetch });
    assert.equal(cleanup1, cleanup2, 'second install must reuse the existing cleanup');
    assert.equal(listenerCount(fake.listeners, 'error'), 1);
    assert.equal(listenerCount(fake.listeners, 'unhandledrejection'), 1);

    fake.target.dispatch('error', { error: new Error('boom from window') });
    fake.target.dispatch('error', { error: new Error('boom from window') });
    await delay(10);
    assert.equal(stub.calls.length, 2, 'duplicate installs must not double-report');
    assert.equal(jsonBody(stub.calls[0]).message, 'boom from window');
  });

  await t.test('unhandledrejection reports the rejection reason', async (st) => {
    const stub = createFetchStub({ status: 202 });
    const cleanup = installAlerts({ fetch: stub.fetch });
    st.after(cleanup);

    fake.target.dispatch('unhandledrejection', { reason: 'bad promise' });
    await delay(10);
    assert.equal(stub.calls.length, 1);
    assert.equal(jsonBody(stub.calls[0]).message, 'bad promise');
    assert.equal(stub.calls[0].url, '/api/alerts');
  });

  await t.test('cleanup removes listeners but explicit capture keeps the last config', async (st) => {
    const stub = createFetchStub({ status: 202 });
    const cleanup = installAlerts({ fetch: stub.fetch, metadata: { area: 'layout' } });
    st.after(cleanup);

    cleanup();
    cleanup();
    assert.equal(listenerCount(fake.listeners, 'error'), 0);
    assert.equal(listenerCount(fake.listeners, 'unhandledrejection'), 0);

    assert.equal(captureException(new Error('after stop')), true, 'manual capture stays usable after cleanup');
    await delay(10);
    assert.equal(stub.calls.length, 1);
    const body = jsonBody(stub.calls[0]);
    assert.equal(body.message, 'after stop');
    assert.deepEqual(body.metadata, { area: 'layout' }, 'cleanup keeps the last configured options');
  });

  await t.test('synchronous fetch failures return false without throwing', (st) => {
    const throwingFetch: FetchLike = () => {
      throw new Error('sync boom');
    };
    const cleanup = installAlerts({ fetch: throwingFetch });
    st.after(cleanup);
    assert.equal(captureException(new Error('boom')), false);
    assert.equal(captureMessage('x', 'y'), false);
  });

  await t.test('in-flight cap drops new reports and drains after timeout', async (st) => {
    const hang = createFetchStub({ hangUntilAbort: true });
    const cleanup = installAlerts({ fetch: hang.fetch, timeoutMs: 20, maxInFlight: 3 });
    st.after(cleanup);
    const results = [1, 2, 3, 4, 5].map(() => captureException(new Error('flood')));
    assert.deepEqual(results, [true, true, true, false, false]);
    await delay(80);
    assert.equal(captureException(new Error('after drain')), true);
    await delay(80);
  });

  await t.test('after cleanup a boundary still reports with the last config, drops are retriable, no listeners return', async (st) => {
    const hang = createFetchStub({ hangUntilAbort: true });
    const cleanup = installAlerts({
      fetch: hang.fetch,
      timeoutMs: 20,
      maxInFlight: 1,
      path: '/relay/alerts',
      metadata: { area: 'root-layout' },
    });
    st.after(cleanup);
    cleanup();

    assert.equal(listenerCount(fake.listeners, 'error'), 0);
    assert.equal(listenerCount(fake.listeners, 'unhandledrejection'), 0);

    assert.equal(captureException(new Error('slot filler')), true, 'explicit capture after cleanup keeps the last config');
    assert.equal(captureException(new Error('boundary boom')), false, 'a capture over the in-flight cap is dropped');

    fake.target.dispatch('error', { error: new Error('auto boom') });
    fake.target.dispatch('unhandledrejection', { reason: 'auto rejection' });
    await delay(10);
    assert.equal(hang.calls.length, 1, 'cleanup must not leave automatic listeners behind');
    assert.equal(hang.calls[0].url, '/relay/alerts');

    await delay(80);
    assert.equal(captureException(new Error('boundary boom')), true, 'a dropped capture is retriable');
    await delay(10);
    const boundaryCalls = hang.calls.filter((call) => jsonBody(call).message === 'boundary boom');
    assert.equal(boundaryCalls.length, 1);
    assert.deepEqual(jsonBody(boundaryCalls[0]).metadata, { area: 'root-layout' });
  });
});
