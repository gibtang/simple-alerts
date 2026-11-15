'use client';

import { buildEvent, errorInfo } from './shared/error.js';
import { fitEvent, MAX_PAYLOAD_BYTES } from './shared/payload.js';
import { sanitizeMetadata, sanitizeUrl } from './shared/sanitize.js';
import type { EventContext, EventInput, FetchLike } from './shared/types.js';

export type { AlertSource, EventInput, FetchLike } from './shared/types.js';
export type { EventContext as CaptureContext } from './shared/types.js';

/** Default same-origin relay path. Must be mounted via app/api/alerts/route.ts. */
export const DEFAULT_RELAY_PATH = '/api/alerts';
/** Default deadline for a single relay POST. */
export const DEFAULT_TIMEOUT_MS = 5000;
/** Maximum simultaneous in-flight posts; further captures are dropped. */
export const DEFAULT_MAX_IN_FLIGHT = 10;

export interface BrowserAlertsOptions {
  /** Same-origin relay path. Must start with "/". Default "/api/alerts". */
  path?: string;
  /** Deadline for a single relay POST. Default 5000ms. */
  timeoutMs?: number;
  /** Hard payload ceiling in bytes. Default 64 KiB. */
  maxBytes?: number;
  /** Maximum simultaneous in-flight posts. Default 10. */
  maxInFlight?: number;
  /** Install window error + unhandledrejection listeners. Default true. */
  captureUnhandled?: boolean;
  /** Injectable fetch (tests). Must honor init.signal. */
  fetch?: FetchLike;
  /** Static metadata merged into every capture, sanitized before upload. */
  metadata?: Record<string, unknown>;
}

interface ResolvedBrowserOptions {
  path: string;
  timeoutMs: number;
  maxBytes: number;
  maxInFlight: number;
  captureUnhandled: boolean;
  fetch: FetchLike | null;
  metadata: Record<string, unknown> | undefined;
}

interface ListenerTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

let activeOptions: ResolvedBrowserOptions | null = null;
let uninstallFn: (() => void) | null = null;
let inFlightCount = 0;

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function softResolveFetch(injected?: FetchLike): FetchLike | null {
  if (typeof injected === 'function') {
    return injected;
  }
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === 'function' ? (candidate as FetchLike) : null;
}

function isListenerTarget(value: unknown): value is ListenerTarget {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  const candidate = value as { addEventListener?: unknown; removeEventListener?: unknown };
  return (
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  );
}

function resolveOptions(options: BrowserAlertsOptions | undefined): ResolvedBrowserOptions {
  const raw = options ?? {};
  const rawPath = typeof raw.path === 'string' ? raw.path : undefined;
  return {
    path: rawPath !== undefined && rawPath.startsWith('/') ? rawPath : DEFAULT_RELAY_PATH,
    timeoutMs: positiveNumber(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxBytes: positiveNumber(raw.maxBytes, MAX_PAYLOAD_BYTES),
    maxInFlight: positiveNumber(raw.maxInFlight, DEFAULT_MAX_IN_FLIGHT),
    captureUnhandled: raw.captureUnhandled !== false,
    fetch: softResolveFetch(raw.fetch),
    metadata: raw.metadata ? (sanitizeMetadata(raw.metadata) ?? undefined) : undefined,
  };
}

/** Current page URL reduced to origin + path; query and fragment never leave. */
function currentUrl(): string | undefined {
  try {
    const href = safeLocationHref();
    return typeof href === 'string' ? sanitizeUrl(href) : undefined;
  } catch {
    return undefined;
  }
}

function safeLocationHref(): unknown {
  try {
    return (globalThis as { location?: { href?: unknown } }).location?.href;
  } catch {
    return undefined;
  }
}

function mergeMetadata(
  staticMetadata: Record<string, unknown> | undefined,
  callMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!staticMetadata && !callMetadata) {
    return undefined;
  }
  return { ...(staticMetadata ?? {}), ...(callMetadata ?? {}) };
}

