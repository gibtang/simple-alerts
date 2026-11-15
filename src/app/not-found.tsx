import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="error-wrap">
      <div className="card error-card">
        <h1>Page not found</h1>
        <p className="muted">
          The page you requested does not exist. The error group you followed
          may have been removed by retention cleanup.
        </p>
        <div className="error-actions">
          <Link href="/" className="btn btn-primary">
            Back to overview
          </Link>
        </div>
      </div>
    </div>
  );
}
