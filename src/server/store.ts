import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import { getDb, num } from './db';
import { getConfig } from './config';
import { readHeartbeat } from './queue';

/**
 * Read-model for the dashboard. Never exposes raw SQL, configuration, keys,
 * chat ids or secrets. Lists are capped: 100 latest groups, 50 latest
 * occurrences, 50 latest deliveries.
 */

export const GROUPS_LIMIT = 100;
export const OCCURRENCES_LIMIT = 50;
export const DELIVERIES_LIMIT = 50;

export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface Delivery {
  id: number;
  groupId: number | null;
  projectId: string;
  projectName: string;
  kind: string;
  status: DeliveryStatus;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  count: number;
}

export interface GroupSummary {
  id: number;
  projectId: string;
  projectName: string;
  name: string;
  message: string;
  source: 'browser' | 'server';
  count: number;
  firstSeen: number;
  lastSeen: number;
  deliveryStatus: string;
}

export interface Overview {
  projects: Array<{
    id: string;
    name: string;
    groups: number;
    occurrences: number;
    failed: number;
  }>;
  groups: GroupSummary[];
  deliveries: Delivery[];
  totals: {
    groups: number;
    occurrences: number;
    pending: number;
    failed: number;
  };
  worker: { lastHeartbeat: number | null };
}

export interface OccurrenceDetail {
  id: number;
  receivedAt: number;
  stack: string | null;
  url: string | null;
  metadata: string;
}

export interface GroupDetail {
  group: GroupSummary;
  occurrences: OccurrenceDetail[];
  deliveries: Delivery[];
}

interface GroupRowRaw extends Record<string, SQLOutputValue> {
  id: number | bigint;
  project_id: string;
  project_name: string;
  name: string;
  message: string;
  source: string;
  count: number | bigint;
  first_seen: number | bigint;
  last_seen: number | bigint;
  delivery_status: string | null;
}

function mapGroup(raw: GroupRowRaw): GroupSummary {
  return {
    id: num(raw.id),
    projectId: raw.project_id,
    projectName: raw.project_name,
    name: raw.name,
    message: raw.message,
    source: raw.source as GroupSummary['source'],
    count: num(raw.count),
    firstSeen: num(raw.first_seen),
    lastSeen: num(raw.last_seen),
    deliveryStatus: raw.delivery_status ?? 'none',
  };
}

interface DeliveryRowRaw extends Record<string, SQLOutputValue> {
  id: number | bigint;
  group_id: number | bigint | null;
  project_id: string;
  project_name: string;
  kind: string;
  status: string;
  attempts: number | bigint;
  created_at: number | bigint;
  next_attempt_at: number | bigint | null;
  last_error: string | null;
  count: number | bigint;
}

function mapDelivery(raw: DeliveryRowRaw): Delivery {
  return {
    id: num(raw.id),
    groupId: raw.group_id === null ? null : num(raw.group_id),
    projectId: raw.project_id,
    projectName: raw.project_name,
    kind: raw.kind,
    status: raw.status as DeliveryStatus,
    attempts: num(raw.attempts),
    createdAt: num(raw.created_at),
    nextAttemptAt: raw.next_attempt_at === null ? null : num(raw.next_attempt_at),
    lastError: raw.last_error,
    count: num(raw.count),
  };
}

const DELIVERY_SELECT = `SELECT id, group_id, project_id, project_name, kind, status, attempts, created_at, next_attempt_at, last_error, count FROM deliveries`;

