import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireSession } from '@/server/auth';
import { getGroup } from '@/server/store';
import { Timestamp } from '@/components/Timestamp';
import { SourceBadge, StatusPill } from '@/components/StatusPill';
import { EmptyState } from '@/components/EmptyState';
import { DeliveryTable, deliveryCapReached } from '@/components/DeliveryTable';
import { MetadataView, SafeUrl } from '@/components/MetadataView';

export const dynamic = 'force-dynamic';

const OCCURRENCE_CAP = 50;

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  await requireSession();
  const { id } = await params;
  const parsed = parseId(id);
  if (parsed === null) {
    return { title: 'Group not found' };
  }
  const detail = await getGroup(parsed);
  return { title: detail ? detail.group.name : 'Group not found' };
}

export default async function GroupDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession();

  const { id } = await params;
  const parsed = parseId(id);
  if (parsed === null) {
    notFound();
  }

  const detail = await getGroup(parsed);
  if (!detail) {
    notFound();
  }

  const { group, occurrences, deliveries } = detail;
  const occurrencesCapped = occurrences.length >= OCCURRENCE_CAP;

  return (
    <>
      <p className="breadcrumb">
        <a href={`/?project=${encodeURIComponent(group.projectId)}`}>
          ← Back to overview
        </a>
      </p>

      <section className="card">
        <h1>{group.name}</h1>
        <p className="group-message">{group.message}</p>
        <dl className="meta-grid">
          <div>
            <dt>Project</dt>
            <dd>{group.projectName}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              <SourceBadge source={group.source} />
            </dd>
          </div>
          <div>
            <dt>Occurrences</dt>
            <dd>{group.count}</dd>
          </div>
          <div>
            <dt>Delivery</dt>
            <dd>
              <StatusPill status={group.deliveryStatus} />
            </dd>
          </div>
          <div>
            <dt>First seen</dt>
            <dd>
              <Timestamp at={group.firstSeen} relative />
            </dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>
              <Timestamp at={group.lastSeen} relative />
            </dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <h2>Occurrences</h2>
        {occurrences.length === 0 ? (
          <EmptyState title="No occurrences recorded for this group." />
        ) : (
          <>
            <div>
              {occurrences.map((o) => (
                <details key={o.id} className="occurrence">
                  <summary>
                    <span className="mono small">#{o.id}</span>
                    <Timestamp at={o.receivedAt} compact />
                  </summary>
                  <div className="occurrence-body">
                    <div className="occurrence-line small">
                      <span className="muted">Received:</span>{' '}
                      <Timestamp at={o.receivedAt} />
                    </div>
                    {o.url ? (
                      <div className="occurrence-line small">
                        <span className="muted">URL:</span> <SafeUrl url={o.url} />
                      </div>
                    ) : null}
                    <div className="occurrence-line">
                      <span className="small muted">Metadata:</span>
                      <MetadataView metadata={o.metadata} />
                    </div>
                    {o.stack ? (
                      <div className="occurrence-line">
                        <span className="small muted">Stack:</span>
                        <pre className="stack">{o.stack}</pre>
                      </div>
                    ) : (
                      <p className="small muted">No stack captured.</p>
                    )}
                  </div>
                </details>
              ))}
            </div>
            {occurrencesCapped ? (
              <p className="cap-note">
                Showing the latest {occurrences.length} occurrences of this
                group.
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Deliveries</h2>
        {deliveries.length === 0 ? (
          <EmptyState title="No deliveries for this group yet.">
            Notifications for new occurrences will appear here with their
            attempt history.
          </EmptyState>
        ) : (
          <>
            <DeliveryTable deliveries={deliveries} showProject={false} />
            {deliveryCapReached(deliveries.length) ? (
              <p className="cap-note">
                Showing the latest {deliveries.length} deliveries of this
                group.
              </p>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
