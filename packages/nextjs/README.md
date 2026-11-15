# @simple-alerts/nextjs

Privacy-first error reporting for Next.js App Router applications (Next 15/16, React 19). Part of [Simple Alerts](../../README.md).

Four entry points:

| Import | Runtime | Purpose |
| --- | --- | --- |
| `@simple-alerts/nextjs` | Server (Node or Edge) | `createReporter`: `captureException` + Next-compatible `onRequestError` |
| `@simple-alerts/nextjs/browser` | Browser | `installAlerts` / `captureException` / `captureMessage`: automatic + explicit capture |
| `@simple-alerts/nextjs/browser/react` | Browser (React) | `AlertsErrorBoundary`, `useReportError`, `reportErrorOnce` for `error.tsx` / `global-error.tsx` |
| `@simple-alerts/nextjs/relay` | Server (Node or Edge) | `createBrowserRelay`: same-origin route that forwards browser events while keeping the project key server-side |

No runtime dependencies. The Node runtime requires Node.js 22 or newer; the dashboard requires Node.js 24 LTS. `next` and `react` are optional peer dependencies. The server and relay entries never import React or Node builtins and also work in Edge runtimes with the standard fetch and stream APIs.

## How the pieces fit

```
Server code ── createReporter().captureException ─────────► https://alerts.example.com/api/ingest
                                                            (Authorization: Bearer PROJECT_KEY)
instrumentation.ts onRequestError ────────────────────────► same endpoint

Browser code ─ installAlerts() / captureException ── POST ► /api/alerts  (same-origin, no key)
                                              app/api/alerts/route.ts = createBrowserRelay()
                                                   relay ── fetch ──► https://alerts.example.com/api/ingest
                                                                        (key attached server-side)
```

The browser never sees the project key. The relay injects it server-side.

## Install

The package is not published to npm. From the Simple Alerts checkout:

```sh
npm run build:sdk
npm pack --workspace @simple-alerts/nextjs
```

Then install the generated archive in your monitored application:

```sh
npm install /absolute/path/to/simple-alerts-nextjs-0.1.0.tgz
```

The package uses plain `tsc`, ESM output with explicit extensions, and type declarations in `dist/`.

## Server reporting

### `instrumentation.ts` (Next 15/16 App Router)

```ts
import { createReporter } from '@simple-alerts/nextjs';

export const onRequestError = createReporter({
  endpoint: process.env.ALERTS_ENDPOINT ?? 'https://alerts.example.com/api/ingest',
  projectKey: process.env.ALERTS_PROJECT_KEY ?? '',
}).onRequestError;
```

`onRequestError(error, request, context)` is awaited by Next; the SDK reports `source: 'server'` with the request path stripped of query and fragment, the route context (`routerKind`, `routePath`, `routeType`, `revalidateReason`) as metadata, and no headers or cookies. Request headers are never read.

### Manual capture anywhere on the server

```ts
import { createReporter } from '@simple-alerts/nextjs';

const reporter = createReporter({
  endpoint: process.env.ALERTS_ENDPOINT!,
  projectKey: process.env.ALERTS_PROJECT_KEY!,
});

await reporter.captureException(error, {
  url: request.url, // optional; query/fragment stripped before upload
  metadata: { orderId: order.id }, // recursively redacted before upload
});
```

`captureException` resolves `true` on a 2xx response and `false` on any failure — timeout, network error, non-2xx, unusable input. It never throws and never rejects, so the host application keeps its original error regardless of what happens to reporting. Failures are not retried and not logged (the reporter contains no secrets and produces no logs).

### Reporter options

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `endpoint` | `string` | — | Required. Ingestion URL. |
| `projectKey` | `string` | — | Required. Server-side only. |
| `fetch` | `FetchLike` | `globalThis.fetch` | Injectable for tests/proxies. Must honor `init.signal`. |
| `timeoutMs` | `number` | `5000` | Finite deadline per report. |
| `maxBytes` | `number` | `65536` | Hard payload ceiling; larger payloads degrade (see limits). |

