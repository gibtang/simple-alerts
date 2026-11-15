import { buildEvent, errorInfo } from './shared/error.js';
import { fitEvent, MAX_PAYLOAD_BYTES } from './shared/payload.js';
import { maskSecrets, sanitizeMetadata, sanitizeStack, sanitizeUrl } from './shared/sanitize.js';
import { resolveFetch } from './shared/runtime.js';
import type { EventInput, FetchLike } from './shared/types.js';

export type { AlertSource, EventInput, FetchLike } from './shared/types.js';

/** Default deadline for the upstream ingestion POST. */
export const DEFAULT_RELAY_TIMEOUT_MS = 5000;
/**
 * Default relay rate limit: fixed window per process/instance. Upstream
 * ingestion remains the authoritative limiter; this protects the origin from
 * browser floods without trusting any client identity.
 */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

export interface BrowserRelayOptions {
  /** Ingestion endpoint, e.g. https://alerts.example.com/api/ingest */
  endpoint: string;
  /** Project key, held server-side only; never sent to the browser. */
  projectKey: string;
  /** Injectable fetch (tests, proxies). Must honor init.signal. */
  fetch?: FetchLike;
  /** Deadline covering the request-body read and the upstream POST through its response body. Default 5000ms. */
  timeoutMs?: number;
  /** Maximum accepted request body AND forwarded payload, in bytes. Default 64 KiB. */
  maxBytes?: number;
  /** Fixed-window global rate limit (requests/minute). Default 120. */
  rateLimitPerMinute?: number;
  /** Extra origins accepted besides the relay route's own origin. */
  allowedOrigins?: string[];
}

export interface BrowserRelay {
  /** Mount as `export const POST = relay.POST` in app/api/alerts/route.ts. */
  POST: (request: Request) => Promise<Response>;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function selfOriginOf(request: Request): string | null {
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Hard cap on how many upstream response bytes are read. The ingestion reply
 * is a tiny JSON object; anything larger is treated as unusable.
 */
const MAX_UPSTREAM_RESPONSE_BYTES = 16 * 1024;

interface UpstreamOutcome {
  /** HTTP status when a response arrived; 0 when fetch failed or timed out. */
  status: number;
  /** Parsed JSON body when it arrived complete and parseable, else undefined. */
  data: unknown;
  /** True when fetch itself rejected or the deadline hit before a response. */
  failed: boolean;
}

type StreamReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'deadline' | 'too_large' | 'read_error' };

function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => {});
}

/**
 * Reads a web stream incrementally with a hard byte cap and one total
 * deadline (an absolute point in time, so chunk pacing cannot extend it).
 * The cap is enforced per chunk BEFORE buffering, so an oversized stream is
 * cancelled instead of being absorbed into memory, and a stream that stalls
 * or never closes still resolves once the deadline passes.
 */
