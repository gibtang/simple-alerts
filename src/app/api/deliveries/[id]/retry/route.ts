import { getDb } from '@/server/db';
import { getConfig } from '@/server/config';
import { retryDelivery } from '@/server/queue';
import { getSession, originAllowed } from '@/server/auth';
import { formRedirect, jsonError } from '@/server/http';

/**
 * POST /api/deliveries/[id]/retry — authenticated dashboard form mutation.
 * Manual retry for FAILED deliveries only: resets the 24h window and
 * backoff, then 303 '/?notice=retry'. Other statuses redirect with
 * '?notice=retry-not-failed'; unknown ids 404.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const config = getConfig();
  if (!originAllowed(req, config)) return jsonError(403, 'cross-origin form submission rejected');
  if ((await getSession()) === null) return jsonError(401, 'authentication required');

  const { id } = await context.params;
  const deliveryId = Number(id);
  if (!Number.isInteger(deliveryId) || deliveryId <= 0) {
    return jsonError(404, 'unknown delivery');
  }

  const outcome = retryDelivery(getDb(), deliveryId, Date.now());
  if (outcome === 'not-found') return jsonError(404, 'unknown delivery');
  if (outcome === 'not-failed') return formRedirect(config, '/?notice=retry-not-failed');
  return formRedirect(config, '/?notice=retry');
}