function sendWith(options: ResolvedBrowserOptions, event: EventInput): boolean {
  const fetchFn = options.fetch;
  if (!fetchFn || inFlightCount >= options.maxInFlight) {
    return false;
  }
  let body: string;
  try {
    body = fitEvent(event, options.maxBytes);
  } catch {
    return false;
  }
  inFlightCount += 1;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const settle = () => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    inFlightCount -= 1;
  };
  try {
    timer = setTimeout(() => controller.abort(), options.timeoutMs);
    fetchFn(options.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
      mode: 'same-origin',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    }).then(settle, settle);
    return true;
  } catch {
    settle();
    return false;
  }
}

/**
 * Last configured options win; before the first install and after cleanup
 * this falls back to defaults, so explicit capture never depends on the
 * automatic-listener lifecycle.
 */
function optionsForCapture(): ResolvedBrowserOptions {
  return activeOptions ?? resolveOptions(undefined);
}

/**
 * Explicitly captures an error. Fire-and-forget: resolves nothing, throws
 * nothing, returns `true` when the report was queued, `false` when dropped
 * (no fetch available or over the in-flight cap). Uses the options from the
 * latest install — retained after cleanup so a global-error fallback can
 * still report — or defaults before the first install.
 */
export function captureException(error: unknown, context: EventContext = {}): boolean {
  try {
    const options = optionsForCapture();
    const event = buildEvent('browser', errorInfo(error), {
      name: context.name,
      message: context.message,
      url: context.url ?? currentUrl(),
      metadata: mergeMetadata(options.metadata, context.metadata),
    });
    return sendWith(options, event);
  } catch {
    return false;
  }
}

/**
 * Explicitly captures a message. Same failure contract as captureException.
 */
export function captureMessage(name: unknown, message: unknown, context: EventContext = {}): boolean {
  try {
    const options = optionsForCapture();
    const info = {
      name: typeof name === 'string' && name.length > 0 ? name : 'Message',
      message: typeof message === 'string' && message.length > 0 ? message : 'Unknown message',
    };
    const event = buildEvent('browser', info, {
      url: context.url ?? currentUrl(),
      metadata: mergeMetadata(options.metadata, context.metadata),
    });
    return sendWith(options, event);
  } catch {
    return false;
  }
}

/**
 * Installs global listeners for `error` and `unhandledrejection`.
 *
 * - Idempotent: a second install while active returns the existing cleanup
 *   instead of adding duplicate listeners.
 * - Returns a cleanup function; calling it twice is safe. Cleanup removes
 *   the automatic listeners only and keeps the last configured options, so
 *   explicit capture keeps working (a root layout can tear down its installer
 *   while a `global-error` fallback still reports with the same config). No
 *   automatic listeners exist again until the next install.
 * - Safe to call where no `window` exists (SSR): still returns a valid
 *   cleanup, explicit capture keeps working with defaults.
 * - All listener bodies are guarded; errors inside the reporter never
 *   re-enter window error handling.
 */
export function installAlerts(options: BrowserAlertsOptions = {}): () => void {
  if (uninstallFn) {
    return uninstallFn;
  }
  const resolved = resolveOptions(options);
  const windowCandidate = (globalThis as { window?: unknown }).window;
  const target = resolved.captureUnhandled && isListenerTarget(windowCandidate) ? windowCandidate : null;

  const onError = (event: unknown) => {
    try {
      const errorEvent = event as { error?: unknown; message?: unknown } | null;
      const reason =
        errorEvent && errorEvent.error !== undefined && errorEvent.error !== null
          ? errorEvent.error
          : typeof errorEvent?.message === 'string' && errorEvent.message.length > 0
            ? errorEvent.message
            : 'Uncaught error';
      captureException(reason);
    } catch {
      // Never let reporting re-enter window error handling.
    }
  };

  const onRejection = (event: unknown) => {
    try {
      const rejectionEvent = event as { reason?: unknown } | null;
      captureException(rejectionEvent && rejectionEvent.reason !== undefined ? rejectionEvent.reason : 'Unhandled rejection');
    } catch {
      // Never let reporting re-enter window error handling.
    }
  };

  if (target) {
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
  }

  activeOptions = resolved;

  let removed = false;
  const uninstall = () => {
    if (removed) {
      return;
    }
    removed = true;
    if (target) {
      try {
        target.removeEventListener('error', onError);
        target.removeEventListener('unhandledrejection', onRejection);
      } catch {
        // Removal is best-effort; the retained options keep explicit capture working.
      }
    }
    uninstallFn = null;
  };
  uninstallFn = uninstall;
  return uninstall;
}
