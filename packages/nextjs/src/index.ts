import {
  buildEvent,
  errorInfo,
  safeField,
  type ErrorInfo,
} from './shared/error.js';
import { fitEvent, MAX_PAYLOAD_BYTES } from './shared/payload.js';
import { resolveFetch } from './shared/runtime.js';
import type { EventContext, EventInput, FetchLike } from './shared/types.js';

export type { AlertSource, EventInput, FetchLike } from './shared/types.js';
export type { EventContext as CaptureContext } from './shared/types.js';

/** Default deadline for a single report POST. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Context Next.js passes to `onRequestError` in instrumentation.ts
 * (Next 15+/16 App Router). Structural on purpose: the SDK never imports
 * `next`, so the reporter works in any runtime and stays type-compatible
 * with Next's expected handler signature.
 */
export interface OnRequestErrorContext {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
  revalidateReason?: string;
}

/**
 * Next-compatible onRequestError handler. Returns a promise that resolves
 * after reporting completes (or fails); it never rejects and never throws,
 * so the host application's error handling is unaffected.
 */
export type OnRequestErrorHandler = (
  error: unknown,
  request: unknown,
  context?: OnRequestErrorContext,
) => Promise<void>;

export interface Reporter {
  /**
   * Reports an error to the ingestion endpoint. Resolves `true` on a 2xx
   * response, `false` on any failure (network, timeout, non-2xx, bad input).
   * Never throws and never rejects.
   */
  captureException(error: unknown, context?: EventContext): Promise<boolean>;
  /** Next-compatible instrumentation handler; see OnRequestErrorHandler. */
  onRequestError: OnRequestErrorHandler;
}

export interface ReporterOptions {
  /** Ingestion endpoint, e.g. https://alerts.example.com/api/ingest */
  endpoint: string;
  /** Project key; server-side only, never shipped to browsers. */
  projectKey: string;
  /** Injectable fetch (tests, proxies). Must honor init.signal. */
  fetch?: FetchLike;
  /** Deadline for a single report POST. Default 5000ms. */
  timeoutMs?: number;
  /** Hard payload ceiling in bytes. Default 64 KiB (matches report limit). */
  maxBytes?: number;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function requestUrl(request: unknown): string | undefined {
  return safeField(() => (request as { path?: unknown } | null | undefined)?.path);
}

function instrumentationMetadata(context: OnRequestErrorContext | undefined): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }
  const metadata: Record<string, unknown> = {};
  if (typeof context.routerKind === 'string') {
    metadata.routerKind = context.routerKind;
  }
  if (typeof context.routePath === 'string') {
    metadata.routePath = context.routePath;
  }
  if (typeof context.routeType === 'string') {
    metadata.routeType = context.routeType;
  }
  if (typeof context.revalidateReason === 'string') {
    metadata.revalidateReason = context.revalidateReason;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Creates a server-side reporter (Node and Edge runtimes; fetch only, no
 * Node builtins). The reporter is fail-safe by contract: every failure mode
 * resolves to `false` so the host application keeps its original error.
 */
export function createReporter(options: ReporterOptions): Reporter {
  if (!options || typeof options.endpoint !== 'string' || options.endpoint.length === 0) {
    throw new TypeError('createReporter: options.endpoint must be a non-empty string.');
  }
  if (typeof options.projectKey !== 'string' || options.projectKey.length === 0) {
    throw new TypeError('createReporter: options.projectKey must be a non-empty string.');
  }
  const fetchFn = resolveFetch(options.fetch);
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBytes = positiveNumber(options.maxBytes, MAX_PAYLOAD_BYTES);
  const { endpoint, projectKey } = options;

  async function post(body: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${projectKey}`,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function captureException(error: unknown, context: EventContext = {}): Promise<boolean> {
    try {
      const info: ErrorInfo = errorInfo(error);
      const event: EventInput = buildEvent('server', info, context);
      const body = fitEvent(event, maxBytes);
      const response = await post(body);
      return response.status >= 200 && response.status < 300;
    } catch {
      // Reporting must never surface into the host application.
      return false;
    }
  }

  async function onRequestError(
    error: unknown,
    request: unknown,
    context?: OnRequestErrorContext,
  ): Promise<void> {
    try {
      await captureException(error, {
        url: requestUrl(request),
        metadata: instrumentationMetadata(context),
      });
    } catch {
      // Never reject: Next awaits this handler and must not see failures.
    }
  }

  return { captureException, onRequestError };
}
