# Security

Do not report vulnerabilities with credentials or real error reports in a public issue. Use GitHub private vulnerability reporting for this repository when available. Otherwise contact the maintainer through their GitHub profile to arrange a private channel before sharing details.

## Deployment requirements

- Put the dashboard behind HTTPS before exposing it outside localhost.
- Keep the SQLite database on a persistent local disk, not a network share.
- Restrict `.env`, YAML secrets, database files, and backups to the operator.
- Use separate, randomly generated session and project keys.
- Treat browser reports as untrusted even when their relay checks Origin.
- Keep Docker and Node.js 24 LTS patched.
- Back up the database and configuration. Test restores before relying on them.

Automatic redaction is best-effort. Arbitrary error messages and stacks may contain sensitive values that pattern-based filters cannot identify. Telegram receives alert content and applies its own storage policies; deleting local reports does not delete Telegram messages.

Reporting is best-effort from monitored applications. Process termination, offline browsers, blocked requests, and unreported caught exceptions can prevent capture. A Telegram timeout can lead to duplicate messages when retried.
