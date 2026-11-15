import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Privacy' };

export default function PrivacyPage() {
  return (
    <article className="static-page">
      <h1>Privacy</h1>
      <p className="muted">
        Simple Alerts is self-hosted software for a single operator. What
        happens to data on this instance is controlled by whoever runs it —
        this page describes how the software itself treats data.
      </p>

      <h2>What is stored</h2>
      <ul>
        <li>
          Error reports you send to the ingestion API: error name, message,
          optional stack, source (browser or server), URL path and metadata,
          plus receive timestamps.
        </li>
        <li>
          Delivery records: notification queue state, attempt counts, bounded
          error text from failed sends.
        </li>
        <li>
          A single login session cookie for the dashboard and persistent login
          rate-limit state.
        </li>
      </ul>

      <h2>What is never stored</h2>
      <ul>
        <li>HTTP request headers, bodies or cookies from your apps.</li>
        <li>URL query strings or fragments from reported URLs.</li>
        <li>
          Plaintext secrets: metadata is recursively redacted and common
          inline secret patterns are masked before anything is written to disk
          or sent to Telegram.
        </li>
      </ul>

      <h2>Where data goes</h2>
      <ul>
        <li>
          Everything is kept in the instance's local SQLite database on the
          operator's own server.
        </li>
        <li>
          Alert notifications are delivered through the Telegram Bot API to
          the chat IDs configured by the operator. That is the only outbound
          data flow.
        </li>
        <li>No analytics, tracking, third-party scripts or external fonts.</li>
      </ul>

      <h2>Retention</h2>
      <p>
        Events and delivery records are pruned after 30 days by default
        (configurable via <code>retentionDays</code>). Expired sessions and
        stale login throttles are cleaned up automatically. Dashboard sessions
        expire after 12 hours or on logout.
      </p>

      <h2>Contact</h2>
      <p>
        For questions about data on this instance, contact the person or
        organisation operating it.
      </p>
    </article>
  );
}
