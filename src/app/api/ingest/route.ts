import { authenticateProject, consumeIngestSlot, ingestReport, REPORT_MAX_BYTES, ReportValidationError, validateReport, type IngestReport } from '@/server/ingest';
import { getDb } from '@/server/db';
import { getConfig, type Config } from '@/server/config';
import { jsonError } from '@/server/http';
import { readBoundedBody, BodyTooLargeError, BodyTimeoutError, BodyUnreadableError } from '@/server/body';

/**
 * POST /api/ingest — SDK ingestion endpoint.
 *
 * Authorization: Bearer <project key>; JSON report body bounded to 64 KiB,
 * consumed incrementally so memory stays finite for chunked uploads. The
 * persistent per-project rate slot is consumed BEFORE the body is read, so
 * quota-exhausted senders never get their input buffered.
 * 202 {id, groupId} on success; 401 bad key, 400 invalid payload,
 * 413 oversize, 408 stalled, 429 rate limited. No redirects, no secrets in
 * responses.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  let config: Config;
  try {
    config = getConfig();
  } catch {
    return jsonError(500, 'server configuration invalid');
  }

  const project = authenticateProject(config, req);
  if (project === null) return jsonError(401, 'invalid project key');

  const db = getDb();
  const now = Date.now();
  if (!consumeIngestSlot(db, project.id, now)) {
    return jsonError(429, 'ingest rate limit exceeded');
  }

  let bodyText: string;
  try {
    bodyText = await readBoundedBody(req, REPORT_MAX_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return jsonError(413, 'report exceeds 64 KiB limit');
    if (error instanceof BodyTimeoutError) return jsonError(408, 'report body read timed out');
    if (error instanceof BodyUnreadableError) return jsonError(400, 'unreadable request body');
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return jsonError(400, 'request body is not valid JSON');
  }

  let report: IngestReport;
  try {
    report = validateReport(parsed);
  } catch (error) {
    if (error instanceof ReportValidationError) return jsonError(400, error.message);
    throw error;
  }

  const result = ingestReport(db, config, project, report, now);
  return Response.json({ id: result.id, groupId: result.groupId }, { status: 202 });
}
