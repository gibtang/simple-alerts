import { readBoundedBody } from './body';
import { redactErrorText } from './redact';

/**
 * Telegram delivery with explicit outcome classification. Response and error
 * contents are bounded and redacted; the bot token must never appear in any
 * stored or displayed error.
 */

export const TELEGRAM_TIMEOUT_MS = 20_000;

export type TelegramOutcome =
  | { class: 'sent' }
  | { class: 'rate'; retryAfterMs: number; error: string }
  | { class: 'retryable'; error: string }
  | { class: 'permanent'; error: string };

export interface TelegramDeps {
  botToken: string;
  chatId: string;
  text: string;
  fetchImpl: typeof fetch;
}

/** POST one sendMessage call and classify the result for retry policy. */
export async function sendTelegramMessage(deps: TelegramDeps): Promise<TelegramOutcome> {
  const redact = (text: string) => redactErrorText(text, [deps.botToken]);
  let response: Response;
  try {
    response = await deps.fetchImpl(
      `https://api.telegram.org/bot${deps.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: deps.chatId,
          text: deps.text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown network failure';
    return { class: 'retryable', error: redact(`network error: ${message}`) };
  }

  let bodyText = '';
  try {
    bodyText = await readBoundedBody(response, 64 * 1024, { timeoutMs: TELEGRAM_TIMEOUT_MS });
  } catch {
    bodyText = '';
  }
  const body = redact(bodyText);
  let result: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      result = parsed as Record<string, unknown>;
    }
  } catch {
    // A successful HTTP status alone does not establish Telegram acceptance.
  }
  const status = result?.ok === false && typeof result.error_code === 'number'
    ? result.error_code
    : response.status;

  if (status === 429) {
    let retryAfterMs = parseRetryAfterMs(bodyText, response.headers.get('retry-after'));
    if (retryAfterMs === null) retryAfterMs = 30_000;
    return {
      class: 'rate',
      retryAfterMs,
      error: redact(`telegram rate limited: ${body}`),
    };
  }

  if (status >= 500) {
    return { class: 'retryable', error: redact(`telegram ${status}: ${body}`) };
  }

  if (status >= 200 && status < 300) {
    return result?.ok === true
      ? { class: 'sent' }
      : { class: 'retryable', error: redact(`telegram invalid acknowledgement: ${body}`) };
  }

  return { class: 'permanent', error: redact(`telegram ${status}: ${body}`) };
}

function parseRetryAfterMs(body: string, headerValue: string | null): number | null {
  try {
    const parsed = JSON.parse(body) as { parameters?: { retry_after?: unknown } };
    const retryAfter = parsed.parameters?.retry_after;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
      return retryAfter * 1000;
    }
  } catch {
    // fall through to header
  }
  if (headerValue !== null) {
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return null;
}
