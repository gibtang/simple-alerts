import { getDb } from '@/server/db';
import { getConfig } from '@/server/config';
import {
  authenticateLogin,
  createSession,
  originAllowed,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from '@/server/auth';
import { readBoundedBody, BodyTooLargeError, BodyTimeoutError, BodyUnreadableError } from '@/server/body';
import { formRedirect, jsonError } from '@/server/http';

/**
 * POST /api/auth/login — dashboard form login (urlencoded, HTML form only).
 * Body is read incrementally under an 8 KiB cap with a read deadline.
 * 303 '/' on success, 303 '/login?error=invalid' on bad credentials,
 * 303 '/login?error=rate' when the persistent operator-keyed throttle
 * denies the attempt. Rejects absent or foreign Origin headers, non-form
 * content types with 415, and oversized/stalled bodies without parsing.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOGIN_BODY_MAX_BYTES = 8 * 1024;

function parseFormFields(bodyText: string): { username: string; password: string } | null {
  const params = new URLSearchParams(bodyText);
  const username = params.get('username');
  const password = params.get('password');
  if (username === null || password === null) return null;
  return { username, password };
}

export async function POST(req: Request): Promise<Response> {
  const config = getConfig();
  if (!originAllowed(req, config)) return jsonError(403, 'cross-origin form submission rejected');

  const contentType = (req.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') {
    return jsonError(415, 'login requires an urlencoded form body');
  }

  let bodyText: string;
  try {
    bodyText = await readBoundedBody(req, LOGIN_BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof BodyTimeoutError) {
      return jsonError(408, 'login form body read timed out');
    }
    if (error instanceof BodyTooLargeError) {
      return jsonError(413, 'login form body exceeds limit');
    }
    if (error instanceof BodyUnreadableError) return jsonError(400, 'login form body is unreadable');
    throw error;
  }

  const fields = parseFormFields(bodyText);
  const credentials =
    fields === null ? { username: '', password: '' } : { username: fields.username, password: fields.password };

  const db = getDb();
  const now = Date.now();
  const result = authenticateLogin(db, config, credentials, now);

  if (result === 'rate') return formRedirect(config, '/login?error=rate');
  if (result === 'invalid') return formRedirect(config, '/login?error=invalid');

  const session = createSession(db, config, config.auth.username, now);
  const response = formRedirect(config, '/');
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: session.cookieValue,
    ...sessionCookieOptions(config, session.expiresAt),
  });
  return response;
}