async function readStreamBounded(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  deadlineAt: number,
): Promise<StreamReadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
  let timedOut = false;
  const { promise: deadlinePromise, reject: rejectDeadline } = Promise.withResolvers<never>();
  controller.signal.addEventListener(
    'abort',
    () => {
      timedOut = true;
      rejectDeadline(new Error('read deadline exceeded'));
    },
    { once: true },
  );
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (Date.now() >= deadlineAt) {
        cancelQuietly(reader);
        return { ok: false, reason: 'deadline' };
      }
      const read = reader.read();
      read.catch(() => undefined); // race loser may reject later; never unhandled
      const result = await Promise.race([read, deadlinePromise]);
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > maxBytes) {
        cancelQuietly(reader);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(result.value);
    }
  } catch {
    cancelQuietly(reader);
    return { ok: false, reason: timedOut ? 'deadline' : 'read_error' };
  } finally {
    clearTimeout(timer);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

/**
 * Posts to the upstream ingestion endpoint under one absolute deadline that
 * covers the fetch AND the bounded read of its response body, so a stalled
 * or oversized upstream reply can never hang the relay.
 */
async function postUpstream(
  fetchFn: FetchLike,
  endpoint: string,
  projectKey: string,
  body: string,
  deadlineAt: number,
): Promise<UpstreamOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));
  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${projectKey}`,
      },
      body,
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return { status: 0, data: undefined, failed: true };
  }
  try {
    const reader = response.body?.getReader();
    if (!reader) {
      return { status: response.status, data: undefined, failed: false };
    }
    const read = await readStreamBounded(reader, MAX_UPSTREAM_RESPONSE_BYTES, deadlineAt);
    let data: unknown;
    if (read.ok && read.text.length > 0) {
      try {
        data = JSON.parse(read.text);
      } catch {
        // Partial, truncated, or non-JSON upstream body: no usable data.
        data = undefined;
      }
    }
    return { status: response.status, data, failed: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Creates a same-origin relay for browser events.
 *
 * The host application mounts the returned `POST` handler at a same-origin
 * route (default `/api/alerts`). The relay:
 * - requires a same-origin (or explicitly allowed) Origin header; requests
 *   without an Origin, with opaque `Origin: null`, or from foreign origins
 *   are rejected,
 * - enforces a fixed-window rate limit with O(1) memory,
 * - rejects bodies over `maxBytes` (default 64 KiB) by header and by
 *   incremental read: oversized streams are cancelled before being buffered
 *   and stalled streams hit the request deadline instead of hanging,
 * - re-sanitizes everything (defense in depth: URLs, stacks, metadata,
 *   inline secrets), strips every client-controlled field it does not
 *   recognize, and forces `source: 'browser'` so a browser can never
 *   forge server-sourced events,
 * - forwards to the ingestion endpoint with the server-held project key,
 * - maps upstream outcomes: 2xx -> 202 with only the validated numeric
 *   `id`/`groupId` fields from the ingestion response (never raw upstream
 *   fields), 400/413/429 pass through as generic errors, everything else
 *   (auth failures, upstream outages, timeouts) collapses to 502 so the
 *   browser learns nothing about the key or the upstream.
 */
export function createBrowserRelay(options: BrowserRelayOptions): BrowserRelay {
  if (!options || typeof options.endpoint !== 'string' || options.endpoint.length === 0) {
    throw new TypeError('createBrowserRelay: options.endpoint must be a non-empty string.');
  }
  if (typeof options.projectKey !== 'string' || options.projectKey.length === 0) {
    throw new TypeError('createBrowserRelay: options.projectKey must be a non-empty string.');
  }
  const { endpoint, projectKey } = options;
  const fetchFn = resolveFetch(options.fetch);
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_RELAY_TIMEOUT_MS);
  const maxBytes = positiveNumber(options.maxBytes, MAX_PAYLOAD_BYTES);
  const rateLimit = positiveNumber(options.rateLimitPerMinute, DEFAULT_RATE_LIMIT_PER_MINUTE);
  const allowedOrigins = Array.isArray(options.allowedOrigins) ? options.allowedOrigins : [];

  let windowCount = 0;
  let windowStartedAt = Date.now();
  const allowRequest = (): boolean => {
    const now = Date.now();
    if (now - windowStartedAt >= 60_000) {
      windowStartedAt = now;
      windowCount = 0;
    }
    if (windowCount >= rateLimit) {
      return false;
    }
    windowCount += 1;
    return true;
  };

  const POST = async (request: Request): Promise<Response> => {
    try {
      // Cross-origin and missing Origin headers are both rejected: the relay
      // only accepts same-origin (or explicitly allowed) browser posts.
      const origin = request.headers.get('origin');
      const selfOrigin = selfOriginOf(request);
      if (origin === null || (origin !== selfOrigin && !allowedOrigins.includes(origin))) {
        return jsonResponse(403, { error: 'forbidden' });
      }
      if (!allowRequest()) {
        return jsonResponse(429, { error: 'rate_limited' });
      }

      const contentLength = Number(request.headers.get('content-length') ?? '0');
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        return jsonResponse(413, { error: 'too_large' });
      }
      // Read incrementally: the byte cap applies per chunk before buffering,
      // oversize streams are cancelled, and stalled or never-closing streams
      // hit the request deadline (timeoutMs) instead of hanging the handler.
      const deadlineAt = Date.now() + timeoutMs;
      let raw = '';
      if (request.body) {
        const read = await readStreamBounded(request.body.getReader(), maxBytes, deadlineAt);
        if (!read.ok) {
          if (read.reason === 'too_large') {
            return jsonResponse(413, { error: 'too_large' });
          }
          return jsonResponse(400, { error: 'invalid' });
        }
        raw = read.text;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return jsonResponse(400, { error: 'invalid' });
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return jsonResponse(400, { error: 'invalid' });
      }
      const body = parsed as Record<string, unknown>;
      const name =
        typeof body.name === 'string' && body.name.length > 0
          ? maskSecrets(body.name)
          : undefined;
      const message =
        typeof body.message === 'string' && body.message.length > 0
          ? maskSecrets(body.message)
          : undefined;
      if (name === undefined || message === undefined) {
        return jsonResponse(400, { error: 'invalid' });
      }

      const rawStack = typeof body.stack === 'string' ? sanitizeStack(body.stack) : undefined;
      const rawUrl =
        typeof body.url === 'string' && body.url.length > 0
          ? body.url
          : request.headers.get('referer');
      const url = rawUrl ? sanitizeUrl(rawUrl) : undefined;
      const metadata = sanitizeMetadata(body.metadata);

      const event: EventInput = { name, message, source: 'browser' };
      if (rawStack) {
        event.stack = rawStack;
      }
      if (url) {
        event.url = url;
      }
      if (metadata) {
        event.metadata = metadata;
      }

      const payload = fitEvent(event, maxBytes);
      const upstream = await postUpstream(fetchFn, endpoint, projectKey, payload, deadlineAt);

      if (upstream.failed) {
        return jsonResponse(502, { error: 'upstream' });
      }
      if (upstream.status >= 200 && upstream.status < 300) {
        // Only validated numeric ids cross back to the browser; arbitrary
        // upstream response fields are never forwarded.
        const result: Record<string, unknown> = {};
        if (
          upstream.data !== null &&
          typeof upstream.data === 'object' &&
          !Array.isArray(upstream.data)
        ) {
          const { id, groupId } = upstream.data as Record<string, unknown>;
          if (typeof id === 'number' && Number.isFinite(id)) {
            result.id = id;
          }
          if (typeof groupId === 'number' && Number.isFinite(groupId)) {
            result.groupId = groupId;
          }
        }
        if (result.id === undefined && result.groupId === undefined) {
          // Upstream accepted the event but sent no usable body.
          result.ok = true;
        }
        return jsonResponse(202, result);
      }
      if (upstream.status === 400) {
        return jsonResponse(400, { error: 'invalid' });
      }
      if (upstream.status === 413) {
        return jsonResponse(413, { error: 'too_large' });
      }
      if (upstream.status === 429) {
        return jsonResponse(429, { error: 'rate_limited' });
      }
      return jsonResponse(502, { error: 'upstream' });
    } catch {
      return jsonResponse(500, { error: 'internal' });
    }
  };

  return { POST };
}
