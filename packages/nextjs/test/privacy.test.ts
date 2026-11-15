import assert from 'node:assert/strict';
import test from 'node:test';
import { maskSecrets, sanitizeMetadata, sanitizeStack, sanitizeUrl } from '../src/shared/sanitize.js';

test('maskSecrets masks bearer tokens in free text', () => {
  assert.equal(
    maskSecrets('connect ECONNREFUSED after Bearer abcdef123456 expired'),
    'connect ECONNREFUSED after Bearer [redacted] expired',
  );
});

test('maskSecrets masks JWTs', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
  assert.equal(maskSecrets(`jwt: ${jwt}!`), 'jwt: [redacted]!');
});

test('maskSecrets masks password assignments', () => {
  assert.equal(
    maskSecrets('login failed for password: hunter2secret with retries'),
    'login failed for password: [redacted] with retries',
  );
});

test('maskSecrets masks query strings inside URLs in text', () => {
  assert.equal(
    maskSecrets('open https://ex.com/pay?token=abc12345 next'),
    'open https://ex.com/pay?[redacted] next',
  );
});

test('maskSecrets masks fragments inside URLs in text', () => {
  assert.equal(
    maskSecrets('doc https://ex.com/guide#password-reset ends'),
    'doc https://ex.com/guide#[redacted] ends',
  );
});

test('sanitizeUrl keeps only origin and path', () => {
  assert.equal(sanitizeUrl('https://app.test/checkout?secret=abc#top'), 'https://app.test/checkout');
});

test('sanitizeUrl drops credentials and query from opaque URLs', () => {
  assert.equal(sanitizeUrl('https://user:pass@app.test/p?token=1#f'), 'https://app.test/p');
});

test('sanitizeUrl falls back to splitting on ? and # for unparseable input', () => {
  assert.equal(sanitizeUrl('not a url?token=1#frag'), 'not a url');
  assert.equal(sanitizeUrl(''), undefined);
});

test('sanitizeStack strips query strings from stack frame URLs and bounds length', () => {
  const stack = [
    'Error: boom',
    '    at foo (/app/x.js:1:2)',
    '    at fetch (https://cdn.test/app.js?ver=1.2:10:5)',
  ].join('\n');
  const cleaned = sanitizeStack(stack);
  assert.ok(cleaned?.includes('https://cdn.test/app.js'));
  assert.equal(cleaned?.includes('?'), false);
  assert.equal(cleaned?.includes('ver=1.2'), false);
  assert.ok(cleaned?.includes('/app/x.js:1:2'));
  const bounded = sanitizeStack('y'.repeat(20000));
  assert.ok(bounded !== undefined && bounded.length <= 8000);
});

test('sanitizeStack masks inline secrets repeated in stack text', () => {
  const stack = [
    'Error: request failed with Bearer abcdef123456',
    '    at send (/app/x.js:1:2)',
  ].join('\n');
  const cleaned = sanitizeStack(stack);
  assert.equal(cleaned?.includes('abcdef123456'), false);
  assert.ok(cleaned?.includes('Bearer [redacted]'));
  assert.ok(cleaned?.includes('/app/x.js:1:2'));
});

test('sanitizeMetadata removes sensitive keys recursively', () => {
  const out = sanitizeMetadata({
    username: 'u',
    password: 'hunter2secret',
    user_token: 't',
    Session: 's',
    Authorization: 'Bearer abcdef123456',
    nested: { api_key: 'k', note: 'keep me' },
    items: [{ token: 't', ok: 1 }],
  }) as Record<string, unknown>;
  assert.equal(out.username, 'u');
  assert.equal('password' in out, false);
  assert.equal('user_token' in out, false);
  assert.equal('Session' in out, false);
  assert.equal('Authorization' in out, false);
  const nested = out.nested as Record<string, unknown>;
  assert.equal('api_key' in nested, false);
  assert.equal(nested.note, 'keep me');
  const item = (out.items as Array<Record<string, unknown>>)[0];
  assert.equal('token' in item, false);
  assert.equal(item.ok, 1);
});

test('sanitizeMetadata masks secret shapes inside kept strings', () => {
  const out = sanitizeMetadata({ note: 'auth Bearer zzzz9999aaaa failed' }) as Record<string, unknown>;
  assert.equal(out.note, 'auth Bearer [redacted] failed');
});

test('sanitizeMetadata survives circular references', () => {
  const value: Record<string, unknown> = { name: 'a' };
  value.self = value;
  const out = sanitizeMetadata(value) as Record<string, unknown>;
  assert.equal(out.name, 'a');
  assert.equal(out.self, '[circular]');
});

test('sanitizeMetadata caps depth', () => {
  let node: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < 12; i += 1) {
    node = { a: node };
  }
  const out = sanitizeMetadata(node) as Record<string, unknown>;
  let current: unknown = out;
  for (let i = 0; i < 8; i += 1) {
    current = (current as Record<string, unknown>).a;
  }
  assert.equal(current, '[depth]');
});

test('sanitizeMetadata bounds arrays and object keys', () => {
  const bigArray = sanitizeMetadata({ arr: Array.from({ length: 60 }, (_, i) => i) }) as Record<
    string,
    unknown
  >;
  const arr = bigArray.arr as unknown[];
  assert.equal(arr.length, 51);
  assert.equal(arr[50], '[10 more]');

  const bigObject: Record<string, number> = {};
  for (let i = 0; i < 60; i += 1) {
    bigObject[`k${i}`] = i;
  }
  const out = sanitizeMetadata(bigObject) as Record<string, unknown>;
  assert.equal(Object.keys(out).length, 51);
  assert.equal(out['[dropped]'], 10);
});

test('sanitizeMetadata drops functions and symbols, normalizes exotics', () => {
  const out = sanitizeMetadata({
    fn: () => 1,
    sym: Symbol('x'),
    nan: Number.NaN,
    big: 10n,
    str: 'x',
  }) as Record<string, unknown>;
  assert.equal('fn' in out, false);
  assert.equal('sym' in out, false);
  assert.equal(out.nan, null);
  assert.equal(out.big, '10');
  assert.equal(out.str, 'x');
});

test('sanitizeMetadata wraps non-object roots', () => {
  assert.deepEqual(sanitizeMetadata('plain'), { value: 'plain' });
  assert.deepEqual(sanitizeMetadata(42), { value: 42 });
  assert.equal(sanitizeMetadata(undefined), undefined);
  assert.equal(sanitizeMetadata(null), undefined);
});
