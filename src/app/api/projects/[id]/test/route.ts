import { getDb } from '@/server/db';
import { getConfig } from '@/server/config';
import { enqueueTestDelivery } from '@/server/queue';
import { getSession, originAllowed } from '@/server/auth';
import { formRedirect, jsonError } from '@/server/http';

/**
 * POST /api/projects/[id]/test — authenticated dashboard form mutation.
 * Enqueues a test delivery for the selected project's chat, then
 * 303 '/?project=ID&notice=test'.
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
  const project = config.projects.find((candidate) => candidate.id === id);
  if (project === undefined) return jsonError(404, 'unknown project');

  enqueueTestDelivery(getDb(), config, project.id, Date.now());
  return formRedirect(config, `/?project=${encodeURIComponent(project.id)}&notice=test`);
}
