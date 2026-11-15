/**
 * Shared wire types for @simple-alerts/nextjs.
 *
 * `EventInput` mirrors the Simple Alerts ingestion payload exactly:
 * POST /api/ingest with `Authorization: Bearer PROJECT_KEY`.
 */

export type AlertSource = 'server' | 'browser';

export interface EventInput {
  name: string;
  message: string;
  stack?: string;
  source: AlertSource;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface EventContext {
  /** Overrides the reported error name. */
  name?: string;
  /** Overrides the reported message. */
  message?: string;
  /** Raw URL associated with the event; query and fragment are stripped before upload. */
  url?: string;
  /** Structured metadata; recursively redacted before upload. */
  metadata?: Record<string, unknown>;
}

/**
 * Minimal fetch shape used everywhere in the SDK. Callers may inject their own
 * implementation (tests, proxies, custom agents). The injected fetch MUST honor
 * `init.signal` (all standard fetch implementations do).
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
