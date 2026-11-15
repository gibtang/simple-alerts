import type { FetchLike } from './types.js';

/**
 * Resolves the fetch implementation: injected first, then the platform
 * global. Throws only when no fetch exists at all (very old runtimes);
 * callers treat that as a permanent reporting failure, never a crash.
 */
export function resolveFetch(injected?: FetchLike): FetchLike {
  if (typeof injected === 'function') {
    return injected;
  }
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== 'function') {
    throw new Error(
      '@simple-alerts/nextjs: global fetch is unavailable; pass a fetch implementation via options.fetch.',
    );
  }
  return candidate as FetchLike;
}
