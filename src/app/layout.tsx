import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { getSession } from '@/server/auth';
import { LogoutForm } from '@/components/forms';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Simple Alerts',
    template: '%s · Simple Alerts',
  },
  description:
    'Self-hosted error alerts grouped, deduplicated and delivered to Telegram.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession();

  return (
    <html lang="en">
      <body>
        <div className="site">
          <header className="site-header">
            <div className="container header-inner">
              <Link href="/" className="brand">
                Simple Alerts
              </Link>
              <div className="session">
                {session ? (
                  <>
                    <span className="small muted">
                      Signed in as {session.username}
                    </span>
                    <LogoutForm />
                  </>
                ) : null}
              </div>
            </div>
          </header>
          <main className="container site-main">{children}</main>
          <footer className="site-footer">
            <div className="container footer-inner">
              <span>Simple Alerts — self-hosted Telegram error alerts.</span>
              <nav className="footer-nav" aria-label="Legal">
                <Link href="/privacy">Privacy</Link>
                <Link href="/terms">Terms</Link>
              </nav>
            </div>
            <div className="container">
              <p className="footer-note small muted">
                The dashboard is read-only: configuration (projects, keys,
                Telegram chat targets) is managed in <code>alerts.yaml</code>{' '}
                and reloaded on restart. Error reports and delivery retries can
                be inspected and triggered here.
              </p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
