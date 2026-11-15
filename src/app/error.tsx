'use client';

import Link from 'next/link';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="error-wrap">
      <div className="card error-card">
        <h1>Something went wrong</h1>
        <p className="muted">
          The dashboard failed to render this view. The error details below
          are shown only to the logged-in operator.
        </p>
        {error.digest ? (
          <p className="small muted">
            Digest: <span className="mono">{error.digest}</span>
          </p>
        ) : null}
        <div className="error-actions">
          <button type="button" className="btn btn-primary" onClick={reset}>
            Try again
          </button>
          <Link href="/" className="btn">
            Back to overview
          </Link>
        </div>
      </div>
    </div>
  );
}
