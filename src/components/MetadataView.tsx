/**
 * Renders an event URL safely: links only http(s) URLs, everything else
 * (or untrusted schemes) is shown as inert text. Event content is
 * attacker-influenced, so it is never turned into executable markup.
 */
export function SafeUrl({ url }: { url: string | null | undefined }) {
  if (!url) {
    return <span className="muted">—</span>;
  }
  if (/^https?:\/\//i.test(url)) {
    return (
      <a href={url} target="_blank" rel="noreferrer noopener nofollow">
        {url}
      </a>
    );
  }
  return <span className="mono">{url}</span>;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) return 'null';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function renderEntries(entries: [string, unknown][]) {
  return (
    <dl className="meta-list">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd className={typeof value === 'object' && value !== null ? 'mono' : undefined}>
            {formatValue(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Occurrence metadata is stored as a JSON string (already redacted by the
 * ingestion path). Parsing failures fall back to inert preformatted text.
 */
export function MetadataView({ metadata }: { metadata: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return <pre className="stack">{metadata}</pre>;
  }

  if (parsed === null || parsed === undefined) {
    return <p className="small muted">No metadata.</p>;
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return <p className="small muted">No metadata.</p>;
    }
    return renderEntries(parsed.map((value, i) => [`[${i}]`, value]));
  }

  if (typeof parsed === 'object') {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) {
      return <p className="small muted">No metadata.</p>;
    }
    return renderEntries(entries);
  }

  return <p className="small">{formatValue(parsed)}</p>;
}
