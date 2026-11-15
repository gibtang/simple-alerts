import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  readBoundedBody,
  BodyTooLargeError,
  BodyTimeoutError,
  BodyUnreadableError,
} from './body';

function trackedStream(chunks: Uint8Array[]): { stream: ReadableStream<Uint8Array>; cancelled: string[] } {
  const cancelled: string[] = [];
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
      } else {
        controller.close();
      }
    },
    cancel(reason) {
      cancelled.push(String(reason));
    },
  });
  return { stream, cancelled };
}

function requestWith(body: BodyInit | null): Request {
  return new Request('https://alerts.example.com/api/ingest', {
    method: 'POST',
    body,
    // @ts-expect-error duplex is required for streaming request bodies
    duplex: 'half',
  });
}

test('reads a body under the cap as UTF-8 text', async () => {
  const req = requestWith(JSON.stringify({ name: 'Err', message: 'boom' }));
  const text = await readBoundedBody(req, 64 * 1024);
  assert.deepEqual(JSON.parse(text), { name: 'Err', message: 'boom' });
});

test('a missing body reads as empty text', async () => {
  const req = requestWith(null);
  assert.equal(await readBoundedBody(req, 1024), '');
});

test('declared Content-Length over the cap rejects before touching the stream', async () => {
  let pulled = false;
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      pulled = true;
      controller.enqueue(new TextEncoder().encode('tiny'));
    },
  }, { highWaterMark: 0 });
  const req = {
    headers: new Headers({ 'content-length': String(64 * 1024 + 1) }),
    body: stream,
  };
  await assert.rejects(readBoundedBody(req, 64 * 1024), BodyTooLargeError);
  assert.equal(pulled, false, 'stream must not be consumed when Content-Length over-declares');
});

test('oversize is enforced mid-stream and the stream is cancelled', async () => {
  const encoder = new TextEncoder();
  const first = encoder.encode('x'.repeat(60 * 1024));
  const second = encoder.encode('x'.repeat(10 * 1024)); // pushes total past 64 KiB
  const { stream, cancelled } = trackedStream([first, second]);
  const req = requestWith(stream);
  await assert.rejects(readBoundedBody(req, 64 * 1024), BodyTooLargeError);
  assert.equal(cancelled.length, 1, 'oversized stream must be cancelled');
});

test('a stalled body hits the read deadline and is cancelled', async () => {
  const cancelled: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start() {
      // Never enqueues and never closes: sender stalls.
    },
    cancel(reason) {
      cancelled.push(String(reason));
    },
  });
  const req = requestWith(stream);
  await assert.rejects(readBoundedBody(req, 1024, { timeoutMs: 30 }), BodyTimeoutError);
  assert.equal(cancelled.length, 1, 'stalled stream must be cancelled');
});

test('a stream that errors surfaces as unreadable', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('connection reset'));
    },
  });
  await assert.rejects(readBoundedBody(requestWith(stream), 1024), BodyUnreadableError);
});

test('multi-byte characters split across chunk boundaries decode correctly', async () => {
  const encoder = new TextEncoder();
  const full = encoder.encode('{"name":"报错💥"}');
  const { stream } = trackedStream([full.slice(0, 5), full.slice(5, 12), full.slice(12)]);
  const req = requestWith(stream);
  const text = await readBoundedBody(req, 1024);
  assert.deepEqual(JSON.parse(text), { name: '报错💥' });
});
