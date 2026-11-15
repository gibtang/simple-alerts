import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Terms' };

export default function TermsPage() {
  return (
    <article className="static-page">
      <h1>Terms</h1>
      <p className="muted">
        Simple Alerts is self-hosted software, licensed under the MIT license.
        These terms describe the intended use of this instance; the operator
        of the instance sets any additional rules.
      </p>

      <h2>Use of the service</h2>
      <ul>
        <li>
          The dashboard is a single-operator tool. Access credentials must not
          be shared, and each configured project key authorises error reports
          for that project only.
        </li>
        <li>
          The dashboard is read-only by design: configuration (projects,
          Telegram targets, keys) lives in <code>alerts.yaml</code> on the
          server and reloads on restart. Test sends and delivery retries are
          the only operational actions available here.
        </li>
      </ul>

      <h2>No warranty</h2>
      <ul>
        <li>
          The software is provided “as is”, without warranty of any kind,
          express or implied. Error capture and delivery are best-effort:
          events may be lost if the worker is offline, the network is down or
          the process is killed, and notifications are deduplicated rather
          than guaranteed exactly-once.
        </li>
        <li>
          The operator is responsible for backups, availability and compliance
          of deployed instances, including compliance with the Telegram terms
          of service when delivering notifications.
        </li>
      </ul>

      <h2>Acceptable content</h2>
      <ul>
        <li>
          Only report errors from systems you own or operate. Do not use this
          instance to collect data about other people without their consent,
          and do not intentionally submit secrets, personal data or content
          you have no right to process.
        </li>
      </ul>

      <h2>License</h2>
      <p>
        The source code is available under the MIT license; see the LICENSE
        file in the repository.
      </p>
    </article>
  );
}