## Browser capture

Install once in a client component that mounts for the whole app:

```tsx
'use client';
// components/AlertsClient.tsx
import { useEffect } from 'react';
import { installAlerts } from '@simple-alerts/nextjs/browser';

export function AlertsClient() {
  useEffect(() => installAlerts({ metadata: { release: process.env.NEXT_PUBLIC_RELEASE } }), []);
  return null;
}
```

Mount `<AlertsClient />` in `app/layout.tsx`. `installAlerts`:

- captures `window` `error` and `unhandledrejection` events automatically,
- is idempotent — a second call returns the existing cleanup instead of adding duplicate listeners,
- returns a cleanup function (safe to call twice) that removes automatic listeners; explicit capture keeps the last configured options so `global-error.tsx` can report after root-layout teardown,
- posts to the same-origin relay path (default `/api/alerts`) with `mode: 'same-origin'`, `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, and `keepalive: true` so in-flight reports survive navigation,
- never references a project key — there is no key option at all.

Explicit capture works with or without installed listeners:

```ts
import { captureException, captureMessage } from '@simple-alerts/nextjs/browser';

try {
  risky();
} catch (error) {
  captureException(error, { metadata: { cartId } }); // returns true if queued, false if dropped
}
captureMessage('checkout', 'payment retry scheduled');
```

`captureException` / `captureMessage` are synchronous fire-and-forget; `true` means queued, `false` means dropped (no fetch available or over the in-flight cap). Errors thrown by the reporting code itself are swallowed and never re-enter `window.onerror`.

### Browser options

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `path` | `string` | `'/api/alerts'` | Must start with `/`; same-origin only. |
| `timeoutMs` | `number` | `5000` | Per-report deadline via `AbortController`. |
| `maxBytes` | `number` | `65536` | Payload ceiling per report. |
| `maxInFlight` | `number` | `10` | Concurrent posts; further captures return `false`. |
| `captureUnhandled` | `boolean` | `true` | Set `false` for explicit-capture-only mode. |
| `fetch` | `FetchLike` | `globalThis.fetch` | Injectable for tests. Must honor `init.signal`. |
| `metadata` | `Record<string, unknown>` | — | Static context sanitized and merged into every capture. |

## React error boundaries (`error.tsx` / `global-error.tsx`)

```tsx
'use client';
// app/error.tsx
import { AlertsErrorBoundary } from '@simple-alerts/nextjs/browser/react';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AlertsErrorBoundary error={error} reset={reset} />;
}
```

```tsx
'use client';
// app/global-error.tsx
import { AlertsErrorBoundary } from '@simple-alerts/nextjs/browser/react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html>
      <body>
        <AlertsErrorBoundary error={error} reset={reset} />
      </body>
    </html>
  );
}
```

The component reports each distinct error object at most once (`Object.is` identity + a `WeakSet`, so React StrictMode's double effects in development do not double-report), then renders a minimal fallback with a **Try again** button wired to `reset`. Error details are never rendered — messages can contain secrets.

For custom boundaries, `useReportError(error)` reports once per render pass, and `reportErrorOnce(error)` exposes the same dedupe for `componentDidCatch` in existing class boundaries.

## Relay route (required for browser capture)

The browser posts to your app; your app forwards to the ingestion server with the key:

```ts
// app/api/alerts/route.ts
import { createBrowserRelay } from '@simple-alerts/nextjs/relay';

const relay = createBrowserRelay({
  endpoint: process.env.ALERTS_ENDPOINT!,
  projectKey: process.env.ALERTS_PROJECT_KEY!,
});

