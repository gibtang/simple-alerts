import { pathToFileURL } from 'node:url';

import type { DatabaseSync } from 'node:sqlite';

import { openDb } from './db';
import { getConfig, type Config } from './config';
import {
  beat,
  markMaintenance,
  processDueDeliveries,
  readLastMaintenance,
  recoverStaleLeases,
  runMaintenance,
  type WorkerDeps,
} from './queue';
import { MAINTENANCE_INTERVAL_MS } from './queue';

/**
 * Worker executable: `npm run worker` (tsx src/server/worker.ts).
 *
 * Runs as a separate process from the Next.js app; the app never starts the
 * worker. Every tick recovers stale leases, processes due deliveries with
 * lease/24h/retry_after policy, refreshes the persistent heartbeat the
 * dashboard health check reads, and periodically sweeps retention and
 * expired sessions.
 */

export const WORKER_TICK_MS = 2000;

export interface WorkerTickResult {
  processed: number;
  maintenance: boolean;
}

/** One full worker tick. Exported for injected-fetch/clock smoke tests. */
export async function runWorkerTick(deps: WorkerDeps): Promise<WorkerTickResult> {
  const now = deps.now ?? Date.now;
  const at = now();
  recoverStaleLeases(deps.db, at);
  let processed = 0;
  try {
    processed = await processDueDeliveries(deps);
  } finally {
    beat(deps.db, now());
  }
  const maintenance =
    readLastMaintenance(deps.db) + MAINTENANCE_INTERVAL_MS <= now();
  if (maintenance) {
    runMaintenance(deps.db, deps.config, now());
    markMaintenance(deps.db, now());
  }
  return { processed, maintenance };
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Run the worker loop until SIGINT/SIGTERM. The in-flight send finishes;
 * anything still claimed is recovered via lease expiry on next start.
 */
export async function runWorker(deps: Omit<WorkerDeps, 'now'>): Promise<void> {
  let stopping = false;
  const onStop = () => {
    stopping = true;
  };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);

  while (!stopping) {
    const startedAt = Date.now();
    let maintenance = false;
    try {
      ({ maintenance } = await runWorkerTick({ ...deps, now: Date.now }));
    } catch (error) {
      console.error(
        '[worker] tick failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
    }
    if (maintenance) {
      console.log('[worker] maintenance sweep complete');
    }
    const elapsed = Date.now() - startedAt;
    if (!stopping) await sleep(Math.max(0, WORKER_TICK_MS - elapsed));
  }

  process.off('SIGINT', onStop);
  process.off('SIGTERM', onStop);
}

export async function main(): Promise<void> {
  const config: Config = getConfig();
  const db: DatabaseSync = openDb(config.server.databasePath);
  console.log(`[worker] started; database ${config.server.databasePath}`);
  await runWorker({ db, config });
  console.log('[worker] stopped');
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error('[worker] fatal:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
