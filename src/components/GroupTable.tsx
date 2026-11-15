import type { GroupSummary } from '@/server/store';
import { SourceBadge, StatusPill } from '@/components/StatusPill';
import { Timestamp } from '@/components/Timestamp';

const GROUP_CAP = 100;

export function groupCapReached(count: number): boolean {
  return count >= GROUP_CAP;
}

export function GroupTable({ groups }: { groups: GroupSummary[] }) {
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>Group</th>
            <th>Message</th>
            <th>Project</th>
            <th>Source</th>
            <th>Count</th>
            <th>First seen</th>
            <th>Last seen</th>
            <th>Delivery</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.id}>
              <td className="nowrap">
                <a href={`/groups/${g.id}`} title={g.name}>
                  <span className="cell-clip">{g.name}</span>
                </a>
              </td>
              <td>
                <span className="cell-clip mono" title={g.message}>
                  {g.message}
                </span>
              </td>
              <td>
                <span className="cell-clip" title={g.projectName}>
                  {g.projectName}
                </span>
              </td>
              <td>
                <SourceBadge source={g.source} />
              </td>
              <td className="nowrap">{g.count}</td>
              <td>
                <Timestamp at={g.firstSeen} compact />
              </td>
              <td>
                <Timestamp at={g.lastSeen} compact />
              </td>
              <td>
                <StatusPill status={g.deliveryStatus} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
