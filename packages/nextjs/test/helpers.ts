import type { FetchLike } from '../src/shared/types.js';

export interface RecordedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, unknown>;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

export interface FetchStubOptions {
  status?: number;
  body?: unknown;
  rejectWith?: unknown;
  hangUntilAbort?: boolean;
}

/**
 * Our SDK always sends plain header objects; Headers/Response instances are
 * never produced by it, so spreading a plain object is safe here.
 */
function normalizeHeaders(headers: unknown): Record<string, unknown> {
  if (headers !== null && typeof headers === 'object' && !Array.isArray(headers)) {
    return { ...(headers as Record<string, unknown>) };
  }
  return {};
}

function record(url: string, init?: RequestInit): RecordedCall {
  return {
    url,
    method: init?.method,
    headers: normalizeHeaders(init?.headers),
    body: typeof init?.body === 'string' ? init.body : undefined,
    signal: init?.signal ?? undefined,
  };
}

export function createFetchStub(options: FetchStubOptions = {}): {
  calls: RecordedCall[];
  fetch: FetchLike;
} {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push(record(url, init));
    if (options.rejectWith !== undefined) {
      return Promise.reject(options.rejectWith);
    }
    if (options.hangUntilAbort) {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      return promise;
    }
    const status = options.status ?? 202;
    const payload =
      options.body === undefined
        ? '{}'
        : typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body);
    return Promise.resolve(new Response(payload, { status }));
  };
  return { calls, fetch };
}

export function jsonBody(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(call.body ?? 'null') as Record<string, unknown>;
}

export function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
