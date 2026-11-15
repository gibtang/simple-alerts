import type { ReactElement } from 'react';

const UTC_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function localFormatter(): Intl.DateTimeFormat {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** "2026-11-15 14:32:05 UTC" */
export function formatUtc(ms: number): string {
  return `${UTC_FORMATTER.format(new Date(ms))} UTC`;
}

/** "2026-11-15 15:32:05 Europe/Berlin" (server-local zone) */
export function formatLocal(ms: number): string {
  return `${localFormatter().format(new Date(ms))} ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
}

/** "just now", "3m ago", "2h ago", "5d ago", "in 5m" */
export function formatRelative(ms: number): string {
  const diff = ms - Date.now();
  const future = diff > 0;
  const s = Math.floor(Math.abs(diff) / 1000);
  let text: string;
  if (s < 10) {
    return 'just now';
  } else if (s < 60) {
    text = `${s}s`;
  } else if (s < 3600) {
    text = `${Math.floor(s / 60)}m`;
  } else if (s < 86400) {
    text = `${Math.floor(s / 3600)}h`;
  } else {
    text = `${Math.floor(s / 86400)}d`;
  }
  return future ? `in ${text}` : `${text} ago`;
}

/**
 * Human-readable timestamp, UTC primary plus server-local rendering.
 * `compact` (used in dense tables) shows UTC + relative time only.
 */
export function Timestamp({
  at,
  relative = false,
  compact = false,
}: {
  at: number | null;
  relative?: boolean;
  compact?: boolean;
}): ReactElement | null {
  if (at === null || !Number.isFinite(at)) {
    return <span className="muted">—</span>;
  }
  const iso = new Date(at).toISOString();
  if (compact) {
    return (
      <time className="timestamp" dateTime={iso}>
        <span className="ts-utc">{formatUtc(at)}</span>
        <span className="ts-rel">{formatRelative(at)}</span>
      </time>
    );
  }
  return (
    <time className="timestamp" dateTime={iso}>
      <span className="ts-utc">{formatUtc(at)}</span>
      {!compact && <span className="ts-local">{formatLocal(at)}</span>}
      {relative && <span className="ts-rel">{formatRelative(at)}</span>}
    </time>
  );
}
