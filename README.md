# Simple Alerts

Self-hosted error alerts for Next.js. Send reports directly to your own server, investigate them in a private dashboard, and receive Telegram notifications. No Sentry account, Google login, Redis, or managed database required.

MIT licensed. One installation serves one operator and multiple monitored projects.

## What it does

- Password-protected dashboard with project filtering, error groups, occurrence details, stack traces, and delivery history.
- YAML configuration, environment references for secrets, and persistent SQLite storage.
- Immediate first alerts and coalesced repeat summaries, once per five-minute window by default.
- Durable Telegram delivery with backoff, rate-limit handling, a 24-hour retry window, and manual retry for failed alerts.
- A reusable Next.js 15/16 App Router integration for server errors, browser errors, React error boundaries, and explicit reports.
- Same-origin browser relay: project reporting keys remain on your application's server.
- Thirty-day local retention by default and best-effort secret redaction before persistence or delivery.

This is an error notification tool, not a full Sentry replacement. It does not upload source maps, reconstruct minified source locations, or monitor performance. Caught errors require explicit reporting. Browser disconnections, process termination, and transport failures can prevent capture. Telegram timeouts can cause duplicate delivery.

## Architecture

```text
Next.js server errors ----------------------------+
                                                   |
Browser errors -> monitored app's same-origin relay +-> authenticated ingestion
                                                        |
                                              SQLite transaction
                                              /                \
                                      private dashboard    pending alerts
                                                               |
                                                        delivery worker
                                                               |
                                                            Telegram
```

The dashboard and worker are separate processes on one host sharing one local SQLite database. Both must run. Do not mount the database over NFS or share it between independent hosts. Horizontal replicas and high availability are not supported.

## Quick start

