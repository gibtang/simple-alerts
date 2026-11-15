import type { Delivery } from '@/server/store';
import { StatusPill } from '@/components/StatusPill';
import { Timestamp } from '@/components/Timestamp';
import { RetryForm } from '@/components/forms';

export const DELIVERY_CAP = 50;

export function deliveryCapReached(count: number): boolean {
  return count >= DELIVERY_CAP;
}

export function DeliveryTable({
  deliveries,
  showProject = true,
}: {
  deliveries: Delivery[];
  showProject?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>ID</th>
            {showProject && <th>Project</th>}
            <th>Kind</th>
            <th>Group</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Created</th>
            <th>Next attempt</th>
            <th>Last error</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((d) => (
            <tr key={d.id}>
              <td className="mono nowrap">{d.id}</td>
              {showProject && (
                <td>
                  <span className="cell-clip" title={d.projectName}>
                    {d.projectName}
                  </span>
                </td>
              )}
              <td className="mono">{d.kind}</td>
              <td>
                {d.groupId === null ? (
                  <span className="muted">—</span>
                ) : (
                  <a href={`/groups/${d.groupId}`}>#{d.groupId}</a>
                )}
              </td>
              <td>
                <StatusPill status={d.status} />
              </td>
              <td className="nowrap">{d.attempts}</td>
              <td>
                <Timestamp at={d.createdAt} compact />
              </td>
              <td>
                {d.status === 'sent' ? (
                  <span className="muted">—</span>
                ) : (
                  <Timestamp at={d.nextAttemptAt} compact />
                )}
              </td>
              <td>
                {d.lastError ? (
                  <span
                    className="cell-clip mono"
                    title={d.lastError}
                  >
                    {d.lastError}
                  </span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                {d.status === 'failed' ? (
                  <RetryForm deliveryId={d.id} />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
