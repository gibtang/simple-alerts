import { getDb } from '@/server/db';
import { HEARTBEAT_STALE_MS, readHeartbeat } from '@/server/queue';

/**
 * GET /api/health — database + worker readiness. No secrets.
 * 200 when the database answers and the worker heartbeat is fresh;
 * 503 when the database is unreachable or the heartbeat is stale/absent.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  let database: 'ok' | 'error' = 'error';
  let lastHeartbeat: number | null = null;
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    database = 'ok';
    lastHeartbeat = readHeartbeat(db);
  } catch {
    database = 'error';
  }

  const workerFresh =
    lastHeartbeat !== null && Date.now() - lastHeartbeat < HEARTBEAT_STALE_MS;
  const healthy = database === 'ok' && workerFresh;

  return Response.json(
    {
      status: healthy ? 'ok' : 'unhealthy',
      database,
      worker: workerFresh ? 'ok' : 'stale',
      lastHeartbeat,
    },
    { status: healthy ? 200 : 503 },
  );
}
