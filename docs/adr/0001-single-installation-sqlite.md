# Keep each installation on one persistent SQLite database

Simple Alerts uses SQLite for error occurrences, alert delivery state, login throttling, and worker health. The dashboard and worker run as separate processes on the same host and share one persistent local volume; independent hosts or network-mounted database files are not supported.

This keeps self-hosting small and makes accepted reports durable without Redis or a managed database. In exchange, an installation is not horizontally scalable or highly available, and the operator must maintain backups. WAL mode and transactions protect concurrent dashboard and worker access, but they do not replace backups or durable host storage.