/** Global dashboard overview, optionally filtered to one project. */
export function getOverview(projectId?: string): Overview {
  const config = getConfig();
  const db: DatabaseSync = getDb();
  // Unknown filter values degrade to the unfiltered view; the projects list
  // always covers every configured project for navigation.
  const normalized =
    projectId !== undefined && config.projects.some((project) => project.id === projectId)
      ? projectId
      : undefined;
  const filter = normalized !== undefined;
  const bindProject: string[] = normalized !== undefined ? [normalized] : [];

  const groupStats = db
    .prepare(
      'SELECT project_id, COUNT(*) AS groups, COALESCE(SUM(count), 0) AS occurrences FROM groups GROUP BY project_id',
    )
    .all() as Array<{ project_id: string; groups: number | bigint; occurrences: number | bigint }>;
  const failedStats = db
    .prepare(
      "SELECT project_id, COUNT(*) AS failed FROM deliveries WHERE status = 'failed' GROUP BY project_id",
    )
    .all() as Array<{ project_id: string; failed: number | bigint }>;
  const groupsByProject = new Map(groupStats.map((row) => [row.project_id, row]));
  const failedByProject = new Map(failedStats.map((row) => [row.project_id, row]));

  const totalsRow = db
    .prepare(
      `SELECT COUNT(*) AS groups, COALESCE(SUM(count), 0) AS occurrences FROM groups${filter ? ' WHERE project_id = ?' : ''}`,
    )
    .get(...bindProject) as { groups: number | bigint; occurrences: number | bigint };
  const deliveryTotals = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM deliveries WHERE status IN ('pending','failed')${filter ? ' AND project_id = ?' : ''} GROUP BY status`,
    )
    .all(...bindProject) as Array<{ status: string; c: number | bigint }>;
  const pendingTotal = deliveryTotals.find((row) => row.status === 'pending');
  const failedTotal = deliveryTotals.find((row) => row.status === 'failed');

  const groupsSql = `SELECT g.*, (SELECT status FROM deliveries d WHERE d.group_id = g.id ORDER BY d.id DESC LIMIT 1) AS delivery_status
     FROM groups g${filter ? ' WHERE g.project_id = ?' : ''}
     ORDER BY g.last_seen DESC, g.id DESC LIMIT ${GROUPS_LIMIT}`;
  const groups = (
    filter
      ? (db.prepare(groupsSql).all(...bindProject) as GroupRowRaw[])
      : (db.prepare(groupsSql).all() as GroupRowRaw[])
  ).map(mapGroup);

  const deliveriesSql = `${DELIVERY_SELECT}${filter ? ' WHERE project_id = ?' : ''} ORDER BY id DESC LIMIT ${DELIVERIES_LIMIT}`;
  const deliveries = (
    filter
      ? (db.prepare(deliveriesSql).all(...bindProject) as DeliveryRowRaw[])
      : (db.prepare(deliveriesSql).all() as DeliveryRowRaw[])
  ).map(mapDelivery);

  return {
    projects: config.projects.map((project) => ({
      id: project.id,
      name: project.name,
      groups: groupsByProject.has(project.id)
        ? num(groupsByProject.get(project.id)?.groups)
        : 0,
      occurrences: groupsByProject.has(project.id)
        ? num(groupsByProject.get(project.id)?.occurrences)
        : 0,
      failed: failedByProject.has(project.id) ? num(failedByProject.get(project.id)?.failed) : 0,
    })),
    groups,
    deliveries,
    totals: {
      groups: num(totalsRow.groups),
      occurrences: num(totalsRow.occurrences),
      pending: pendingTotal === undefined ? 0 : num(pendingTotal.c),
      failed: failedTotal === undefined ? 0 : num(failedTotal.c),
    },
    worker: { lastHeartbeat: readHeartbeat(db) },
  };
}

/** One group with its latest 50 occurrences and 50 deliveries, or null. */
export function getGroup(id: number): GroupDetail | null {
  const db: DatabaseSync = getDb();
  const raw = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRowRaw | undefined;
  if (raw === undefined) return null;
  const group = mapGroup(raw);
  const latestDelivery = db
    .prepare('SELECT status FROM deliveries WHERE group_id = ? ORDER BY id DESC LIMIT 1')
    .get(id) as { status: string } | undefined;
  group.deliveryStatus = latestDelivery === undefined ? 'none' : latestDelivery.status;

  const occurrences = (
    db
      .prepare(
        `SELECT id, received_at, stack, url, metadata FROM occurrences
         WHERE group_id = ? ORDER BY received_at DESC, id DESC LIMIT ${OCCURRENCES_LIMIT}`,
      )
      .all(id) as Array<{
      id: number | bigint;
      received_at: number | bigint;
      stack: string | null;
      url: string | null;
      metadata: string;
    }>
  ).map((row) => ({
    id: num(row.id),
    receivedAt: num(row.received_at),
    stack: row.stack,
    url: row.url,
    metadata: row.metadata,
  }));

  const deliveries = (
    db
      .prepare(`${DELIVERY_SELECT} WHERE group_id = ? ORDER BY id DESC LIMIT ${DELIVERIES_LIMIT}`)
      .all(id) as DeliveryRowRaw[]
  ).map(mapDelivery);

  return { group, occurrences, deliveries };
}
