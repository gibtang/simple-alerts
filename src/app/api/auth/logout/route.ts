import { cookies } from 'next/headers';

import { getDb } from '@/server/db';
import { getConfig } from '@/server/config';
import {
  destroySession,
  getSession,
  originAllowed,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from '@/server/auth';
import { formRedirect, jsonError } from '@/server/http';

/**
 * POST /api/auth/logout — dashboard form logout.
 * Destroys the server-side session and clears the cookie, then 303 /login.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const config = getConfig();
  if (!originAllowed(req, config)) return jsonError(403, 'cross-origin form submission rejected');

  const db = getDb();
  const session = await getSession();
  if (session !== null) {
    const raw = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    destroySession(db, config, raw);
  }

  const response = formRedirect(config, '/login');
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: '',
    ...sessionCookieOptions(config, 0),
  });
  return response;
}