export const POST = relay.POST;
export const runtime = 'nodejs'; // 'edge' works too: fetch-only, no Node builtins
export const dynamic = 'force-dynamic';
```

The relay handler:

- requires a same-origin `Origin` header (or one of `allowedOrigins`), rejecting others with 403,
- enforces a fixed-window rate limit with O(1) memory (default 120 requests/minute per instance; per-isolate on Edge — upstream ingestion remains the authoritative limiter),
- rejects bodies over `maxBytes` (default 64 KiB) before buffering them, using declared length and an incremental stream reader; stalled request bodies hit a finite deadline,
- parses and validates `{ name, message }` (400 otherwise), then re-sanitizes everything — URLs (origin + path), stacks (query/fragment stripped), metadata (recursive redaction), inline secret masking — and **forces `source: 'browser'`** so browsers cannot forge server-sourced events,
- forwards only the fields it understands; `authorization`, `cookies`, and any other client-controlled fields are dropped,
- maps upstream results: 2xx → 202 with validated numeric `id`/`groupId` fields, or `{ ok: true }` when no usable IDs arrive; 400/413/429 → the same status with a generic `{ error }` body; upstream 401, 5xx, fetch failures, and timeouts before response headers become 502 `{ error: 'upstream' }`. Response-body reads are bounded to 16 KiB and share the same deadline.

### Relay options

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `endpoint` | `string` | — | Required. Ingestion URL. |
| `projectKey` | `string` | — | Required. Server-side only; never sent to the browser. |
| `fetch` | `FetchLike` | `globalThis.fetch` | Injectable. Must honor `init.signal`. |
| `timeoutMs` | `number` | `5000` | Total deadline across request reading, upstream POST, and response reading. |
| `maxBytes` | `number` | `65536` | Request-body and forwarded-payload ceiling. |
| `rateLimitPerMinute` | `number` | `120` | Fixed window, per relay instance. |
| `allowedOrigins` | `string[]` | `[]` | Extra origins besides the route's own. |

## Privacy model

Applied before anything is serialized or uploaded:

- **URLs** are reduced to origin + path. Query strings and fragments never leave the app — in `url`, in stack frames, or embedded inside message/metadata text (best-effort masking).
- **Metadata** is walked recursively: headers, bodies, request/response header and body containers, and cookies are discarded. Keys matching `password`, `secret`, `token`, `apiKey`, `authorization`, `credential`, `session`, `privateKey`, `ssn`, card numbers, `bearer`, `jwt`, and close variants are removed at any depth; string values are masked for inline secrets.
- **No cookies, headers, referrer values, or identity data** are collected. Browser posts send no credentials; the relay reads the `referer` header only to derive a sanitized page URL.
- **Errors are data**: name, message, stack, and your metadata. No source maps are uploaded, and there is no performance tracing, breadcrumbs, session replay, or billing.

## Transport limits

| Boundary | Value |
| --- | --- |
| Payload ceiling (all SDK paths) | 64 KiB, enforced by stepped degradation: full event → drop metadata → cap stack (4 KiB) → cap message (2 KiB → 500 → 200 chars) |
| Metadata bounds | depth 8, 50 keys/object, 50 items/array, 2000 chars/string |
| Stack bounds | 8000 chars, URLs stripped of query/fragment |
| Timeouts | 5000 ms per report; relay shares one deadline across request reading, upstream POST, and bounded response reading |
| Browser concurrency | 10 in-flight posts; excess captures dropped (`false`) |
| Relay rate limit | 120 requests/minute, fixed window, per instance |
| Ingestion limit | 64 KiB (`413` beyond), matching the SDK ceiling |

## Honest failure guarantees

Capture is **best effort, at most once per call**:

- No guarantee for process kills, power loss, `SIGKILL`, browsers closed mid-flight, or devices offline — `keepalive` helps but cannot promise delivery.
- Errors your code catches and does not report are never captured; unhandled-rejection reporting depends on the runtime firing the event.
- Failures resolve to `false` and are not retried or queued; there is no exact-once or at-least-once delivery. The server deduplicates and coalesces, but the SDK does not claim exact-once.

## Building and testing

```sh
npm run build -w @simple-alerts/nextjs   # tsc -> dist/ (ESM, explicit .js extensions, .d.ts)
npm test -w @simple-alerts/nextjs        # node:test via tsx
```

## License

MIT — see [LICENSE](./LICENSE).
