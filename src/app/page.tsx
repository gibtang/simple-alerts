import type { Metadata } from 'next';
import { requireSession } from '@/server/auth';
import { getOverview } from '@/server/store';
import type { Overview } from '@/server/store';
import { firstParam, Notice } from '@/components/Notice';
import { EmptyState } from '@/components/EmptyState';
import { WorkerHealth } from '@/components/WorkerHealth';
import { GroupTable } from '@/components/GroupTable';
import {
  DeliveryTable,
  DELIVERY_CAP,
} from '@/components/DeliveryTable';
import { TestSendForm } from '@/components/forms';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();

  const sp = await searchParams;
  const projectFilter = firstParam(sp['project']);
  const notice = firstParam(sp['notice']);

  const data: Overview = await getOverview(projectFilter);

  const filterId =
    projectFilter && data.projects.some((p) => p.id === projectFilter)
      ? projectFilter
      : undefined;
  const filterName = data.projects.find((p) => p.id === filterId)?.name;

  const totals = data.totals;
  const groupsCapped = data.groups.length < totals.groups;
  const deliveriesCapped = data.deliveries.length >= DELIVERY_CAP;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="small muted">
            Error groups, occurrences and Telegram deliveries
            {filterName ? ` for “${filterName}”` : ' across all projects'}.
          </p>
        </div>
        <WorkerHealth lastHeartbeat={data.worker.lastHeartbeat} />
      </div>

      <Notice notice={notice} projectName={filterName} />

      <div className="cards">
        <div className="card">
          <div className="stat-value">{data.projects.length}</div>
          <div className="stat-label">
            Configured projects
          </div>
        </div>
        <div className="card">
          <div className="stat-value">{totals.groups}</div>
          <div className="stat-label">Error groups</div>
        </div>
        <div className="card">
          <div className="stat-value">{totals.occurrences}</div>
          <div className="stat-label">Occurrences</div>
        </div>
        <div className="card">
          <div className="stat-value">{totals.pending}</div>
          <div className="stat-label">Pending deliveries</div>
        </div>
        <div className="card">
          <div className="stat-value">{totals.failed}</div>
          <div className="stat-label">Failed deliveries</div>
        </div>
      </div>

      <nav className="chips" aria-label="Project filter">
        <a href="/" className={filterId ? 'chip' : 'chip active'}>
          All projects
        </a>
        {data.projects.map((p) => (
          <a
            key={p.id}
            href={`/?project=${encodeURIComponent(p.id)}`}
            className={p.id === filterId ? 'chip active' : 'chip'}
          >
            {p.name}
          </a>
        ))}
      </nav>

      <section className="panel">
        <h2>Projects</h2>
        {data.projects.length === 0 ? (
          <EmptyState title="No projects configured.">
            Add projects to <code>alerts.yaml</code> (each with an id, name,
            key and Telegram chat id) and restart to reload the configuration.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Groups</th>
                  <th>Occurrences</th>
                  <th>Failed deliveries</th>
                  <th>Test</th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <a href={`/?project=${encodeURIComponent(p.id)}`}>
                        {p.name}
                      </a>
                      <div className="small muted mono">{p.id}</div>
                    </td>
                    <td>{p.groups}</td>
                    <td>{p.occurrences}</td>
                    <td>{p.failed}</td>
                    <td>
                      <TestSendForm projectId={p.id} projectName={p.name} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Error groups</h2>
          {filterName ? (
            <a href="/" className="small">
              Clear filter
            </a>
          ) : null}
        </div>
        {data.groups.length === 0 ? (
          <EmptyState
            title={
              filterName
                ? `No error groups for “${filterName}” yet.`
                : 'No error groups yet.'
            }
          >
            Report errors with an authenticated POST to{' '}
            <code>/api/ingest</code>; they will be grouped here per project,
            source and error name.
          </EmptyState>
        ) : (
          <>
            <GroupTable groups={data.groups} />
            {groupsCapped ? (
              <p className="cap-note">
                Showing the latest {data.groups.length} of {totals.groups}{' '}
                groups; open a group for its recent occurrences.
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Deliveries</h2>
        {data.deliveries.length === 0 ? (
          <EmptyState title="No deliveries yet.">
            Alert, digest and test deliveries will appear here with their
            attempt counts and errors. Failed deliveries can be retried.
          </EmptyState>
        ) : (
          <>
            <DeliveryTable deliveries={data.deliveries} />
            {deliveriesCapped ? (
              <p className="cap-note">
                Showing the latest {data.deliveries.length} deliveries.
              </p>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
