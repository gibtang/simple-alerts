import { NextResponse } from 'next/server';

import type { Config } from './config';

/**
 * Shared helpers for API form routes: redirects anchored at the configured
 * base URL (proxy-safe) and minimal JSON errors that never leak secrets.
 */

export function formRedirect(config: Config, path: string, status = 303): NextResponse {
  const origin = new URL(config.server.baseUrl).origin;
  return NextResponse.redirect(new URL(path, origin), { status });
}

export function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}
