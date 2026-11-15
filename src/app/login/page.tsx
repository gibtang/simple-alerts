import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth';
import { PasswordInput } from '@/components/PasswordInput';
import { firstParam } from '@/components/Notice';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Log in' };

const LOGIN_ERRORS: Record<string, string> = {
  invalid: 'Invalid username or password.',
  rate: 'Too many login attempts. Wait a few minutes and try again.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (session) {
    redirect('/');
  }

  const sp = await searchParams;
  const error = firstParam(sp['error']);
  const message = error && Object.hasOwn(LOGIN_ERRORS, error) ? LOGIN_ERRORS[error] : undefined;

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <h1>Log in</h1>
        <p className="small muted">
          Single-operator access to the Simple Alerts dashboard.
        </p>
        {message ? (
          <p className="notice notice-error" role="alert">
            {message}
          </p>
        ) : null}
        <form method="post" action="/api/auth/login">
          <div className="field">
            <label className="field-label" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              className="input"
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <PasswordInput id="password" />
          </div>
          <button type="submit" className="btn btn-primary btn-block">
            Log in
          </button>
        </form>
      </div>
    </div>
  );
}
