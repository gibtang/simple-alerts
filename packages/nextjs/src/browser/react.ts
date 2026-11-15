'use client';

import { createElement, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { captureException } from '../browser.js';

/**
 * Errors already reported, tracked by object identity so a single error
 * object is never uploaded twice — including React StrictMode's intentional
 * double-invocation of effects in development.
 */
const reportedErrors = new WeakSet<object>();

/**
 * Reports an error at most once per error object identity. Returns `true`
 * when a fresh report was queued; `false` when it was already reported or
 * the capture was dropped — a dropped attempt is not marked, so the same
 * object can be retried (e.g. after the in-flight queue drains). Never
 * throws. Exposed for custom integrations (e.g. inside `componentDidCatch`
 * of an existing class boundary).
 */
export function reportErrorOnce(error: unknown): boolean {
  try {
    if (error !== null && typeof error === 'object') {
      if (reportedErrors.has(error)) {
        return false;
      }
      if (!captureException(error)) {
        return false;
      }
      reportedErrors.add(error);
      return true;
    }
    return captureException(error);
  } catch {
    return false;
  }
}

/**
 * Reports the given error once per distinct error object. Re-renders with
 * the same error object are skipped, so Next error boundaries can call it
 * safely on every render pass. A capture that was dropped stays unmarked
 * and is retried on the next render pass.
 */
export function useReportError(error: unknown): void {
  const lastReported = useRef<unknown>(undefined);
  useEffect(() => {
    if (lastReported.current === error) {
      return;
    }
    if (!reportErrorOnce(error)) {
      return;
    }
    lastReported.current = error;
  });
}

export interface AlertsErrorBoundaryProps {
  /** The error passed to the Next error boundary component. */
  error: unknown;
  /** Next's reset callback; renders a "Try again" button when provided. */
  reset?: () => void;
  /** Rendered instead of the default fallback when provided. */
  fallback?: ReactNode;
  /** Heading for the default fallback. Never renders error details. */
  title?: string;
}

/**
 * Ready-made body for Next.js App Router error boundaries (`error.tsx`,
 * `global-error.tsx`) and any client component boundary. Reports the error
 * once via the browser SDK, then renders a minimal fallback with a reset
 * action. Error details are never rendered — message text can carry secrets.
 *
 * Usage in `app/error.tsx`:
 *
 * ```tsx
 * 'use client';
 * import { AlertsErrorBoundary } from '@simple-alerts/nextjs/browser/react';
 *
 * export default function Error({ error, reset }: { error: Error; reset: () => void }) {
 *   return <AlertsErrorBoundary error={error} reset={reset} />;
 * }
 * ```
 */
export function AlertsErrorBoundary(props: AlertsErrorBoundaryProps): ReactNode {
  useReportError(props.error);
  if (props.fallback !== undefined) {
    return props.fallback;
  }
  return createElement(
    'div',
    { role: 'alert', style: { padding: '1.5rem', fontFamily: 'system-ui, sans-serif' } },
    createElement('p', { style: { margin: '0 0 1rem', fontWeight: 600 } }, props.title ?? 'Something went wrong'),
    createElement(
      'p',
      { style: { margin: '0 0 1rem', color: '#666' } },
      'You can retry, or reload the page.',
    ),
    typeof props.reset === 'function'
      ? createElement(
          'button',
          { type: 'button', onClick: props.reset, style: { padding: '0.5rem 1rem', cursor: 'pointer' } },
          'Try again',
        )
      : null,
  );
}

export default AlertsErrorBoundary;
