/**
 * Bounded request-body reading for API routes. Requests are consumed
 * incrementally from the underlying stream so memory stays finite even for
 * chunked uploads with no declared length: the byte cap is enforced while
 * reading, a hard deadline rejects stalled senders, and the stream is
 * cancelled on any failure. No Next.js dependency, so tests run against
 * plain Request objects with ReadableStream bodies.
 */

export const BODY_READ_TIMEOUT_MS = 10_000;

/** Body exceeds the configured byte cap (declared or observed). */
export class BodyTooLargeError extends Error {
  constructor(message = 'request body exceeds size limit') {
    super(message);
    this.name = 'BodyTooLargeError';
  }
}

/** The body did not finish reading within the deadline. */
export class BodyTimeoutError extends Error {
  constructor(message = 'request body read timed out') {
    super(message);
    this.name = 'BodyTimeoutError';
  }
}

/** The stream errored or the request was aborted mid-read. */
export class BodyUnreadableError extends Error {
  constructor(message = 'request body is unreadable') {
    super(message);
    this.name = 'BodyUnreadableError';
  }
}

export interface BoundedBodyOptions {
  timeoutMs?: number;
}

/**
 * Read a request body as UTF-8 text under a hard byte cap and deadline.
 * Throws BodyTooLargeError before reading when Content-Length over-declares,
 * otherwise as soon as the observed stream passes the cap; BodyTimeoutError
 * when the sender stalls; BodyUnreadableError on stream failure. The
 * underlying stream is cancelled in every failure path.
 */
export async function readBoundedBody(
  req: Pick<Request, 'headers' | 'body'>,
  maxBytes: number,
  options: BoundedBodyOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? BODY_READ_TIMEOUT_MS;

  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError();
  }

  if (req.body === null) return '';

  const reader = req.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel(new BodyTimeoutError()).catch(() => {});
  }, timeoutMs);

  let received = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maxBytes) {
        void reader.cancel(new BodyTooLargeError()).catch(() => {});
        throw new BodyTooLargeError();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    if (timedOut) throw new BodyTimeoutError();
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw error;
    if (timedOut) throw new BodyTimeoutError();
    void reader.cancel(error instanceof Error ? error : undefined).catch(() => {});
    throw new BodyUnreadableError();
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // Lock already released by cancel(); nothing to do.
    }
  }
}
