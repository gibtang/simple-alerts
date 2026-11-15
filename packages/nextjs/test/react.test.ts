import assert from 'node:assert/strict';
import test from 'node:test';
import { reportErrorOnce } from '../src/browser/react.js';
import { installAlerts } from '../src/browser.js';
import { createFetchStub, delay, jsonBody } from './helpers.js';

test('reportErrorOnce uploads an error object at most once', async (t) => {
  const stub = createFetchStub({ status: 202 });
  const cleanup = installAlerts({ fetch: stub.fetch });
  t.after(cleanup);
  const error = new Error('boundary boom');

  assert.equal(reportErrorOnce(error), true);
  await delay(10);
  assert.equal(stub.calls.length, 1);

  assert.equal(reportErrorOnce(error), false, 'same error object must not re-upload');
  assert.equal(reportErrorOnce(error), false);
  await delay(10);
  assert.equal(stub.calls.length, 1, 'dedupe must survive repeated calls');
  assert.equal(jsonBody(stub.calls[0]).message, 'boundary boom');

  assert.equal(reportErrorOnce(new Error('different boom')), true);
  await delay(10);
  assert.equal(stub.calls.length, 2);
});

test('reportErrorOnce reports primitive errors each time', async (t) => {
  const stub = createFetchStub({ status: 202 });
  const cleanup = installAlerts({ fetch: stub.fetch });
  t.after(cleanup);
  assert.equal(reportErrorOnce('first string failure'), true);
  assert.equal(reportErrorOnce('second string failure'), true);
  await delay(10);
  assert.equal(stub.calls.length, 2);
  assert.equal(jsonBody(stub.calls[0]).message, 'first string failure');
});

test('a dropped report is not permanently deduped', async (t) => {
  const hang = createFetchStub({ hangUntilAbort: true });
  const cleanup = installAlerts({ fetch: hang.fetch, timeoutMs: 20, maxInFlight: 1 });
  t.after(cleanup);

  assert.equal(reportErrorOnce(new Error('queue filler')), true, 'first report fills the only slot');
  const dropped = new Error('boundary boom');
  assert.equal(reportErrorOnce(dropped), false, 'an over-cap report is dropped without being marked');

  await delay(80);
  assert.equal(reportErrorOnce(dropped), true, 'the dropped object is retriable after the queue drains');
  assert.equal(reportErrorOnce(dropped), false, 'a successfully queued object stays deduped');
  await delay(10);
  const boundaryCalls = hang.calls.filter((call) => jsonBody(call).message === 'boundary boom');
  assert.equal(boundaryCalls.length, 1);
});
