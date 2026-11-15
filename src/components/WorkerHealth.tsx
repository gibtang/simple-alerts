import { Timestamp } from '@/components/Timestamp';
import { HEARTBEAT_STALE_MS } from '@/server/queue';


/**
 * Worker heartbeat indicator. The worker writes heartbeats to the shared
 * database; the UI uses the readiness endpoint's stale threshold so
 * delivery problems are obvious at a glance.
 */
export function WorkerHealth({
  lastHeartbeat,
}: {
  lastHeartbeat: number | null;
}) {
  if (lastHeartbeat === null) {
    return (
      <div className="worker">
        <span className="dot dot-bad" aria-hidden="true" />
        <div className="worker-detail">
          <span className="worker-label">Worker offline</span>
          <span className="small muted">
            No heartbeat recorded — the delivery worker is not reporting.
          </span>
        </div>
      </div>
    );
  }

  const age = Date.now() - lastHeartbeat;
  const healthy = age < HEARTBEAT_STALE_MS;

  return (
    <div className="worker">
      <span
        className={healthy ? 'dot dot-ok' : 'dot dot-bad'}
        aria-hidden="true"
      />
      <div className="worker-detail">
        <span className="worker-label">
          {healthy ? 'Worker healthy' : 'Worker stale'}
        </span>
        <span className="small muted">
          Last heartbeat <Timestamp at={lastHeartbeat} relative />
        </span>
      </div>
    </div>
  );
}
