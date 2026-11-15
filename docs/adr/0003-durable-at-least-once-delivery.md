# Commit reports before delivering Telegram alerts

Ingestion commits an error occurrence and its notification state in one SQLite transaction before returning success. A separate worker claims persisted alerts and records delivery attempts, retries transient failures for a bounded window, and recovers abandoned claims after restart.

The worker never holds a database transaction open during a Telegram network request. This keeps dashboard access and new ingestion independent of Telegram latency. The tradeoff is at-least-once delivery: a successful Telegram send whose response is lost may be retried, producing a duplicate. Exactly-once delivery is not promised because Telegram does not expose an idempotency key for sending messages.
