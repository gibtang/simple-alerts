'use client';

export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem', maxWidth: '42rem', margin: 'auto' }}>
        <h1>Dashboard unavailable</h1>
        <p>Simple Alerts could not render this page. Check the dashboard process logs and configuration.</p>
        <button type="button" onClick={reset}>Try again</button>
      </body>
    </html>
  );
}