Requirements: Node.js 24 LTS and npm, or Docker with Compose. Create a Telegram bot through [BotFather](https://t.me/BotFather), start a conversation with it, and obtain your chat ID. Group destinations require adding the bot with permission to send messages. Keep the bot token private.

```sh
npm ci
cp .env.example .env
cp alerts.example.yaml alerts.yaml
npm run password
```

The password helper prompts without echoing your password and prints a colon-delimited scrypt hash. This format avoids Next.js environment-variable expansion of dollar signs. Put the hash in `.env`, keeping the entire value single-quoted. Generate separate secrets with `openssl rand -hex 32` for the session and each project's reporting key.

Complete these values in `.env`:

```dotenv
ALERTS_CONFIG=./alerts.yaml
ALERTS_BASE_URL=http://localhost:3000
ALERTS_DATABASE_PATH=./data/alerts.sqlite
ALERTS_SESSION_SECRET=your-independently-generated-session-secret
ALERTS_PASSWORD_HASH='paste-the-generated-scrypt-hash-here'
TELEGRAM_BOT_TOKEN=your-bot-token
MY_APP_REPORTING_KEY=your-independently-generated-project-key
MY_APP_TELEGRAM_CHAT_ID=your-chat-id
```

The text above is illustrative, not valid credentials. Never commit populated `.env` files, `alerts.yaml`, databases, backups, or real error reports.

Start two terminals:

```sh
# Terminal 1
npm run dev

# Terminal 2
npm run worker
```

Open `http://localhost:3000`, log in as `operator` with the password you hashed, select your project, and use **Send test alert**. Inspect its delivery status in the dashboard. No application error is needed to test routing.

For a production Node deployment:

```sh
npm run build
npm start
# Run separately under a process supervisor:
npm run worker
```

Use HTTPS outside localhost. Set `server.baseUrl` to the exact externally visible origin, including any nonstandard port. Keep hostname and scheme consistent when logging in; browser mutation requests are checked against this origin.

## YAML configuration

[`alerts.example.yaml`](./alerts.example.yaml) is the complete starting configuration. `${NAME}` references resolve from the process environment; missing references fail startup. Environment files are loaded through dotenv. Restart both processes after changing YAML or credentials.

```yaml
server:
  baseUrl: "${ALERTS_BASE_URL}"
  databasePath: "${ALERTS_DATABASE_PATH}"
  sessionSecret: "${ALERTS_SESSION_SECRET}"
auth:
  username: operator
  passwordHash: "${ALERTS_PASSWORD_HASH}"
telegram:
  botToken: "${TELEGRAM_BOT_TOKEN}"
projects:
  - id: my-app
    name: My Next.js app
    key: "${MY_APP_REPORTING_KEY}"
    chatId: "${MY_APP_TELEGRAM_CHAT_ID}"
alerts:
  repeatIntervalSeconds: 300
  retryWindowHours: 24
retentionDays: 30
```

Project IDs and reporting keys must be unique. Every project requires an explicit destination; multiple projects can intentionally use the same Telegram chat. There is one bot per installation. Keep chat IDs quoted in YAML so large or negative IDs remain strings.

Configuration is read-only in the dashboard. Test sends and manual retries change operational data, not YAML. There is no signup, email reset flow, OAuth, or team access. To recover login access, generate a new password hash, update configuration, and restart. Rotating login credentials or the session secret invalidates existing sessions.

## Connect a Next.js application

The reusable integration lives in [`packages/nextjs`](./packages/nextjs). It is not automatically published to npm. Build and package it locally:

```sh
npm run build:sdk
npm pack --workspace @simple-alerts/nextjs
# In your monitored application:
npm install /absolute/path/to/simple-alerts-nextjs-0.1.0.tgz
```

See the [package README](./packages/nextjs/README.md) for complete instrumentation, browser listener, relay, `error.tsx`, and `global-error.tsx` examples. Never prefix a project reporting key with `NEXT_PUBLIC_`.

### Direct reporting interface

Server-side clients can also submit reports without the package:

```sh
curl --fail-with-body http://localhost:3000/api/ingest \
  -H "Authorization: Bearer $MY_APP_REPORTING_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Error","message":"Example failure","source":"server","stack":"Error: Example failure\n    at checkout (app/checkout.ts:12:3)","metadata":{"release":"example"}}'
```

Successful ingestion returns HTTP 202 with occurrence `id` and `groupId` only after committing to SQLite. Authentication failures return 401, malformed input 400, oversized reports 413, and rate limits 429. The report body limit is 64 KiB.

Reports contain `name`, `message`, `source` (`server` or `browser`), and optional `stack`, `url`, and `metadata`. Browser reports remain untrusted even behind a same-origin relay. Origin headers are not proof of identity.

## Alert and delivery behavior

Reports group by project, source, error name, message, and normalized stack location. Line and column changes do not create separate groups; browser and server reports do. Changes in messages can create new groups, including messages containing changing IDs.

Every occurrence is stored. A new group queues an immediate alert. Repeated occurrences accumulate into a delayed summary, which is sent even if no further reports arrive when the window closes. Persisted queue state survives dashboard or worker restarts. An in-flight alert is not modified when new occurrences arrive.

The worker retries network failures, Telegram server errors, and rate limits with backoff. It respects Telegram's retry delay. Permanent failures stop immediately; transient failures stop after the configured retry window. Failed alerts remain visible and can be retried manually. Acknowledged Telegram delivery means Telegram accepted the message, not that a person read it.

Delivery is at-least-once: if Telegram accepts a message but its response is lost, retrying may send a duplicate. Durable local storage cannot guarantee capture before the monitored application successfully submits its report.

## Docker deployment

```sh
docker compose up --build -d
docker compose logs -f dashboard worker
```

Compose starts both processes, mounts YAML read-only, and uses a named volume for SQLite. It binds the dashboard to `127.0.0.1:3000`; place an HTTPS reverse proxy in front of it. Configure that proxy with a request-body limit and rate limiting as additional protection. Do not publicly expose the raw Docker port without TLS.

Set `ALERTS_BASE_URL` to the public HTTPS origin before deployment. Compose overrides the database location to `/app/data/alerts.sqlite` and the configuration path to `/app/alerts.yaml` for both processes. Application containers run as a non-root user.

`GET /api/health` checks database access and worker heartbeat. HTTP 503 indicates an unavailable database or a stale/missing worker. A new installation is unhealthy until the worker starts. The health response does not disclose configuration secrets or report contents.

### Backup

Back up configuration and environment secrets separately in encrypted, access-controlled storage. For a consistent live SQLite backup, use its backup interface rather than copying only the main file while WAL writes are active:

```sh
docker compose exec -T dashboard node --input-type=module -e \
  "import { DatabaseSync, backup } from 'node:sqlite'; const db = new DatabaseSync('/app/data/alerts.sqlite'); await backup(db, '/app/data/backup.sqlite'); db.close();"
docker compose cp dashboard:/app/data/backup.sqlite ./backup.sqlite
```

Transfer the backup to protected storage outside the Docker host. Backup files contain error data. Retention does not erase existing backups.

### Restore

Stop both processes. Preserve the current database before replacing it. Restore the backup as the main database in the named volume, remove stale `-wal` and `-shm` sidecars only while both processes are stopped, and ensure the container's `node` user owns the restored files. Restore matching YAML and environment secrets, then start both processes and check `/api/health` and the dashboard.

Restoring an older backup may redeliver alerts recorded after that backup. Test this procedure on a separate installation before relying on it.

## Privacy and security

Headers, cookies, request bodies, URL queries, and fragments are excluded from normal reporting. Common sensitive metadata keys and recognizable inline credentials are redacted before local storage or Telegram delivery. These filters are best-effort: arbitrary error text may still contain sensitive data. Do not deliberately report secrets or personal data.

Telegram stores notification contents under its own policies. Local retention does not delete Telegram messages. Serve `/privacy` and `/terms` with deployment-specific legal details when required; included pages describe the software, not legal advice.

The dashboard uses HttpOnly, SameSite cookies, finite sessions, origin checks for mutations, and persistent login throttling. HTTPS enables secure cookies. Protect backups as carefully as the live database. See [SECURITY.md](./SECURITY.md).

No analytics, third-party fonts, or telemetry integrations are required. Application failures are logged locally rather than recursively reporting to this same installation.

## Development and verification

```sh
npm ci
npm run build:sdk
npm run typecheck
npm test
npm run build
```

CI runs these gates on Node.js 24. For UI or integration changes, also run the actual dashboard and worker and exercise the changed path. Tests alone do not prove a deployed Telegram destination works.

See [CONTRIBUTING.md](./CONTRIBUTING.md), the [domain glossary](./CONTEXT.md), and [architecture decisions](./docs/adr).

## License

[MIT](./LICENSE). Commercial use and modifications are allowed subject to that license. Hosting, retention, access controls, backups, and alert destinations remain the operator's responsibility.
