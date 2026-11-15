# Contributing

Simple Alerts is MIT-licensed. Keep changes focused on reporting errors, investigating them, and delivering Telegram alerts.

## Development

Use Node.js 24 LTS and npm. Install with `npm ci`, copy `.env.example` to `.env`, and copy `alerts.example.yaml` to `alerts.yaml`. Complete the configuration described in the README. Run the dashboard and worker in separate terminals.

Before opening a pull request, run:

```sh
npm run build:sdk
npm run typecheck
npm test
npm run build
```

Exercise the behavior you changed. For UI changes, include desktop and mobile evidence without real error data or credentials.

## Design constraints

- One installation, one operator, multiple monitored projects.
- YAML owns configuration. SQLite owns runtime data.
- Browser reports are untrusted and pass through the monitored application's same-origin relay.
- Acknowledge reports only after committing their occurrence and notification state.
- Telegram delivery is at-least-once, not exactly-once.
- Never store authorization headers, cookies, request bodies, or URL queries in reports.
- Do not add Sentry, OAuth, signup, source-map uploads, or performance monitoring.

Tests should cover observable behavior, especially privacy, authentication, durable queue transitions, and reporting failures. Never commit `.env`, `alerts.yaml`, databases, real error reports, bot tokens, or project reporting keys.

See [CONTEXT.md](./CONTEXT.md) for domain terms and [docs/adr](./docs/adr) for architectural tradeoffs.
