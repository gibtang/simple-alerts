function pillClass(status: string): string {
  switch (status) {
    case 'sent':
      return 'pill pill-ok';
    case 'failed':
      return 'pill pill-bad';
    case 'pending':
      return 'pill pill-warn';
    case 'sending':
      return 'pill pill-info';
    default:
      return 'pill pill-neutral';
  }
}

export function StatusPill({ status }: { status: string }) {
  return <span className={pillClass(status)}>{status}</span>;
}

export function SourceBadge({ source }: { source: string }) {
  const cls =
    source === 'browser'
      ? 'badge badge-browser'
      : source === 'server'
        ? 'badge badge-server'
        : 'badge badge-browser';
  return <span className={cls}>{source}</span>;
}
